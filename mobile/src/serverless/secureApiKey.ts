/**
 * Secure storage for the user's personal OpenRouter API key
 * (SPEC TASK-093, serverless mode).
 *
 * The key is held only in the device keychain/keystore via
 * react-native-keychain. It must NEVER be written to local SQLite or
 * AsyncStorage, and it must NEVER appear in logs. The model selection
 * lives next to it in the serverless settings table because that data
 * is not sensitive.
 *
 * The service identifier is namespaced so it cannot collide with the
 * authentication-token keychain entry (auth/secureStorage.ts).
 */
import * as Keychain from 'react-native-keychain';

const SERVERLESS_KEYCHAIN_SERVICE = 'com.elearningmobile.serverless';
const SERVERLESS_KEYCHAIN_USERNAME = 'openrouter-api-key';

/**
 * Save the user's OpenRouter API key into secure device storage. Any
 * previous key stored under the same service is replaced atomically by
 * the keychain, so this also implements "replace" semantics.
 */
export async function saveServerlessApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('OpenRouter API key must not be empty.');
  }
  await Keychain.setGenericPassword(SERVERLESS_KEYCHAIN_USERNAME, trimmed, {
    service: SERVERLESS_KEYCHAIN_SERVICE,
  });
}

/**
 * Read the saved OpenRouter API key. Returns null when no key is
 * stored, when the keychain has been cleared, or when the stored entry
 * is somehow empty. The caller is responsible for keeping the returned
 * value out of logs and ephemeral component state.
 */
export async function loadServerlessApiKey(): Promise<string | null> {
  const credentials = await Keychain.getGenericPassword({
    service: SERVERLESS_KEYCHAIN_SERVICE,
  });
  if (!credentials) {
    return null;
  }
  const value = credentials.password.trim();
  return value ? value : null;
}

/**
 * Permanently remove the saved OpenRouter API key from device storage.
 * Clearing an absent key is a no-op rather than an error.
 */
export async function clearServerlessApiKey(): Promise<void> {
  await Keychain.resetGenericPassword({service: SERVERLESS_KEYCHAIN_SERVICE});
}

/** True when an OpenRouter API key is currently stored. */
export async function hasServerlessApiKey(): Promise<boolean> {
  return (await loadServerlessApiKey()) !== null;
}
