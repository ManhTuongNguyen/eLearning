/**
 * Serverless model discovery with local caching (SPEC TASK-084).
 *
 * The OpenRouter transport itself lives in ./openrouterClient (TASK-083);
 * this module adds the local-cache layer on top of the serverless SQLite
 * settings store. `refreshModelCatalog` fetches through an injected
 * `listModels` adapter and persists the result only after success, so a
 * failed refresh never destroys the previously cached catalog — cached
 * models stay available without any network access via
 * `getCachedModelCatalog`.
 */
import type {SqlExecutor} from '../db/driver';
import {nowIso} from '../db/driver';
import {getSetting, setSetting} from '../db/settingsStore';
import type {ModelInfo} from './types';

/** Settings key holding the serialized catalog snapshot. */
export const MODEL_CATALOG_SETTING_KEY = 'model_catalog';

/** One locally persisted catalog snapshot. */
export interface CachedModelCatalog {
  models: ModelInfo[];
  /** ISO-8601 timestamp of when the snapshot was fetched from OpenRouter. */
  fetchedAt: string;
}

/** Validate one parsed ModelInfo-shaped value from the cache payload. */
function isModelInfo(value: unknown): value is ModelInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.trim().length > 0;
}

/** Parse a stored catalog snapshot; anything unusable resolves to null. */
function parseCachedCatalog(raw: string | null): CachedModelCatalog | null {
  if (!raw) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const models = record.models;
  const fetchedAt = record.fetchedAt;
  if (!Array.isArray(models) || !models.every(isModelInfo) || typeof fetchedAt !== 'string') {
    return null;
  }
  return {models, fetchedAt};
}

/**
 * Fetch the model catalog directly from OpenRouter through `listModels` and
 * persist it locally. On failure the normalized provider error propagates
 * and any previously cached catalog remains untouched.
 */
export async function refreshModelCatalog(
  db: SqlExecutor,
  listModels: () => Promise<ModelInfo[]>,
): Promise<CachedModelCatalog> {
  const models = await listModels();
  const snapshot: CachedModelCatalog = {models, fetchedAt: nowIso()};
  await setSetting(db, MODEL_CATALOG_SETTING_KEY, JSON.stringify(snapshot));
  return snapshot;
}

/**
 * Read the locally cached catalog without touching the network. Resolves
 * null when nothing was cached yet or the stored payload is unusable; the
 * next successful refresh overwrites such entries.
 */
export async function getCachedModelCatalog(
  db: SqlExecutor,
): Promise<CachedModelCatalog | null> {
  return parseCachedCatalog(await getSetting(db, MODEL_CATALOG_SETTING_KEY));
}
