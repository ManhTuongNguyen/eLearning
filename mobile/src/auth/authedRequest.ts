/**
 * Central one-time access-token refresh wrapper (TASK-AUDIT-005).
 *
 * Every authenticated backend request flows through here: the original
 * request executes, an expired/unauthorized access token (401) triggers one
 * shared refresh attempt, and the original request — retained whole as
 * path + options, so its method, URL, headers, body, and other options are
 * preserved — is retried exactly once with the fresh access token. A failed
 * refresh ends the local session (the provider clears credentials and the
 * root navigator returns to Login) and the original 401 propagates. The
 * retry result is returned or thrown directly, so no infinite retry loop is
 * possible, and the single-flight refresh hook keeps concurrent 401 arrivals
 * to one network refresh.
 *
 * The module is framework-free: AuthProvider supplies the session hooks
 * (restore gate, token source, refresh), screens and endpoint bindings only
 * ever see the `AuthedRequester` callable.
 */
import {apiRequest, ApiError} from '../api/client';
import type {RequestOptions} from '../api/client';
import {assertServerApiAllowed} from '../mode/runtime';
import type {AuthTokens} from './tokens';

/** Options for an authenticated request; the Bearer token is managed centrally. */
export type AuthedRequestOptions = Omit<RequestOptions, 'token'>;

/**
 * Authenticated request executor. Throws the normalized ApiError of the
 * last attempt — the original 401 when the session could not be recovered.
 */
export type AuthedRequester = <T>(
  path: string,
  options?: AuthedRequestOptions,
) => Promise<T>;

/** Session hooks the wrapper needs from the authentication provider. */
export interface AuthedRequestHooks {
  /**
   * Resolves once the initial session restore has settled, so callers never
   * race the startup token read.
   */
  whenReady(): Promise<void>;
  /** Current stored tokens, or null while signed out. */
  getTokens(): AuthTokens | null;
  /**
   * Single-flight access-token refresh: resolves the fresh access token, or
   * null once the session was ended locally because the refresh credentials
   * were rejected. Concurrent callers share the in-flight attempt.
   */
  refresh(): Promise<string | null>;
}

/** Build the central authenticated requester over the given session hooks. */
export function createAuthedRequester(hooks: AuthedRequestHooks): AuthedRequester {
  return async function authedRequest<T>(
    path: string,
    options: AuthedRequestOptions = {},
  ): Promise<T> {
    // Serverless mode never talks to backend endpoints (SPEC TASK-080): the
    // gate fires before any auth or transport work so local data cannot leak
    // out — and in serverless the typed ServerApiBlockedError surfaces even
    // while signed out.
    assertServerApiAllowed();
    await hooks.whenReady();
    const tokens = hooks.getTokens();
    if (!tokens) {
      throw new ApiError(401, 'You are signed out. Please log in again.');
    }
    try {
      return await apiRequest<T>(path, {...options, token: tokens.access});
    } catch (err) {
      // Only an authentication failure triggers transparent re-auth;
      // network/validation/server errors surface untouched.
      if (!(err instanceof ApiError) || err.status !== 401) {
        throw err;
      }
      const access = await hooks.refresh();
      if (!access) {
        // Session ended locally (root navigator is back at Login);
        // surface the original authentication failure.
        throw err;
      }
      // A single retry; a still-failing retry propagates without looping.
      return apiRequest<T>(path, {...options, token: access});
    }
  };
}
