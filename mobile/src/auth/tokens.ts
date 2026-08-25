/** Shared authentication types mirroring the backend API payloads. */

export interface AuthTokens {
  access: string;
  refresh: string;
}

export interface AuthUser {
  id: number;
  username: string;
  email: string;
}
