/**
 * Schema migrations with integer versioning for the local database
 * (SPEC TASK-081).
 *
 * `MIGRATIONS[v - 1]` upgrades the schema from version v-1 to v; the applied
 * version is persisted in SQLite's `user_version` pragma, so an existing
 * database only ever replays the migrations it has not seen yet.
 */

import type { SqlDriver } from './driver';

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
 * Version 3: local speaking-practice history (TASK-101/102). One row per
 * completed read-aloud session, shown by SpeakingHistoryScreen.
 */
const MIGRATION_003: readonly string[] = [
  `CREATE TABLE speaking_practice_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      raw_prompt TEXT NOT NULL DEFAULT '',
      english_level TEXT NOT NULL DEFAULT 'A1'
        CHECK (english_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'AUTO')),
      text TEXT NOT NULL DEFAULT '',
      minutes INTEGER NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX idx_speaking_history_user ON speaking_practice_history (user_id, created_at)`,
];

/**
 * Version 4: real-life sentence bank and its spaced-repetition state
 * (TASK-SENT-003).
 *
 * A topic holds the situations the learner wants to talk about; each sentence
 * holds the English text, an English meaning, the real-life situation, and its
 * own review schedule. `normalized_text` is the duplicate key (unique per
 * topic) and the review log is an append-only trail used for stats.
 */
const MIGRATION_004: readonly string[] = [
  `CREATE TABLE sentence_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      english_level TEXT NOT NULL DEFAULT 'AUTO'
        CHECK (english_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'AUTO')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE sentences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES sentence_topics (id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      meaning TEXT NOT NULL DEFAULT '',
      situation TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'learning', 'review', 'suspended')),
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      ease REAL NOT NULL DEFAULT 2.5,
      interval_days REAL NOT NULL DEFAULT 0,
      due_at TEXT NOT NULL,
      last_grade TEXT NOT NULL DEFAULT ''
        CHECK (last_grade IN ('', 'again', 'good', 'easy')),
      last_reviewed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE UNIQUE INDEX idx_sentences_topic_normalized
      ON sentences (topic_id, normalized_text)`,
  `CREATE INDEX idx_sentences_topic ON sentences (topic_id, due_at)`,
  `CREATE INDEX idx_sentences_due ON sentences (due_at)`,
  `CREATE TABLE sentence_review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sentence_id INTEGER NOT NULL REFERENCES sentences (id) ON DELETE CASCADE,
      topic_id INTEGER NOT NULL,
      grade TEXT NOT NULL CHECK (grade IN ('again', 'good', 'easy')),
      mode TEXT NOT NULL CHECK (mode IN ('dictation', 'recall')),
      reviewed_at TEXT NOT NULL
    )`,
  `CREATE INDEX idx_sentence_review_log_sentence
      ON sentence_review_log (sentence_id, reviewed_at)`,
];

/**
 * Version 5: optional learner guidance for sentence generation.
 *
 * The advanced "generation instructions" field on a topic is stored with the
 * topic (not on each request) so generating later batches keeps the same
 * guidance. It is plain user context; the prompt builder treats it as
 * untrusted data.
 */
const MIGRATION_005: readonly string[] = [
  `ALTER TABLE sentence_topics ADD COLUMN generation_prompt TEXT NOT NULL DEFAULT ''`,
];

/**
 * Ordered migration list; length is the current schema version. Append new
 * entries — never edit shipped ones.
 */
export const MIGRATIONS: readonly (readonly string[])[] = [
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
  MIGRATION_005,
];

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
