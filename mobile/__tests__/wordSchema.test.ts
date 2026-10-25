/**
 * Word bank schema tests (WORD_BANK_V1 TASK-WB-001).
 *
 * Migration v7 adds the word bank on top of the shipped schema: `word_topics`,
 * `words` (dictionary JSON + FSRS review state) and `word_review_log`. These
 * tests run against real SQL (sql.js) and prove the properties the rest of the
 * feature depends on: a fresh install creates every object, a v6 database
 * upgrades without losing sentence data, topic deletion cascades through words
 * and the review log, and the JSON columns round-trip through the typed
 * helpers without throwing on malformed content.
 */
import { MIGRATIONS, migrateDatabase, SCHEMA_VERSION } from '../src/db/migrations';
import { parseWordPhonetics, parseWordSenses, type WordSense } from '../src/db/types';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

const NOW = '2026-10-24T09:00:00.000Z';
const SENSES_JSON = JSON.stringify([
  {
    partOfSpeech: 'noun',
    definitions: [
      { definition: 'An institution that holds money.', example: 'I need to go to the bank.' },
      { definition: 'The land alongside a river.' },
    ],
  },
  {
    partOfSpeech: 'verb',
    definitions: [{ definition: 'To rely on.', example: 'You can bank on it.' }],
  },
]);

async function userVersion(db: Awaited<ReturnType<typeof openSqlJsDriver>>): Promise<number> {
  const result = await db.execute('PRAGMA user_version');
  return Number(result.rows[0]?.user_version ?? 0);
}

async function schemaNames(
  db: Awaited<ReturnType<typeof openSqlJsDriver>>,
  type: 'table' | 'index',
): Promise<string[]> {
  const result = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`,
  );
  return result.rows.map(row => String(row.name));
}

async function insertTopic(db: Awaited<ReturnType<typeof openSqlJsDriver>>): Promise<number> {
  const result = await db.execute(
    `INSERT INTO word_topics (title, description, extra_prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['Cooking', "I'm a chef, I often read cooking blogs", 'focus on kitchen verbs', NOW, NOW],
  );
  return Number(result.insertId);
}

async function insertWord(
  db: Awaited<ReturnType<typeof openSqlJsDriver>>,
  topicId: number,
  overrides: Record<string, string | number | null> = {},
): Promise<number> {
  const columns: Record<string, string | number | null> = {
    topic_id: topicId,
    text: 'bank',
    normalized_text: 'bank',
    phonetics_json: JSON.stringify(['/bæŋk/']),
    senses_json: SENSES_JSON,
    data_source: 'dictionary',
    data_status: 'complete',
    state: 'new',
    due_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  const keys = Object.keys(columns);
  const result = await db.execute(
    `INSERT INTO words (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map(key => columns[key]),
  );
  return Number(result.insertId);
}

async function countRows(
  db: Awaited<ReturnType<typeof openSqlJsDriver>>,
  table: string,
): Promise<number> {
  const result = await db.execute(`SELECT COUNT(*) AS total FROM ${table}`);
  return Number(result.rows[0]?.total ?? -1);
}

describe('word bank schema (TASK-WB-001)', () => {
  test('a fresh database creates the word bank and records version 9', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    expect(SCHEMA_VERSION).toBe(9);
    expect(await userVersion(db)).toBe(9);

    const tables = await schemaNames(db, 'table');
    expect(tables).toEqual(expect.arrayContaining(['word_topics', 'words', 'word_review_log']));

    const indexes = await schemaNames(db, 'index');
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_words_topic_normalized',
        'idx_words_topic',
        'idx_words_due',
        'idx_words_topic_state',
        'idx_word_review_log_word',
        'idx_word_review_log_reviewed',
      ]),
    );

    await db.close();
  });

  test('a version 6 database upgrades to 7 without losing sentence data', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db, MIGRATIONS.slice(0, 6));
    expect(await userVersion(db)).toBe(6);

    const topicResult = await db.execute(
      `INSERT INTO sentence_topics (title, description, english_level, created_at, updated_at)
       VALUES (?, ?, 'AUTO', ?, ?)`,
      ['Meeting someone new', 'first day in a new city', NOW, NOW],
    );
    const sentenceTopicId = Number(topicResult.insertId);
    await db.execute(
      `INSERT INTO sentences
         (topic_id, text, normalized_text, meaning, situation, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sentenceTopicId, 'Nice to meet you.', 'nice to meet you', '', '', NOW, NOW, NOW],
    );

    await migrateDatabase(db);

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const sentences = await db.execute('SELECT text FROM sentences');
    expect(sentences.rows.map(row => String(row.text))).toEqual(['Nice to meet you.']);

    // The new tables are usable after the upgrade, and an explicit
    // `extra_prompt`/`data_status` round-trips through a plain insert.
    const wordTopicId = await insertTopic(db);
    const wordId = await insertWord(db, wordTopicId, { enriched_at: null });
    const wordRow = await db.execute(
      `SELECT text, phonetics_json, senses_json, data_source, data_status, state, suspended
         FROM words WHERE id = ?`,
      [wordId],
    );
    expect(wordRow.rows[0]).toMatchObject({
      text: 'bank',
      phonetics_json: JSON.stringify(['/bæŋk/']),
      senses_json: SENSES_JSON,
      data_source: 'dictionary',
      data_status: 'complete',
      state: 'new',
      suspended: 0,
    });
    const topicRow = await db.execute('SELECT extra_prompt FROM word_topics WHERE id = ?', [
      wordTopicId,
    ]);
    expect(topicRow.rows[0]?.extra_prompt).toBe('focus on kitchen verbs');

    await db.close();
  });

  test('an existing v7 word bank gains the learn-ahead column with the default', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db, MIGRATIONS.slice(0, 7));
    expect(await userVersion(db)).toBe(7);

    const wordTopicId = await insertTopic(db);

    await migrateDatabase(db);

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const row = await db.execute('SELECT learn_ahead_minutes FROM word_topics WHERE id = ?', [
      wordTopicId,
    ]);
    expect(row.rows[0]?.learn_ahead_minutes).toBe(10);

    await db.close();
  });

  test('an existing v8 word bank gains the daily limit columns with Anki defaults', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db, MIGRATIONS.slice(0, 8));
    expect(await userVersion(db)).toBe(8);

    const wordTopicId = await insertTopic(db);

    await migrateDatabase(db);

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const row = await db.execute(
      'SELECT new_cards_per_day, max_reviews_per_day, max_session_cards FROM word_topics WHERE id = ?',
      [wordTopicId],
    );
    expect(row.rows[0]).toMatchObject({
      new_cards_per_day: 20,
      max_reviews_per_day: 200,
      max_session_cards: 20,
    });

    await db.close();
  });

  test('the duplicate key is unique per topic but shared across topics', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    const first = await insertTopic(db);
    const second = await db.execute(
      `INSERT INTO word_topics (title, description, created_at, updated_at)
       VALUES ('Finance', '', ?, ?)`,
      [NOW, NOW],
    );

    await insertWord(db, first);
    await expect(
      insertWord(db, first, { text: 'BANK', normalized_text: 'bank' }),
    ).rejects.toThrow();
    await expect(insertWord(db, Number(second.insertId))).resolves.toBeGreaterThan(0);

    await db.close();
  });

  test('the schema rejects unknown data sources, data statuses and grades', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    const topicId = await insertTopic(db);

    await expect(insertWord(db, topicId, { data_source: 'ai' })).rejects.toThrow();
    await expect(insertWord(db, topicId, { data_status: 'partial' })).rejects.toThrow();
    await expect(insertWord(db, topicId, { last_grade: 'perfect' })).rejects.toThrow();

    await db.close();
  });

  test('deleting a word topic cascades to its words and review log', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    const topicId = await insertTopic(db);
    const wordId = await insertWord(db, topicId);
    await db.execute(
      `INSERT INTO word_review_log (word_id, topic_id, grade, rating, state, mode, reviewed_at)
       VALUES (?, ?, 'good', 3, 'review', 'recall', ?)`,
      [wordId, topicId, NOW],
    );

    const otherTopicId = await db.execute(
      `INSERT INTO word_topics (title, description, created_at, updated_at)
       VALUES ('Travel', '', ?, ?)`,
      [NOW, NOW],
    );
    await insertWord(db, Number(otherTopicId.insertId), {
      text: 'passport',
      normalized_text: 'passport',
    });

    await db.execute('DELETE FROM word_topics WHERE id = ?', [topicId]);

    expect(await countRows(db, 'words')).toBe(1);
    expect(await countRows(db, 'word_review_log')).toBe(0);
    expect(await countRows(db, 'word_topics')).toBe(1);

    await db.close();
  });

  test('deleting a word removes its review-log rows but keeps the topic', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    const topicId = await insertTopic(db);
    const wordId = await insertWord(db, topicId);
    await db.execute(
      `INSERT INTO word_review_log (word_id, topic_id, grade, rating, state, mode, reviewed_at)
       VALUES (?, ?, 'again', 1, 'learning', 'dictation', ?)`,
      [wordId, topicId, NOW],
    );

    await db.execute('DELETE FROM words WHERE id = ?', [wordId]);

    expect(await countRows(db, 'words')).toBe(0);
    expect(await countRows(db, 'word_review_log')).toBe(0);
    expect(await countRows(db, 'word_topics')).toBe(1);

    await db.close();
  });
});

describe('word JSON helpers (TASK-WB-001)', () => {
  test('parseWordSenses round-trips the API shape', () => {
    const senses: WordSense[] = [
      {
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'An institution that holds money.', example: 'I went to the bank.' },
          { definition: 'The land alongside a river.' },
        ],
      },
      { partOfSpeech: 'verb', definitions: [{ definition: 'To rely on.' }] },
    ];
    expect(parseWordSenses(JSON.stringify(senses))).toEqual(senses);
    // Already-parsed values pass through unchanged.
    expect(parseWordSenses(senses)).toEqual(senses);
  });

  test('parseWordSenses preserves tags, extra examples and relations', () => {
    const rich = JSON.stringify([
      {
        partOfSpeech: 'adjective',
        synonyms: ['large', 'huge'],
        antonyms: ['little'],
        definitions: [
          {
            definition: 'Of great size.',
            example: 'A big house.',
            extraExamples: ['Big deal.'],
            tags: ['informal', 'UK'],
            synonyms: ['ample'],
            antonyms: ['tiny'],
          },
        ],
      },
    ]);
    expect(parseWordSenses(rich)).toEqual([
      {
        partOfSpeech: 'adjective',
        synonyms: ['large', 'huge'],
        antonyms: ['little'],
        definitions: [
          {
            definition: 'Of great size.',
            example: 'A big house.',
            extraExamples: ['Big deal.'],
            tags: ['informal', 'UK'],
            synonyms: ['ample'],
            antonyms: ['tiny'],
          },
        ],
      },
    ]);
    // Malformed optional fields are dropped, valid ones survive.
    expect(
      parseWordSenses(
        JSON.stringify([
          {
            partOfSpeech: 'noun',
            synonyms: ['ok', '', 42, null],
            definitions: [
              { definition: 'Valid.', tags: 'not-an-array', extraExamples: [1, 'kept'] },
            ],
          },
        ]),
      ),
    ).toEqual([
      {
        partOfSpeech: 'noun',
        synonyms: ['ok'],
        definitions: [{ definition: 'Valid.', extraExamples: ['kept'] }],
      },
    ]);
  });

  test('parseWordSenses yields safe defaults for malformed content', () => {
    expect(parseWordSenses('not json at all')).toEqual([]);
    expect(parseWordSenses('{"senses": []}')).toEqual([]);
    expect(parseWordSenses(null)).toEqual([]);
    expect(parseWordSenses(42)).toEqual([]);
    // Malformed entries are skipped; valid ones survive.
    const mixed = JSON.stringify([
      'garbage',
      { partOfSpeech: 'noun', definitions: [{ definition: 'Valid.' }] },
      { partOfSpeech: '', definitions: [{ definition: 'No POS, dropped.' }] },
      { partOfSpeech: 'verb', definitions: [] },
      { partOfSpeech: 'verb', definitions: [{ definition: '   ' }, 'oops'] },
    ]);
    expect(parseWordSenses(mixed)).toEqual([
      { partOfSpeech: 'noun', definitions: [{ definition: 'Valid.' }] },
    ]);
    // Missing example and whitespace-only example are normalized away.
    expect(
      parseWordSenses(
        JSON.stringify([
          { partOfSpeech: 'noun', definitions: [{ definition: ' D ', example: '   ' }] },
        ]),
      ),
    ).toEqual([{ partOfSpeech: 'noun', definitions: [{ definition: 'D' }] }]);
  });

  test('parseWordPhonetics round-trips IPA strings and defaults safely', () => {
    expect(parseWordPhonetics(JSON.stringify(['/bæŋk/', '/bæŋks/']))).toEqual([
      '/bæŋk/',
      '/bæŋks/',
    ]);
    expect(parseWordPhonetics('[]')).toEqual([]);
    expect(parseWordPhonetics('broken')).toEqual([]);
    expect(parseWordPhonetics(JSON.stringify(['', '/ok/', 7, null]))).toEqual(['/ok/']);
    expect(parseWordPhonetics(undefined)).toEqual([]);
  });
});
