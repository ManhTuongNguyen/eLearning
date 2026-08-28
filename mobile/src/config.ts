/**
 * Application-wide configuration.
 *
 * Values come from `.env` files, inlined at build time by the
 * react-native-dotenv babel plugin (mobile/babel.config.js) — never
 * hard-coded in application source. See mobile/.env.example for the
 * supported variables and how the mode files are selected:
 * .env (base) -> .env.<mode>, where mode is development (debug bundles),
 * test (jest) or production (release bundles).
 */
import {API_BASE_URL as API_BASE_URL_FROM_ENV} from '@env';

/**
 * Validate a raw environment value and narrow it to a defined URL string.
 *
 * The babel plugin fails the bundle when `allowUndefined: false` and the
 * variable is missing entirely; this guard additionally rejects empty or
 * malformed values with an actionable message instead of a confusing fetch
 * failure at first request, and strips trailing slashes so API paths join
 * cleanly regardless of how the URL was written.
 */
export function resolveApiBaseUrl(raw: string | undefined): string {
  const value = raw?.trim().replace(/\/+$/, '');
  if (!value || !/^https?:\/\//.test(value)) {
    throw new Error(
      'API_BASE_URL is not configured. Copy .env.example to .env and set ' +
        'API_BASE_URL to the backend base URL (see .env.example).',
    );
  }
  return value;
}

export const API_BASE_URL: string = resolveApiBaseUrl(API_BASE_URL_FROM_ENV);
