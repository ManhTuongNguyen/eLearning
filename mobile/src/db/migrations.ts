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
 * Version 6: FSRS scheduling (TASK-SENT-015).
 *
 * Replaces the hand-written ease/interval scheduler with the FSRS card fields
 * used by `ts-fsrs` (the model Anki ships): stability, difficulty, elapsed and
 * scheduled days, learning steps, and a four-state card. Suspension becomes
 * Anki's boolean flag instead of a state, so a suspended card keeps its memory
 * state.
 *
 * The `sentences` and `sentence_review_log` tables are rebuilt in place because
 * SQLite cannot add `CHECK` constraints or widen the old ones. The rebuild is
 * ordered for SQLite < 3.25 (some Android 9 devices): the old child table is
 * dropped before its parent, and the new log is created (with a live foreign
 * key) only after the new parent has its final name. Legacy rows are preserved;
 * a reviewed card seeds FSRS stability from its old interval and gets neutral
 * difficulty, so its spacing survives the upgrade. Pre-v6 log rows keep their
 * old grade but get `rating = 0`, `state = 'new'` and zeroed FSRS fields, so the
 * optimizer export can skip history that predates FSRS.
 *
 * `srs_config` is the single-row collection config: the FSRS weight preset
 * (space-separated, empty = package default), Anki's deck-preset knobs, and the
 * local study-day rollover hour (4 a.m. by default).
 */
const MIGRATION_006: readonly string[] = [
  `CREATE TABLE sentences_fsrs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES sentence_topics (id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      meaning TEXT NOT NULL DEFAULT '',
      situation TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'new'
        CHECK (state IN ('new', 'learning', 'review', 'relearning')),
      suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      stability REAL NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 0,
      elapsed_days INTEGER NOT NULL DEFAULT 0,
      scheduled_days INTEGER NOT NULL DEFAULT 0,
      learning_steps INTEGER NOT NULL DEFAULT 0,
      due_at TEXT NOT NULL,
      last_grade TEXT NOT NULL DEFAULT ''
        CHECK (last_grade IN ('', 'again', 'hard', 'good', 'easy')),
      last_reviewed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
   )`,
  `INSERT INTO sentences_fsrs
      (id, topic_id, text, normalized_text, meaning, situation, state, suspended,
       reps, lapses, stability, difficulty, elapsed_days, scheduled_days,
       learning_steps, due_at, last_grade, last_reviewed_at, created_at, updated_at)
   SELECT id, topic_id, text, normalized_text, meaning, situation,
          CASE status
            WHEN 'suspended' THEN 'new'
            WHEN 'learning' THEN 'learning'
            WHEN 'review' THEN 'review'
            ELSE 'new'
          END,
          CASE status WHEN 'suspended' THEN 1 ELSE 0 END,
          reps, lapses,
          -- Seed the FSRS memory state from the old SM-2 interval so an
          -- existing review card keeps roughly its current spacing, and use a
          -- neutral difficulty. New/learning cards have interval 0.
          interval_days, 5, 0,
          CAST(ROUND(interval_days) AS INTEGER), 0,
          due_at, last_grade, last_reviewed_at, created_at, updated_at
     FROM sentences`,
  // Temporary log table without a foreign key: it must survive the parent
  // rebuild without depending on rename-time FK rewriting.
  `CREATE TABLE sentence_review_log_fsrs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sentence_id INTEGER NOT NULL,
      topic_id INTEGER NOT NULL,
      grade TEXT NOT NULL CHECK (grade IN ('again', 'hard', 'good', 'easy')),
      rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 4),
      state TEXT NOT NULL DEFAULT 'new'
        CHECK (state IN ('new', 'learning', 'review', 'relearning')),
      mode TEXT NOT NULL CHECK (mode IN ('dictation', 'recall')),
      due_at TEXT NOT NULL DEFAULT '',
      stability REAL NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 0,
      elapsed_days INTEGER NOT NULL DEFAULT 0,
      last_elapsed_days INTEGER NOT NULL DEFAULT 0,
      scheduled_days INTEGER NOT NULL DEFAULT 0,
      learning_steps INTEGER NOT NULL DEFAULT 0,
      review_duration_ms INTEGER NOT NULL DEFAULT 0,
      reviewed_at TEXT NOT NULL
   )`,
  `INSERT INTO sentence_review_log_fsrs
      (id, sentence_id, topic_id, grade, rating, state, mode, due_at, stability,
       difficulty, elapsed_days, last_elapsed_days, scheduled_days,
       learning_steps, review_duration_ms, reviewed_at)
   SELECT id, sentence_id, topic_id, grade,
          -- 0 = not an FSRS rating: pre-v6 history is kept for display but the
          -- optimizer export filters it out.
          0,
          'new', mode, '', 0, 0, 0, 0, 0, 0, 0, reviewed_at
     FROM sentence_review_log`,
  `DROP TABLE sentence_review_log`,
  `DROP TABLE sentences`,
  `ALTER TABLE sentences_fsrs RENAME TO sentences`,
  `CREATE TABLE sentence_review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sentence_id INTEGER NOT NULL REFERENCES sentences (id) ON DELETE CASCADE,
      topic_id INTEGER NOT NULL,
      grade TEXT NOT NULL CHECK (grade IN ('again', 'hard', 'good', 'easy')),
      rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 4),
      state TEXT NOT NULL DEFAULT 'new'
        CHECK (state IN ('new', 'learning', 'review', 'relearning')),
      mode TEXT NOT NULL CHECK (mode IN ('dictation', 'recall')),
      due_at TEXT NOT NULL DEFAULT '',
      stability REAL NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 0,
      elapsed_days INTEGER NOT NULL DEFAULT 0,
      last_elapsed_days INTEGER NOT NULL DEFAULT 0,
      scheduled_days INTEGER NOT NULL DEFAULT 0,
      learning_steps INTEGER NOT NULL DEFAULT 0,
      review_duration_ms INTEGER NOT NULL DEFAULT 0,
      reviewed_at TEXT NOT NULL
   )`,
  `INSERT INTO sentence_review_log
      (id, sentence_id, topic_id, grade, rating, state, mode, due_at, stability,
       difficulty, elapsed_days, last_elapsed_days, scheduled_days,
       learning_steps, review_duration_ms, reviewed_at)
   SELECT id, sentence_id, topic_id, grade, rating, state, mode, due_at,
          stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days,
          learning_steps, review_duration_ms, reviewed_at
     FROM sentence_review_log_fsrs`,
  `DROP TABLE sentence_review_log_fsrs`,
  `CREATE UNIQUE INDEX idx_sentences_topic_normalized
      ON sentences (topic_id, normalized_text)`,
  `CREATE INDEX idx_sentences_topic ON sentences (topic_id, due_at)`,
  `CREATE INDEX idx_sentences_due ON sentences (due_at)`,
  `CREATE INDEX idx_sentences_topic_state ON sentences (topic_id, state, suspended)`,
  `CREATE INDEX idx_sentence_review_log_sentence
      ON sentence_review_log (sentence_id, reviewed_at)`,
  `CREATE INDEX idx_sentence_review_log_reviewed
      ON sentence_review_log (reviewed_at)`,
  `CREATE TABLE srs_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model_version TEXT NOT NULL DEFAULT 'FSRS-6',
      weights TEXT NOT NULL DEFAULT '',
      desired_retention REAL NOT NULL DEFAULT 0.9
        CHECK (desired_retention > 0 AND desired_retention <= 1),
      maximum_interval INTEGER NOT NULL DEFAULT 36500
        CHECK (maximum_interval > 0),
      enable_fuzz INTEGER NOT NULL DEFAULT 1 CHECK (enable_fuzz IN (0, 1)),
      enable_short_term INTEGER NOT NULL DEFAULT 1 CHECK (enable_short_term IN (0, 1)),
      learning_steps TEXT NOT NULL DEFAULT '1m 10m',
      relearning_steps TEXT NOT NULL DEFAULT '10m',
      rollover_hour INTEGER NOT NULL DEFAULT 4 CHECK (rollover_hour BETWEEN 0 AND 23),
      updated_at TEXT NOT NULL
   )`,
  `INSERT INTO srs_config
      (id, model_version, weights, desired_retention, maximum_interval,
       enable_fuzz, enable_short_term, learning_steps, relearning_steps,
       rollover_hour, updated_at)
   VALUES (1, 'FSRS-6', '', 0.9, 36500, 1, 1, '1m 10m', '10m', 4,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
];

/**
 * Version 7: the word bank (WORD_BANK_V1 TASK-WB-001).
 *
 * `word_topics` holds learner-created vocabulary topics whose description is
 * free-form learner context and whose `extra_prompt` is an optional additional
 * AI instruction. `words` stores the dictionary facts verbatim as JSON in the
 * API's own shape (`senses_json`, `phonetics_json`), so enrichment can replace
 * the senses wholesale and the change-review modal can diff structurally.
 * `data_status='missing'` marks a word kept without dictionary data (transient
 * API error at generation); it is excluded from practice until a fetch fills
 * it. The FSRS review-state columns and the review log mirror the sentence
 * tables (migration v6) so words share the scheduler, the collection config
 * and the revlog shape. Audio URLs are deliberately not stored: word audio is
 * device TTS only.
 */
const MIGRATION_007: readonly string[] = [
  `CREATE TABLE word_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      extra_prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES word_topics (id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      phonetics_json TEXT NOT NULL DEFAULT '[]',
      senses_json TEXT NOT NULL DEFAULT '[]',
      data_source TEXT NOT NULL DEFAULT 'dictionary'
        CHECK (data_source IN ('dictionary', 'enriched')),
      enriched_at TEXT,
      data_status TEXT NOT NULL DEFAULT 'missing'
        CHECK (data_status IN ('complete', 'missing')),
      state TEXT NOT NULL DEFAULT 'new'
        CHECK (state IN ('new', 'learning', 'review', 'relearning')),
      suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      stability REAL NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 0,
      elapsed_days INTEGER NOT NULL DEFAULT 0,
      scheduled_days INTEGER NOT NULL DEFAULT 0,
      learning_steps INTEGER NOT NULL DEFAULT 0,
      due_at TEXT NOT NULL,
      last_grade TEXT NOT NULL DEFAULT ''
        CHECK (last_grade IN ('', 'again', 'hard', 'good', 'easy')),
      last_reviewed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX idx_words_topic_normalized
      ON words (topic_id, normalized_text)`,
  `CREATE INDEX idx_words_topic ON words (topic_id, due_at)`,
  `CREATE INDEX idx_words_due ON words (due_at)`,
  `CREATE INDEX idx_words_topic_state ON words (topic_id, state, suspended)`,
  `CREATE TABLE word_review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id INTEGER NOT NULL REFERENCES words (id) ON DELETE CASCADE,
      topic_id INTEGER NOT NULL,
      grade TEXT NOT NULL CHECK (grade IN ('again', 'hard', 'good', 'easy')),
      rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 4),
      state TEXT NOT NULL DEFAULT 'new'
        CHECK (state IN ('new', 'learning', 'review', 'relearning')),
      mode TEXT NOT NULL CHECK (mode IN ('dictation', 'recall')),
      due_at TEXT NOT NULL DEFAULT '',
      stability REAL NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 0,
      elapsed_days INTEGER NOT NULL DEFAULT 0,
      last_elapsed_days INTEGER NOT NULL DEFAULT 0,
      scheduled_days INTEGER NOT NULL DEFAULT 0,
      learning_steps INTEGER NOT NULL DEFAULT 0,
      review_duration_ms INTEGER NOT NULL DEFAULT 0,
      reviewed_at TEXT NOT NULL
   )`,
  `CREATE INDEX idx_word_review_log_word
      ON word_review_log (word_id, reviewed_at)`,
  `CREATE INDEX idx_word_review_log_reviewed
      ON word_review_log (reviewed_at)`,
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
  MIGRATION_006,
  MIGRATION_007,
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
