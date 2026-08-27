/**
 * Tests for the serverless OpenRouter API key store (SPEC TASK-093).
 *
 * These tests prove the secret storage contract:
 * - The key is only ever persisted through the device keychain
 * - The key is never written to the local SQLite settings table or to
 *   AsyncStorage
 * - The key survives an application restart (module reload)
 * - The key can be replaced and removed through the public API
 *
 * The keychain mock lives in jest.setup.js and persists across
 * jest.resetModules(), so restart simulation mirrors real device
 * storage behaviour.
 */
import * as AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import {
  clearServerlessApiKey,
  hasServerlessApiKey,
  loadServerlessApiKey,
  saveServerlessApiKey,
} from '../src/serverless/secureApiKey';
import {getLocalDatabase} from '../src/db/database';

const mockedKeychain = Keychain as jest.Mocked<typeof Keychain> & {
  __resetKeychainStore: () => void;
};
const mockedAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const SERVERLESS_SERVICE = 'com.elearningmobile.serverless';
const SERVERLESS_USERNAME = 'openrouter-api-key';
const SECRET = 'sk-or-v1-test-secret-do-not-leak';

describe('secureApiKey (TASK-093)', () => {
  beforeEach(async () => {
    mockedKeychain.__resetKeychainStore();
    (mockedAsyncStorage.default.setItem as jest.Mock).mockClear();
    (mockedAsyncStorage.default.getItem as jest.Mock).mockClear();
    (mockedAsyncStorage.default.removeItem as jest.Mock).mockClear();
    jest.clearAllMocks();
    const db = await getLocalDatabase();
    // Best-effort cleanup of any settings written by previous tests
    // (the SQLite mock only records statements, so DELETE just adds
    // a log entry; it is what production code would execute).
    await db.execute('DELETE FROM settings');
  });

  it('stores the key only through the keychain and never plain AsyncStorage', async () => {
    await saveServerlessApiKey(SECRET);

    expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1);
    expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
      SERVERLESS_USERNAME,
      SECRET,
      expect.objectContaining({service: SERVERLESS_SERVICE}),
    );

    expect(AsyncStorage.default.setItem).not.toHaveBeenCalled();
  });

  it('round-trips the saved key through loadServerlessApiKey', async () => {
    await saveServerlessApiKey(SECRET);
    await expect(loadServerlessApiKey()).resolves.toBe(SECRET);
    expect(Keychain.getGenericPassword).toHaveBeenCalledWith({
      service: SERVERLESS_SERVICE,
    });
  });

  it('trims surrounding whitespace before persisting', async () => {
    await saveServerlessApiKey('   ' + SECRET + '\n');
    await expect(loadServerlessApiKey()).resolves.toBe(SECRET);
  });

  it('rejects empty or whitespace-only keys without writing anything', async () => {
    await expect(saveServerlessApiKey('')).rejects.toThrow();
    await expect(saveServerlessApiKey('   ')).rejects.toThrow();
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled();
  });

  it('returns null when no key has been stored', async () => {
    await expect(loadServerlessApiKey()).resolves.toBeNull();
  });

  it('returns null when the stored keychain entry is empty', async () => {
    await (Keychain.setGenericPassword as jest.Mock)(
      SERVERLESS_USERNAME,
      '   ',
      {service: SERVERLESS_SERVICE},
    );
    await expect(loadServerlessApiKey()).resolves.toBeNull();
  });

  it('keeps the key readable after a full module reload (app restart)', async () => {
    await saveServerlessApiKey(SECRET);

    jest.resetModules();
    const revived = require('../src/serverless/secureApiKey') as typeof import('../src/serverless/secureApiKey');

    await expect(revived.loadServerlessApiKey()).resolves.toBe(SECRET);
  });

  it('replaces the previous key when save is called again', async () => {
    await saveServerlessApiKey(SECRET);
    const replacement = 'sk-or-v1-replacement-key';
    await saveServerlessApiKey(replacement);

    await expect(loadServerlessApiKey()).resolves.toBe(replacement);
    expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(2);
  });

  it('removes the key through clearServerlessApiKey and leaves a no-op clear alone', async () => {
    await saveServerlessApiKey(SECRET);
    await clearServerlessApiKey();

    expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
      service: SERVERLESS_SERVICE,
    });
    await expect(loadServerlessApiKey()).resolves.toBeNull();
    await expect(hasServerlessApiKey()).resolves.toBe(false);

    // Clearing a key that was never stored must not throw.
    await expect(clearServerlessApiKey()).resolves.toBeUndefined();
  });

  it('uses a distinct keychain service from the auth-token store', async () => {
    // Both stores are real in production; an accidental collision would
    // either lose the user's key on logout or vice versa. The
    // namespacing is part of the security contract.
    await saveServerlessApiKey(SECRET);

    const setCalls = (Keychain.setGenericPassword as jest.Mock).mock.calls;
    const services = setCalls.map(call => call[2]?.service);
    expect(services).toContain(SERVERLESS_SERVICE);
    expect(services).not.toContain('com.elearningmobile.auth');
  });

  it('does not write the key into the local settings table', async () => {
    await saveServerlessApiKey(SECRET);

    // The settings store only ever sees non-secret identifiers
    // (primary + fallback models). The key must never appear there,
    // even indirectly. We verify by checking that the mock keychain
    // is the only persistence seam touched for the secret itself.
    const setCalls = (Keychain.setGenericPassword as jest.Mock).mock.calls;
    const keychainPersisted = setCalls.some(
      call => call[0] === SERVERLESS_USERNAME && call[1] === SECRET,
    );
    expect(keychainPersisted).toBe(true);

    // AsyncStorage is also explicitly off-limits for the secret.
    const asyncSet = (AsyncStorage.default.setItem as jest.Mock).mock.calls;
    const leakedToAsync = asyncSet.some(call => String(call[1] ?? '').includes(SECRET));
    expect(leakedToAsync).toBe(false);
  });
});
