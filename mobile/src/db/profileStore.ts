/**
 * On-device learning profile storage (SPEC TASK-081).
 *
 * A single row (id = 1) holds the level. Missing rows resolve to the default
 * level deterministically, mirroring how the server mode falls back when no
 * profile exists yet (TASK-016).
 */
import type {EnglishLevel} from '../api/profile';

import type {SqlExecutor} from './driver';
import {nowIso} from './driver';
import type {LocalLearningProfile} from './types';

export const DEFAULT_LOCAL_LEVEL: EnglishLevel = 'A1';
const PROFILE_ROW_ID = 1;

/** Read the stored profile; a fresh database yields the default level. */
export async function getLearningProfile(
  db: SqlExecutor,
): Promise<LocalLearningProfile> {
  const result = await db.execute(
    'SELECT id, level, updated_at FROM learning_profile WHERE id = ?',
    [PROFILE_ROW_ID],
  );
  const row = result.rows[0];
  if (!row) {
    return {level: DEFAULT_LOCAL_LEVEL, updated_at: ''};
  }
  return {
    level: String(row.level ?? DEFAULT_LOCAL_LEVEL) as EnglishLevel,
    updated_at: String(row.updated_at ?? ''),
  };
}

/** Persist the level as the single profile row and return the stored value. */
export async function saveLearningProfile(
  db: SqlExecutor,
  level: EnglishLevel,
): Promise<LocalLearningProfile> {
  const timestamp = nowIso();
  // INSERT OR REPLACE for pre-3.24 SQLite compatibility (no UPSERT).
  await db.execute(
    `INSERT OR REPLACE INTO learning_profile (id, level, updated_at) VALUES (?, ?, ?)`,
    [PROFILE_ROW_ID, level, timestamp],
  );
  return {level, updated_at: timestamp};
}
