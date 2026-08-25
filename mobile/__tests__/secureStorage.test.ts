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
});
