import * as Keychain from 'react-native-keychain';

import {clearTokens, loadTokens, saveTokens} from '../src/auth/secureStorage';

const mocked = Keychain as jest.Mocked<typeof Keychain> & {
  __resetKeychainStore: () => void;
};

describe('secureStorage', () => {
  beforeEach(() => {
    mocked.__resetKeychainStore();
    jest.clearAllMocks();
  });

  it('persists and reloads tokens via the keychain', async () => {
    await saveTokens({access: 'a-token', refresh: 'r-token'});

    expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
      'elearning-auth',
      JSON.stringify({access: 'a-token', refresh: 'r-token'}),
      expect.objectContaining({service: 'com.elearningmobile.auth'}),
    );

    await expect(loadTokens()).resolves.toEqual({
      access: 'a-token',
      refresh: 'r-token',
    });
  });

  it('returns null when no credentials are stored', async () => {
    await expect(loadTokens()).resolves.toBeNull();
  });

  it('returns null for corrupted stored payloads', async () => {
    await saveTokens({access: 'a-token', refresh: 'r-token'});
    // Overwrite with garbage through the same keychain API.
    await (Keychain.setGenericPassword as jest.Mock)(
      'elearning-auth',
      'not-json',
      {service: 'com.elearningmobile.auth'},
    );
    await expect(loadTokens()).resolves.toBeNull();
  });

  it('removes credentials on clear so they no longer load', async () => {
    await saveTokens({access: 'a-token', refresh: 'r-token'});
    await clearTokens();

    expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
      service: 'com.elearningmobile.auth',
    });
    await expect(loadTokens()).resolves.toBeNull();
  });

  it('rejects stored payloads missing required token fields', async () => {
    await (Keychain.setGenericPassword as jest.Mock)(
      'elearning-auth',
      JSON.stringify({access: 'only-access'}),
      {service: 'com.elearningmobile.auth'},
    );
    await expect(loadTokens()).resolves.toBeNull();
  });

  it('keeps tokens readable after a full module reload (app restart)', async () => {
    await saveTokens({access: 'a-token', refresh: 'r-token'});

    // Simulate an application restart: drop every JS module instance while
    // the device keychain store persists, then load through a FRESH copy of
    // the storage module.
    jest.resetModules();
    const revived = require('../src/auth/secureStorage') as typeof import('../src/auth/secureStorage');

    await expect(revived.loadTokens()).resolves.toEqual({
      access: 'a-token',
      refresh: 'r-token',
    });
  });

  it('stays empty across a restart once credentials were cleared', async () => {
    await saveTokens({access: 'a-token', refresh: 'r-token'});
    await clearTokens();

    jest.resetModules();
    const revived = require('../src/auth/secureStorage') as typeof import('../src/auth/secureStorage');

    await expect(revived.loadTokens()).resolves.toBeNull();
  });

  it('rejects corrupted payloads written before a restart', async () => {
    await saveTokens({access: 'a-token', refresh: 'r-token'});
    await (Keychain.setGenericPassword as jest.Mock)(
      'elearning-auth',
      'not-json',
      {service: 'com.elearningmobile.auth'},
    );

    jest.resetModules();
    const revived = require('../src/auth/secureStorage') as typeof import('../src/auth/secureStorage');

    await expect(revived.loadTokens()).resolves.toBeNull();
  });

  it('writes only through the keychain and never plain AsyncStorage', async () => {
    await saveTokens({access: 'a-token', refresh: 'r-token'});

    expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1);
    // The persisted payload is the JSON token envelope handed to the
    // keychain; no other persistence API is imported anywhere in src/.
    expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
      'elearning-auth',
      JSON.stringify({access: 'a-token', refresh: 'r-token'}),
      {service: 'com.elearningmobile.auth'},
    );
  });
});
