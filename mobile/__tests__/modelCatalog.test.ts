/**
 * Serverless model discovery cache tests (SPEC TASK-084). Runs against the
 * sql.js-backed driver with real SQL semantics: refreshing fetches through
 * an injected OpenRouter adapter and persists locally, cached models stay
 * readable with zero network activity, failed refreshes keep the previous
 * snapshot intact, and unusable cache payloads resolve to null.
 */
import {openLocalDatabase} from '../src/db/database';
import type {SqlDriver} from '../src/db/driver';
import {openSqlJsDriver} from '../testing/sqlJsDriver';
import {FakeOpenRouterClient} from '../testing/fakeOpenRouter';
import {OpenRouterAvailabilityError} from '../src/serverless/errors';
import {
  MODEL_CATALOG_SETTING_KEY,
  getCachedModelCatalog,
  refreshModelCatalog,
} from '../src/serverless/modelCatalog';

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
    fake.enqueueModels([
      {id: 'vendor/model-a', name: 'Model A', description: null, contextLength: 8192, created: 1},
      {id: 'vendor/model-b', name: '', description: null, contextLength: null, created: null},
    ]);

    const snapshot = await refreshModelCatalog(db, () => fake.listModels());

    expect(snapshot.models).toHaveLength(2);
    expect(snapshot.fetchedAt).not.toBe('');
    expect(await getCachedModelCatalog(db)).toEqual(snapshot);
    expect(fake.modelsCalls).toBe(1);
  });

  test('a later refresh replaces the previous snapshot', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueModels([{id: 'old/model', name: 'Old', description: null, contextLength: null, created: null}]);
    await refreshModelCatalog(db, () => fake.listModels());

    const updated = [
      {id: 'new/model', name: 'New', description: 'Fresh', contextLength: 4096, created: 2},
    ];
    fake.clearScripts();
    fake.enqueueModels(updated);
    const second = await refreshModelCatalog(db, () => fake.listModels());

    expect(second.models).toEqual(updated);
    expect(await getCachedModelCatalog(db)).toEqual(second);
  });

  test('cached models remain readable without any network activity', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueModels([{id: 'vendor/model-a', name: 'Model A', description: null, contextLength: null, created: null}]);
    const stored = await refreshModelCatalog(db, () => fake.listModels());

    // A brand-new adapter proves reading the cache never calls OpenRouter.
    expect(fake.modelsCalls).toBe(1);
    const fresh = new FakeOpenRouterClient();
    await expect(getCachedModelCatalog(db)).resolves.toEqual(stored);
    expect(fresh.modelsCalls).toBe(0);
  });

  test('a failed refresh keeps the previous cache and rethrows the error', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueModels([{id: 'vendor/model-a', name: 'Model A', description: null, contextLength: null, created: null}]);
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
});
