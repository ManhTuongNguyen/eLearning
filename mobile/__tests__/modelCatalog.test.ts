/**
 * Serverless model discovery cache tests (SPEC TASK-084, TASK-AUDIT-017).
 * Runs against the sql.js-backed driver with real SQL semantics: refreshing
 * fetches through an injected OpenRouter adapter and persists locally,
 * cached models stay readable with zero network activity, failed refreshes
 * keep the previous snapshot intact, unusable cache payloads resolve to
 * null, and snapshot staleness is derived deterministically from the
 * stored timestamp without ever discarding the cached models.
 */
import {openLocalDatabase} from '../src/db/database';
import type {SqlDriver} from '../src/db/driver';
import {openSqlJsDriver} from '../testing/sqlJsDriver';
import {FakeOpenRouterClient} from '../testing/fakeOpenRouter';
import {OpenRouterAvailabilityError} from '../src/serverless/errors';
import type {ModelInfo} from '../src/serverless/types';
import {
  MODEL_CATALOG_MAX_AGE_MS,
  MODEL_CATALOG_SETTING_KEY,
  getCachedModelCatalog,
  isModelCatalogStale,
  modelCatalogAgeMs,
  refreshModelCatalog,
} from '../src/serverless/modelCatalog';

/** Full normalized ModelInfo with the optional catalog fields defaulted. */
function model(id: string, name: string, contextLength: number | null = null): ModelInfo {
  return {
    id,
    name,
    canonicalSlug: null,
    description: null,
    contextLength,
    created: null,
    architecture: null,
    pricing: null,
    topProvider: null,
    supportedParameters: [],
  };
}

describe('serverless model discovery (TASK-084)', () => {
  let db: SqlDriver;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  test('refresh persists the fetched catalog with a timestamp', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueModels([model('vendor/model-a', 'Model A', 8192), model('vendor/model-b', '')]);

    const snapshot = await refreshModelCatalog(db, () => fake.listModels());

    expect(snapshot.models).toHaveLength(2);
    expect(snapshot.fetchedAt).not.toBe('');
    expect(await getCachedModelCatalog(db)).toEqual(snapshot);
    expect(fake.modelsCalls).toBe(1);
  });

  test('a later refresh replaces the previous snapshot', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueModels([model('old/model', 'Old')]);
    await refreshModelCatalog(db, () => fake.listModels());

    const updated = [model('new/model', 'New', 4096)];
    fake.clearScripts();
    fake.enqueueModels(updated);
    const second = await refreshModelCatalog(db, () => fake.listModels());

    expect(second.models).toEqual(updated);
    expect(await getCachedModelCatalog(db)).toEqual(second);
  });

  test('cached models remain readable without any network activity', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueModels([model('vendor/model-a', 'Model A')]);
    const stored = await refreshModelCatalog(db, () => fake.listModels());

    // A brand-new adapter proves reading the cache never calls OpenRouter.
    expect(fake.modelsCalls).toBe(1);
    const fresh = new FakeOpenRouterClient();
    await expect(getCachedModelCatalog(db)).resolves.toEqual(stored);
    expect(fresh.modelsCalls).toBe(0);
  });

  test('a failed refresh keeps the previous cache and rethrows the error', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueModels([model('vendor/model-a', 'Model A')]);
    const original = await refreshModelCatalog(db, () => fake.listModels());

    fake.clearScripts();
    fake.enqueueModels(new OpenRouterAvailabilityError('catalog temporarily unavailable'));
    await expect(refreshModelCatalog(db, () => fake.listModels())).rejects.toBeInstanceOf(
      OpenRouterAvailabilityError,
    );

    await expect(getCachedModelCatalog(db)).resolves.toEqual(original);
  });

  test('an empty database resolves to null instead of throwing', async () => {
    await expect(getCachedModelCatalog(db)).resolves.toBeNull();
  });

  test('unusable cache payloads resolve to null', async () => {
    const payloads = [
      '{not json',
      '"just a string"',
      '{"models": "nope", "fetchedAt": "x"}',
      '{"models": [{"id": ""}], "fetchedAt": "x"}',
      '{"models": [], "fetchedAt": 42}',
    ];
    for (const raw of payloads) {
      await db.execute('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [
        MODEL_CATALOG_SETTING_KEY,
        raw,
        new Date().toISOString(),
      ]);
      await expect(getCachedModelCatalog(db)).resolves.toBeNull();
      await db.execute('DELETE FROM settings WHERE key = ?', [MODEL_CATALOG_SETTING_KEY]);
    }
  });

  test('legacy snapshots written before the extended ModelInfo fields are re-normalized', async () => {
    // Old-shape entry: only the original five fields, everything extended
    // missing. It must read back onto the full normalized shape.
    await db.execute('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [
      MODEL_CATALOG_SETTING_KEY,
      JSON.stringify({
        models: [
          {id: 'vendor/legacy', name: 'Legacy', description: null, contextLength: 1024, created: 5},
        ],
        fetchedAt: '2026-01-01T00:00:00.000Z',
      }),
      new Date().toISOString(),
    ]);

    await expect(getCachedModelCatalog(db)).resolves.toEqual({
      models: [
        {
          id: 'vendor/legacy',
          name: 'Legacy',
          canonicalSlug: null,
          description: null,
          contextLength: 1024,
          created: 5,
          architecture: null,
          pricing: null,
          topProvider: null,
          supportedParameters: [],
        },
      ],
      fetchedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('catalog snapshot staleness (TASK-AUDIT-017)', () => {
  // Fixed clock so every assertion below is deterministic.
  const NOW_MS = Date.parse('2026-08-29T12:00:00.000Z');

  let db: SqlDriver;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  test('a just-fetched snapshot is not stale', () => {
    const snapshot = {models: [], fetchedAt: new Date(NOW_MS).toISOString()};
    expect(modelCatalogAgeMs(snapshot, NOW_MS)).toBe(0);
    expect(isModelCatalogStale(snapshot, NOW_MS)).toBe(false);
  });

  test('a snapshot within the default window is not stale', () => {
    const snapshot = {models: [], fetchedAt: new Date(NOW_MS - MODEL_CATALOG_MAX_AGE_MS + 1).toISOString()};
    expect(isModelCatalogStale(snapshot, NOW_MS)).toBe(false);
  });

  test('a snapshot older than the default window is stale', () => {
    const snapshot = {models: [], fetchedAt: new Date(NOW_MS - MODEL_CATALOG_MAX_AGE_MS - 1).toISOString()};
    expect(isModelCatalogStale(snapshot, NOW_MS)).toBe(true);
  });

  test('staleness honours a custom window at the exact boundary', () => {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const snapshot = {models: [], fetchedAt: new Date(NOW_MS - ONE_HOUR_MS).toISOString()};
    expect(isModelCatalogStale(snapshot, NOW_MS, ONE_HOUR_MS)).toBe(false);
    expect(isModelCatalogStale(snapshot, NOW_MS, ONE_HOUR_MS - 1)).toBe(true);
  });

  test('a future timestamp clamps to a zero age instead of going negative', () => {
    const snapshot = {models: [], fetchedAt: new Date(NOW_MS + 60_000).toISOString()};
    expect(modelCatalogAgeMs(snapshot, NOW_MS)).toBe(0);
    expect(isModelCatalogStale(snapshot, NOW_MS)).toBe(false);
  });

  test('an unusable timestamp reports stale so a refresh can repair it', () => {
    const snapshot = {models: [], fetchedAt: 'not-a-timestamp'};
    expect(modelCatalogAgeMs(snapshot, NOW_MS)).toBeNull();
    expect(isModelCatalogStale(snapshot, NOW_MS)).toBe(true);
  });

  test('stale snapshots stay readable from the cache — staleness never drops models', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueModels([model('vendor/model-a', 'Model A')]);
    await refreshModelCatalog(db, () => fake.listModels());

    // Age the stored snapshot far past the window without rewriting it.
    const stored = await getCachedModelCatalog(db);
    expect(stored).not.toBeNull();
    await db.execute('UPDATE settings SET value = ? WHERE key = ?', [
      JSON.stringify({models: stored!.models, fetchedAt: '2020-01-01T00:00:00.000Z'}),
      MODEL_CATALOG_SETTING_KEY,
    ]);

    const aged = await getCachedModelCatalog(db);
    expect(aged!.models).toEqual([model('vendor/model-a', 'Model A')]);
    expect(isModelCatalogStale(aged!)).toBe(true);
    // Reading the aged cache never went back to the provider.
    expect(fake.modelsCalls).toBe(1);
  });
});
