/**
 * Chat SSE client tests (SPEC TASK-049): wire-protocol parsing against the
 * backend llm/sse.py frame format plus transport behavior over a scripted
 * fake XMLHttpRequest (progress chunks, HTTP rejections, network failures
 * and abort semantics).
 */
import type {ChatStreamEvent} from '../src/api/chatStream';
import {
  decodeChatStreamFrame,
  parseSseFrame,
  streamChatTurn,
} from '../src/api/chatStream';
import {API_BASE_URL} from '../src/config';

type Listener = (() => void) | null;

/**
 * Scriptable XMLHttpRequest double: tests push response text through
 * emit() (progress events with accumulating responseText, mirroring RN)
 * and close the stream via respond() or fail it via networkFail().
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

interface ActiveTurn {
  xhr: FakeXHR;
  events: ChatStreamEvent[];
  errors: unknown[];
  handle: {abort(): void};
}

function beginTurn(): ActiveTurn {
  const turn: ActiveTurn = {xhr: new FakeXHR(), events: [], errors: [], handle: null as never};
  turn.handle = streamChatTurn({
    token: 'token-sse',
    sessionId: 7,
    text: 'Hi there',
    onEvent: event => {
      turn.events.push(event);
    },
    onError: error => {
      turn.errors.push(error);
    },
  });
  // streamChatTurn issues exactly one request synchronously.
  turn.xhr = FakeXHR.sent[FakeXHR.sent.length - 1];
  return turn;
}

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const realXHR = globalThis.XMLHttpRequest;

beforeEach(() => {
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  FakeXHR.sent = [];
});

afterEach(() => {
  globalThis.XMLHttpRequest = realXHR;
});

describe('parseSseFrame', () => {
  it('parses event and data fields', () => {
    expect(parseSseFrame('event: delta\ndata: {"text": "Hi"}')).toEqual({
      event: 'delta',
      data: '{"text": "Hi"}',
    });
  });

  it('joins multiple data lines and defaults a missing event to message', () => {
    expect(parseSseFrame('data: line-one\ndata:line two')).toEqual({
      event: 'message',
      data: 'line-one\nline two',
    });
  });

  it('returns null for comment-only or empty keep-alive frames', () => {
    expect(parseSseFrame(': ping')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
  });
});

describe('decodeChatStreamFrame', () => {
  it.each([
    [
      {event: 'start', data: JSON.stringify({model: 'vendor/model'})},
      {type: 'start', model: 'vendor/model'},
    ],
    [
      {event: 'delta', data: JSON.stringify({text: 'Hello'})},
      {type: 'delta', text: 'Hello'},
    ],
    [
      {
        event: 'completed',
        data: JSON.stringify({text: 'Hello', model: 'vendor/model', delta_count: 3}),
      },
      {type: 'completed', text: 'Hello', model: 'vendor/model', deltaCount: 3},
    ],
    [
      {event: 'error', data: JSON.stringify({error: 'boom', retryable: true})},
      {type: 'error', message: 'boom', retryable: true},
    ],
    [
      {event: 'error', data: JSON.stringify({error: 'auth', retryable: false})},
      {type: 'error', message: 'auth', retryable: false},
    ],
  ])('decodes %j', (frameInput, expected) => {
    expect(decodeChatStreamFrame(frameInput)).toEqual(expected);
  });

  it('falls back to zero delta_count and non-retryable for junk fields', () => {
    expect(
      decodeChatStreamFrame({
        event: 'completed',
        data: JSON.stringify({text: 'Done', model: 'm'}),
      }),
    ).toEqual({type: 'completed', text: 'Done', model: 'm', deltaCount: 0});
    expect(
      decodeChatStreamFrame({event: 'error', data: JSON.stringify({retryable: 'yes'})}),
    ).toEqual({type: 'error', message: 'The AI response failed.', retryable: false});
  });

  it('ignores malformed payloads and unknown event names', () => {
    expect(decodeChatStreamFrame({event: 'delta', data: '{oops'})).toBeNull();
    expect(decodeChatStreamFrame({event: 'delta', data: '{}'})).toBeNull();
    expect(
      decodeChatStreamFrame({event: 'completed', data: JSON.stringify({text: 42})}),
    ).toBeNull();
    expect(decodeChatStreamFrame({event: 'ping', data: '{}'})).toBeNull();
  });
});

describe('streamChatTurn transport', () => {
  it('issues a POST carrying JSON text, SSE accept and Bearer auth', () => {
    const turn = beginTurn();

    expect(turn.xhr.method).toBe('POST');
    expect(turn.xhr.url).toBe(`${API_BASE_URL}/api/v1/sessions/7/messages/stream/`);
    expect(turn.xhr.headers['Content-Type']).toBe('application/json');
    expect(turn.xhr.headers.Accept).toBe('text/event-stream');
    expect(turn.xhr.headers.Authorization).toBe('Bearer token-sse');
    expect(JSON.parse(turn.xhr.body ?? 'null')).toEqual({text: 'Hi there'});
    expect(turn.events).toEqual([]);
    expect(turn.errors).toEqual([]);
  });

  it('delivers start/delta/completed incrementally as progress chunks arrive', () => {
    const turn = beginTurn();

    turn.xhr.emit(sse('start', {model: 'vendor/model'}));
    expect(turn.events).toEqual([{type: 'start', model: 'vendor/model'}]);

    turn.xhr.emit(sse('delta', {text: 'Hello'}));
    expect(turn.events[1]).toEqual({type: 'delta', text: 'Hello'});

    turn.xhr.emit(sse('delta', {text: ' world'}));
    turn.xhr.emit(sse('completed', {text: 'Hello world', model: 'm', delta_count: 2}));
    turn.xhr.respond(200);

    expect(turn.events.map(event => event.type)).toEqual([
      'start',
      'delta',
      'delta',
      'completed',
    ]);
    expect(turn.errors).toEqual([]);
  });

  it('parses several frames packed into one chunk', () => {
    const turn = beginTurn();

    turn.xhr.emit(
      `${sse('start', {model: 'm'})}${sse('delta', {text: 'A'})}${sse('delta', {text: 'B'})}`,
    );
    turn.xhr.respond(200);

    expect(turn.events.map(event => event.type)).toEqual(['start', 'delta', 'delta']);
  });

  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const turn = beginTurn();
    const wire =
      sse('delta', {text: 'Split frame'}) +
      sse('completed', {text: 'Split frame', model: 'm', delta_count: 1});

    turn.xhr.emit(wire.slice(0, 8));
    turn.xhr.emit(wire.slice(8, 30));
    turn.xhr.emit(wire.slice(30));
    turn.xhr.respond(200);

    expect(turn.events).toEqual([
      {type: 'delta', text: 'Split frame'},
      {type: 'completed', text: 'Split frame', model: 'm', deltaCount: 1},
    ]);
    expect(turn.errors).toEqual([]);
  });

  it('surfaces error frames as typed retryable events', () => {
    const turn = beginTurn();

    turn.xhr.emit(sse('error', {error: 'provider unavailable', retryable: true}));
    turn.xhr.respond(200);

    expect(turn.events).toEqual([
      {type: 'error', message: 'provider unavailable', retryable: true},
    ]);
    expect(turn.errors).toEqual([]);
  });

  it('normalizes non-SSE HTTP rejections into ApiError without events', () => {
    const turn = beginTurn();

    turn.xhr.responseText = JSON.stringify({text: ['text must not be empty.']});
    turn.xhr.respond(400);

    expect(turn.events).toEqual([]);
    expect(turn.errors).toHaveLength(1);
    const error = turn.errors[0];
    expect(error).toMatchObject({name: 'ApiError', status: 400});
    expect((error as Error).message).toContain('text must not be empty.');
  });

  it('passes DRF detail messages through for auth failures', () => {
    const turn = beginTurn();

    turn.xhr.responseText = JSON.stringify({detail: 'Invalid credentials.'});
    turn.xhr.respond(401);

    expect(turn.errors[0]).toMatchObject({
      name: 'ApiError',
      status: 401,
      message: 'Invalid credentials.',
    });
  });

  it('reports network failures as unreachable ApiError(0)', () => {
    const turn = beginTurn();

    turn.xhr.networkFail();

    expect(turn.errors).toHaveLength(1);
    expect(turn.errors[0]).toMatchObject({name: 'ApiError', status: 0});
    expect((turn.errors[0] as Error).message).toMatch(/network request failed/i);
  });

  it('reports a clean close that never delivered a terminal frame', () => {
    const turn = beginTurn();

    turn.xhr.emit(sse('delta', {text: 'partial'}));
    turn.xhr.respond(200);

    expect(turn.errors).toHaveLength(1);
    expect((turn.errors[0] as Error).message).toMatch(/closed before/i);
  });

  it('suppresses every callback once abort() is called', () => {
    const turn = beginTurn();
    turn.xhr.emit(sse('start', {model: 'm'}));

    turn.handle.abort();
    expect(turn.xhr.aborted).toBe(true);

    // Late traffic after abort must not reach the UI, and a second abort
    // call is a harmless no-op.
    turn.handle.abort();
    turn.xhr.emit(sse('delta', {text: 'late'}));
    turn.xhr.respond(200);
    turn.xhr.networkFail();

    expect(turn.events).toEqual([{type: 'start', model: 'm'}]);
    expect(turn.errors).toEqual([]);
  });

  it('ignores stray frames arriving after the terminal event', () => {
    const turn = beginTurn();

    turn.xhr.emit(sse('completed', {text: 'Done', model: 'm', delta_count: 1}));
    turn.xhr.emit(sse('delta', {text: 'stray'}));
    turn.xhr.respond(200);

    expect(turn.events).toEqual([
      {type: 'completed', text: 'Done', model: 'm', deltaCount: 1},
    ]);
    expect(turn.errors).toEqual([]);
  });
});
