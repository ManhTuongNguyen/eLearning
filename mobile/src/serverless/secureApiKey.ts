/**
 * Secure storage for the user's personal provider API keys
 * (SPEC TASK-093, TASK-AUDIT-013; serverless mode).
 *
 * Keys are held only in the device keychain/keystore via
 * react-native-keychain. They must NEVER be written to local SQLite or
 * AsyncStorage, and they must NEVER appear in logs. Model selection lives
 * next to the keys in the serverless settings table because that data is
 * not sensitive.
 *
 * Each supported provider gets its own keychain namespace so keys cannot
 * overwrite each other (and so Android's one-credential-per-service model
 * stays correct). The OpenRouter namespace is unchanged from the original
 * single-provider implementation (service `com.elearningmobile.serverless`,
 * username `openrouter-api-key`) so existing installs keep working.
 */
import * as Keychain from 'react-native-keychain';
import type {ProviderId} from './types';

const SERVERLESS_KEYCHAIN_SERVICE = 'com.elearningmobile.serverless';
const SERVERLESS_KEYCHAIN_USERNAME = 'openrouter-api-key';

/** Keychain namespace for one provider's key. */
function keychainNamespace(provider: ProviderId): {service: string; username: string} {
  if (provider === 'openrouter') {
    // Historic namespace — never renamed, or stored keys become unreadable.
    return {service: SERVERLESS_KEYCHAIN_SERVICE, username: SERVERLESS_KEYCHAIN_USERNAME};
  }
  return {
    service: `${SERVERLESS_KEYCHAIN_SERVICE}.${provider}`,
    username: 'api-key',
  };
}

/**
 * Save the user's provider API key into secure device storage. Any
 * previous key stored under the same namespace is replaced atomically by
 * the keychain, so this also implements "replace" semantics.
 */
export async function saveServerlessApiKey(
  apiKey: string,
  provider: ProviderId = 'openrouter',
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('Provider API key must not be empty.');
  }
  const {service, username} = keychainNamespace(provider);
  await Keychain.setGenericPassword(username, trimmed, {service});
}

/**
 * Read the saved provider API key. Returns null when no key is stored,
 * when the keychain has been cleared, or when the stored entry is somehow
 * empty. The caller is responsible for keeping the returned value out of
 * logs and ephemeral component state.
 */
export async function loadServerlessApiKey(
  provider: ProviderId = 'openrouter',
): Promise<string | null> {
  const {service} = keychainNamespace(provider);
  const credentials = await Keychain.getGenericPassword({service});
  if (!credentials) {
    return null;
  }
  const value = credentials.password.trim();
  return value ? value : null;
}

/**
 * Permanently remove the saved provider API key from device storage.
 * Clearing an absent key is a no-op rather than an error.
 */
export async function clearServerlessApiKey(provider: ProviderId = 'openrouter'): Promise<void> {
  const {service} = keychainNamespace(provider);
  await Keychain.resetGenericPassword({service});
}

/** True when an API key is currently stored for the provider. */
export async function hasServerlessApiKey(
  provider: ProviderId = 'openrouter',
): Promise<boolean> {
  return (await loadServerlessApiKey(provider)) !== null;
}
