/**
 * Serverless model discovery with local caching (SPEC TASK-084,
 * TASK-AUDIT-013).
 *
 * The provider transports live behind the serverless client factories
 * (./openAICompatibleClient, ./geminiClient); this module adds the
 * local-cache layer on top of the serverless SQLite settings store.
 * Catalog snapshots are namespaced per provider (the historic
 * `model_catalog` key remains the OpenRouter namespace), so switching
 * providers never mixes model ids. `refreshModelCatalog` fetches through
 * an injected `listModels` adapter and persists the result only after
 * success, so a failed refresh never destroys the previously cached
 * catalog — cached models stay available without any network access via
 * `getCachedModelCatalog`.
 *
 * TASK-AUDIT-017: snapshots carry the `fetchedAt` timestamp so staleness
 * can be reported through `isModelCatalogStale`. A stale snapshot is never
 * discarded or refetched implicitly — the models keep working offline and
 * only an explicit user refresh goes back to the provider, so neither a
 * screen mount nor a re-render can trigger a catalog request.
 */
import type {SqlExecutor} from '../db/driver';
import {nowIso} from '../db/driver';
import {getSetting, setSetting} from '../db/settingsStore';
import {normalizeModelInfo, type ModelInfo, type ProviderId} from './types';

/** Settings key holding the serialized OpenRouter catalog snapshot (historic). */
export const MODEL_CATALOG_SETTING_KEY = 'model_catalog';

/** Settings key holding the serialized catalog snapshot for one provider. */
export function modelCatalogSettingKey(provider: ProviderId): string {
  return provider === 'openrouter' ? MODEL_CATALOG_SETTING_KEY : `${MODEL_CATALOG_SETTING_KEY}_${provider}`;
}

/** One locally persisted catalog snapshot. */
export interface CachedModelCatalog {
  models: ModelInfo[];
  /** ISO-8601 timestamp of when the snapshot was fetched from the provider. */
  fetchedAt: string;
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
  if (!Array.isArray(models) || typeof fetchedAt !== 'string') {
    return null;
  }
  // Re-coerce every entry so snapshots written by older app versions —
  // before the extended ModelInfo fields existed — are backfilled onto the
  // full normalized shape; an unusable entry still voids the whole cache.
  const normalized: ModelInfo[] = [];
  for (const entry of models) {
    const parsed = normalizeModelInfo(entry);
    if (!parsed) {
      return null;
    }
    normalized.push(parsed);
  }
  return {models: normalized, fetchedAt};
}

/**
 * Fetch the model catalog directly from the provider through `listModels`
 * and persist it locally under the provider's cache namespace. On failure
 * the normalized provider error propagates and any previously cached
 * catalog remains untouched.
 */
export async function refreshModelCatalog(
  db: SqlExecutor,
  listModels: () => Promise<ModelInfo[]>,
  provider: ProviderId = 'openrouter',
): Promise<CachedModelCatalog> {
  const models = await listModels();
  const snapshot: CachedModelCatalog = {models, fetchedAt: nowIso()};
  await setSetting(db, modelCatalogSettingKey(provider), JSON.stringify(snapshot));
  return snapshot;
}

/**
 * Read the locally cached catalog without touching the network. Resolves
 * null when nothing was cached yet or the stored payload is unusable; the
 * next successful refresh overwrites such entries.
 */
export async function getCachedModelCatalog(
  db: SqlExecutor,
  provider: ProviderId = 'openrouter',
): Promise<CachedModelCatalog | null> {
  return parseCachedCatalog(await getSetting(db, modelCatalogSettingKey(provider)));
}

/** How long a snapshot stays fresh before the UI should offer a refresh. */
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Milliseconds elapsed since the snapshot was fetched from the provider,
 * or null when the stored timestamp is unusable. A future timestamp (device
 * clock moved back) clamps to zero instead of reporting a negative age.
 */
export function modelCatalogAgeMs(
  snapshot: CachedModelCatalog,
  nowMs: number = Date.now(),
): number | null {
  const fetchedMs = Date.parse(snapshot.fetchedAt);
  if (Number.isNaN(fetchedMs)) {
    return null;
  }
  return Math.max(0, nowMs - fetchedMs);
}

/**
 * True when the snapshot is older than `maxAgeMs` or carries an unusable
 * timestamp. Staleness never hides or drops cached models — they remain
 * fully usable offline — it only asks the UI to advertise an explicit
 * refresh so the catalog can be brought back up to date on demand.
 */
export function isModelCatalogStale(
  snapshot: CachedModelCatalog,
  nowMs: number = Date.now(),
  maxAgeMs: number = MODEL_CATALOG_MAX_AGE_MS,
): boolean {
  const ageMs = modelCatalogAgeMs(snapshot, nowMs);
  return ageMs === null || ageMs > maxAgeMs;
}
