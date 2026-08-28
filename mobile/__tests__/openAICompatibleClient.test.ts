/**
 * Shared OpenAI-compatible provider strategy tests (TASK-AUDIT-013).
 * Exercises the common /chat/completions strategy through a non-OpenRouter
 * spec (OpenAI: authenticated model discovery) so vendor-specific wrappers
 * are not the only thing under test. Covers configuration validation,
 * payload construction, ordered fallback semantics (only retryable
 * failures advance), HTTP status → normalized error mapping, SSE streaming
 * over a scripted fake XMLHttpRequest (keep-alive comments, [DONE],
 * mid-stream error payloads, committed streams that never retry), abort
 * semantics, and the keyless vs authorized model-catalog contract. All
 * external HTTP calls are mocked.
 */
import type {ServerlessStreamEvent} from '../src/serverless/types';
import {
  buildModelChain,
  createOpenAICompatibleClient,
  extractErrorMessage,
  requestModelCatalog,
} from '../src/serverless/openAICompatibleClient';
import {createOpenAIClient} from '../src/serverless/openAIClient';
import {
  LLMAuthenticationError,
  LLMAvailabilityError,
  LLMBadRequestError,
  LLMError,
  LLMResponseError,
  LLMTimeoutError,
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

function completionBody(model: string, content = 'Hello there.'): unknown {
  return {
    id: 'chatcmpl-1',
    model,
    choices: [{message: {role: 'assistant', content}, finish_reason: 'stop'}],
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

const realXHR = globalThis.XMLHttpRequest;

beforeEach(() => {
  FakeXHR.sent = [];
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  globalThis.XMLHttpRequest = realXHR;
});

function makeClient(fallbacks?: string[], timeoutMs?: number) {
  return createOpenAIClient({
    apiKey: 'sk-openai-user-key',
    primaryModel: 'gpt-4o-mini',
    fallbackModels: fallbacks ?? [],
    timeoutMs,
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

describe('configuration validation', () => {
  test('missing key, model, base URL or timeout throws synchronously', () => {
    expect(() => createOpenAIClient({apiKey: '  ', primaryModel: 'gpt-4o-mini'})).toThrow(
      /OpenAI API key is required/,
    );
    expect(() => createOpenAIClient({apiKey: 'sk', primaryModel: ''})).toThrow(
      /primary OpenAI model is required/,
    );
    expect(() =>
      createOpenAICompatibleClient(
        {apiKey: 'sk', primaryModel: 'm', baseUrl: '   '},
        {id: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1'},
      ),
    ).toThrow(/base URL must be a non-empty string/);
    expect(() =>
      createOpenAIClient({apiKey: 'sk', primaryModel: 'm', timeoutMs: 0}),
    ).toThrow(/timeout must be greater than zero/);
    expect(() =>
      createOpenAIClient({apiKey: 'sk', primaryModel: 'm', timeoutMs: Number.POSITIVE_INFINITY}),
    ).toThrow(/timeout must be greater than zero/);
  });
});

describe('buildModelChain', () => {
  test('primary first, unique non-blank fallbacks after', () => {
    expect(buildModelChain('a', ['b', 'a', '  ', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(buildModelChain('a')).toEqual(['a']);
  });
});

describe('extractErrorMessage', () => {
  test('prefers nested error.message, then message, then raw snippet', () => {
    expect(extractErrorMessage(JSON.stringify({error: {message: 'Bad key'}}))).toBe('Bad key');
    expect(extractErrorMessage(JSON.stringify({message: 'Plain message'}))).toBe('Plain message');
    expect(extractErrorMessage('raw text body')).toBe('raw text body');
    expect(extractErrorMessage('')).toBe('empty error body');
  });

  test('never returns more than the capped snippet length', () => {
    const long = 'x'.repeat(5000);
    expect(extractErrorMessage(long)).toHaveLength(300);
  });
});

describe('complete', () => {
  test('POSTs the normalized chat payload with Bearer auth and maps the result', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, completionBody('gpt-4o-mini')));
    try {
      const result = await makeClient().complete({
        messages: [
          {role: 'system', content: 'You are helpful.'},
          {role: 'user', content: 'Hi'},
        ],
        temperature: 0.4,
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        Authorization: 'Bearer sk-openai-user-key',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'gpt-4o-mini',
        messages: [
          {role: 'system', content: 'You are helpful.'},
          {role: 'user', content: 'Hi'},
        ],
        stream: false,
        temperature: 0.4,
      });
      expect(result).toEqual({
        text: 'Hello there.',
        model: 'gpt-4o-mini',
        finishReason: 'stop',
        requestId: 'chatcmpl-1',
      });
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('advances to the fallback model only on retryable failures', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => jsonResponse(429, {error: {message: 'slow down'}}))
      .mockImplementationOnce(async () => jsonResponse(200, completionBody('gpt-4o', 'Fallback!')));
      ;
    try {
      const client = makeClient(['gpt-4o']);
      const result = await client.complete({messages: [{role: 'user', content: 'Hi'}]});

      expect(result.model).toBe('gpt-4o');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).model).toBe('gpt-4o');
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('stops immediately on non-retryable failures', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(401, {error: {message: 'bad key'}}));
    try {
      const error = (await makeClient(['gpt-4o']).complete({
        messages: [{role: 'user', content: 'Hi'}],
      }).catch(caught => caught)) as LLMError;

      expect(error).toBeInstanceOf(LLMAuthenticationError);
      expect(error.message).toBe('bad key');
      expect(error.model).toBe('gpt-4o-mini');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('aggregates a fully exhausted chain into one availability error', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(503, {error: {message: 'down'}}));
    try {
      const error = (await makeClient(['gpt-4o']).complete({
        messages: [{role: 'user', content: 'Hi'}],
      }).catch(caught => caught)) as LLMError;

      expect(error).toBeInstanceOf(LLMAvailabilityError);
      expect(error.message).toContain('all 2 configured model(s) failed');
      expect(error.message).toContain('gpt-4o-mini: down');
      expect(error.message).toContain('gpt-4o: down');
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('maps HTTP statuses onto the normalized error classes', async () => {
    // Direct status → class mapping contract (mirrors backend
    // provider_errors.py); retryable statuses are further routed through
    // the fallback chain by the client.
    expect(normalizeHttpFailure(401, 'nope', null, 'OpenAI')).toBeInstanceOf(
      LLMAuthenticationError,
    );
    expect(normalizeHttpFailure(403, 'nope', null, 'OpenAI')).toBeInstanceOf(
      LLMAuthenticationError,
    );
    expect(normalizeHttpFailure(400, 'nope', null, 'OpenAI')).toBeInstanceOf(
      LLMBadRequestError,
    );
    expect(normalizeHttpFailure(422, 'nope', null, 'OpenAI')).toBeInstanceOf(
      LLMBadRequestError,
    );
    expect(normalizeHttpFailure(408, 'nope', null, 'OpenAI')).toBeInstanceOf(LLMTimeoutError);
    expect(normalizeHttpFailure(429, 'nope', null, 'OpenAI')).toBeInstanceOf(
      LLMAvailabilityError,
    );
    expect(normalizeHttpFailure(500, 'nope', null, 'OpenAI')).toBeInstanceOf(
      LLMAvailabilityError,
    );
    expect(normalizeHttpFailure(418, 'nope', null, 'OpenAI')).toBeInstanceOf(LLMResponseError);
    // A non-retryable status surfaces directly from complete() with the
    // failing model attached.
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(401, {message: 'nope'}));
    try {
      const error = (await makeClient(['gpt-4o']).complete({
        messages: [{role: 'user', content: 'Hi'}],
      }).catch(caught => caught)) as LLMError;
      expect(error).toBeInstanceOf(LLMAuthenticationError);
      expect(error.model).toBe('gpt-4o-mini');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('transport timeouts and network failures are retryable request errors', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new TypeError('Network request failed');
    });
    try {
      const error = (await makeClient(undefined, 25).complete({
        messages: [{role: 'user', content: 'Hi'}],
      }).catch(caught => caught)) as LLMError;
      // Every attempt failed, so the retryable transport error surfaces
      // through the chain-exhaustion aggregate (retryable, per-attempt
      // messages preserved).
      expect(error).toBeInstanceOf(LLMAvailabilityError);
      expect(error.retryable).toBe(true);
      expect(error.message).toContain(
        'gpt-4o-mini: Network request failed. Check your connection and try again.',
      );
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('an explicit model pin replaces the whole chain', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, completionBody('pinned-model')));
    try {
      await makeClient(['gpt-4o']).complete({
        messages: [{role: 'user', content: 'Hi'}],
        model: 'pinned-model',
      });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('pinned-model');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });
});

describe('streamCompletion', () => {
  test('emits start, deltas and a completed event with the aggregated text', async () => {
    const client = makeClient();
    const stream = beginStream(client);

    const xhr = stream.xhr();
    xhr.emit(': keep-alive\n\n');
    xhr.emit(
      `data: ${JSON.stringify({model: 'gpt-4o-mini', choices: [{delta: {content: 'Hello'}}]})}\n\n`,
    );
    xhr.emit(`data: ${JSON.stringify({choices: [{delta: {content: ' world'}}]})}\n\n`);
    xhr.emit('data: [DONE]\n\n');
    xhr.respond();

    expect(stream.events).toEqual([
      {type: 'start', model: 'gpt-4o-mini'},
      {type: 'delta', text: 'Hello'},
      {type: 'delta', text: ' world'},
      {type: 'completed', text: 'Hello world', model: 'gpt-4o-mini', deltaCount: 2},
    ]);
    expect(stream.xhr().headers.Authorization).toBe('Bearer sk-openai-user-key');
    expect(stream.xhr().headers.Accept).toBe('text/event-stream');
    expect(JSON.parse(String(stream.xhr().body)).stream).toBe(true);
  });

  test('falls back to the next model while probing before the first event', async () => {
    const client = makeClient(['gpt-4o']);
    const stream = beginStream(client);

    stream.xhr().respond(429);
    await Promise.resolve();

    const fallbackXhr = stream.xhr();
    expect(fallbackXhr).not.toBe(FakeXHR.sent[0]);
    fallbackXhr.emit(
      `data: ${JSON.stringify({model: 'gpt-4o', choices: [{delta: {content: 'Ok'}}]})}\n\n`,
    );
    fallbackXhr.emit('data: [DONE]\n\n');
    fallbackXhr.respond();

    expect(stream.events).toEqual([
      {type: 'start', model: 'gpt-4o'},
      {type: 'delta', text: 'Ok'},
      {type: 'completed', text: 'Ok', model: 'gpt-4o', deltaCount: 1},
    ]);
  });

  test('a committed stream never retries: mid-stream errors end as failed with partial text', async () => {
    const client = makeClient(['gpt-4o']);
    const stream = beginStream(client);

    const xhr = stream.xhr();
    xhr.emit(`data: ${JSON.stringify({choices: [{delta: {content: 'Par'}}]})}\n\n`);
    xhr.emit(`data: ${JSON.stringify({error: {code: 503, message: 'dropped'}})}\n\n`);
    xhr.respond();

    expect(stream.events).toEqual([
      {type: 'start', model: 'gpt-4o-mini'},
      {type: 'delta', text: 'Par'},
      {type: 'failed', message: 'dropped', retryable: true, text: 'Par'},
    ]);
    expect(FakeXHR.sent).toHaveLength(1);
  });

  test('non-retryable HTTP failures surface the normalized error immediately', async () => {
    const client = makeClient(['gpt-4o']);
    const stream = beginStream(client);

    const xhr = stream.xhr();
    // The error body arrives before the response closes; non-SSE text is
    // ignored by the frame parser and picked up by the status handler.
    xhr.emit(`${JSON.stringify({error: {message: 'bad key'}})}\n\n`);
    xhr.respond(401);

    expect(stream.events).toEqual([
      {
        type: 'failed',
        message: 'bad key',
        retryable: false,
        text: '',
      },
    ]);
    expect(FakeXHR.sent).toHaveLength(1);
  });

  test('a stream closed without any events fails as a response error', async () => {
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

  test('abort suppresses every later callback including terminal events', async () => {
    const client = makeClient();
    const stream = beginStream(client);

    const xhr = stream.xhr();
    xhr.emit(`data: ${JSON.stringify({choices: [{delta: {content: 'Hi'}}]})}\n\n`);
    stream.handle.abort();
    xhr.emit(`data: ${JSON.stringify({choices: [{delta: {content: 'again'}}]})}\n\n`);
    xhr.respond();

    expect(stream.events.filter(event => event.type === 'delta')).toHaveLength(1);
    expect(stream.events.filter(event => event.type === 'completed')).toHaveLength(0);
  });

  test('network and timeout failures advance the chain, exhaustion aggregates', async () => {
    const client = makeClient(['gpt-4o']);
    const stream = beginStream(client);
    stream.xhr().networkFail();
    await Promise.resolve();
    stream.xhr().timeOut();
    await Promise.resolve();

    expect(stream.events).toEqual([
      {
        type: 'failed',
        message: 'all 2 configured model(s) failed: gpt-4o-mini: Network request failed. Check your connection and try again.; gpt-4o: request exceeded timeout of 60000ms',
        retryable: true,
        text: '',
      },
    ]);
  });
});

describe('model catalog', () => {
  test('requestModelCatalog stays fully keyless when no key is supplied', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, {data: [{id: 'a-model'}]}));
    try {
      const models = await requestModelCatalog('https://provider.example/v1', 5000);
      const [, init] = fetchMock.mock.calls[0];
      expect(init?.headers).toBeUndefined();
      expect(models.map(model => model.id)).toEqual(['a-model']);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('requestModelCatalog sends Authorization only when a key is supplied', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, {data: []}));
    try {
      await requestModelCatalog('https://api.openai.com/v1', 5000, 'sk-openai-user-key');
      const [, init] = fetchMock.mock.calls[0];
      expect(init?.headers).toEqual({Authorization: 'Bearer sk-openai-user-key'});
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });

  test('listModels respects the spec: OpenAI discovery requires the user key', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, {data: [{id: 'gpt-4o'}]}));
    try {
      const models = await makeClient().listModels();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/models');
      expect(init?.headers).toEqual({Authorization: 'Bearer sk-openai-user-key'});
      expect(models.map(model => model.id)).toEqual(['gpt-4o']);
    } finally {
      (globalThis.fetch as unknown as jest.SpyInstance).mockRestore();
    }
  });
});
