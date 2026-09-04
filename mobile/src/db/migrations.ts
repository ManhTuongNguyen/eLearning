/**
 * Schema migrations with integer versioning for the local database
 * (SPEC TASK-081).
 *
 * `MIGRATIONS[v - 1]` upgrades the schema from version v-1 to v; the applied
 * version is persisted in SQLite's `user_version` pragma, so an existing
 * database only ever replays the migrations it has not seen yet.
 */

import type {SqlDriver} from './driver';

/** Version 1: initial serverless schema (sessions/messages/summaries/profile/settings). */
const MIGRATION_001: readonly string[] = [
  `CREATE TABLE learning_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      level TEXT NOT NULL DEFAULT 'A1'
        CHECK (level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'AUTO')),
      updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      topic_hint TEXT NOT NULL DEFAULT '',
      learning_level TEXT NOT NULL DEFAULT 'A1'
        CHECK (learning_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'AUTO')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX idx_sessions_updated_at ON sessions (updated_at)`,
  `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      status TEXT NOT NULL DEFAULT 'complete'
        CHECK (status IN ('pending', 'complete', 'failed')),
      content TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, sequence)
   )`,
  `CREATE INDEX idx_messages_session ON messages (session_id, sequence)`,
  `CREATE TABLE summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL UNIQUE REFERENCES sessions (id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      message_boundary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
];

/**
 * Version 2: cached grammar improvements (opt-in auto-check + manual action).
 * The improvement of a fixed text never changes, so it is stored on the
 * message row: reopening a conversation (or the app) restores badges and
 * suggestions with zero provider calls, and repeating a check for the same
 * message never re-generates.
 */
const MIGRATION_002: readonly string[] = [
  `ALTER TABLE messages ADD COLUMN improvement_content TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE messages ADD COLUMN improvement_explanation TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE messages ADD COLUMN improvement_severity TEXT NOT NULL DEFAULT ''
     CHECK (improvement_severity IN ('', 'none', 'minor', 'critical'))`,
];

/**
 * Ordered migration list; length is the current schema version. Append new
 * entries — never edit shipped ones.
 */
export const MIGRATIONS: readonly (readonly string[])[] = [MIGRATION_001, MIGRATION_002];

export const SCHEMA_VERSION: number = MIGRATIONS.length;

async function readUserVersion(db: SqlDriver): Promise<number> {
  const result = await db.execute('PRAGMA user_version');
  return Number(result.rows[0]?.user_version ?? 0);
}

/**
 * Bring the database up to `migrations.length`. Each pending version applies
 * atomically: a failed migration rolls back its statements and leaves the
 * recorded version untouched so the same migration can be retried.
 */
export async function migrateDatabase(
  db: SqlDriver,
  migrations: readonly (readonly string[])[] = MIGRATIONS,
): Promise<void> {
  const currentVersion = await readUserVersion(db);

  for (let version = currentVersion + 1; version <= migrations.length; version++) {
    await applyMigration(db, version, migrations[version - 1]);
  }
}

/** Apply one migration version atomically and record it as applied. */
async function applyMigration(
  db: SqlDriver,
  version: number,
  statements: readonly string[],
): Promise<void> {
  await db.transaction(async tx => {
    for (const statement of statements) {
      await tx.execute(statement);
    }
    // PRAGMAs cannot take bound parameters; the value is an internal
    // constant derived from the migration list, never user input.
    await tx.execute(`PRAGMA user_version = ${version}`);
  });
}
