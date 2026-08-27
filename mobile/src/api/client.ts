/** HTTP client for the backend API with normalized error handling. */

import {assertServerApiAllowed} from '../mode/runtime';
import {API_BASE_URL} from '../config';

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
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // Serverless mode never talks to backend endpoints (SPEC TASK-080): the
  // gate fires before any request is opened so local data cannot leak out.
  assertServerApiAllowed();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (err) {
    // Distinguish timeout from general network failure when possible.
    const isTimeout =
      err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('timeout'));
    if (isTimeout) {
      throw new ApiError(0, 'The request timed out. Please try again.', {}, 'timeout');
    }
    throw new ApiError(0, 'Network request failed. Check your connection and try again.', {}, 'network');
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
