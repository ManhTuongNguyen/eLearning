/**
 * Serverless OpenRouter settings loading (SPEC TASK-088, TASK-092, TASK-093).
 *
 * Loads the user's OpenRouter configuration from on-device storage:
 * - API key from secure keychain via secureApiKey (never in plain SQLite,
 *   never in AsyncStorage, never logged)
 * - Primary model and fallback models from the local settings table
 *
 * The two halves of the configuration are intentionally split: the
 * secret lives in the keychain, the non-secret identifiers live next
 * to other local preferences so they are easy to clear together.
 */
import {getLocalDatabase} from '../db/database';
import {
  clearServerlessApiKey,
  loadServerlessApiKey,
  saveServerlessApiKey,
} from './secureApiKey';
import {clearServerlessLocalData} from '../db/clearLocalData';
import type {OpenRouterClientConfig} from './types';

const SETTING_PRIMARY_MODEL = 'serverless_primary_model';
const SETTING_FALLBACK_MODELS = 'serverless_fallback_models';

/** Load the complete serverless OpenRouter configuration. */
export async function loadServerlessOpenRouterConfig(): Promise<OpenRouterClientConfig | null> {
  const db = await getLocalDatabase();

  const apiKey = await loadServerlessApiKey();
  if (!apiKey) {
    return null;
  }

  // Load primary model from settings
  const primaryResult = await db.execute('SELECT value FROM settings WHERE key = ?', [
    SETTING_PRIMARY_MODEL,
  ]);
  const primaryRow = primaryResult.rows[0];
  const primaryModel = primaryRow && primaryRow.value !== null ? String(primaryRow.value).trim() : '';
  if (!primaryModel) {
    return null;
  }

  // Load fallback models from settings (comma-separated)
  const fallbackResult = await db.execute('SELECT value FROM settings WHERE key = ?', [
    SETTING_FALLBACK_MODELS,
  ]);
  const fallbackRow = fallbackResult.rows[0];
  const fallbackModels = fallbackRow && fallbackRow.value !== null
    ? String(fallbackRow.value).split(',').map(m => m.trim()).filter(Boolean)
    : [];

  return {
    apiKey,
    primaryModel,
    fallbackModels,
  };
}

/** Save the serverless OpenRouter configuration. */
export async function saveServerlessOpenRouterConfig(config: OpenRouterClientConfig): Promise<void> {
  const db = await getLocalDatabase();

  // Persist the secret into the keychain (TASK-093) and the non-secret
  // identifiers into the local settings table (TASK-092).
  await saveServerlessApiKey(config.apiKey);

  await db.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [SETTING_PRIMARY_MODEL, config.primaryModel],
  );

  const fallbackValue = (config.fallbackModels ?? []).join(',');
  await db.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [SETTING_FALLBACK_MODELS, fallbackValue],
  );
}

/** Clear the serverless OpenRouter configuration. */
export async function clearServerlessOpenRouterConfig(): Promise<void> {
  const db = await getLocalDatabase();
  await clearServerlessApiKey();
  await db.execute('DELETE FROM settings WHERE key IN (?, ?)', [
    SETTING_PRIMARY_MODEL,
    SETTING_FALLBACK_MODELS,
  ]);
}

/** Clear all serverless local data (TASK-094). */
export async function clearAllServerlessData(): Promise<void> {
  await clearServerlessLocalData();
}

/** Check if serverless OpenRouter is configured. */
export async function isServerlessOpenRouterConfigured(): Promise<boolean> {
  const config = await loadServerlessOpenRouterConfig();
  return config !== null;
}
