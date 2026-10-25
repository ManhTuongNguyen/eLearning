/**
 * Sentence schema tests (TASK-SENT-003, TASK-SENT-015).
 *
 * Migration v4 adds the sentence bank on top of the shipped serverless schema,
 * v5 adds advanced generation guidance, and v6 rebuilds the sentence tables for
 * FSRS (card memory state, Anki's suspension flag, revlog columns and the
 * `srs_config` weights row). These tests run against real SQL (sql.js) and prove
 * the properties the rest of the feature depends on: a fresh install creates
 * every object and the Anki defaults, a v3 database upgrades without losing
 * conversations, a v5 sentence bank upgrades without losing sentences or
 * history, and topic deletion cascades through sentences and the review log.
 */
import type { SqlDriver } from '../src/db/driver';
import { insertMessage, listMessages } from '../src/db/messageStore';
import { MIGRATIONS, migrateDatabase, SCHEMA_VERSION } from '../src/db/migrations';
import { insertSession, listSessions } from '../src/db/sessionStore';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

const NOW = '2026-10-19T09:00:00.000Z';

async function userVersion(db: SqlDriver): Promise<number> {
  const result = await db.execute('PRAGMA user_version');
  return Number(result.rows[0]?.user_version ?? 0);
}

async function schemaNames(db: SqlDriver, type: 'table' | 'index'): Promise<string[]> {
  const result = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`,
  );
  return result.rows.map(row => String(row.name));
}

async function insertTopic(db: SqlDriver, title = 'Meeting someone new'): Promise<number> {
  const result = await db.execute(
    `INSERT INTO sentence_topics (title, description, english_level, created_at, updated_at)
     VALUES (?, ?, 'AUTO', ?, ?)`,
    [title, 'first day in a new city', NOW, NOW],
  );
  return Number(result.insertId);
}

async function insertSentence(
  db: SqlDriver,
  topicId: number,
  text: string,
  normalized: string,
): Promise<number> {
  const result = await db.execute(
    `INSERT INTO sentences
       (topic_id, text, normalized_text, meaning, situation, due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [topicId, text, normalized, 'say hello', 'meeting a neighbour', NOW, NOW, NOW],
  );
  return Number(result.insertId);
}

async function countRows(db: SqlDriver, table: string): Promise<number> {
  const result = await db.execute(`SELECT COUNT(*) AS total FROM ${table}`);
  return Number(result.rows[0]?.total ?? -1);
}

describe('sentence schema (TASK-SENT-003, TASK-SENT-015)', () => {
  test('a fresh database creates the sentence bank and records version 10', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    expect(SCHEMA_VERSION).toBe(10);
    expect(await userVersion(db)).toBe(10);

    const tables = await schemaNames(db, 'table');
    expect(tables).toEqual(
      expect.arrayContaining(['sentence_topics', 'sentences', 'sentence_review_log', 'srs_config']),
    );

    const indexes = await schemaNames(db, 'index');
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_sentences_topic_normalized',
        'idx_sentences_topic',
        'idx_sentences_due',
        'idx_sentences_topic_state',
        'idx_sentence_review_log_sentence',
        'idx_sentence_review_log_reviewed',
      ]),
    );

    await db.close();
  });

  test('a fresh database stores Anki/FSRS defaults in srs_config', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    const result = await db.execute(
      `SELECT model_version, weights, desired_retention, maximum_interval,
              enable_fuzz, enable_short_term, learning_steps, relearning_steps,
              rollover_hour
         FROM srs_config WHERE id = 1`,
    );
    expect(result.rows[0]).toMatchObject({
      model_version: 'FSRS-6',
      weights: '',
      desired_retention: 0.9,
      maximum_interval: 36500,
      enable_fuzz: 1,
      enable_short_term: 1,
      learning_steps: '1m 10m',
      relearning_steps: '10m',
      rollover_hour: 4,
    });

    await db.close();
  });

  test('a version 3 database upgrades to the current schema without losing conversations', async () => {
    const db = await openSqlJsDriver();
    // Install only the migrations that existed before the sentence bank.
    await migrateDatabase(db, MIGRATIONS.slice(0, 3));
    expect(await userVersion(db)).toBe(3);

    const session = await insertSession(db, { title: 'Trip to Da Nang', topic: 'travel' });
    await insertMessage(db, {
      session_id: session.id,
      role: 'user',
      status: 'complete',
      content: 'I want to talk about my trip.',
    });

    await migrateDatabase(db);

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const sessions = await listSessions(db);
    expect(sessions.map(item => item.title)).toEqual(['Trip to Da Nang']);
    const messages = await listMessages(db, session.id);
    expect(messages.map(message => message.content)).toEqual(['I want to talk about my trip.']);

    // The new tables and the v5 column are usable after the upgrade.
    const topicId = await insertTopic(db);
    expect(
      await insertSentence(db, topicId, 'Nice to meet you.', 'nice to meet you'),
    ).toBeGreaterThan(0);
    const topicRow = await db.execute(
      'SELECT generation_prompt FROM sentence_topics WHERE id = ?',
      [topicId],
    );
    expect(topicRow.rows[0]?.generation_prompt).toBe('');

    await db.close();
  });

  test('an existing v5 sentence bank upgrades to FSRS without losing rows', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db, MIGRATIONS.slice(0, 5));
    expect(await userVersion(db)).toBe(5);

    const topicId = await insertTopic(db);
    await db.execute(
      `INSERT INTO sentences
         (id, topic_id, text, normalized_text, meaning, situation, status, reps, lapses,
          ease, interval_days, due_at, last_grade, last_reviewed_at, created_at, updated_at)
       VALUES (10, ?, 'Nice to meet you.', 'nice to meet you', '', '', 'review', 4, 1,
               2.3, 6.4, ?, 'good', ?, ?, ?)`,
      [topicId, NOW, NOW, NOW, NOW],
    );
    await db.execute(
      `INSERT INTO sentences
         (id, topic_id, text, normalized_text, meaning, situation, status, reps, lapses,
          ease, interval_days, due_at, last_grade, last_reviewed_at, created_at, updated_at)
       VALUES (11, ?, 'Is this seat taken?', 'is this seat taken', '', '', 'suspended', 2, 0,
               2.5, 0, ?, 'again', ?, ?, ?)`,
      [topicId, NOW, NOW, NOW, NOW],
    );
    await db.execute(
      `INSERT INTO sentence_review_log (sentence_id, topic_id, grade, mode, reviewed_at)
       VALUES (10, ?, 'good', 'recall', ?)`,
      [topicId, NOW],
    );

    await migrateDatabase(db);

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const sentences = await db.execute(
      `SELECT id, state, suspended, stability, difficulty, elapsed_days, scheduled_days,
              learning_steps, last_reviewed_at, last_grade
         FROM sentences ORDER BY id`,
    );
    expect(sentences.rows[0]).toMatchObject({
      id: 10,
      state: 'review',
      suspended: 0,
      // The old SM-2 interval seeds FSRS stability (in days); difficulty is
      // neutral because the old schema did not track it.
      stability: 6.4,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 6,
      learning_steps: 0,
      last_reviewed_at: NOW,
      last_grade: 'good',
    });
    // The old `suspended` state becomes Anki's flag; with no interval there is
    // no stability to carry over.
    expect(sentences.rows[1]).toMatchObject({
      id: 11,
      state: 'new',
      suspended: 1,
      stability: 0,
    });

    const log = await db.execute(
      `SELECT grade, rating, state, mode, reviewed_at
         FROM sentence_review_log`,
    );
    expect(log.rows[0]).toMatchObject({
      grade: 'good',
      rating: 0,
      state: 'new',
      mode: 'recall',
      reviewed_at: NOW,
    });

    await db.close();
  });

  test('an existing v7 sentence bank gains the learn-ahead column with the default', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db, MIGRATIONS.slice(0, 7));
    expect(await userVersion(db)).toBe(7);

    const topicId = await insertTopic(db);

    await migrateDatabase(db);

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const topicRow = await db.execute(
      'SELECT learn_ahead_minutes FROM sentence_topics WHERE id = ?',
      [topicId],
    );
    // Existing topics pick up the shipped default (kept in sync with
    // DEFAULT_LEARN_AHEAD_MINUTES in src/srs/session.ts).
    expect(topicRow.rows[0]?.learn_ahead_minutes).toBe(10);

    await db.close();
  });

  test('an existing v8 sentence bank gains the daily limit columns with Anki defaults', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db, MIGRATIONS.slice(0, 8));
    expect(await userVersion(db)).toBe(8);

    const topicId = await insertTopic(db);

    await migrateDatabase(db);

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const topicRow = await db.execute(
      'SELECT new_cards_per_day, max_reviews_per_day, max_session_cards FROM sentence_topics WHERE id = ?',
      [topicId],
    );
    // Defaults kept in sync with the DEFAULT_* constants in src/srs/session.ts.
    expect(topicRow.rows[0]).toMatchObject({
      new_cards_per_day: 20,
      max_reviews_per_day: 200,
      max_session_cards: 20,
    });

    await db.close();
  });

  test('deleting a topic cascades to its sentences and review log', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    const topicId = await insertTopic(db);
    const sentenceId = await insertSentence(db, topicId, 'Nice to meet you.', 'nice to meet you');
    await db.execute(
      `INSERT INTO sentence_review_log (sentence_id, topic_id, grade, mode, reviewed_at)
       VALUES (?, ?, 'good', 'dictation', ?)`,
      [sentenceId, topicId, NOW],
    );

    const otherTopicId = await insertTopic(db, 'Ordering coffee');
    await insertSentence(db, otherTopicId, 'Can I get a flat white?', 'can i get a flat white');

    await db.execute('DELETE FROM sentence_topics WHERE id = ?', [topicId]);

    expect(await countRows(db, 'sentences')).toBe(1);
    expect(await countRows(db, 'sentence_review_log')).toBe(0);
    expect(await countRows(db, 'sentence_topics')).toBe(1);

    await db.close();
  });

  test('the duplicate key is unique per topic, and shared across topics', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    const first = await insertTopic(db, 'Meeting someone new');
    const second = await insertTopic(db, 'Small talk at work');
    await insertSentence(db, first, 'Nice to meet you.', 'nice to meet you');

    await expect(
      insertSentence(db, first, 'Nice to meet you!', 'nice to meet you'),
    ).rejects.toThrow();

    // The same sentence may legitimately belong to another topic.
    await expect(
      insertSentence(db, second, 'Nice to meet you.', 'nice to meet you'),
    ).resolves.toBeGreaterThan(0);

    await db.close();
  });

  test('the schema rejects unknown review states, grades and card modes', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    const topicId = await insertTopic(db);
    const sentenceId = await insertSentence(db, topicId, 'Nice to meet you.', 'nice to meet you');

    await expect(
      db.execute(
        `INSERT INTO sentences
           (topic_id, text, normalized_text, state, due_at, created_at, updated_at)
         VALUES (?, 'Hello.', 'hello', 'mastered', ?, ?, ?)`,
        [topicId, NOW, NOW, NOW],
      ),
    ).rejects.toThrow();

    await expect(
      db.execute(
        `INSERT INTO sentence_review_log (sentence_id, topic_id, grade, mode, reviewed_at)
         VALUES (?, ?, 'perfect', 'dictation', ?)`,
        [sentenceId, topicId, NOW],
      ),
    ).rejects.toThrow();

    await expect(
      db.execute(
        `INSERT INTO sentence_review_log (sentence_id, topic_id, grade, mode, reviewed_at)
         VALUES (?, ?, 'good', 'telepathy', ?)`,
        [sentenceId, topicId, NOW],
      ),
    ).rejects.toThrow();

    await db.close();
  });
});
