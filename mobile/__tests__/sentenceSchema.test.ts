/**
 * Sentence schema tests (TASK-SENT-003).
 *
 * Migration v4 adds the sentence bank on top of the shipped serverless schema
 * and v5 adds advanced generation guidance, so these tests run against real SQL
 * (sql.js) and prove the three properties the rest of the feature depends on: a
 * fresh install creates every object, an existing v3 database upgrades without
 * losing conversations, and topic deletion cascades through sentences and the
 * review log.
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

describe('sentence schema (TASK-SENT-003)', () => {
  test('a fresh database creates the sentence bank and records version 5', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    expect(SCHEMA_VERSION).toBe(5);
    expect(await userVersion(db)).toBe(5);

    const tables = await schemaNames(db, 'table');
    expect(tables).toEqual(
      expect.arrayContaining(['sentence_topics', 'sentences', 'sentence_review_log']),
    );

    const indexes = await schemaNames(db, 'index');
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_sentences_topic_normalized',
        'idx_sentences_topic',
        'idx_sentences_due',
        'idx_sentence_review_log_sentence',
      ]),
    );

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
           (topic_id, text, normalized_text, status, due_at, created_at, updated_at)
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
