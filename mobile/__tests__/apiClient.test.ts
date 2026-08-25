import {ApiError, apiRequest} from '../src/api/client';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
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
});
