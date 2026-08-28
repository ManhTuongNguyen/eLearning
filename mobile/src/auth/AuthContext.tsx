/**
 * Application authentication state backed by secure token storage.
 *
 * Owns the full session lifecycle: startup restore, login/register/logout,
 * and (TASK-047) mid-session transparent re-auth — `authedRequest` retries
 * once after a single-flight access-token refresh when the backend answers
 * 401, and ends the local session (returning the user to Login via
 * RootNavigator) when refresh credentials are no longer accepted.
 *
 * The startup restore is application-mode aware (TASK-AUDIT-003): while
 * serverless mode is active it is skipped entirely, so initializing the
 * serverless app never reads credentials or contacts the backend; stored
 * credentials are left untouched for a later switch back to server mode.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import * as authApi from '../api/auth';
import type {RegisterInput} from '../api/auth';
import {ApiError} from '../api/client';
import {createAuthedRequester} from './authedRequest';
import type {AuthedRequestOptions} from './authedRequest';
import {useOptionalApplicationMode} from '../mode/ModeContext';
import {clearTokens, loadTokens, saveTokens} from './secureStorage';
import type {AuthTokens, AuthUser} from './tokens';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/** Options for authenticated requests; the Bearer token is managed centrally. */
export type AuthorizedRequestOptions = AuthedRequestOptions;

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  busy: boolean;
  /** Current access token for authenticated API calls once restored. */
  getAccessToken(): Promise<string | null>;
  /**
   * Authenticated API request with transparent re-auth: a 401 triggers one
   * shared refresh attempt and a single retry; an unusable refresh ends the
   * session locally and rethrows the original error.
   */
  authedRequest<T>(path: string, options?: AuthorizedRequestOptions): Promise<T>;
  login(identifier: string, password: string): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({children}: {children: React.ReactNode}) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Application mode (TASK-AUDIT-003): serverless is independent of server
  // authentication, so the session restore waits for the mode to settle and
  // is skipped entirely while serverless — no keychain reads and no backend
  // requests are made merely to initialize the serverless application.
  const applicationMode = useOptionalApplicationMode();
  const tokensRef = useRef<AuthTokens | null>(null);
  const restorePromiseRef = useRef<Promise<void> | null>(null);
  const restoreResolverRef = useRef<(() => void) | null>(null);
  // In-flight refresh shared by every 401 arrival so concurrent callers
  // trigger exactly one network refresh.
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);
  // Resolves once the initial session restore has finished, so late callers
  // (e.g. screens mounted alongside the provider) read a settled token state.
  if (!restorePromiseRef.current) {
    restorePromiseRef.current = new Promise<void>(resolve => {
      restoreResolverRef.current = resolve;
    });
  }

  /**
   * Single-flight access-token refresh. Resolves the new access token, or
   * null once the session was ended locally because the refresh credentials
   * were rejected (tokens cleared, status back to unauthenticated).
   */
  const refreshAccess = useCallback(async (): Promise<string | null> => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }
    const current = tokensRef.current;
    if (!current) {
      return null;
    }
    const attempt = authApi
      .refreshAccessToken(current.refresh)
      .then(async ({access}) => {
        const nextTokens = {...current, access};
        tokensRef.current = nextTokens;
        await saveTokens(nextTokens);
        return access;
      })
      .catch(async () => {
        await clearTokens();
        tokensRef.current = null;
        setUser(null);
        setStatus('unauthenticated');
        return null;
      })
      .finally(() => {
        refreshPromiseRef.current = null;
      });
    refreshPromiseRef.current = attempt;
    return attempt;
  }, []);

  useEffect(() => {
    // Until the persisted mode is known the restore decision cannot be made;
    // RootNavigator keeps showing the splash during this window.
    if (applicationMode && applicationMode.status === 'loading') {
      return undefined;
    }
    if (applicationMode && applicationMode.mode === 'serverless') {
      // Serverless initialization never touches server authentication.
      // Existing credentials stay stored so switching back to server mode
      // can restore the normal session flow.
      setStatus(prev => (prev === 'loading' ? 'unauthenticated' : prev));
      restoreResolverRef.current?.();
      return undefined;
    }
    let cancelled = false;

    async function restore() {
      try {
        const tokens = await loadTokens();
        if (!tokens) {
          if (!cancelled) {
            setStatus('unauthenticated');
          }
          return;
        }
        tokensRef.current = tokens;
        try {
          const me = await authApi.getMe(tokens.access);
          if (!cancelled) {
            setUser(me);
            setStatus('authenticated');
          }
        } catch {
          // Access token expired or revoked: fall back to one shared refresh.
          const access = await refreshAccess();
          if (!cancelled && access) {
            try {
              setUser(await authApi.getMe(access));
              setStatus('authenticated');
            } catch {
              await clearTokens();
              tokensRef.current = null;
              if (!cancelled) {
                setUser(null);
                setStatus('unauthenticated');
              }
            }
          } else if (!cancelled) {
            // Credentials were already cleared by refreshAccess.
            setStatus('unauthenticated');
          }
        }
      } finally {
        // Settle even on unmount so awaited callers never hang.
        restoreResolverRef.current?.();
      }
    }

    restore();
    return () => {
      cancelled = true;
    };
  }, [applicationMode, refreshAccess]);

  const applyLoginResponse = useCallback(async (response: authApi.LoginResponse) => {
    const tokens: AuthTokens = {access: response.access, refresh: response.refresh};
    tokensRef.current = tokens;
    await saveTokens(tokens);
    setUser(response.user);
    setStatus('authenticated');
  }, []);

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (err) {
        setError(toErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const login = useCallback(
    (identifier: string, password: string) =>
      runAction(async () => {
        const response = await authApi.login(identifier, password);
        await applyLoginResponse(response);
      }),
    [applyLoginResponse, runAction],
  );

  const register = useCallback(
    (input: RegisterInput) =>
      runAction(async () => {
        await authApi.register(input);
        // Auto-login after successful registration for a smooth first run.
        const response = await authApi.login(input.username, input.password);
        await applyLoginResponse(response);
      }),
    [applyLoginResponse, runAction],
  );

  const logout = useCallback(
    () =>
      runAction(async () => {
        const tokens = tokensRef.current;
        tokensRef.current = null;
        if (tokens) {
          // Server-side invalidation is best-effort; always end locally.
          try {
            await authApi.logout(tokens);
          } catch {
            // Ignore network/auth failures during logout.
          }
        }
        await clearTokens();
        setUser(null);
        setStatus('unauthenticated');
      }),
    [runAction],
  );

  const authedRequest = useMemo(
    // TASK-AUDIT-005: the request flow itself lives in the central
    // authedRequest module; the provider only supplies session hooks.
    () =>
      createAuthedRequester({
        // The restore promise is created during the first render, before any
        // request can run, so awaiting it here always observes a promise.
        whenReady: async () => {
          await restorePromiseRef.current;
        },
        getTokens: () => tokensRef.current,
        refresh: refreshAccess,
      }),
    [refreshAccess],
  );

  const value = useMemo(
    () => ({
      status,
      user,
      error,
      busy,
      getAccessToken: async () => {
        await restorePromiseRef.current;
        return tokensRef.current?.access ?? null;
      },
      authedRequest,
      login,
      register,
      logout,
    }),
    [status, user, error, busy, authedRequest, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.category) {
      case 'network':
        return 'Network connection failed. Check your internet and try again.';
      case 'timeout':
        return 'The request timed out. Please try again.';
      case 'authentication':
        return err.message || 'Your session has expired. Please log in again.';
      case 'validation':
        return err.message || 'Invalid input. Please check your data and try again.';
      case 'llm':
        return 'The AI service is temporarily unavailable. Please try again in a moment.';
      case 'server':
      default:
        if (err.status === 0 || err.status >= 500) {
          return 'The server is unreachable right now. Please try again later.';
        }
        return err.message;
    }
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}
