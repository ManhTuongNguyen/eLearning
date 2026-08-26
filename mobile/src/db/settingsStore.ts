/**
 * Key/value settings storage for serverless mode (SPEC TASK-081).
 *
 * Holds non-secret local preferences (e.g. selected model ids). The
 * OpenRouter API key must NOT be stored here — it belongs in secure device
 * storage (TASK-093), mirroring the auth token policy.
 */
import type {SqlExecutor} from './driver';
import {nowIso} from './driver';

/** Read one setting; resolves null when the key was never stored. */
export async function getSetting(
  db: SqlExecutor,
  key: string,
): Promise<string | null> {
  const result = await db.execute('SELECT value FROM settings WHERE key = ?', [key]);
  const row = result.rows[0];
  return row && row.value !== null ? String(row.value) : null;
}

/** Upsert one setting. */
export async function setSetting(
  db: SqlExecutor,
  key: string,
  value: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    [key, value, nowIso()],
  );
}

/** Remove one setting; deleting an absent key is not an error. */
export async function deleteSetting(
  db: SqlExecutor,
  key: string,
): Promise<void> {
  await db.execute('DELETE FROM settings WHERE key = ?', [key]);
}

/** All stored settings as a plain key/value record. */
export async function listSettings(db: SqlExecutor): Promise<Record<string, string>> {
  const result = await db.execute('SELECT key, value FROM settings ORDER BY key');
  const settings: Record<string, string> = {};
  for (const row of result.rows) {
    if (row.key !== null) {
      settings[String(row.key)] = String(row.value ?? '');
    }
  }
  return settings;
}
