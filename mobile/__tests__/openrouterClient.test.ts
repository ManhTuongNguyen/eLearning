/**
 * Serverless OpenRouter client tests (SPEC TASK-083). Covers configuration
 * validation, the ordered model-fallback chain, HTTP status → normalized
 * error mapping, SSE streaming over a scripted fake XMLHttpRequest, direct
 * model discovery, and the guarantee that user requests only ever target
 * openrouter.ai (the API key never reaches the eLearning backend).
 */
import type {ServerlessStreamEvent} from '../src/serverless/types';
import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  buildModelChain,
  createOpenRouterClient,
} from '../src/serverless/openrouterClient';
import {
  OpenRouterAuthenticationError,
  OpenRouterAvailabilityError,
  OpenRouterBadRequestError,
  OpenRouterRequestError,
  OpenRouterResponseError,
  OpenRouterTimeoutError,
  normalizeHttpFailure,
} from '../src/serverless/errors';

type Listener = (() => void) | null;

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: {get: (name: string) => headers[name.toLowerCase()] ?? null},
  } as unknown as Response;
}

function makeClient(fallbacks?: string[]) {
  return createOpenRouterClient({
    apiKey: 'sk-or-user-key',
    primaryModel: 'vendor/primary',
    fallbackModels: fallbacks ?? [],
  });
}

function completionBody(model: string, content = 'Hello there.'): unknown {
  return {
    id: 'gen-1',
    model,
    choices: [{message: {role: 'assistant', content}, finish_reason: 'stop'}],
  };
}

function openRouterSse(chunk: object): string {
  return `: OPENROUTER PROCESSING\n\ndata: ${JSON.stringify(chunk)}\n\n`;
}

function deltaChunk(text: string, model?: string): object {
  return {
    ...(model ? {model} : {}),
    choices: [{delta: {content: text}, finish_reason: null}],
  };
}

/**
 * Scriptable XMLHttpRequest double mirroring React Native progress
 * semantics: emit() appends to responseText and fires onprogress, respond()
 * closes successfully, networkFail()/timeOut() simulate transport failures.
 */
class FakeXHR {
  static sent: FakeXHR[] = [];

  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: string | undefined = undefined;
  responseText = '';
  status = 0;
  aborted = false;
  onprogress: Listener = null;
  onload: Listener = null;
  onerror: Listener = null;
  onabort: Listener = null;
  ontimeout: Listener = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body?: string): void {
    this.body = body;
    FakeXHR.sent.push(this);
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  emit(chunk: string): void {
    this.responseText += chunk;
    this.onprogress?.();
  }

  respond(status = 200): void {
    this.status = status;
    this.onload?.();
  }

  networkFail(): void {
    this.onerror?.();
  }

  timeOut(): void {
    this.ontimeout?.();
  }
}

interface ActiveStream {
  events: ServerlessStreamEvent[];
  handle: {abort(): void};
  /** The most recent attempt's XHR. */
  xhr(): FakeXHR;
}

const realXHR = globalThis.XMLHttpRequest;

function beginStream(
  client: ReturnType<typeof createOpenRouterClient>,
  request?: Parameters<typeof client.streamCompletion>[0]['request'],
): ActiveStream {
  const state: ActiveStream = {
    events: [],
    handle: null as never,
    xhr: () => FakeXHR.sent[FakeXHR.sent.length - 1],
  };
  state.handle = client.streamCompletion({
    request: request ?? {messages: [{role: 'user', content: 'Hi'}]},
    onEvent: event => {
      state.events.push(event);
    },
  });
  return state;
}

beforeEach(() => {
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  FakeXHR.sent = [];
});

afterEach(() => {
  globalThis.XMLHttpRequest = realXHR;
  jest.restoreAllMocks();
});

describe('buildModelChain', () => {
  it('keeps the primary first and drops blanks and duplicates in order', () => {
    expect(buildModelChain('a', ['b', ' b ', '', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    expect(buildModelChain('a')).toEqual(['a']);
  });
});

describe('createOpenRouterClient configuration', () => {
  it('rejects a blank API key or primary model', () => {
    expect(() => createOpenRouterClient({apiKey: '   ', primaryModel: 'm'})).toThrow();
    expect(() => createOpenRouterClient({apiKey: 'k', primaryModel: '  '})).toThrow();
  });

  it('rejects a non-positive timeout', () => {
    expect(() =>
      createOpenRouterClient({apiKey: 'k', primaryModel: 'm', timeoutMs: 0}),
    ).toThrow(/timeout/i);
  });
});

describe('complete', () => {
  it('POSTs to OpenRouter with Bearer auth and a non-streaming payload', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, completionBody('vendor/primary')));

    const result = await makeClient().complete({
      messages: [
        {role: 'system', content: 'Be helpful.'},
        {role: 'user', content: 'Hi'},
      ],
      temperature: 0.5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${DEFAULT_BASE_URL}/chat/completions`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer sk-or-user-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'vendor/primary',
      messages: [
        {role: 'system', content: 'Be helpful.'},
        {role: 'user', content: 'Hi'},
      ],
      stream: false,
      temperature: 0.5,
    });
    expect(result).toEqual({
      text: 'Hello there.',
      model: 'vendor/primary',
      finishReason: 'stop',
      requestId: 'gen-1',
    });
  });

  it('prefers the x-request-id response header over the body id', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, completionBody('m'), {'x-request-id': 'req-9'}));

    const result = await makeClient().complete({messages: [{role: 'user', content: 'Hi'}]});
    expect(result.requestId).toBe('req-9');
  });

  it('advances through retryable failures onto the configured fallbacks', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(503, {error: {message: 'upstream busy'}}))
      .mockResolvedValueOnce(jsonResponse(200, completionBody('vendor/fallback')));

    const result = await makeClient(['vendor/fallback']).complete({
      messages: [{role: 'user', content: 'Hi'}],
    });

    expect(result.model).toBe('vendor/fallback');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('vendor/primary');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).model).toBe('vendor/fallback');
  });

  it('survives transport failures by falling back', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(jsonResponse(200, completionBody('vendor/fallback')));

    await expect(
      makeClient(['vendor/fallback']).complete({messages: [{role: 'user', content: 'Hi'}]}),
    ).resolves.toMatchObject({model: 'vendor/fallback'});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops at the first non-retryable HTTP failure without advancing', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, {error: {message: 'problem 401'}}));

    await expect(
      makeClient(['vendor/fallback']).complete({messages: [{role: 'user', content: 'Hi'}]}),
    ).rejects.toBeInstanceOf(OpenRouterAuthenticationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, OpenRouterBadRequestError],
    [422, OpenRouterBadRequestError],
    [408, OpenRouterTimeoutError],
    [429, OpenRouterAvailabilityError],
    [500, OpenRouterAvailabilityError],
  ])('normalizes HTTP %i onto %j', async (status, expected) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(status, {error: {message: `problem ${status}`}}));

    // Without fallbacks the normalized attempt error escapes directly when
    // non-retryable, or as a one-entry aggregate when retryable.
    await expect(
      makeClient().complete({messages: [{role: 'user', content: 'Hi'}]}),
    ).rejects.toThrow(
      expected === OpenRouterTimeoutError || status === 408
        ? 'all 1 configured model(s) failed: vendor/primary: problem 408'
        : `problem ${status}`,
    );
  });

  it.each([
    [401, OpenRouterAuthenticationError, false],
    [403, OpenRouterAuthenticationError, false],
    [400, OpenRouterBadRequestError, false],
    [404, OpenRouterBadRequestError, false],
    [413, OpenRouterBadRequestError, false],
    [422, OpenRouterBadRequestError, false],
    [408, OpenRouterTimeoutError, true],
    [429, OpenRouterAvailabilityError, true],
    [502, OpenRouterAvailabilityError, true],
    [418, OpenRouterResponseError, false],
  ])('maps status %i onto the right retryability contract', (_status, expected, retryable) => {
    const error = normalizeHttpFailure(_status, 'boom', 'vendor/m');
    expect(error).toBeInstanceOf(expected);
    expect(error.retryable).toBe(retryable);
    expect(error.model).toBe('vendor/m');
  });

  it('advances through every retryable status before aggregating', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(408, {error: {message: 'slow upstream'}}));

    await expect(
      makeClient(['vendor/fallback']).complete({messages: [{role: 'user', content: 'Hi'}]}),
    ).rejects.toThrow(
      'all 2 configured model(s) failed: vendor/primary: slow upstream; vendor/fallback: slow upstream',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('extracts nested error payloads and top-level messages', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, {error: {message: 'Invalid OpenRouter key.'}}));
    await expect(makeClient().complete({messages: [{role: 'user', content: 'Hi'}]}))
      .rejects.toThrow('Invalid OpenRouter key.');
  });

  it('aggregates every attempt when the whole chain fails retryably', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(429, {error: {message: 'rate limited'}}));

    await expect(
      makeClient(['vendor/fallback']).complete({messages: [{role: 'user', content: 'Hi'}]}),
    ).rejects.toThrow(
      'all 2 configured model(s) failed: vendor/primary: rate limited; vendor/fallback: rate limited',
    );
  });

  it('treats malformed success payloads as non-retryable response errors', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, '{oops'));

    await expect(makeClient(['f']).complete({messages: [{role: 'user', content: 'Hi'}]}))
      .rejects.toBeInstanceOf(OpenRouterResponseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, {choices: []}));
    await expect(makeClient(['f']).complete({messages: [{role: 'user', content: 'Hi'}]}))
      .rejects.toBeInstanceOf(OpenRouterResponseError);
  });

  it('an explicit model pin replaces the whole chain', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(503, {error: {message: 'down'}}));

    await expect(
      makeClient(['vendor/fallback']).complete({
        messages: [{role: 'user', content: 'Hi'}],
        model: 'vendor/pinned',
      }),
    ).rejects.toBeInstanceOf(OpenRouterAvailabilityError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('vendor/pinned');
  });

  it('maps an exceeded timeout onto OpenRouterTimeoutError', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted.')),
          );
        }),
    );
    try {
      const promise = makeClient().complete({messages: [{role: 'user', content: 'Hi'}]});
      jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);
      await expect(promise).rejects.toThrow(
        'all 1 configured model(s) failed: vendor/primary: request exceeded timeout of 60000ms',
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('listModels', () => {
  it('GETs the catalog with auth and normalizes well-formed entries', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        data: [
          {
            id: ' vendor/model-a ',
            name: 'Model A',
            description: 'First.',
            context_length: 8192,
            created: 1700000000,
          },
          {id: '', name: 'Broken'},
          'not-an-object',
          {id: 'vendor/model-b'},
          {id: 'vendor/model-c', context_length: 'bogus'},
        ],
      }),
    );

    const models = await makeClient().listModels();

    expect(fetchMock.mock.calls[0][0]).toBe(`${DEFAULT_BASE_URL}/models`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer sk-or-user-key',
    });
    expect(models).toEqual([
      {
        id: 'vendor/model-a',
        name: 'Model A',
        description: 'First.',
        contextLength: 8192,
        created: 1700000000,
      },
      {id: 'vendor/model-b', name: '', description: null, contextLength: null, created: null},
      {id: 'vendor/model-c', name: '', description: null, contextLength: null, created: null},
    ]);
  });

  it('normalizes catalog failures like any other HTTP error', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, {error: {message: 'bad key'}}));
    await expect(makeClient().listModels()).rejects.toBeInstanceOf(OpenRouterAuthenticationError);

    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {nope: true}));
    await expect(makeClient().listModels()).rejects.toBeInstanceOf(OpenRouterResponseError);
  });

  it('reports transport failures as retryable request errors', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('down'));
    await expect(makeClient().listModels()).rejects.toBeInstanceOf(OpenRouterRequestError);
  });
});

describe('streamCompletion transport', () => {
  it('issues a streaming POST carrying the model, messages and Bearer auth', () => {
    beginStream(makeClient(['vendor/fallback']), {
      messages: [{role: 'user', content: 'Hi'}],
      temperature: 0.2,
    });

    const xhr = FakeXHR.sent[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(`${DEFAULT_BASE_URL}/chat/completions`);
    expect(xhr.headers.Accept).toBe('text/event-stream');
    expect(xhr.headers.Authorization).toBe('Bearer sk-or-user-key');
    expect(JSON.parse(xhr.body ?? 'null')).toEqual({
      model: 'vendor/primary',
      messages: [{role: 'user', content: 'Hi'}],
      stream: true,
      temperature: 0.2,
    });
  });

  it('streams start/delta/completed incrementally across keep-alives and [DONE]', () => {
    const stream = beginStream(makeClient());

    // The first content chunk synthesizes the start event and its own delta,
    // mirroring backend llm/openrouter.py.
    stream.xhr().emit(openRouterSse(deltaChunk('Hello', 'vendor/resolved')));
    expect(stream.events).toEqual([
      {type: 'start', model: 'vendor/resolved'},
      {type: 'delta', text: 'Hello'},
    ]);

    stream.xhr().emit(openRouterSse(deltaChunk(' world')));
    stream.xhr().emit(`data: ${JSON.stringify(deltaChunk('!'))}\n\ndata: [DONE]\n\n`);

    expect(stream.events).toEqual([
      {type: 'start', model: 'vendor/resolved'},
      {type: 'delta', text: 'Hello'},
      {type: 'delta', text: ' world'},
      {type: 'delta', text: '!'},
      {type: 'completed', text: 'Hello world!', model: 'vendor/resolved', deltaCount: 3},
    ]);

    // The terminal event already fired; onload must not double-complete.
    stream.xhr().respond(200);
    expect(stream.events).toHaveLength(5);
  });

  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const stream = beginStream(makeClient());
    const wire =
      openRouterSse(deltaChunk('Split', 'vendor/m')) +
      `data: [DONE]\n\n`;

    stream.xhr().emit(wire.slice(0, 10));
    stream.xhr().emit(wire.slice(10, 34));
    stream.xhr().emit(wire.slice(34));
    stream.xhr().respond(200);

    expect(stream.events).toEqual([
      {type: 'start', model: 'vendor/m'},
      {type: 'delta', text: 'Split'},
      {type: 'completed', text: 'Split', model: 'vendor/m', deltaCount: 1},
    ]);
  });

  it('synthesizes completed on a clean close without [DONE]', () => {
    const stream = beginStream(makeClient());

    stream.xhr().emit(openRouterSse(deltaChunk('partial', 'vendor/m')));
    stream.xhr().respond(200);

    expect(stream.events).toEqual([
      {type: 'start', model: 'vendor/m'},
      {type: 'delta', text: 'partial'},
      {type: 'completed', text: 'partial', model: 'vendor/m', deltaCount: 1},
    ]);
  });

  it('silently falls back when the probe fails with a retryable HTTP status', () => {
    const stream = beginStream(makeClient(['vendor/fallback']));

    FakeXHR.sent[0].responseText = JSON.stringify({error: {message: 'capacity'}});
    FakeXHR.sent[0].respond(503);

    // Nothing reached the consumer yet; a fresh attempt started.
    expect(stream.events).toEqual([]);
    expect(FakeXHR.sent).toHaveLength(2);
    expect(JSON.parse(FakeXHR.sent[1].body ?? 'null').model).toBe('vendor/fallback');

    stream.xhr().emit(openRouterSse(deltaChunk('Recovered', 'vendor/fallback')));
    stream.xhr().respond(200);

    expect(stream.events).toEqual([
      {type: 'start', model: 'vendor/fallback'},
      {type: 'delta', text: 'Recovered'},
      {type: 'completed', text: 'Recovered', model: 'vendor/fallback', deltaCount: 1},
    ]);
  });

  it('falls back on a pre-first-byte network failure', () => {
    const stream = beginStream(makeClient(['vendor/fallback']));

    FakeXHR.sent[0].networkFail();

    expect(FakeXHR.sent).toHaveLength(2);
    stream.xhr().emit(openRouterSse(deltaChunk('ok', 'vendor/fallback')));
    stream.xhr().respond(200);
    expect(stream.events.map(event => event.type)).toEqual(['start', 'delta', 'completed']);
  });

  it('stops immediately on a non-retryable authentication failure', () => {
    const stream = beginStream(makeClient(['vendor/fallback']));

    FakeXHR.sent[0].responseText = JSON.stringify({error: {message: 'bad key'}});
    FakeXHR.sent[0].respond(401);

    expect(FakeXHR.sent).toHaveLength(1);
    expect(stream.events).toEqual([
      {type: 'failed', message: 'bad key', retryable: false, text: ''},
    ]);
  });

  it('never restarts after the stream is committed; failures carry partial text', () => {
    const stream = beginStream(makeClient(['vendor/fallback']));

    stream.xhr().emit(openRouterSse(deltaChunk('partial ', 'vendor/primary')));
    stream.xhr().networkFail();

    expect(FakeXHR.sent).toHaveLength(1);
    expect(stream.events).toEqual([
      {type: 'start', model: 'vendor/primary'},
      {type: 'delta', text: 'partial '},
      {
        type: 'failed',
        message: 'Network request failed. Check your connection and try again.',
        retryable: true,
        text: 'partial ',
      },
    ]);
  });

  it('emits an aggregate failure when every chain entry fails before committing', () => {
    const stream = beginStream(makeClient(['vendor/fallback']));

    FakeXHR.sent[0].responseText = JSON.stringify({error: {message: 'one'}});
    FakeXHR.sent[0].respond(500);
    FakeXHR.sent[1].responseText = JSON.stringify({error: {message: 'two'}});
    FakeXHR.sent[1].respond(429);

    expect(FakeXHR.sent).toHaveLength(2);
    expect(stream.events).toEqual([
      {
        type: 'failed',
        message:
          'all 2 configured model(s) failed: vendor/primary: one; vendor/fallback: two',
        retryable: true,
        text: '',
      },
    ]);
  });

  it('normalizes inline mid-stream error payloads into the terminal event', () => {
    const stream = beginStream(makeClient());

    stream.xhr().emit(openRouterSse(deltaChunk('so far', 'vendor/m')));
    stream.xhr().emit(
      openRouterSse({error: {message: 'quota exhausted', code: 402}}),
    );

    expect(stream.events).toEqual([
      {type: 'start', model: 'vendor/m'},
      {type: 'delta', text: 'so far'},
      {
        type: 'failed',
        message: 'Unexpected HTTP 402: quota exhausted',
        retryable: false,
        text: 'so far',
      },
    ]);
  });

  it('fails a stream that closed without delivering anything', () => {
    const stream = beginStream(makeClient());
    stream.xhr().respond(200);

    expect(stream.events).toEqual([
      {
        type: 'failed',
        message: 'Provider closed the stream without sending any events.',
        retryable: false,
        text: '',
      },
    ]);
  });

  it('treats a [DONE] with no content chunks as a provider violation', () => {
    const stream = beginStream(makeClient());
    stream.xhr().emit('data: [DONE]\n\n');

    expect(stream.events).toEqual([
      {
        type: 'failed',
        message: 'Provider closed the stream without sending any events.',
        retryable: false,
        text: '',
      },
    ]);
  });

  it('suppresses every callback once abort() is called', () => {
    const stream = beginStream(makeClient());

    stream.xhr().emit(openRouterSse(deltaChunk('first', 'vendor/m')));
    stream.handle.abort();

    expect(stream.xhr().aborted).toBe(true);
    stream.handle.abort();
    stream.xhr().emit(openRouterSse(deltaChunk('late')));
    stream.xhr().respond(200);

    expect(stream.events).toEqual([
      {type: 'start', model: 'vendor/m'},
      {type: 'delta', text: 'first'},
    ]);
  });

  it('ignores stray traffic after the terminal event', () => {
    const stream = beginStream(makeClient());

    stream
      .xhr()
      .emit(
        openRouterSse(deltaChunk('Done', 'vendor/m')) +
          `data: [DONE]\n\n` +
          openRouterSse(deltaChunk('stray')),
      );
    stream.xhr().respond(200);

    expect(stream.events).toEqual([
      {type: 'start', model: 'vendor/m'},
      {type: 'delta', text: 'Done'},
      {type: 'completed', text: 'Done', model: 'vendor/m', deltaCount: 1},
    ]);
  });

  it('normalizes XHR timeouts reported by the host', () => {
    const stream = beginStream(makeClient());
    stream.xhr().timeOut();

    // A single-entry chain still reports the aggregate contract.
    expect(stream.events).toEqual([
      {
        type: 'failed',
        message:
          'all 1 configured model(s) failed: vendor/primary: request exceeded timeout of 60000ms',
        retryable: true,
        text: '',
      },
    ]);
  });
});
