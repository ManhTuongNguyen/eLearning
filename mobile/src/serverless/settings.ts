/**
 * Serverless LLM settings loading (SPEC TASK-088, TASK-092, TASK-093,
 * TASK-AUDIT-013).
 *
 * Loads the user's serverless provider configuration from on-device
 * storage:
 * - API key from secure keychain via secureApiKey (never in plain SQLite,
 *   never in AsyncStorage, never logged) — namespaced per provider
 * - Selected provider from the local settings table
 * - Primary model and fallback models from the local settings table,
 *   namespaced per provider so switching providers never mixes catalogs
 *
 * The two halves of the configuration are intentionally split: the
 * secrets live in the keychain, the non-secret identifiers live next
 * to other local preferences so they are easy to clear together.
 *
 * The historic OpenRouter-only setting keys (`serverless_primary_model`,
 * `serverless_fallback_models`) remain the OpenRouter namespace so
 * existing installs keep working; every other provider gets suffixed keys.
 */
import {getLocalDatabase} from '../db/database';
import {
  clearServerlessApiKey,
  loadServerlessApiKey,
  saveServerlessApiKey,
} from './secureApiKey';
import {clearServerlessLocalData} from '../db/clearLocalData';
import {resolveProviderId} from './providerRegistry';
import type {LLMClientConfig, ProviderId} from './types';

const SETTING_PROVIDER = 'serverless_provider';
const SETTING_PRIMARY_MODEL = 'serverless_primary_model';
const SETTING_FALLBACK_MODELS = 'serverless_fallback_models';

/** Settings key holding the primary model for one provider. */
export function primaryModelSettingKey(provider: ProviderId): string {
  return provider === 'openrouter' ? SETTING_PRIMARY_MODEL : `${SETTING_PRIMARY_MODEL}_${provider}`;
}

/** Settings key holding the fallback models for one provider. */
export function fallbackModelsSettingKey(provider: ProviderId): string {
  return provider === 'openrouter'
    ? SETTING_FALLBACK_MODELS
    : `${SETTING_FALLBACK_MODELS}_${provider}`;
}

/** Read the persisted provider id; blank values resolve to `openrouter`. */
export async function loadServerlessProvider(): Promise<ProviderId> {
  const db = await getLocalDatabase();
  const result = await db.execute('SELECT value FROM settings WHERE key = ?', [SETTING_PROVIDER]);
  const row = result.rows[0];
  const stored = row && row.value !== null ? String(row.value) : '';
  return resolveProviderId(stored);
}

/** Load the complete serverless provider configuration (null when unset). */
export async function loadServerlessOpenRouterConfig(): Promise<LLMClientConfig | null> {
  const provider = await loadServerlessProvider();
  const state = await loadServerlessProviderState(provider);
  if (!state.apiKey || !state.primaryModel) {
    return null;
  }
  return {
    provider,
    apiKey: state.apiKey,
    primaryModel: state.primaryModel,
    fallbackModels: state.fallbackModels,
  };
}

/** Non-sensitive per-provider snapshot used by the settings editor. */
export interface ServerlessProviderState {
  /** The stored key value (editor-only; never rendered or logged). */
  apiKey: string | null;
  primaryModel: string | null;
  fallbackModels: string[];
}

/**
 * Load one provider's stored configuration regardless of completeness:
 * the settings editor needs the partial state (key saved but no model
 * chosen yet, etc.) which `loadServerlessOpenRouterConfig` collapses to
 * null. Reads the key from the provider's keychain namespace and the
 * models from the provider's settings namespace.
 */
export async function loadServerlessProviderState(
  provider: ProviderId,
): Promise<ServerlessProviderState> {
  const db = await getLocalDatabase();

  const apiKey = await loadServerlessApiKey(provider);

  const primaryResult = await db.execute('SELECT value FROM settings WHERE key = ?', [
    primaryModelSettingKey(provider),
  ]);
  const primaryRow = primaryResult.rows[0];
  const primaryModel =
    primaryRow && primaryRow.value !== null ? String(primaryRow.value).trim() : '';

  const fallbackResult = await db.execute('SELECT value FROM settings WHERE key = ?', [
    fallbackModelsSettingKey(provider),
  ]);
  const fallbackRow = fallbackResult.rows[0];
  const fallbackModels =
    fallbackRow && fallbackRow.value !== null
      ? String(fallbackRow.value)
          .split(',')
          .map(m => m.trim())
          .filter(Boolean)
      : [];

  return {
    apiKey: apiKey ?? null,
    primaryModel: primaryModel || null,
    fallbackModels,
  };
}

/** Save the serverless provider configuration. */
export async function saveServerlessOpenRouterConfig(config: LLMClientConfig): Promise<void> {
  const db = await getLocalDatabase();
  const provider = resolveProviderId(config.provider ?? 'openrouter');

  // Persist the secret into the keychain (TASK-093) and the non-secret
  // identifiers into the local settings table (TASK-092).
  await saveServerlessApiKey(config.apiKey, provider);

  await db.execute(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    [SETTING_PROVIDER, provider],
  );

  await db.execute(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    [primaryModelSettingKey(provider), config.primaryModel],
  );

  const fallbackValue = (config.fallbackModels ?? []).join(',');
  await db.execute(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    [fallbackModelsSettingKey(provider), fallbackValue],
  );
}

/** Clear the serverless configuration for the persisted provider. */
export async function clearServerlessOpenRouterConfig(): Promise<void> {
  const db = await getLocalDatabase();
  const provider = await loadServerlessProvider();
  await clearServerlessApiKey(provider);
  await db.execute('DELETE FROM settings WHERE key IN (?, ?, ?)', [
    SETTING_PROVIDER,
    primaryModelSettingKey(provider),
    fallbackModelsSettingKey(provider),
  ]);
}

/** Clear all serverless local data (TASK-094). */
export async function clearAllServerlessData(): Promise<void> {
  await clearServerlessLocalData();
}

/** Check if the serverless provider is configured. */
export async function isServerlessOpenRouterConfigured(): Promise<boolean> {
  const config = await loadServerlessOpenRouterConfig();
  return config !== null;
}
