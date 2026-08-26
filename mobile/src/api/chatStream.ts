/**
 * Typed SSE consumption for chat streaming (SPEC TASK-049) and failed-turn
 * retries (SPEC TASK-054).
 *
 * Speaks the wire protocol produced by the backend (llm/sse.py):
 *
 *   event: start
 *   data: {"model": "vendor/model"}
 *
 *   event: delta
 *   data: {"text": "Hello"}
 *
 *   event: completed
 *   data: {"text": "Hello", "model": "vendor/model", "delta_count": 1}
 *
 *   event: error
 *   data: {"error": "...", "retryable": true}
 *
 * Transport: React Native's fetch buffers response bodies before they
 * resolve, so incremental reads go through XMLHttpRequest, whose progress
 * events expose the accumulating `responseText` as bytes arrive. The handle
 * returned by streamChatTurn/streamRetryTurn aborts the underlying request;
 * leaving a chat screen must call it so no turn outlives its UI.
 */
import {assertServerApiAllowed} from '../mode/runtime';
import {API_BASE_URL} from '../config';
import {ApiError, normalizeApiError} from './client';

/** Normalized application events carried by the SSE frames. */
export type ChatStreamEvent =
  | {type: 'start'; model: string}
  | {type: 'delta'; text: string}
  | {type: 'completed'; text: string; model: string; deltaCount: number}
  | {type: 'error'; message: string; retryable: boolean};

/** One decoded SSE frame: an event name plus its raw data payload. */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Parse one raw SSE frame (the lines before a blank separator). Returns null
 * when the frame carries nothing dispatchable (keep-alive comments). Field
 * values are trimmed; multi-line data payloads are joined.
 */
export function parseSseFrame(raw: string): SseFrame | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
    // Other fields (id:, retry:) and comment lines (: keep-alive) are ignored.
  }
  const data = dataLines.join('\n');
  if (!event && !data) {
    return null;
  }
  return {event: event || 'message', data};
}

/** Map one frame onto the typed event union; unknown events return null. */
export function decodeChatStreamFrame(frame: SseFrame): ChatStreamEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    payload = null;
  }
  const record =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};

  switch (frame.event) {
    case 'start':
      return typeof record.model === 'string' ? {type: 'start', model: record.model} : null;
    case 'delta':
      return typeof record.text === 'string' ? {type: 'delta', text: record.text} : null;
    case 'completed': {
      const {text, model, delta_count: deltaCount} = record;
      if (typeof text !== 'string' || typeof model !== 'string') {
        return null;
      }
      return {
        type: 'completed',
        text,
        model,
        deltaCount: typeof deltaCount === 'number' ? deltaCount : 0,
      };
    }
    case 'error':
      return {
        type: 'error',
        message:
          typeof record.error === 'string' ? record.error : 'The AI response failed.',
        retryable: record.retryable === true,
      };
    default:
      return null;
  }
}

export interface StreamChatTurnOptions {
  token: string;
  sessionId: number;
  text: string;
  /** Application events as they arrive, in wire order. */
  onEvent: (event: ChatStreamEvent) => void;
  /** Transport-level failures: HTTP rejection, network drop, early close. */
  onError: (error: unknown) => void;
}

/** Retry one failed assistant generation (SPEC TASK-054). */
export interface StreamRetryTurnOptions {
  token: string;
  sessionId: number;
  /** The failed assistant message row being retried. */
  messageId: number;
  onEvent: (event: ChatStreamEvent) => void;
  onError: (error: unknown) => void;
}

export interface ChatStreamHandle {
  /**
   * Cancel the stream. After abort() no further callbacks fire, so screens
   * can safely drop the handle on unmount or navigation.
   */
  abort(): void;
}

const NETWORK_ERROR_MESSAGE =
  'Network request failed. Check your connection and try again.';

function toApiError(status: number, bodyText: string): ApiError {
  let payload: unknown = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = null;
  }
  return normalizeApiError(status, payload);
}

interface ConsumeStreamOptions {
  url: string;
  /** Serialized JSON request body; null sends no body at all. */
  body: string | null;
  token: string;
  onEvent: (event: ChatStreamEvent) => void;
  onError: (error: unknown) => void;
}

/**
 * Shared XHR/SSE consumption loop behind streamChatTurn and
 * streamRetryTurn: both backend endpoints answer with the identical frame
 * protocol, so only the URL and request body differ.
 */
function consumeSseStream(options: ConsumeStreamOptions): ChatStreamHandle {
  // Serverless mode streams directly from OpenRouter instead (SPEC
  // TASK-080): fail the turn without opening any backend connection.
  try {
    assertServerApiAllowed();
  } catch (err) {
    options.onError(err);
    return {
      abort() {
        // Nothing is in flight; aborting a blocked turn is a no-op.
      },
    };
  }

  // aborted: user cancel — suppress every callback from now on.
  // finished: the stream reached its single terminal outcome.
  let aborted = false;
  let finished = false;
  let terminalSeen = false;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', options.url);
  if (options.body !== null) {
    xhr.setRequestHeader('Content-Type', 'application/json');
  }
  xhr.setRequestHeader('Accept', 'text/event-stream');
  xhr.setRequestHeader('Authorization', `Bearer ${options.token}`);

  // Cursor into the accumulating responseText plus the tail of a possibly
  // half-delivered frame across progress boundaries.
  let cursor = 0;
  let pending = '';

  function dispatch(raw: string): void {
    if (aborted || finished || terminalSeen) {
      return;
    }
    const frame = parseSseFrame(raw.replace(/\r/g, ''));
    if (!frame) {
      return;
    }
    const event = decodeChatStreamFrame(frame);
    if (!event) {
      return;
    }
    if (event.type === 'completed' || event.type === 'error') {
      terminalSeen = true;
    }
    options.onEvent(event);
  }

  function consumeBuffer(): void {
    const total = xhr.responseText.length;
    if (total > cursor) {
      pending += xhr.responseText.slice(cursor, total);
      cursor = total;
      let separator = pending.indexOf('\n\n');
      while (separator !== -1) {
        dispatch(pending.slice(0, separator));
        pending = pending.slice(separator + 2);
        separator = pending.indexOf('\n\n');
      }
    }
  }

  function finishWith(error: ApiError): void {
    if (aborted || finished) {
      return;
    }
    finished = true;
    options.onError(error);
  }

  xhr.onprogress = () => {
    if (!aborted && !finished) {
      consumeBuffer();
    }
  };

  xhr.onload = () => {
    if (aborted || finished) {
      return;
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      // Pre-stream rejections (auth/validation/404/409) are plain DRF JSON,
      // not SSE.
      finishWith(toApiError(xhr.status, xhr.responseText));
      return;
    }
    consumeBuffer();
    if (pending.trim()) {
      // Tolerate a server that closes without the trailing blank line.
      dispatch(pending);
      pending = '';
    }
    if (!terminalSeen) {
      finishWith(new ApiError(0, 'The connection closed before the response finished.'));
      return;
    }
    finished = true;
  };

  xhr.onerror = () => {
    finishWith(new ApiError(0, NETWORK_ERROR_MESSAGE));
  };

  xhr.send(options.body ?? undefined);

  return {
    abort() {
      if (aborted) {
        return;
      }
      aborted = true;
      finished = true;
      xhr.abort();
    },
  };
}

/**
 * Start one chat turn over SSE and consume it incrementally. Returns an
 * abort handle immediately; events flow through callbacks afterwards.
 * Exactly one terminal outcome occurs per stream: a `completed` or `error`
 * application event, or an onError transport failure — never both.
 */
export function streamChatTurn(options: StreamChatTurnOptions): ChatStreamHandle {
  return consumeSseStream({
    url: `${API_BASE_URL}/api/v1/sessions/${options.sessionId}/messages/stream/`,
    body: JSON.stringify({text: options.text}),
    token: options.token,
    onEvent: options.onEvent,
    onError: options.onError,
  });
}

/**
 * Retry one failed assistant generation over SSE (TASK-042 backend
 * contract): POST without a body to
 * /api/v1/sessions/{id}/messages/{message_pk}/retry/. The failed row is
 * re-armed in place server-side and the replacement attempt streams with
 * the same start/delta/completed/error frames as a fresh turn.
 */
export function streamRetryTurn(options: StreamRetryTurnOptions): ChatStreamHandle {
  return consumeSseStream({
    url: `${API_BASE_URL}/api/v1/sessions/${options.sessionId}/messages/${options.messageId}/retry/`,
    body: null,
    token: options.token,
    onEvent: options.onEvent,
    onError: options.onError,
  });
}
