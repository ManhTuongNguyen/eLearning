/**
 * Serverless OpenRouter settings loading (SPEC TASK-088, TASK-093).
 *
 * Loads the user's OpenRouter configuration from on-device storage:
 * - API key from secure keychain (never in plain SQLite)
 * - Primary model and fallback models from local settings table
 */
import * as Keychain from 'react-native-keychain';
import {getLocalDatabase} from '../db/database';
import type {OpenRouterClientConfig} from './types';

const SERVERLESS_KEYCHAIN_SERVICE = 'com.elearningmobile.serverless';
const SERVERLESS_KEYCHAIN_USERNAME = 'openrouter-config';

const SETTING_PRIMARY_MODEL = 'serverless_primary_model';
const SETTING_FALLBACK_MODELS = 'serverless_fallback_models';

/** Load the complete serverless OpenRouter configuration. */
export async function loadServerlessOpenRouterConfig(): Promise<OpenRouterClientConfig | null> {
  const db = await getLocalDatabase();

  // Load API key from secure storage
  const credentials = await Keychain.getGenericPassword({
    service: SERVERLESS_KEYCHAIN_SERVICE,
  });
  if (!credentials) {
    return null;
  }
  const apiKey = credentials.password.trim();
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

  // Save API key to secure storage
  await Keychain.setGenericPassword(
    SERVERLESS_KEYCHAIN_USERNAME,
    config.apiKey,
    {service: SERVERLESS_KEYCHAIN_SERVICE},
  );

  // Save primary model to settings
  await db.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [SETTING_PRIMARY_MODEL, config.primaryModel],
  );

  // Save fallback models as comma-separated string
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
  await Keychain.resetGenericPassword({service: SERVERLESS_KEYCHAIN_SERVICE});
  await db.execute('DELETE FROM settings WHERE key IN (?, ?)', [
    SETTING_PRIMARY_MODEL,
    SETTING_FALLBACK_MODELS,
  ]);
}

/** Check if serverless OpenRouter is configured. */
export async function isServerlessOpenRouterConfigured(): Promise<boolean> {
  const config = await loadServerlessOpenRouterConfig();
  return config !== null;
}