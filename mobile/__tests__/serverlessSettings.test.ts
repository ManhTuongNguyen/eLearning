/**
 * Serverless provider settings tests (SPEC TASK-111, TASK-AUDIT-013).
 *
 * Covers the direct-provider configuration seam of serverless mode
 * (TASK-088/092/093/094/013) against a real in-memory SQLite database
 * (sql.js) and the mocked keychain/AsyncStorage stores:
 * - the API key lives ONLY in the keychain, never in the local database,
 *   namespaced per provider
 * - the active provider and per-provider primary/fallback model
 *   identifiers live in the settings table
 * - load/save/clear assemble and tear down the full LLMClientConfig
 * - switching providers never mixes keys, models or namespaces
 * - clearAllServerlessData wipes every serverless trace while leaving
 *   authentication tokens untouched
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import {openLocalDatabase} from '../src/db/database';
import type {SqlDriver} from '../src/db/driver';
import {insertSession, listSessions} from '../src/db/sessionStore';
import {getSetting, setSetting} from '../src/db/settingsStore';
import {
  clearServerlessApiKey,
  loadServerlessApiKey,
  saveServerlessApiKey,
} from '../src/serverless/secureApiKey';
import {
  clearAllServerlessData,
  clearServerlessOpenRouterConfig,
  fallbackModelsSettingKey,
  isServerlessOpenRouterConfigured,
  loadServerlessOpenRouterConfig,
  loadServerlessProvider,
  loadServerlessProviderState,
  primaryModelSettingKey,
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
const GEMINI_SECRET = 'AIza-gemini-serverless-config-secret';
const AUTH_TOKEN = 'auth-token-should-not-be-cleared';

describe('serverless provider settings (TASK-111, TASK-AUDIT-013)', () => {
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

    test('assembles provider, key, primary model and trimmed fallback models', async () => {
      await saveServerlessApiKey(SECRET);
      await setSetting(mockDb, 'serverless_primary_model', 'vendor/model-a');
      await setSetting(mockDb, 'serverless_fallback_models', ' vendor/model-b ,, vendor/model-c , ');

      await expect(loadServerlessOpenRouterConfig()).resolves.toEqual({
        provider: 'openrouter',
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

    test('loads the active provider configuration from its namespace', async () => {
      await saveServerlessOpenRouterConfig({
        provider: 'gemini',
        apiKey: GEMINI_SECRET,
        primaryModel: 'gemini-2.0-flash',
        fallbackModels: ['gemini-1.5-pro'],
      });

      await expect(loadServerlessOpenRouterConfig()).resolves.toEqual({
        provider: 'gemini',
        apiKey: GEMINI_SECRET,
        primaryModel: 'gemini-2.0-flash',
        fallbackModels: ['gemini-1.5-pro'],
      });
    });

    test('is provider-scoped: a stored OpenRouter key does not satisfy Gemini', async () => {
      await saveServerlessApiKey(SECRET, 'openrouter');
      await setSetting(mockDb, 'serverless_primary_model', 'vendor/model-a');
      await setSetting(mockDb, 'serverless_provider', 'gemini');
      await setSetting(mockDb, 'serverless_primary_model_gemini', 'gemini-2.0-flash');

      await expect(loadServerlessOpenRouterConfig()).resolves.toBeNull();
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
      expect(await getSetting(mockDb, 'serverless_provider')).toBe('openrouter');
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
        'serverless_provider',
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
        provider: 'openrouter',
        apiKey: 'sk-or-v1-replaced-key',
        primaryModel: 'vendor/model-z',
        fallbackModels: ['vendor/model-y'],
      });
    });

    test('namespaces non-default providers away from the historic OpenRouter keys', async () => {
      await saveServerlessOpenRouterConfig({
        provider: 'openrouter',
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
      });
      await saveServerlessOpenRouterConfig({
        provider: 'gemini',
        apiKey: GEMINI_SECRET,
        primaryModel: 'gemini-2.0-flash',
      });

      // The OpenRouter namespace keeps the historic (unsuffixed) keys.
      expect(await getSetting(mockDb, 'serverless_primary_model')).toBe('vendor/model-a');
      // The Gemini namespace uses suffixed keys and its own keychain entry.
      expect(await getSetting(mockDb, 'serverless_primary_model_gemini')).toBe(
        'gemini-2.0-flash',
      );
      await expect(loadServerlessApiKey('openrouter')).resolves.toBe(SECRET);
      await expect(loadServerlessApiKey('gemini')).resolves.toBe(GEMINI_SECRET);
      // The persisted active provider follows the most recent save.
      await expect(loadServerlessProvider()).resolves.toBe('gemini');
    });

    test('switching providers never mixes primary models across namespaces', async () => {
      await saveServerlessOpenRouterConfig({
        provider: 'openrouter',
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
        fallbackModels: ['vendor/model-b'],
      });
      await saveServerlessOpenRouterConfig({
        provider: 'gemini',
        apiKey: GEMINI_SECRET,
        primaryModel: 'gemini-2.0-flash',
      });

      await expect(loadServerlessOpenRouterConfig()).resolves.toMatchObject({
        provider: 'gemini',
        primaryModel: 'gemini-2.0-flash',
      });

      // Saving OpenRouter again restores its own stored models.
      await saveServerlessOpenRouterConfig({
        provider: 'openrouter',
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
        fallbackModels: ['vendor/model-b'],
      });
      await expect(loadServerlessOpenRouterConfig()).resolves.toMatchObject({
        provider: 'openrouter',
        primaryModel: 'vendor/model-a',
        fallbackModels: ['vendor/model-b'],
      });
    });

    test('rejects unknown provider ids', async () => {
      await expect(
        saveServerlessOpenRouterConfig({
          provider: 'not-a-provider' as never,
          apiKey: SECRET,
          primaryModel: 'vendor/model-a',
        }),
      ).rejects.toThrow(/Unknown serverless provider/);
    });
  });

  describe('loadServerlessProviderState', () => {
    test('returns partial state without requiring a complete configuration', async () => {
      await saveServerlessApiKey(SECRET, 'gemini');

      await expect(loadServerlessProviderState('gemini')).resolves.toEqual({
        apiKey: SECRET,
        primaryModel: null,
        fallbackModels: [],
      });
    });

    test('reads models from the provider-specific settings namespace', async () => {
      await saveServerlessApiKey(SECRET, 'openai');
      await setSetting(mockDb, 'serverless_primary_model_openai', 'gpt-4o-mini');
      await setSetting(mockDb, 'serverless_fallback_models_openai', 'gpt-4o, o4-mini');

      await expect(loadServerlessProviderState('openai')).resolves.toEqual({
        apiKey: SECRET,
        primaryModel: 'gpt-4o-mini',
        fallbackModels: ['gpt-4o', 'o4-mini'],
      });
    });

    test('resolves nulls when nothing is stored for the provider', async () => {
      await expect(loadServerlessProviderState('ninerouter')).resolves.toEqual({
        apiKey: null,
        primaryModel: null,
        fallbackModels: [],
      });
    });
  });

  describe('settings key namespacing', () => {
    test('keeps the historic unsuffixed keys for OpenRouter only', () => {
      expect(primaryModelSettingKey('openrouter')).toBe('serverless_primary_model');
      expect(fallbackModelsSettingKey('openrouter')).toBe('serverless_fallback_models');
      expect(primaryModelSettingKey('gemini')).toBe('serverless_primary_model_gemini');
      expect(fallbackModelsSettingKey('ninerouter')).toBe(
        'serverless_fallback_models_ninerouter',
      );
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
      expect(await getSetting(mockDb, 'serverless_provider')).toBeNull();
      expect(await getSetting(mockDb, 'unrelated_setting')).toBe('stays');
    });

    test('clears only the active provider namespace', async () => {
      await saveServerlessOpenRouterConfig({
        provider: 'openrouter',
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
      });
      await saveServerlessOpenRouterConfig({
        provider: 'gemini',
        apiKey: GEMINI_SECRET,
        primaryModel: 'gemini-2.0-flash',
      });

      await clearServerlessOpenRouterConfig();

      // The active provider (Gemini) is cleared; OpenRouter stays intact.
      await expect(loadServerlessApiKey('gemini')).resolves.toBeNull();
      expect(await getSetting(mockDb, 'serverless_primary_model_gemini')).toBeNull();
      await expect(loadServerlessApiKey('openrouter')).resolves.toBe(SECRET);
      expect(await getSetting(mockDb, 'serverless_primary_model')).toBe('vendor/model-a');
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
    test('wipes conversations, settings and keys but keeps auth tokens', async () => {
      await asyncStorage.setItem('auth_token', AUTH_TOKEN);
      await saveServerlessOpenRouterConfig({
        apiKey: SECRET,
        primaryModel: 'vendor/model-a',
        fallbackModels: ['vendor/model-b'],
      });
      await saveServerlessOpenRouterConfig({
        provider: 'gemini',
        apiKey: GEMINI_SECRET,
        primaryModel: 'gemini-2.0-flash',
      });
      await insertSession(mockDb, {title: 'Local chat'});

      await clearAllServerlessData();

      expect(await listSessions(mockDb)).toEqual([]);
      await expect(loadServerlessApiKey('openrouter')).resolves.toBeNull();
      await expect(loadServerlessApiKey('gemini')).resolves.toBeNull();
      expect(await getSetting(mockDb, 'serverless_primary_model')).toBeNull();
      expect(await getSetting(mockDb, 'serverless_fallback_models')).toBeNull();
      expect(await getSetting(mockDb, 'serverless_primary_model_gemini')).toBeNull();
      await expect(asyncStorage.getItem('auth_token')).resolves.toBe(AUTH_TOKEN);
    });
  });

  describe('key clear', () => {
    test('clearServerlessApiKey removes only the target provider namespace', async () => {
      await saveServerlessApiKey(SECRET, 'openrouter');
      await saveServerlessApiKey(GEMINI_SECRET, 'gemini');

      await clearServerlessApiKey('openrouter');

      await expect(loadServerlessApiKey('openrouter')).resolves.toBeNull();
      await expect(loadServerlessApiKey('gemini')).resolves.toBe(GEMINI_SECRET);
    });
  });
});
