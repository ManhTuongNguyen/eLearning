/**
 * Configuration module tests (TASK-AUDIT-010): the backend base URL is
 * environment-driven (react-native-dotenv `@env` import) — never hard-coded
 * in application source — and the resolver validates raw values with an
 * actionable error instead of letting misconfiguration surface as a
 * confusing fetch failure.
 */
import {API_BASE_URL, resolveApiBaseUrl} from '../src/config';

describe('config (TASK-AUDIT-010)', () => {
  describe('API_BASE_URL', () => {
    it('uses the committed .env.test mock URL, not a hard-coded value in source', () => {
      // Jest runs with NODE_ENV=test, so the babel plugin loads .env.test on
      // top of .env. Pinning the value here keeps the test-environment
      // contract explicit (see .env.test; update both together).
      expect(API_BASE_URL).toBe('http://test.local:8000');
    });

    it('is a normalised http(s) URL without a trailing slash', () => {
      expect(API_BASE_URL).toMatch(/^https?:\/\//);
      expect(API_BASE_URL.endsWith('/')).toBe(false);
    });
  });

  describe('resolveApiBaseUrl', () => {
    it('accepts and trims a valid http(s) URL', () => {
      expect(resolveApiBaseUrl('  http://10.0.2.2:8000  ')).toBe(
        'http://10.0.2.2:8000',
      );
      expect(resolveApiBaseUrl('https://api.example.com')).toBe(
        'https://api.example.com',
      );
    });

    it('strips trailing slashes so API paths join cleanly', () => {
      expect(resolveApiBaseUrl('http://10.0.2.2:8000/')).toBe(
        'http://10.0.2.2:8000',
      );
      expect(resolveApiBaseUrl('http://10.0.2.2:8000///')).toBe(
        'http://10.0.2.2:8000',
      );
    });

    it('rejects missing, empty, and non-http values with an actionable error', () => {
      for (const bad of [undefined, '', '   ', '10.0.2.2:8000', 'ftp://host']) {
        expect(() => resolveApiBaseUrl(bad)).toThrow(
          'API_BASE_URL is not configured',
        );
      }
    });
  });
});
