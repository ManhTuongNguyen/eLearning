/**
 * Serverless OpenRouter settings tests (SPEC TASK-111).
 *
 * Covers the direct-OpenRouter configuration seam of serverless mode
 * (TASK-088/092/093/094) against a real in-memory SQLite database (sql.js)
 * and the mocked keychain/AsyncStorage stores:
 * - the API key lives ONLY in the keychain, never in the local database
 * - the primary/fallback model identifiers live in the settings table
 * - load/save/clear assemble and tear down the full OpenRouterClientConfig
 * - clearAllServerlessData wipes every serverless trace while leaving
 *   authentication tokens untouched
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import {openLocalDatabase} from '../src/db/database';
import type {SqlDriver} from '../src/db/driver';
import {insertSession, listSessions} from '../src/db/sessionStore';
import {getSetting, setSetting} from '../src/db/settingsStore';
import {loadServerlessApiKey, saveServerlessApiKey} from '../src/serverless/secureApiKey';
import {
  clearAllServerlessData,
  clearServerlessOpenRouterConfig,
  isServerlessOpenRouterConfigured,
  loadServerlessOpenRouterConfig,
  saveServerlessOpenRouterConfig,
} from '../src/serverless/settings';
import {openSqlJsDriver} from '../testing/sqlJsDriver';

let mockDb: SqlDriver;

jest.mock('../src/db/database', () => {
  const actual = jest.requireActual('../src/db/database');
  return {
    ...actual,
    // settings.ts and clearLocalData.ts resolve the shared database
    // implicitly; route both to the per-test sql.js instance below.
    getLocalDatabase: () => Promise.resolve(mockDb),
    resetLocalDatabase: () => {},
  };
});

const mockedKeychain = Keychain as jest.Mocked<typeof Keychain> & {
  __resetKeychainStore: () => void;
};
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

const SECRET = 'sk-or-v1-serverless-config-secret';
const AUTH_TOKEN = 'auth-token-should-not-be-cleared';

describe('serverless OpenRouter settings (TASK-111)', () => {
  beforeAll(async () => {
    mockDb = await openLocalDatabase(() => openSqlJsDriver());
  });

  afterAll(async () => {
    await mockDb.close();
  });

  beforeEach(async () => {
    mockedKeychain.__resetKeychainStore();
    asyncStorage.__resetAsyncStorageStore();
    jest.clearAllMocks();
    await mockDb.execute('DELETE FROM settings');
    await mockDb.execute('DELETE FROM sessions');
  });

  describe('loadServerlessOpenRouterConfig', () => {
    test('resolves null while no API key is stored', async () => {
      await setSetting(mockDb, 'serverless_primary_model', 'vendor/model-a');

      await expect(loadServerlessOpenRouterConfig()).resolves.toBeNull();
    });

    test('resolves null while the primary model is missing', async () => {
      await saveServerlessApiKey(SECRET);

      await expect(loadServerlessOpenRouterConfig()).resolves.toBeNull();
    });

    test('assembles key, primary model and trimmed fallback models', async () => {
      await saveServerlessApiKey(SECRET);
      await setSetting(mockDb, 'serverless_primary_model', 'vendor/model-a');
      await setSetting(mockDb, 'serverless_fallback_models', ' vendor/model-b ,, vendor/model-c , ');

      await expect(loadServerlessOpenRouterConfig()).resolves.toEqual({
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
        fallbackModels: ['vendor/model-b', 'vendor/model-c'],
      });
    });

    test('returns an empty fallback list when none are configured', async () => {
      await saveServerlessApiKey(SECRET);
      await setSetting(mockDb, 'serverless_primary_model', 'vendor/model-a');

      const config = await loadServerlessOpenRouterConfig();

      expect(config?.fallbackModels).toEqual([]);
    });
  });

  describe('saveServerlessOpenRouterConfig', () => {
    test('stores the key in the keychain and the models in the settings table', async () => {
      await saveServerlessOpenRouterConfig({
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
        fallbackModels: ['vendor/model-b', 'vendor/model-c'],
      });

      await expect(loadServerlessApiKey()).resolves.toBe(SECRET);
      expect(await getSetting(mockDb, 'serverless_primary_model')).toBe('vendor/model-a');
      expect(await getSetting(mockDb, 'serverless_fallback_models')).toBe(
        'vendor/model-b,vendor/model-c',
      );
    });

    test('never writes the API key into the local database', async () => {
      await saveServerlessOpenRouterConfig({
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
        fallbackModels: ['vendor/model-b'],
      });

      const rows = await mockDb.execute('SELECT key FROM settings');
      expect(rows.rows.map(row => String(row.key)).sort()).toEqual([
        'serverless_fallback_models',
        'serverless_primary_model',
      ]);
    });

    test('round-trips through load and overwrites a previous configuration', async () => {
      await saveServerlessOpenRouterConfig({
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
      });
      await saveServerlessOpenRouterConfig({
        apiKey: 'sk-or-v1-replaced-key',
        primaryModel: 'vendor/model-z',
        fallbackModels: ['vendor/model-y'],
      });

      await expect(loadServerlessOpenRouterConfig()).resolves.toEqual({
        apiKey: 'sk-or-v1-replaced-key',
        primaryModel: 'vendor/model-z',
        fallbackModels: ['vendor/model-y'],
      });
    });
  });

  describe('clearServerlessOpenRouterConfig', () => {
    test('clears the key and both model settings but keeps unrelated settings', async () => {
      await saveServerlessOpenRouterConfig({
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
        fallbackModels: ['vendor/model-b'],
      });
      await setSetting(mockDb, 'unrelated_setting', 'stays');

      await clearServerlessOpenRouterConfig();

      await expect(loadServerlessApiKey()).resolves.toBeNull();
      expect(await getSetting(mockDb, 'serverless_primary_model')).toBeNull();
      expect(await getSetting(mockDb, 'serverless_fallback_models')).toBeNull();
      expect(await getSetting(mockDb, 'unrelated_setting')).toBe('stays');
    });
  });

  describe('isServerlessOpenRouterConfigured', () => {
    test('tracks the configuration lifecycle', async () => {
      await expect(isServerlessOpenRouterConfigured()).resolves.toBe(false);

      await saveServerlessOpenRouterConfig({apiKey: SECRET, primaryModel: 'vendor/model-a'});
      await expect(isServerlessOpenRouterConfigured()).resolves.toBe(true);

      await clearServerlessOpenRouterConfig();
      await expect(isServerlessOpenRouterConfigured()).resolves.toBe(false);
    });

    test('is false when only a key without a primary model exists', async () => {
      await saveServerlessApiKey(SECRET);

      await expect(isServerlessOpenRouterConfigured()).resolves.toBe(false);
    });
  });

  describe('clearAllServerlessData', () => {
    test('wipes conversations, settings and the key but keeps auth tokens', async () => {
      await asyncStorage.setItem('auth_token', AUTH_TOKEN);
      await saveServerlessOpenRouterConfig({
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
        fallbackModels: ['vendor/model-b'],
      });
      await insertSession(mockDb, {title: 'Local chat'});

      await clearAllServerlessData();

      expect(await listSessions(mockDb)).toEqual([]);
      await expect(loadServerlessApiKey()).resolves.toBeNull();
      expect(await getSetting(mockDb, 'serverless_primary_model')).toBeNull();
      expect(await getSetting(mockDb, 'serverless_fallback_models')).toBeNull();
      await expect(asyncStorage.getItem('auth_token')).resolves.toBe(AUTH_TOKEN);
    });
  });
});
