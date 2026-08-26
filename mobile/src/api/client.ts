/** HTTP client for the backend API with normalized error handling. */

import {API_BASE_URL} from '../config';

/** Normalized API failure carrying the HTTP status and DRF field errors. */
export class ApiError extends Error {
  readonly status: number;
  readonly fields: Readonly<Record<string, readonly string[]>>;

  constructor(status: number, message: string, fields?: Record<string, string[]>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields ?? {};
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
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
  } catch {
    throw new ApiError(0, 'Network request failed. Check your connection and try again.');
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    throw normalizeError(response.status, payload);
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

function normalizeError(status: number, payload: unknown): ApiError {
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
    return new ApiError(status, message, fields);
  }

  return new ApiError(status, `Request failed (${status}).`);
}
