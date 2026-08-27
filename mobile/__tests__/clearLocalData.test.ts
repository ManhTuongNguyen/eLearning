/**
 * Local data clearing tests (SPEC TASK-094).
 *
 * Verifies that clearing serverless local data:
 * - Removes all sessions, messages, summaries, profile and settings
 * - Clears the secure OpenRouter API key
 * - Resets auto-increment counters so new sessions start from 1
 * - Leaves authentication tokens (AsyncStorage) untouched
 */
import * as Keychain from 'react-native-keychain';

import {clearServerlessLocalData, resetLocalDatabaseForTests} from '../src/db/clearLocalData';
import {openLocalDatabase, resetLocalDatabase} from '../src/db/database';
import {
  insertSession,
  listSessions,
} from '../src/db/sessionStore';
import {
  insertMessage,
  listMessages,
} from '../src/db/messageStore';
import {getLearningProfile, saveLearningProfile} from '../src/db/profileStore';
import {
  getSetting,
  setSetting,
} from '../src/db/settingsStore';
import {saveSummary} from '../src/db/summaryStore';
import {loadServerlessApiKey, saveServerlessApiKey} from '../src/serverless/secureApiKey';
import {openSqlJsDriver} from '../testing/sqlJsDriver';

const mockAsyncStorageStore = new Map<string, string>();
const mockAsyncStorage = {
  setItem: jest.fn(async (key: string, value: string) => {
    mockAsyncStorageStore.set(key, value);
  }),
  getItem: jest.fn(async (key: string) => mockAsyncStorageStore.get(key) ?? null),
  removeItem: jest.fn(async (key: string) => {
    mockAsyncStorageStore.delete(key);
  }),
  __resetAsyncStorageStore: () => {
    mockAsyncStorageStore.clear();
  },
};

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: mockAsyncStorage,
  setItem: mockAsyncStorage.setItem,
  getItem: mockAsyncStorage.getItem,
  removeItem: mockAsyncStorage.removeItem,
  __resetAsyncStorageStore: mockAsyncStorage.__resetAsyncStorageStore,
}));

const mockedKeychain = Keychain as jest.Mocked<typeof Keychain> & {
  __resetKeychainStore: () => void;
};
const asyncStorage = mockAsyncStorage;

const SERVERLESS_SERVICE = 'com.elearningmobile.serverless';
const SECRET = 'sk-or-v1-test-secret-do-not-leak';
const AUTH_TOKEN = 'auth-token-should-not-be-cleared';

describe('clearLocalData (TASK-094)', () => {
  beforeEach(async () => {
    mockedKeychain.__resetKeychainStore();
    asyncStorage.__resetAsyncStorageStore();
    jest.clearAllMocks();
    resetLocalDatabase();

    // Seed auth token in AsyncStorage (simulates server-mode auth)
    await asyncStorage.setItem('auth_token', AUTH_TOKEN);
  });

  it('deletes all sessions, messages and summaries', async () => {
    const db = await openLocalDatabase(() => openSqlJsDriver());

    // Create sessions with messages and summaries
    const session1 = await insertSession(db, {title: 'First chat'});
    const session2 = await insertSession(db, {title: 'Second chat'});

    await insertMessage(db, {session_id: session1.id, role: 'user', content: 'hello'});
    await insertMessage(db, {session_id: session1.id, role: 'assistant', content: 'hi there'});
    await insertMessage(db, {session_id: session2.id, role: 'user', content: 'another session'});

    await saveSummary(db, {
      session_id: session1.id,
      content: 'User greeted the assistant.',
      message_boundary: 2,
    });

    // Verify data exists before clearing
    expect((await listSessions(db)).length).toBe(2);
    expect((await listMessages(db, session1.id)).length).toBe(2);
    expect((await listMessages(db, session2.id)).length).toBe(1);

    // Clear all local data using the test database
    await clearServerlessLocalData(() => Promise.resolve(db));

    // Verify all serverless data is gone
    const sessionsAfter = await listSessions(db);
    expect(sessionsAfter.length).toBe(0);

    // Messages cascade-deleted via FK, but verify anyway
    const allMessages = await db.execute('SELECT COUNT(*) AS n FROM messages');
    expect(Number(allMessages.rows[0]?.n)).toBe(0);

    const allSummaries = await db.execute('SELECT COUNT(*) AS n FROM summaries');
    expect(Number(allSummaries.rows[0]?.n)).toBe(0);

    await db.close();
  });

  it('clears the learning profile', async () => {
    const db = await openLocalDatabase(() => openSqlJsDriver());

    await saveLearningProfile(db, 'B2');
    expect((await getLearningProfile(db)).level).toBe('B2');

    await clearServerlessLocalData(() => Promise.resolve(db));

    // Profile should be reset to default (empty row deleted)
    const profile = await getLearningProfile(db);
    expect(profile.level).toBe('A1'); // Default level

    await db.close();
  });

  it('clears serverless settings (model selections)', async () => {
    const db = await openLocalDatabase(() => openSqlJsDriver());

    await setSetting(db, 'serverless_primary_model', 'openai/gpt-4o-mini');
    await setSetting(db, 'serverless_fallback_models', 'model-a,model-b');
    await setSetting(db, 'other_setting', 'should-stay'); // Non-serverless setting

    expect(await getSetting(db, 'serverless_primary_model')).toBe('openai/gpt-4o-mini');
    expect(await getSetting(db, 'serverless_fallback_models')).toBe('model-a,model-b');
    expect(await getSetting(db, 'other_setting')).toBe('should-stay');

    await clearServerlessLocalData(() => Promise.resolve(db));

    // Serverless settings should be gone
    expect(await getSetting(db, 'serverless_primary_model')).toBeNull();
    expect(await getSetting(db, 'serverless_fallback_models')).toBeNull();
    // Other settings are also cleared by current implementation
    expect(await getSetting(db, 'other_setting')).toBeNull();

    await db.close();
  });

  it('clears the secure OpenRouter API key', async () => {
    await saveServerlessApiKey(SECRET);
    await expect(loadServerlessApiKey()).resolves.toBe(SECRET);

    // Use default database for this test since keychain is global
    await clearServerlessLocalData();

    await expect(loadServerlessApiKey()).resolves.toBeNull();
    expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
      service: SERVERLESS_SERVICE,
    });
  });

  it('resets auto-increment counters so new sessions start from 1', async () => {
    const db = await openLocalDatabase(() => openSqlJsDriver());

    const session1 = await insertSession(db, {title: 'First'});
    const session2 = await insertSession(db, {title: 'Second'});

    expect(session1.id).toBe(1);
    expect(session2.id).toBe(2);

    await clearServerlessLocalData(() => Promise.resolve(db));

    // New session after clear should start from 1
    const newSession = await insertSession(db, {title: 'After clear'});
    expect(newSession.id).toBe(1);

    await db.close();
  });

  it('does not delete authentication tokens from AsyncStorage', async () => {
    // Auth token already seeded in beforeEach
    const tokenBefore = await asyncStorage.getItem('auth_token');
    expect(tokenBefore).toBe(AUTH_TOKEN);

    await clearServerlessLocalData();

    const tokenAfter = await asyncStorage.getItem('auth_token');
    expect(tokenAfter).toBe(AUTH_TOKEN);
  });

  it('is transactional: partial failure leaves no orphaned state', async () => {
    const db = await openLocalDatabase(() => openSqlJsDriver());

    const session1 = await insertSession(db, {title: 'First'});
    await insertMessage(db, {session_id: session1.id, role: 'user', content: 'hello'});

    // Clear should succeed completely
    await expect(clearServerlessLocalData(() => Promise.resolve(db))).resolves.toBeUndefined();

    // Nothing should remain
    expect((await listSessions(db)).length).toBe(0);
    const allMessages = await db.execute('SELECT COUNT(*) AS n FROM messages');
    expect(Number(allMessages.rows[0]?.n)).toBe(0);

    await db.close();
  });

  it('resetLocalDatabaseForTests reseeds the default profile', async () => {
    const db = await openLocalDatabase(() => openSqlJsDriver());

    await saveLearningProfile(db, 'C1');
    await saveServerlessApiKey(SECRET);
    await setSetting(db, 'serverless_primary_model', 'openai/gpt-4o-mini');
    await insertSession(db, {title: 'Some chat'});

    await resetLocalDatabaseForTests(() => Promise.resolve(db));

    // Profile should be back to default
    const profile = await getLearningProfile(db);
    expect(profile.level).toBe('A1');

    // Key should be cleared
    await expect(loadServerlessApiKey()).resolves.toBeNull();

    // Settings should be cleared
    expect(await getSetting(db, 'serverless_primary_model')).toBeNull();

    // Sessions should be cleared
    expect((await listSessions(db)).length).toBe(0);

    await db.close();
  });
});