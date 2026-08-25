/**
 * Secure token storage backed by the device keychain/keystore via
 * react-native-keychain. Tokens must never be persisted in plain
 * AsyncStorage (SPEC TASK-015).
 */
import * as Keychain from 'react-native-keychain';

import type {AuthTokens} from './tokens';

const KEYCHAIN_USERNAME = 'elearning-auth';
const KEYCHAIN_SERVICE = 'com.elearningmobile.auth';

export async function saveTokens(tokens: AuthTokens): Promise<void> {
  await Keychain.setGenericPassword(
    KEYCHAIN_USERNAME,
    JSON.stringify(tokens),
    {service: KEYCHAIN_SERVICE},
  );
}

export async function loadTokens(): Promise<AuthTokens | null> {
  const credentials = await Keychain.getGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
  if (!credentials) {
    return null;
  }
  try {
    const parsed = JSON.parse(credentials.password) as Partial<AuthTokens>;
    if (typeof parsed.access === 'string' && typeof parsed.refresh === 'string') {
      return {access: parsed.access, refresh: parsed.refresh};
    }
    return null;
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  await Keychain.resetGenericPassword({service: KEYCHAIN_SERVICE});
}
