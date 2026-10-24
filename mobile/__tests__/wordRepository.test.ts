/**
 * Word repository tests (WORD_BANK_V1 TASK-WB-002).
 *
 * Runs against real SQL (sql.js) so the aggregate counts, the duplicate-safe
 * batch insert, the due-date queries (which exclude suspended and dataless
 * words) and the cascading deletes are exercised the way the practice screens
 * will use them.
 */
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import type { SentenceReviewState, WordSense } from '../src/db/types';
import {
  applyWordReviewState,
  countDueWords,
  countDueWordsForTopic,
  createWordTopic,
  deleteWord,
  deleteWordTopic,
  fillWordDictionaryData,
  getWordById,
  getWordByText,
  getWordTopicById,
  insertWords,
  insertWordsWith,
  listDueWords,
  listWordReviewLog,
  listWordsByTopic,
  listWordTopics,
  logWordReview,
  recordWordReview,
  updateWordTopic,
} from '../src/db/wordRepository';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

const EARLIER = '2026-10-24T08:00:00.000Z';
const NOW = '2026-10-24T09:00:00.000Z';
const LATER = '2026-10-25T09:00:00.000Z';

async function freshDb(): Promise<SqlDriver> {
  const db = await openSqlJsDriver();
  await migrateDatabase(db);
  return db;
}

/** A review state that graduates a word into the day-scale schedule. */
function reviewState(overrides: Partial<SentenceReviewState> = {}): SentenceReviewState {
  return {
    state: 'review',
    reps: 1,
    lapses: 0,
    stability: 3.5,
    difficulty: 5.1,
    elapsed_days: 1,
    scheduled_days: 1,
    learning_steps: 0,
    due_at: LATER,
    last_grade: 'good',
    last_reviewed_at: EARLIER,
    ...overrides,
  };
}

const SENSES: WordSense[] = [
  {
    partOfSpeech: 'noun',
    definitions: [
      { definition: 'An institution that holds money.', example: 'I went to the bank.' },
      { definition: 'The land alongside a river.' },
    ],
  },
];

const WORD_A = { text: 'bank', senses_json: SENSES, phonetics_json: ['/bæŋk/'] };
const WORD_B = { text: 'simmer', senses_json: SENSES, phonetics_json: ['/ˈsɪmər/'] };

describe('word topics', () => {
  test('creates a topic with trimmed fields and defaults', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, {
      title: '  Cooking  ',
      description: "  I'm a chef, I often read cooking blogs  ",
    });

    expect(topic.title).toBe('Cooking');
    expect(topic.description).toBe("I'm a chef, I often read cooking blogs");
    expect(topic.extra_prompt).toBe('');
    expect(topic.created_at).toBeTruthy();

    await expect(createWordTopic(db, { title: '   ' })).rejects.toThrow();
    await db.close();
  });

  test('lists topics newest first with word and due counts', async () => {
    const db = await freshDb();
    const first = await createWordTopic(db, { title: 'Cooking' });
    await createWordTopic(db, { title: 'Travel' });

    await insertWords(db, first.id, [{ text: 'simmer', senses_json: SENSES }]);
    // insertWords stamps due_at with the real clock; pin it to a known past
    // instant so the due count is deterministic.
    await db.execute('UPDATE words SET due_at = ?', [EARLIER]);

    const topics = await listWordTopics(db, NOW);
    expect(topics.map(item => item.title)).toEqual(['Travel', 'Cooking']);
    expect(topics[1].word_count).toBe(1);
    expect(topics[1].due_count).toBe(1);
    expect(topics[0].word_count).toBe(0);

    await db.close();
  });

  test('gets, updates and deletes a topic', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, { title: 'Cooking', description: 'chefs' });

    const fetched = await getWordTopicById(db, topic.id);
    expect(fetched?.title).toBe('Cooking');
    expect(await getWordTopicById(db, 999)).toBeNull();

    const updated = await updateWordTopic(db, topic.id, {
      title: 'Kitchen English',
      description: 'blog reading',
      extra_prompt: 'focus on verbs',
    });
    expect(updated).toMatchObject({
      title: 'Kitchen English',
      description: 'blog reading',
      extra_prompt: 'focus on verbs',
    });
    await expect(updateWordTopic(db, topic.id, { title: '  ' })).rejects.toThrow();
    // A no-op patch keeps the row and does not bump updated_at.
    const untouched = await updateWordTopic(db, topic.id, {});
    expect(untouched?.updated_at).toBe(updated?.updated_at);

    await deleteWordTopic(db, topic.id);
    expect(await getWordTopicById(db, topic.id)).toBeNull();

    await db.close();
  });
});

describe('inserting words', () => {
  test('inserts a batch in one transaction and is duplicate-safe', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, { title: 'Cooking' });

    const inserted = await insertWords(db, topic.id, [
      WORD_A,
      { text: 'BANK', senses_json: [] }, // same normalised text, in-batch duplicate
      WORD_B,
      { text: '   ', senses_json: [] }, // empty, skipped
    ]);
    expect(inserted.map(word => word.text)).toEqual(['bank', 'simmer']);
    expect(inserted[0]).toMatchObject({
      topic_id: topic.id,
      normalized_text: 'bank',
      data_source: 'dictionary',
      data_status: 'complete',
      state: 'new',
      suspended: false,
      due_at: inserted[0].created_at,
      enriched_at: null,
    });

    // An existing word keeps its row untouched; casing of the stored text is
    // whatever the first insert kept.
    const secondBatch = await insertWords(db, topic.id, [{ text: 'Bank', senses_json: SENSES }]);
    expect(secondBatch).toEqual([]);

    const rows = await listWordsByTopic(db, topic.id);
    expect(rows.map(row => row.text)).toEqual(['simmer', 'bank']);

    await db.close();
  });

  test('inserts dataless candidates and strips surrounding punctuation', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, { title: 'Cooking' });

    const [missing] = await insertWords(db, topic.id, [{ text: 'blanch', data_status: 'missing' }]);
    expect(missing.data_status).toBe('missing');
    expect(missing.senses_json).toEqual([]);
    expect(missing.phonetics_json).toEqual([]);

    const [punctuated] = await insertWordsWith(db, topic.id, [{ text: '"whisk"' }]);
    expect(punctuated.normalized_text).toBe('whisk');

    await db.close();
  });

  test('a failed batch insert leaves nothing behind', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, { title: 'Cooking' });
    await insertWords(db, topic.id, [WORD_A]);

    // A duplicate against an existing row is skipped silently; an unknown
    // topic violates the foreign key and must leave nothing behind.
    await expect(insertWords(db, 999, [{ text: 'simmer' }])).rejects.toThrow();

    const rows = await listWordsByTopic(db, topic.id);
    expect(rows.map(row => row.text)).toEqual(['bank']);

    await db.close();
  });
});

describe('word lookups and duplicates', () => {
  test('gets a word by id and deletes it with its review log', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [WORD_A]);
    await logWordReview(db, {
      word_id: word.id,
      topic_id: topic.id,
      grade: 'good',
      mode: 'dictation',
      reviewed_at: NOW,
    });

    const fetched = await getWordById(db, word.id);
    expect(fetched?.senses_json).toEqual(SENSES);
    expect(fetched?.phonetics_json).toEqual(['/bæŋk/']);
    expect(await getWordById(db, 999)).toBeNull();

    await deleteWord(db, word.id);
    expect(await getWordById(db, word.id)).toBeNull();
    expect(await listWordReviewLog(db, word.id)).toEqual([]);

    await db.close();
  });

  test('getWordByText finds cross-topic duplicates with the topic title', async () => {
    const db = await freshDb();
    const cooking = await createWordTopic(db, { title: 'Cooking' });
    const travel = await createWordTopic(db, { title: 'Travel' });
    await insertWords(db, cooking.id, [WORD_A]);

    const hint = await getWordByText(db, 'Bank', { excludeTopicId: travel.id });
    expect(hint?.topic_title).toBe('Cooking');
    expect(hint?.word.text).toBe('bank');

    // The topic's own rows are excluded: inserting into the same topic is the
    // repository's duplicate-skip, not a cross-topic hint.
    expect(await getWordByText(db, 'bank', { excludeTopicId: cooking.id })).toBeNull();
    expect(await getWordByText(db, 'passport')).toBeNull();
    expect(await getWordByText(db, '   ')).toBeNull();

    await db.close();
  });

  test('fillWordDictionaryData flips a missing word to complete', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [{ text: 'blanch', data_status: 'missing' }]);

    const updated = await fillWordDictionaryData(db, word.id, {
      senses_json: SENSES,
      phonetics_json: ['/blɑːntʃ/'],
    });
    expect(updated).toMatchObject({
      data_status: 'complete',
      data_source: 'dictionary',
      state: 'new',
    });
    expect(updated?.senses_json).toEqual(SENSES);
    expect(updated?.phonetics_json).toEqual(['/blɑːntʃ/']);
    expect(
      await fillWordDictionaryData(db, 999, { senses_json: [], phonetics_json: [] }),
    ).toBeNull();

    await db.close();
  });
});

describe('due queries', () => {
  test('counts and lists due words, excluding suspended and missing words', async () => {
    const db = await freshDb();
    const cooking = await createWordTopic(db, { title: 'Cooking' });
    const travel = await createWordTopic(db, { title: 'Travel' });

    await insertWords(db, cooking.id, [WORD_A, WORD_B]);
    await insertWords(db, travel.id, [{ text: 'passport', senses_json: SENSES }]);

    // A future-due word, a suspended word and a dataless word are not due.
    const rows = await listWordsByTopic(db, cooking.id);
    await db.execute('UPDATE words SET due_at = ?', [EARLIER]);
    await applyWordReviewState(db, rows[1].id, reviewState({ due_at: LATER }));
    await db.execute('UPDATE words SET suspended = 1 WHERE id = ?', [rows[0].id]);
    await insertWords(db, cooking.id, [{ text: 'blanch', data_status: 'missing' }]);

    expect(await countDueWords(db, NOW)).toBe(1);
    expect(await countDueWordsForTopic(db, cooking.id, NOW)).toBe(0);
    expect(await countDueWordsForTopic(db, travel.id, NOW)).toBe(1);

    const due = await listDueWords(db, NOW, 20);
    expect(due.map(word => word.text)).toEqual(['passport']);

    await db.close();
  });

  test('listDueWords honours the limit and oldest-due order', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, { title: 'Cooking' });
    await insertWords(db, topic.id, [
      { text: 'simmer', senses_json: SENSES },
      { text: 'whisk', senses_json: SENSES },
      { text: 'sear', senses_json: SENSES },
    ]);
    await db.execute('UPDATE words SET due_at = ?', [EARLIER]);

    const limited = await listDueWords(db, NOW, 2);
    expect(limited.length).toBe(2);
    expect(limited[0].due_at <= limited[1].due_at).toBe(true);

    await db.close();
  });
});

describe('review state and log', () => {
  test('applies review state and records the log atomically', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [WORD_A]);

    await recordWordReview(db, {
      word_id: word.id,
      topic_id: topic.id,
      grade: 'good',
      mode: 'dictation',
      state: reviewState(),
      log: {
        grade: 'good',
        rating: 3,
        state: 'new',
        due_at: LATER,
        stability: 3.5,
        difficulty: 5.1,
        elapsed_days: 0,
        last_elapsed_days: 0,
        scheduled_days: 1,
        learning_steps: 0,
        reviewed_at: EARLIER,
      },
      review_duration_ms: 4200,
    });

    const reviewed = await getWordById(db, word.id);
    expect(reviewed).toMatchObject({
      state: 'review',
      stability: 3.5,
      difficulty: 5.1,
      due_at: LATER,
      last_grade: 'good',
    });

    const log = await listWordReviewLog(db, word.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      word_id: word.id,
      topic_id: topic.id,
      grade: 'good',
      rating: 3,
      state: 'new',
      mode: 'dictation',
      scheduled_days: 1,
      review_duration_ms: 4200,
      reviewed_at: EARLIER,
    });

    // A bare log row (no FSRS fields, e.g. from an older caller) still lands.
    await logWordReview(db, {
      word_id: word.id,
      topic_id: topic.id,
      grade: 'again',
      mode: 'recall',
    });
    expect(await listWordReviewLog(db, word.id)).toHaveLength(2);

    await db.close();
  });

  test('applyWordReviewState keeps content columns untouched', async () => {
    const db = await freshDb();
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [WORD_A]);

    await applyWordReviewState(
      db,
      word.id,
      reviewState({ state: 'relearning', last_grade: 'again' }),
    );

    const reviewed = await getWordById(db, word.id);
    expect(reviewed?.state).toBe('relearning');
    expect(reviewed?.senses_json).toEqual(SENSES);
    expect(reviewed?.text).toBe('bank');

    await db.close();
  });
});
