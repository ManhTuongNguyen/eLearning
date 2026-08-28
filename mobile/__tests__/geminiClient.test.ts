/**
 * Mobile-side Gemini provider client tests (TASK-AUDIT-013). Proves the
 * provider abstraction accommodates a genuinely different API surface:
 * distinct paths (:generateContent / :streamGenerateContent?alt=sse), role
 * mapping (assistant → model, system → systemInstruction), x-goog-api-key
 * authentication (the key only ever travels toward Google), SSE without a
 * [DONE] terminator, authenticated model discovery, the ordered fallback
 * chain, and normalized errors. All external HTTP calls are mocked.
 */
import type {ServerlessStreamEvent} from '../src/serverless/types';
import {
  buildGeminiPayload,
  createGeminiClient,
  DEFAULT_GEMINI_BASE_URL,
  listGeminiModels,
  normalizeGeminiModelEntry,
} from '../src/serverless/geminiClient';
import {
  LLMAuthenticationError,
  LLMAvailabilityError,
  LLMBadRequestError,
  LLMError,
  LLMResponseError,
} from '../src/serverless/errors';

type Listener = (() => void) | null;

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: {get: () => null},
  } as unknown as Response;
}

function generateContentBody(text: string, modelVersion = 'gemini-2.0-flash'): unknown {
  return {
    responseId: 'resp-1',
    modelVersion,
    candidates: [
      {
        content: {parts: [{text}], role: 'model'},
        finishReason: 'STOP',
      },
    ],
  };
}

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
}

const realXHR = globalThis.XMLHttpRequest;
const realFetch = globalThis.fetch;

beforeEach(() => {
  FakeXHR.sent = [];
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  globalThis.XMLHttpRequest = realXHR;
  globalThis.fetch = realFetch;
});

function makeClient(fallbacks?: string[]) {
  return createGeminiClient({
    apiKey: 'AIza-user-key',
    primaryModel: 'gemini-2.0-flash',
    fallbackModels: fallbacks ?? [],
  });
}

function beginStream(
  client: ReturnType<typeof makeClient>,
  request?: {messages: {role: 'user'; content: string}[]},
): {
  events: ServerlessStreamEvent[];
  handle: {abort(): void};
  xhr: () => FakeXHR;
} {
  const state = {
    events: [] as ServerlessStreamEvent[],
    handle: null as unknown as {abort(): void},
    xhr: () => FakeXHR.sent[FakeXHR.sent.length - 1],
  };
  state.handle = client.streamCompletion({
    request: request ?? {messages: [{role: 'user', content: 'Hi'}]},
    onEvent: event => state.events.push(event),
  });
  return state;
}

describe('payload construction', () => {
  test('maps roles onto the Gemini wire format', () => {
    const payload = buildGeminiPayload({
      messages: [
        {role: 'system', content: 'Be concise.'},
        {role: 'user', content: 'Hello'},
        {role: 'assistant', content: 'Hi there'},
        {role: 'user', content: 'Bye'},
      ],
    });

    expect(payload).toEqual({
      contents: [
        {role: 'user', parts: [{text: 'Hello'}]},
        {role: 'model', parts: [{text: 'Hi there'}]},
        {role: 'user', parts: [{text: 'Bye'}]},
      ],
      systemInstruction: {parts: [{text: 'Be concise.'}]},
    });
  });

  test('omits systemInstruction and temperature when unused', () => {
    const payload = buildGeminiPayload({messages: [{role: 'user', content: 'Hi'}]});
    expect(payload).toEqual({
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
    });
    expect(payload.generationConfig).toBeUndefined();
  });

  test('temperature is carried in generationConfig', () => {
    const payload = buildGeminiPayload({
      messages: [{role: 'user', content: 'Hi'}],
      temperature: 0.2,
    });
    expect(payload.generationConfig).toEqual({temperature: 0.2});
  });
});

describe('model entry normalization', () => {
  test('strips the models/ prefix and keeps the documented fields', () => {
    expect(
      normalizeGeminiModelEntry({
        name: 'models/gemini-2.0-flash',
        displayName: 'Gemini 2.0 Flash',
        description: 'Fast model',
        inputTokenLimit: 1048576,
        supportedGenerationMethods: ['generateContent', 'countTokens', 42],
      }),
    ).toEqual({
      id: 'gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      canonicalSlug: null,
      description: 'Fast model',
      contextLength: 1048576,
      created: null,
      architecture: null,
      pricing: null,
      topProvider: null,
      supportedParameters: ['generateContent', 'countTokens'],
    });
  });

  test('rejects unusable entries', () => {
    expect(normalizeGeminiModelEntry('nope')).toBeNull();
    expect(normalizeGeminiModelEntry({displayName: 'no name'})).toBeNull();
    expect(normalizeGeminiModelEntry({name: 'models/'})).toBeNull();
  });
});

describe('configuration validation', () => {
  test('missing key, model, base URL or timeout throws synchronously', () => {
    expect(() => createGeminiClient({apiKey: '', primaryModel: 'm'})).toThrow(
      /Gemini API key is required/,
    );
    expect(() => createGeminiClient({apiKey: 'k', primaryModel: ' '})).toThrow(
      /primary Gemini model is required/,
    );
    expect(() => createGeminiClient({apiKey: 'k', primaryModel: 'm', baseUrl: ' '})).toThrow(
      /Gemini base URL must be a non-empty string/,
    );
    expect(() => createGeminiClient({apiKey: 'k', primaryModel: 'm', timeoutMs: -1})).toThrow(
      /timeout must be greater than zero/,
    );
  });
});

describe('complete', () => {
  test('POSTs to :generateContent with the key header and maps the result', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, generateContentBody('Hello!')));
    try {
      const result = await makeClient().complete({
        messages: [{role: 'user', content: 'Hi'}],
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${DEFAULT_GEMINI_BASE_URL}/models/gemini-2.0-flash:generateContent`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        'x-goog-api-key': 'AIza-user-key',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      });
      expect(result).toEqual({
        text: 'Hello!',
        model: 'gemini-2.0-flash',
        finishReason: 'STOP',
        requestId: 'resp-1',
      });
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('the fallback chain advances only on retryable failures', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => jsonResponse(503, {error: {message: 'overloaded'}}))
      .mockImplementationOnce(async () => jsonResponse(200, generateContentBody('Ok', 'gemini-1.5-pro')));
      ;
    try {
      const result = await makeClient(['gemini-1.5-pro']).complete({
        messages: [{role: 'user', content: 'Hi'}],
      });
      expect(result.model).toBe('gemini-1.5-pro');
      expect(fetchMock.mock.calls[1][0]).toBe(
        `${DEFAULT_GEMINI_BASE_URL}/models/gemini-1.5-pro:generateContent`,
      );
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('authentication failures stop the chain immediately', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(401, {error: {message: 'bad key'}}));
    try {
      const error = (await makeClient(['gemini-1.5-pro']).complete({
        messages: [{role: 'user', content: 'Hi'}],
      }).catch(caught => caught)) as LLMError;
      expect(error).toBeInstanceOf(LLMAuthenticationError);
      expect(error.model).toBe('gemini-2.0-flash');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('an exhausted chain aggregates into one availability error', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(500, {error: {message: 'down'}}));
    try {
      const error = (await makeClient(['gemini-1.5-pro']).complete({
        messages: [{role: 'user', content: 'Hi'}],
      }).catch(caught => caught)) as LLMError;
      expect(error).toBeInstanceOf(LLMAvailabilityError);
      expect(error.message).toContain('all 2 configured model(s) failed');
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('responses without text parts are response errors', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, {candidates: []}));
    try {
      const error = (await makeClient().complete({
        messages: [{role: 'user', content: 'Hi'}],
      }).catch(caught => caught)) as LLMError;
      expect(error).toBeInstanceOf(LLMResponseError);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('HTTP bad requests are normalized as non-retryable', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(400, {error: {message: 'bad role'}}));
    try {
      const error = (await makeClient().complete({
        messages: [{role: 'user', content: 'Hi'}],
      }).catch(caught => caught)) as LLMError;
      expect(error).toBeInstanceOf(LLMBadRequestError);
      expect(error.retryable).toBe(false);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });
});

describe('streamCompletion', () => {
  test('streams SSE chunks without [DONE] and completes on load', async () => {
    const client = makeClient();
    const stream = beginStream(client);

    const xhr = stream.xhr();
    expect(xhr.url).toBe(
      `${DEFAULT_GEMINI_BASE_URL}/models/gemini-2.0-flash:streamGenerateContent?alt=sse`,
    );
    expect(xhr.headers['x-goog-api-key']).toBe('AIza-user-key');
    expect(JSON.parse(String(xhr.body)).contents).toEqual([
      {role: 'user', parts: [{text: 'Hi'}]},
    ]);

    xhr.emit(
      `data: ${JSON.stringify({
        modelVersion: 'gemini-2.0-flash',
        candidates: [{content: {parts: [{text: 'Hello'}], role: 'model'}}],
      })}\n\n`,
    );
    xhr.emit(
      `data: ${JSON.stringify({
        modelVersion: 'gemini-2.0-flash',
        candidates: [{content: {parts: [{text: ' there'}], role: 'model'}}],
      })}\n\n`,
    );
    xhr.respond();

    expect(stream.events).toEqual([
      {type: 'start', model: 'gemini-2.0-flash'},
      {type: 'delta', text: 'Hello'},
      {type: 'delta', text: ' there'},
      {type: 'completed', text: 'Hello there', model: 'gemini-2.0-flash', deltaCount: 2},
    ]);
  });

  test('multi-part chunks join into one delta and empty payloads are ignored', async () => {
    const client = makeClient();
    const stream = beginStream(client);

    const xhr = stream.xhr();
    xhr.emit(
      `data: ${JSON.stringify({
        candidates: [{content: {parts: [{text: 'A'}, {text: 'B'}]}}],
      })}\n\n`,
    );
    xhr.emit('data: NOT_JSON\n\n');
    xhr.respond();

    // The malformed chunk terminates the stream with the normalized error.
    expect(stream.events).toEqual([
      {type: 'start', model: 'gemini-2.0-flash'},
      {type: 'delta', text: 'AB'},
      {type: 'failed', message: 'Malformed JSON chunk from provider.', retryable: false, text: 'AB'},
    ]);
  });

  test('mid-stream error payloads end the stream as failed with partial text', async () => {
    const client = makeClient(['gemini-1.5-pro']);
    const stream = beginStream(client);

    const xhr = stream.xhr();
    xhr.emit(
      `data: ${JSON.stringify({candidates: [{content: {parts: [{text: 'Par'}]}}]})}\n\n`,
    );
    xhr.emit(`data: ${JSON.stringify({error: {code: 500, message: 'dropped'}})}\n\n`);
    xhr.respond();

    expect(stream.events).toEqual([
      {type: 'start', model: 'gemini-2.0-flash'},
      {type: 'delta', text: 'Par'},
      {type: 'failed', message: 'dropped', retryable: true, text: 'Par'},
    ]);
    expect(FakeXHR.sent).toHaveLength(1);
  });

  test('retryable failures before the first event probe the fallback model', async () => {
    const client = makeClient(['gemini-1.5-pro']);
    const stream = beginStream(client);

    stream.xhr().respond(429);
    await Promise.resolve();

    const fallbackXhr = stream.xhr();
    expect(fallbackXhr.url).toContain('gemini-1.5-pro:streamGenerateContent');
    fallbackXhr.emit(
      `data: ${JSON.stringify({
        modelVersion: 'gemini-1.5-pro',
        candidates: [{content: {parts: [{text: 'Ok'}]}}],
      })}\n\n`,
    );
    fallbackXhr.respond();

    expect(stream.events).toEqual([
      {type: 'start', model: 'gemini-1.5-pro'},
      {type: 'delta', text: 'Ok'},
      {type: 'completed', text: 'Ok', model: 'gemini-1.5-pro', deltaCount: 1},
    ]);
  });

  test('abort suppresses all later callbacks', async () => {
    const client = makeClient();
    const stream = beginStream(client);

    const xhr = stream.xhr();
    xhr.emit(
      `data: ${JSON.stringify({candidates: [{content: {parts: [{text: 'Hi'}]}}]})}\n\n`,
    );
    stream.handle.abort();
    xhr.emit(
      `data: ${JSON.stringify({candidates: [{content: {parts: [{text: 'again'}]}}]})}\n\n`,
    );
    xhr.respond();

    expect(stream.events.filter(event => event.type === 'delta')).toHaveLength(1);
    expect(stream.events.filter(event => event.type === 'completed')).toHaveLength(0);
  });

  test('a stream closed without events fails as a response error', async () => {
    const client = makeClient();
    const stream = beginStream(client);
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

  test('transport failures advance the chain before the first event', async () => {
    const client = makeClient(['gemini-1.5-pro']);
    const stream = beginStream(client);
    stream.xhr().networkFail();
    await Promise.resolve();

    expect(stream.xhr().url).toContain('gemini-1.5-pro:streamGenerateContent');
    expect(FakeXHR.sent).toHaveLength(2);
  });
});

describe('listGeminiModels', () => {
  test('requires the key and hits the authenticated /models endpoint', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(200, {
        models: [
          {name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash'},
          'not-an-object',
          {name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro'},
        ],
      }),
    );
    try {
      const models = await listGeminiModels({apiKey: 'AIza-user-key'});

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${DEFAULT_GEMINI_BASE_URL}/models`);
      expect(init?.headers).toEqual({'x-goog-api-key': 'AIza-user-key'});
      expect(models.map(model => model.id)).toEqual(['gemini-2.0-flash', 'gemini-1.5-pro']);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('refuses discovery without any key', async () => {
    await expect(listGeminiModels()).rejects.toThrow(
      /Gemini API key is required for model discovery/,
    );
  });

  test('HTTP failures are normalized', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(403, {error: {message: 'denied'}}));
    try {
      const error = (await listGeminiModels({apiKey: 'AIza-user-key'}).catch(caught => caught)) as LLMError;
      expect(error).toBeInstanceOf(LLMAuthenticationError);
      expect(error.message).toBe('denied');
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('client-bound listModels reuses the configured key', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(200, {models: [{name: 'models/gemini-2.0-flash'}]}),
    );
    try {
      const models = await makeClient().listModels();
      expect(fetchMock.mock.calls[0][1]?.headers).toEqual({'x-goog-api-key': 'AIza-user-key'});
      expect(models.map(model => model.id)).toEqual(['gemini-2.0-flash']);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });
});
