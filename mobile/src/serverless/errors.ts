/**
 * Normalized OpenRouter failures for serverless mode (SPEC TASK-083).
 *
 * Mirrors the backend hierarchy in llm/exceptions.py so error handling is
 * uniform across modes. Every transport-, HTTP-, or payload-level failure is
 * translated into one of these classes before it escapes the client;
 * `retryable` marks failures where another attempt (or the next fallback
 * model) may succeed. Messages never contain the API key.
 */

/** Base class for all normalized OpenRouter failures. */
export class OpenRouterError extends Error {
  readonly model: string | null;
  readonly retryable: boolean;

  constructor(message: string, options?: {model?: string | null; retryable?: boolean}) {
    super(message);
    this.name = 'OpenRouterError';
    this.model = options?.model ?? null;
    this.retryable = options?.retryable ?? false;
  }
}

/** Transport-level failure while contacting OpenRouter (retryable). */
export class OpenRouterRequestError extends OpenRouterError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: true});
    this.name = 'OpenRouterRequestError';
  }
}

/** Request exceeded its configured timeout (retryable). */
export class OpenRouterTimeoutError extends OpenRouterRequestError {
  constructor(message: string, model: string | null = null) {
    super(message, model);
    this.name = 'OpenRouterTimeoutError';
  }
}

/** OpenRouter rejected the user's API key (not retryable). */
export class OpenRouterAuthenticationError extends OpenRouterError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: false});
    this.name = 'OpenRouterAuthenticationError';
  }
}

/** OpenRouter rejected the request payload as invalid (not retryable). */
export class OpenRouterBadRequestError extends OpenRouterError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: false});
    this.name = 'OpenRouterBadRequestError';
  }
}

/** Provider-side capacity or availability problem (retryable). */
export class OpenRouterAvailabilityError extends OpenRouterError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: true});
    this.name = 'OpenRouterAvailabilityError';
  }
}

/** OpenRouter returned a malformed or unusable response (not retryable). */
export class OpenRouterResponseError extends OpenRouterError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: false});
    this.name = 'OpenRouterResponseError';
  }
}

/** Same status → failure mapping as backend llm/openrouter.py `_http_failure`. */
export function normalizeHttpFailure(
  status: number,
  message: string,
  model: string | null = null,
): OpenRouterError {
  if (status === 401 || status === 403) {
    return new OpenRouterAuthenticationError(message || 'OpenRouter rejected the API key.', model);
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new OpenRouterBadRequestError(message || `OpenRouter rejected the request (HTTP ${status}).`, model);
  }
  if (status === 408) {
    return new OpenRouterTimeoutError(message || 'OpenRouter request timed out.', model);
  }
  if (status === 429 || status >= 500) {
    return new OpenRouterAvailabilityError(message || 'OpenRouter is temporarily unavailable.', model);
  }
  return new OpenRouterResponseError(`Unexpected HTTP ${status}: ${message}`, model);
}
