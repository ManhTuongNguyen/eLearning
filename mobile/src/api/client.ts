/**
 * HTTP client for the backend API with normalized error handling.
 *
 * Single predictable owner (TASK-AUDIT-015) of the backend transport
 * concerns: base URL assembly, request header construction (including the
 * Authorization format), JSON/text body handling, request deadlines
 * (timeouts), and error normalization. The one-time token refresh/retry
 * lives in auth/authedRequest.ts, which drives this wrapper; the SSE stream
 * transport (api/chatStream.ts) is deliberately separate — XMLHttpRequest
 * progress events are the only incremental read path in React Native — but
 * reuses the header builder and the shared timeout constant so every
 * backend request keeps one wire contract.
 */

import {assertServerApiAllowed} from '../mode/runtime';
import {API_BASE_URL} from '../config';

/**
 * Request deadline for backend calls, matching the backend LLM read timeout
 * and the SSE stream timeout, so every transport shares one policy.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

/** Category of API failure for programmatic handling. */
export type ApiErrorCategory =
  | 'network'
  | 'authentication'
  | 'validation'
  | 'server'
  | 'llm'
  | 'timeout';

/** Normalized API failure carrying the HTTP status, DRF field errors, and category. */
export class ApiError extends Error {
  readonly status: number;
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly category: ApiErrorCategory;

  constructor(
    status: number,
    message: string,
    fields?: Record<string, string[]>,
    category: ApiErrorCategory = 'server',
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields ?? {};
    this.category = category;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
  /** Overrides the Accept header for non-JSON responses (e.g. CSV export). */
  accept?: string;
  /** Parse the response body as raw text instead of JSON. */
  responseType?: 'json' | 'text';
  /**
   * Request deadline in milliseconds; defaults to DEFAULT_REQUEST_TIMEOUT_MS,
   * 0 disables the deadline. Expiry surfaces as a timeout-category ApiError.
   */
  timeoutMs?: number;
}

/**
 * Build the canonical backend request headers. The only place the
 * Authorization header format is defined (TASK-AUDIT-015); apiRequest and
 * the XHR-based SSE transport both construct their headers through this.
 */
export function backendRequestHeaders(
  token: string | null | undefined,
  accept: string,
  contentType?: string,
): Record<string, string> {
  const headers: Record<string, string> = {Accept: accept};
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // Serverless mode never talks to backend endpoints (SPEC TASK-080): the
  // gate fires before any request is opened so local data cannot leak out.
  assertServerApiAllowed();

  const headers = backendRequestHeaders(
    options.token,
    options.accept ?? 'application/json',
    // JSON requests always declare the content type, even bodyless ones,
    // preserving the wire contract this client has always sent.
    options.responseType === 'text' ? undefined : 'application/json',
  );

  // The deadline is enforced with an AbortController so a hung connection
  // surfaces as the same timeout category as a server-reported 408/504.
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (err) {
    // Distinguish timeout from general network failure when possible.
    const isTimeout =
      err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('timeout'));
    if (isTimeout) {
      throw new ApiError(0, 'The request timed out. Please try again.', {}, 'timeout');
    }
    throw new ApiError(0, 'Network request failed. Check your connection and try again.', {}, 'network');
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }

  if (options.responseType === 'text') {
    // Non-JSON success payloads (CSV export) return untouched; DRF error
    // bodies are still JSON, so the shared normalization keeps applying.
    const text = await response.text();
    if (!response.ok) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      throw normalizeApiError(response.status, payload);
    }
    return text as T;
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    throw normalizeApiError(response.status, payload);
  }
  return payload as T;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Map an HTTP status to an error category. */
function statusToCategory(status: number): ApiErrorCategory {
  if (status === 0) {
    return 'network';
  }
  if (status === 401 || status === 403) {
    return 'authentication';
  }
  if (status === 400 || status === 404 || status === 422) {
    return 'validation';
  }
  if (status === 408 || status === 504) {
    return 'timeout';
  }
  if (status >= 500) {
    return 'server';
  }
  return 'server';
}

/** Check if the error response indicates an LLM provider failure. */
function isLlmError(payload: unknown): boolean {
  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    // LLM errors often have specific detail patterns or fields
    const detail = obj.detail;
    if (typeof detail === 'string') {
      const lower = detail.toLowerCase();
      if (
        lower.includes('openrouter') ||
        lower.includes('provider') ||
        lower.includes('model') ||
        lower.includes('llm') ||
        lower.includes('streaming') ||
        lower.includes('completion')
      ) {
        return true;
      }
    }
    // Check for fields related to LLM
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('model') ||
        lowerKey.includes('provider') ||
        lowerKey.includes('stream')
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Build the normalized ApiError for a failed HTTP response payload. */
export function normalizeApiError(status: number, payload: unknown): ApiError {
  const category = statusToCategory(status);

  if (payload !== null && typeof payload === 'object') {
    const fields: Record<string, string[]> = {};
    let detail: string | null = null;

    for (const [key, value] of Object.entries(payload)) {
      if (key === 'detail' && typeof value === 'string') {
        detail = value;
        continue;
      }
      if (typeof value === 'string') {
        fields[key] = [value];
      } else if (
        Array.isArray(value) &&
        value.every((item): item is string => typeof item === 'string')
      ) {
        fields[key] = value;
      }
    }

    const fieldMessages = Object.entries(fields).map(
      ([field, messages]) => `${field}: ${messages.join(' ')}`,
    );
    const message =
      detail ?? (fieldMessages.length > 0 ? fieldMessages.join('\n') : `Request failed (${status}).`);

    // Override category for LLM-specific errors
    let finalCategory = category;
    if (category === 'server' && isLlmError(payload)) {
      finalCategory = 'llm';
    }

    return new ApiError(status, message, fields, finalCategory);
  }

  return new ApiError(status, `Request failed (${status}).`, {}, category);
}
