/**
 * Normalized LLM provider failures for serverless mode (SPEC TASK-083,
 * TASK-AUDIT-013).
 *
 * Mirrors the backend hierarchy in llm/exceptions.py so error handling is
 * uniform across modes AND providers. Every transport-, HTTP-, or
 * payload-level failure is translated into one of these classes before it
 * escapes the client (any provider: OpenRouter, Gemini, OpenAI, 9Router);
 * `retryable` marks failures where another attempt (or the next fallback
 * model) may succeed. Messages never contain the API key.
 *
 * The historic OpenRouter-branded names (OpenRouterError & friends) remain
 * exported as aliases of the same classes, so existing code — including
 * `instanceof` checks — keeps working unchanged.
 */

/** Base class for all normalized provider failures. */
export class LLMError extends Error {
  readonly model: string | null;
  readonly retryable: boolean;

  constructor(message: string, options?: {model?: string | null; retryable?: boolean}) {
    super(message);
    this.name = 'LLMError';
    this.model = options?.model ?? null;
    this.retryable = options?.retryable ?? false;
  }
}

/** Transport-level failure while contacting the provider (retryable). */
export class LLMRequestError extends LLMError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: true});
    this.name = 'LLMRequestError';
  }
}

/** Request exceeded its configured timeout (retryable). */
export class LLMTimeoutError extends LLMRequestError {
  constructor(message: string, model: string | null = null) {
    super(message, model);
    this.name = 'LLMTimeoutError';
  }
}

/** The provider rejected the user's API key (not retryable). */
export class LLMAuthenticationError extends LLMError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: false});
    this.name = 'LLMAuthenticationError';
  }
}

/** The provider rejected the request payload as invalid (not retryable). */
export class LLMBadRequestError extends LLMError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: false});
    this.name = 'LLMBadRequestError';
  }
}

/** Provider-side capacity or availability problem (retryable). */
export class LLMAvailabilityError extends LLMError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: true});
    this.name = 'LLMAvailabilityError';
  }
}

/** The provider returned a malformed or unusable response (not retryable). */
export class LLMResponseError extends LLMError {
  constructor(message: string, model: string | null = null) {
    super(message, {model, retryable: false});
    this.name = 'LLMResponseError';
  }
}

/** Historic OpenRouter-branded aliases — the exact same classes. */
export {LLMError as OpenRouterError};
export {LLMRequestError as OpenRouterRequestError};
export {LLMTimeoutError as OpenRouterTimeoutError};
export {LLMAuthenticationError as OpenRouterAuthenticationError};
export {LLMBadRequestError as OpenRouterBadRequestError};
export {LLMAvailabilityError as OpenRouterAvailabilityError};
export {LLMResponseError as OpenRouterResponseError};

/** Same status → failure mapping as backend llm/provider_errors.py. */
export function normalizeHttpFailure(
  status: number,
  message: string,
  model: string | null = null,
  providerLabel = 'OpenRouter',
): LLMError {
  if (status === 401 || status === 403) {
    return new LLMAuthenticationError(message || `${providerLabel} rejected the API key.`, model);
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new LLMBadRequestError(
      message || `${providerLabel} rejected the request (HTTP ${status}).`,
      model,
    );
  }
  if (status === 408) {
    return new LLMTimeoutError(message || `${providerLabel} request timed out.`, model);
  }
  if (status === 429 || status >= 500) {
    return new LLMAvailabilityError(
      message || `${providerLabel} is temporarily unavailable.`,
      model,
    );
  }
  return new LLMResponseError(`Unexpected HTTP ${status}: ${message}`, model);
}
