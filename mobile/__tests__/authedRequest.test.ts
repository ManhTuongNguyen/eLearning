/**
 * TASK-AUDIT-005 acceptance: the central one-time access-token refresh
 * wrapper. Exercises the framework-free `createAuthedRequester` directly
 * with a provider-shaped hook harness (single-flight refresh mirroring
 * AuthContext.refreshAccess) so the wrapper's own guarantees are judged in
 * isolation from React.
 */
import {createAuthedRequester} from '../src/auth/authedRequest';
import type {AuthedRequester, AuthedRequestOptions} from '../src/auth/authedRequest';
import {ApiError} from '../src/api/client';
import * as client from '../src/api/client';
import {setRuntimeApplicationMode} from '../src/mode/runtime';
import type {AuthTokens} from '../src/auth/tokens';

jest.mock('../src/api/client', () => ({
  ...jest.requireActual('../src/api/client'),
  apiRequest: jest.fn(),
}));

const mockedApiRequest = jest.mocked(client.apiRequest);

const TOKENS: AuthTokens = {access: 'access-1', refresh: 'refresh-1'};

function unauthorized(): ApiError {
  return new ApiError(401, 'Token is invalid or expired', {}, 'authentication');
}

/**
 * Session hooks shaped like AuthProvider's: tokens in a ref-like closure and
 * a single-flight refresh that swaps the access token on success and clears
 * the session when the refresh credentials are rejected.
 */
function makeHarness(initialTokens: AuthTokens | null = TOKENS) {
  let tokens = initialTokens;
  let inFlight: Promise<string | null> | null = null;
  const refreshFn = jest.fn(async (): Promise<string> => 'access-2');

  function refresh(): Promise<string | null> {
    if (inFlight) {
      return inFlight;
    }
    const current = tokens;
    if (!current) {
      return Promise.resolve(null);
    }
    const attempt = refreshFn()
      .then(async access => {
        tokens = {...current, access};
        return access;
      })
      .catch(async () => {
        tokens = null;
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = attempt;
    return attempt;
  }

  const authedRequest: AuthedRequester = createAuthedRequester({
    whenReady: async () => undefined,
    getTokens: () => tokens,
    refresh,
  });

  return {authedRequest, refreshFn, currentTokens: () => tokens};
}

beforeEach(() => {
  jest.clearAllMocks();
  // Server-transport tests: pin the runtime holder because fresh installs
  // now default to serverless.
  setRuntimeApplicationMode('server');
});

describe('authedRequest wrapper (TASK-AUDIT-005)', () => {
  it('executes a normal request with the current access token', async () => {
    const harness = makeHarness();
    mockedApiRequest.mockResolvedValue({level: 'B2'});

    await expect(
      harness.authedRequest<{level: string}>('/api/v1/profile/'),
    ).resolves.toEqual({level: 'B2'});

    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
    expect(mockedApiRequest).toHaveBeenCalledWith('/api/v1/profile/', {token: 'access-1'});
    expect(harness.refreshFn).not.toHaveBeenCalled();
  });

  it('retries the original request exactly once after a 401 refresh', async () => {
    const harness = makeHarness();
    mockedApiRequest
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce({level: 'A2'});
    const options: AuthedRequestOptions = {method: 'PATCH', body: {level: 'B1'}};

    await expect(
      harness.authedRequest<{level: string}>('/api/v1/profile/', options),
    ).resolves.toEqual({level: 'A2'});

    expect(harness.refreshFn).toHaveBeenCalledTimes(1);
    expect(mockedApiRequest).toHaveBeenCalledTimes(2);
    // The original request's path, method, and body are preserved on the
    // retry; only the access token is swapped for the refreshed one.
    expect(mockedApiRequest).toHaveBeenNthCalledWith(1, '/api/v1/profile/', {
      ...options,
      token: 'access-1',
    });
    expect(mockedApiRequest).toHaveBeenNthCalledWith(2, '/api/v1/profile/', {
      ...options,
      token: 'access-2',
    });
    expect(harness.currentTokens()).toEqual({access: 'access-2', refresh: 'refresh-1'});
  });

  it('ends the session and rethrows the original 401 when the refresh fails', async () => {
    const harness = makeHarness();
    mockedApiRequest.mockRejectedValue(unauthorized());
    harness.refreshFn.mockRejectedValue(new ApiError(401, 'Token is invalid or expired'));

    await expect(harness.authedRequest('/api/v1/profile/')).rejects.toMatchObject({
      status: 401,
    });

    expect(harness.refreshFn).toHaveBeenCalledTimes(1);
    // No retry after the refresh died, and the session was cleared.
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
    expect(harness.currentTokens()).toBeNull();
  });

  it('propagates the retried 401 without looping', async () => {
    const harness = makeHarness();
    mockedApiRequest.mockRejectedValue(unauthorized());

    await expect(harness.authedRequest('/api/v1/sessions/')).rejects.toMatchObject({
      status: 401,
    });

    // Exactly one refresh and two attempts: original + single retry.
    expect(harness.refreshFn).toHaveBeenCalledTimes(1);
    expect(mockedApiRequest).toHaveBeenCalledTimes(2);
  });

  it('surfaces non-authentication failures without refreshing', async () => {
    const harness = makeHarness();
    mockedApiRequest.mockRejectedValue(new ApiError(500, 'Server error.'));

    await expect(harness.authedRequest('/api/v1/sessions/')).rejects.toMatchObject({
      status: 500,
    });

    expect(harness.refreshFn).not.toHaveBeenCalled();
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects without any network work while signed out', async () => {
    const harness = makeHarness(null);

    await expect(harness.authedRequest('/api/v1/profile/')).rejects.toMatchObject({
      status: 401,
      message: 'You are signed out. Please log in again.',
    });

    expect(mockedApiRequest).not.toHaveBeenCalled();
    expect(harness.refreshFn).not.toHaveBeenCalled();
  });

  it('shares a single refresh across concurrent expired-token requests', async () => {
    const harness = makeHarness();
    let releaseRefresh!: (access: string) => void;
    const gated = new Promise<string>(resolve => {
      releaseRefresh = resolve;
    });
    harness.refreshFn.mockReturnValue(gated);
    // Every first attempt 401s; retries succeed once the refresh resolves.
    mockedApiRequest.mockImplementation(async (path, options) => {
      if (options?.token === 'access-1') {
        throw unauthorized();
      }
      return {path};
    });

    const first = harness.authedRequest('/api/v1/sessions/');
    const second = harness.authedRequest('/api/v1/profile/');
    const third = harness.authedRequest('/api/v1/vocabulary/');

    // Drain pending microtasks while the refresh is still held: all three
    // callers must be waiting on the SAME in-flight refresh.
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), 0);
    });
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), 0);
    });
    expect(harness.refreshFn).toHaveBeenCalledTimes(1);

    releaseRefresh('access-2');

    await Promise.all([
      expect(first).resolves.toEqual({path: '/api/v1/sessions/'}),
      expect(second).resolves.toEqual({path: '/api/v1/profile/'}),
      expect(third).resolves.toEqual({path: '/api/v1/vocabulary/'}),
    ]);
    // Three originals + three retries, but exactly one network refresh.
    expect(mockedApiRequest).toHaveBeenCalledTimes(6);
    expect(harness.currentTokens()).toEqual({access: 'access-2', refresh: 'refresh-1'});
  });
});
