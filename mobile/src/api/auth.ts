/** Authentication endpoint bindings. */

import {apiRequest} from './client';
import type {AuthTokens, AuthUser} from '../auth/tokens';

export interface LoginResponse extends AuthTokens {
  user: AuthUser;
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
}

export function register(input: RegisterInput): Promise<AuthUser> {
  return apiRequest<AuthUser>('/api/v1/auth/register/', {
    method: 'POST',
    body: input,
  });
}

/** Login with either username or email as the identifier. */
export function login(identifier: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/api/v1/auth/login/', {
    method: 'POST',
    body: {username: identifier, password},
  });
}

export function refreshAccessToken(refresh: string): Promise<Pick<AuthTokens, 'access'>> {
  return apiRequest<Pick<AuthTokens, 'access'>>('/api/v1/auth/refresh/', {
    method: 'POST',
    body: {refresh},
  });
}

export function getMe(token: string): Promise<AuthUser> {
  return apiRequest<AuthUser>('/api/v1/auth/me/', {token});
}

/** Invalidate the refresh token server-side. */
export function logout(tokens: AuthTokens): Promise<void> {
  return apiRequest<{detail: string}>('/api/v1/auth/logout/', {
    method: 'POST',
    body: {refresh: tokens.refresh},
    token: tokens.access,
  }).then(() => undefined);
}
