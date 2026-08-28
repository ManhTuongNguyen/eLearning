import {
  ApiError,
  apiRequest,
  backendRequestHeaders,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../src/api/client';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}


async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('Expected the request to fail.');
}

describe('api client', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends JSON bodies and returns parsed payloads', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, {detail: 'Logged out.'}));

    await expect(
      apiRequest('/api/v1/auth/logout/', {
        method: 'POST',
        body: {refresh: 'r'},
        token: 'a',
      }),
    ).resolves.toEqual({detail: 'Logged out.'});

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/auth/logout/'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer a',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({refresh: 'r'}),
      }),
    );
  });

  it('normalizes DRF field errors into an ApiError with fields', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse(400, {
          username: ['A user with that username already exists.'],
          password: ['This password is too common.', 'This password is too short.'],
        }),
      );

    const promise = apiRequest('/api/v1/auth/register/', {
      method: 'POST',
      body: {},
    });
    await expect(promise).rejects.toBeInstanceOf(ApiError);

    const error = await expectApiError(promise);
    expect(error.status).toBe(400);
    expect(error.fields.username).toEqual(['A user with that username already exists.']);
    expect(error.fields.password).toEqual([
      'This password is too common.',
      'This password is too short.',
    ]);
    expect(error.message).toContain('username: A user with that username already exists.');
    expect(error.message).toContain('This password is too short.');
  });

  it('uses the detail field as the message when present', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, {detail: 'No active account found.'}));

    const error = await expectApiError(apiRequest('/api/v1/auth/login/', {method: 'POST'}));
    expect(error.status).toBe(401);
    expect(error.message).toBe('No active account found.');
  });

  it('maps network failures to a friendly offline error', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));

    const error = await expectApiError(apiRequest('/api/v1/health/'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toContain('Network request failed');
  });

  it('falls back to a generic message for non-JSON error payloads', async () => {
    const badResponse = {
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('invalid json');
      },
    } as unknown as Response;
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(badResponse);

    const error = await expectApiError(apiRequest('/api/v1/health/'));
    expect(error.status).toBe(500);
    expect(error.message).toContain('500');
  });

  it('defaults to GET without an Authorization header when no token is given', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, {healthy: true}));

    await expect(apiRequest('/api/v1/health/')).resolves.toEqual({healthy: true});

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty('Authorization');
  });

  it('passes through non-object JSON success payloads untouched', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, ['a', 'b']));

    await expect(apiRequest<string[]>('/api/v1/things/')).resolves.toEqual(['a', 'b']);
  });

  it('ignores non-string error field values and still raises a consistent ApiError', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(400, {
        level: [{unexpected: 'shape'}, 42],
        count: 3,
        nested: {deep: true},
      }),
    );

    const error = await expectApiError(apiRequest('/api/v1/profile/', {method: 'PATCH'}));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.fields).toEqual({});
    expect(error.message).toBe('Request failed (400).');
  });

  it('normalizes an empty JSON error object to a generic message', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(409, {}));

    const error = await expectApiError(apiRequest('/api/v1/sessions/', {method: 'POST'}));
    expect(error.status).toBe(409);
    expect(error.fields).toEqual({});
    expect(error.message).toBe('Request failed (409).');
  });

  describe('error categorization', () => {
    it('categorizes network failure (status 0) as network', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));

      const error = await expectApiError(apiRequest('/api/v1/health/'));
      expect(error.category).toBe('network');
    });

it('categorizes timeout error (AbortError) as timeout', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    const error = await expectApiError(apiRequest('/api/v1/health/'));
    expect(error.category).toBe('timeout');
  });

    it('categorizes 401 as authentication', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, {detail: 'Unauthorized'}));

      const error = await expectApiError(apiRequest('/api/v1/auth/me/'));
      expect(error.category).toBe('authentication');
    });

    it('categorizes 403 as authentication', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(403, {detail: 'Forbidden'}));

      const error = await expectApiError(apiRequest('/api/v1/auth/me/'));
      expect(error.category).toBe('authentication');
    });

    it('categorizes 400 as validation', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(400, {detail: 'Bad request'}));

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('validation');
    });

    it('categorizes 422 as validation', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(422, {detail: 'Unprocessable'}));

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('validation');
    });

    it('categorizes 408 as timeout', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(408, {detail: 'Request timeout'}));

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('timeout');
    });

    it('categorizes 504 as timeout', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(504, {detail: 'Gateway timeout'}));

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('timeout');
    });

    it('categorizes 500 as server', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(500, {detail: 'Server error'}));

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('server');
    });

    it('categorizes 502 as server', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(502, {detail: 'Bad gateway'}));

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('server');
    });

    it('categorizes 503 as server', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503, {detail: 'Service unavailable'}));

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('server');
    });

    it('categorizes LLM provider error (openrouter in detail) as llm', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse(502, {detail: 'OpenRouter provider unavailable'}),
      );

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('llm');
    });

    it('categorizes LLM provider error (model in detail) as llm', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse(502, {detail: 'Model not found'}),
      );

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('llm');
    });

    it('categorizes LLM provider error (streaming in detail) as llm', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse(502, {detail: 'Streaming failed'}),
      );

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('llm');
    });

    it('categorizes LLM provider error (provider field) as llm', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse(502, {provider: 'OpenRouter unavailable'}),
      );

      const error = await expectApiError(apiRequest('/api/v1/sessions/'));
      expect(error.category).toBe('llm');
    });

    it('categorizes 404 as validation', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(404, {detail: 'Not found'}));

      const error = await expectApiError(apiRequest('/api/v1/sessions/999/'));
      expect(error.category).toBe('validation');
    });
  });

  describe('unified transport concerns (TASK-AUDIT-015)', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns text bodies untouched and omits the JSON content type for text requests', async () => {
      const csv = 'Front,Back,Example,Pronunciation\n"set off","phrasal verb",,\n';
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(textResponse(200, csv));

      await expect(
        apiRequest<string>('/api/v1/vocabulary/export/', {
          accept: 'text/csv',
          responseType: 'text',
          token: 't',
        }),
      ).resolves.toBe(csv);

      const [, init] = fetchMock.mock.calls[0];
      expect(init?.headers).toEqual({Accept: 'text/csv', Authorization: 'Bearer t'});
      // Every JSON/text request carries the shared deadline signal.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('normalizes JSON error bodies on text responses through the shared contract', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(textResponse(401, JSON.stringify({detail: 'Invalid token.'})));

      const error = await expectApiError(
        apiRequest('/api/v1/vocabulary/export/', {accept: 'text/csv', responseType: 'text'}),
      );

      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(401);
      expect(error.message).toBe('Invalid token.');
      expect(error.category).toBe('authentication');
    });

    it('falls back to the generic message when a text error body is not JSON', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(textResponse(503, '<html>gateway down</html>'));

      const error = await expectApiError(
        apiRequest('/api/v1/vocabulary/export/', {accept: 'text/csv', responseType: 'text'}),
      );

      expect(error.status).toBe(503);
      expect(error.message).toBe('Request failed (503).');
    });

    it('aborts a request past its deadline and surfaces the shared timeout error', async () => {
      jest.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const abortError = new Error('Aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }),
      );

      await expect(
        apiRequest('/api/v1/sessions/', {timeoutMs: 10}),
      ).rejects.toMatchObject({
        name: 'ApiError',
        status: 0,
        category: 'timeout',
        message: 'The request timed out. Please try again.',
      });
    });

    it('exposes the shared deadline constant and single header builder', () => {
      expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(60000);
      expect(
        backendRequestHeaders('tok', 'text/event-stream', 'application/json'),
      ).toEqual({
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok',
      });
      // No token → no Authorization header; no content type → no header.
      expect(backendRequestHeaders(null, 'text/csv')).toEqual({Accept: 'text/csv'});
      expect(backendRequestHeaders(undefined, 'application/json')).toEqual({
        Accept: 'application/json',
      });
    });
  });
});
