/** Application authentication state backed by secure token storage. */
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
import {clearTokens, loadTokens, saveTokens} from './secureStorage';
import type {AuthTokens, AuthUser} from './tokens';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  busy: boolean;
  /** Current access token for authenticated API calls once restored. */
  getAccessToken(): Promise<string | null>;
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
  const tokensRef = useRef<AuthTokens | null>(null);
  const restorePromiseRef = useRef<Promise<void> | null>(null);
  const restoreResolverRef = useRef<(() => void) | null>(null);
  // Resolves once the initial session restore has finished, so late callers
  // (e.g. screens mounted alongside the provider) read a settled token state.
  if (!restorePromiseRef.current) {
    restorePromiseRef.current = new Promise<void>(resolve => {
      restoreResolverRef.current = resolve;
    });
  }

  const tryRefreshSession = useCallback(
    async (tokens: AuthTokens): Promise<AuthUser | null> => {
      try {
        const {access} = await authApi.refreshAccessToken(tokens.refresh);
        const nextTokens = {...tokens, access};
        tokensRef.current = nextTokens;
        await saveTokens(nextTokens);
        return await authApi.getMe(access);
      } catch {
        return null;
      }
    },
    [],
  );

  useEffect(() => {
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
          // Access token expired or revoked: fall back to a single refresh.
          const restored = await tryRefreshSession(tokens);
          if (!cancelled) {
            if (restored) {
              setUser(restored);
              setStatus('authenticated');
            } else {
              await clearTokens();
              tokensRef.current = null;
              setStatus('unauthenticated');
            }
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
  }, [tryRefreshSession]);

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
      login,
      register,
      logout,
    }),
    [status, user, error, busy, login, register, logout],
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
    if (err.status === 0 || err.status >= 500) {
      return 'The server is unreachable right now. Please try again later.';
    }
    return err.message;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}
