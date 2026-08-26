/**
 * Auto-initializing local database entry point (SPEC TASK-081).
 *
 * The first `getLocalDatabase()` call opens the on-device SQLite database and
 * replays pending migrations, so callers never perform manual setup. The
 * opened driver is cached process-wide; serverless stores resolve it
 * implicitly through this module.
 */

import type {SqlDriver} from './driver';
import {migrateDatabase} from './migrations';
import {openNativeDriver} from './nativeDriver';

let openPromise: Promise<SqlDriver> | null = null;

/** Open a fresh database connection and migrate it to the current version. */
export async function openLocalDatabase(
  openDriver: () => Promise<SqlDriver> = openNativeDriver,
): Promise<SqlDriver> {
  const db = await openDriver();
  await migrateDatabase(db);
  return db;
}

/**
 * Process-wide database accessor; initializes automatically on first use.
 * Subsequent calls reuse the same migrated connection.
 */
export function getLocalDatabase(): Promise<SqlDriver> {
  if (!openPromise) {
    openPromise = openLocalDatabase().catch(error => {
      // Do not cache failures: the next caller retries initialization.
      openPromise = null;
      throw error;
    });
  }
  return openPromise;
}

/**
 * Drop the cached connection so the next access reopens the database.
 * Intended for tests (and future explicit-close flows) only.
 */
export function resetLocalDatabase(): void {
  openPromise = null;
}
