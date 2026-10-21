/**
 * Local data clearing for serverless mode (SPEC TASK-094,
 * TASK-AUDIT-013, TASK-SENT-014).
 *
 * Removes all serverless-mode data from on-device storage while preserving
 * the authentication tokens used by server mode. The operation is
 * transactional: either everything is cleared or nothing is.
 */

import { SUPPORTED_PROVIDER_IDS } from '../serverless/providerRegistry';
import { clearServerlessApiKey } from '../serverless/secureApiKey';
import { getLocalDatabase } from './database';
import type { SqlDriver, SqlExecutor } from './driver';

/**
 * Clear all serverless local data.
 *
 * Deletes:
 * - All conversation sessions, messages, and summaries (cascade via FKs)
 * - All sentence topics, sentences and their review log (TASK-SENT-014)
 * - Learning profile row
 * - Serverless settings (model selections)
 * - Secure provider API keys from the keychain, for every supported
 *   provider namespace (TASK-AUDIT-013)
 *
 * Does NOT delete:
 * - Authentication tokens (server mode credentials)
 * - Theme preference
 * - Application mode selection
 */
export async function clearServerlessLocalData(
  openDb: () => Promise<SqlDriver> = getLocalDatabase,
): Promise<void> {
  const db = await openDb();

  await db.transaction(async (tx: SqlExecutor) => {
    // Drop all serverless tables data. The ON DELETE CASCADE foreign keys
    // on messages.session_id and summaries.session_id remove dependent rows.
    await tx.execute('DELETE FROM sessions');
    await tx.execute('DELETE FROM learning_profile');
    await tx.execute('DELETE FROM settings');

    // Real-life sentence bank: delete the dependent review log first, then
    // the sentences and their topics (TASK-SENT-014). Deleting the topics
    // alone would cascade too; the explicit order keeps the wipe legible.
    await tx.execute('DELETE FROM sentence_review_log');
    await tx.execute('DELETE FROM sentences');
    await tx.execute('DELETE FROM sentence_topics');

    // Reset the auto-increment counters so new sessions start from 1.
    // SQLite keeps counters in sqlite_sequence; deleting from that table
    // resets AUTOINCREMENT for the named tables.
    await tx.execute(
      'DELETE FROM sqlite_sequence WHERE name IN ' +
        "('sessions', 'messages', 'summaries', 'sentence_topics', 'sentences', 'sentence_review_log')",
    );
  });

  // Secure storage is outside the SQLite transaction; clear it after
  // the database succeeds so a database failure does not orphan the keys.
  // Every provider namespace is wiped: stale credentials must never
  // survive a "clear local data" operation.
  for (const provider of SUPPORTED_PROVIDER_IDS) {
    await clearServerlessApiKey(provider);
  }
}

/**
 * Development/test helper: clear and re-initialize the database.
 * Not used in production flows.
 */
export async function resetLocalDatabaseForTests(
  openDb: () => Promise<SqlDriver> = getLocalDatabase,
): Promise<void> {
  await clearServerlessLocalData(openDb);

  // Re-seed the single learning_profile row with the default level so
  // callers that read the profile immediately get a valid result.
  const db = await openDb();
  await db.execute(
    `INSERT OR REPLACE INTO learning_profile (id, level, updated_at) VALUES (1, 'A1', datetime('now'))`,
  );
}
