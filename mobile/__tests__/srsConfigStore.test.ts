/**
 * FSRS collection config + optimizer export tests (TASK-SENT-015).
 *
 * The config table is the only mutable scheduling input, so these tests pin the
 * Anki defaults a fresh install gets, the round trip of an optimized weight set,
 * and the shape of the review history the offline optimizer consumes.
 */
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import { createSentenceTopic, insertSentences } from '../src/db/sentenceRepository';
import {
  getSrsConfig,
  listReviewHistoryForOptimization,
  saveSrsConfig,
} from '../src/db/srsConfigStore';
import { DEFAULT_FSRS_CONFIG } from '../src/srs/config';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

async function freshDb(): Promise<SqlDriver> {
  const db = await openSqlJsDriver();
  await migrateDatabase(db);
  return db;
}

async function seedReview(
  db: SqlDriver,
  sentenceId: number,
  topicId: number,
  reviewedAt: string,
  rating: number,
): Promise<void> {
  await db.execute(
    `INSERT INTO sentence_review_log
       (sentence_id, topic_id, grade, rating, state, mode, due_at, stability,
        difficulty, elapsed_days, last_elapsed_days, scheduled_days,
        learning_steps, review_duration_ms, reviewed_at)
     VALUES (?, ?, ?, ?, 'review', 'recall', '', 4.2, 5.1, 6, 3, 11, 0, 4200, ?)`,
    [
      sentenceId,
      topicId,
      rating === 1 ? 'again' : rating === 2 ? 'hard' : rating === 3 ? 'good' : 'easy',
      rating,
      reviewedAt,
    ],
  );
}

describe('getSrsConfig', () => {
  test('a fresh install returns the Anki/FSRS defaults', async () => {
    const db = await freshDb();

    await expect(getSrsConfig(db)).resolves.toMatchObject({
      ...DEFAULT_FSRS_CONFIG,
      modelVersion: 'FSRS-6',
    });

    await db.close();
  });
});

describe('saveSrsConfig', () => {
  test('round-trips an optimized weight set and the Anki knobs', async () => {
    const db = await freshDb();
    const weights = Array.from({ length: 21 }, (_, index) => index / 10 + 0.1);

    const saved = await saveSrsConfig(db, {
      weights,
      desiredRetention: 0.85,
      maximumInterval: 1000,
      enableFuzz: false,
      enableShortTerm: false,
      learningSteps: ['2m', '15m'],
      relearningSteps: ['5m'],
      rolloverHour: 3,
    });

    expect(saved).toMatchObject({
      weights,
      desiredRetention: 0.85,
      maximumInterval: 1000,
      enableFuzz: false,
      enableShortTerm: false,
      learningSteps: ['2m', '15m'],
      relearningSteps: ['5m'],
      rolloverHour: 3,
    });
    expect(saved.updatedAt).not.toBe('');

    // The same single row comes back, including the serialised weights.
    const reloaded = await getSrsConfig(db);
    expect(reloaded.weights).toEqual(weights);
    expect(reloaded.learningSteps).toEqual(['2m', '15m']);
    expect(reloaded.rolloverHour).toBe(3);
    const count = await db.execute('SELECT COUNT(*) AS total FROM srs_config');
    expect(Number(count.rows[0]?.total)).toBe(1);

    await db.close();
  });

  test('clamps invalid values instead of persisting a broken schedule', async () => {
    const db = await freshDb();

    const saved = await saveSrsConfig(db, {
      desiredRetention: 4,
      maximumInterval: 0,
      rolloverHour: 99,
    });

    expect(saved.desiredRetention).toBe(DEFAULT_FSRS_CONFIG.desiredRetention);
    expect(saved.maximumInterval).toBe(DEFAULT_FSRS_CONFIG.maximumInterval);
    expect(saved.rolloverHour).toBe(DEFAULT_FSRS_CONFIG.rolloverHour);

    await db.close();
  });

  test('empty weights and steps normalise to the package and Anki defaults', async () => {
    const db = await freshDb();

    const saved = await saveSrsConfig(db, { weights: [], learningSteps: [] });

    expect(saved.weights).toBeNull();
    expect(saved.learningSteps).toEqual(DEFAULT_FSRS_CONFIG.learningSteps);
    const reloaded = await getSrsConfig(db);
    expect(reloaded.weights).toBeNull();
    expect(reloaded.learningSteps).toEqual(DEFAULT_FSRS_CONFIG.learningSteps);

    await db.close();
  });
});

describe('listReviewHistoryForOptimization', () => {
  test('returns FSRS-rated reviews oldest first and skips legacy rows', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    const sentences = await insertSentences(db, topic.id, [
      { text: 'First sentence.', meaning: '', situation: '' },
      { text: 'Second sentence.', meaning: '', situation: '' },
    ]);

    await seedReview(db, sentences[0].id, topic.id, '2026-10-01T09:00:00.000Z', 3);
    await seedReview(db, sentences[1].id, topic.id, '2026-10-02T09:00:00.000Z', 1);
    // Pre-v6 history: kept for display but not usable for training.
    await seedReview(db, sentences[0].id, topic.id, '2026-10-03T09:00:00.000Z', 0);

    const history = await listReviewHistoryForOptimization(db);

    expect(history).toHaveLength(2);
    expect(history.map(row => row.rating)).toEqual([3, 1]);
    expect(history[0]).toMatchObject({
      card_id: sentences[0].id,
      topic_id: topic.id,
      review_time: Date.parse('2026-10-01T09:00:00.000Z'),
      state: 'review',
      grade: 'good',
      elapsed_days: 6,
      last_elapsed_days: 3,
      scheduled_days: 11,
      stability: 4.2,
      difficulty: 5.1,
      review_duration_ms: 4200,
    });

    await db.close();
  });

  test('filters by topic and honours the limit', async () => {
    const db = await freshDb();
    const first = await createSentenceTopic(db, { title: 'Coffee' });
    const second = await createSentenceTopic(db, { title: 'Directions' });
    const [firstSentence] = await insertSentences(db, first.id, [
      { text: 'Flat white, please.', meaning: '', situation: '' },
    ]);
    const [secondSentence] = await insertSentences(db, second.id, [
      { text: 'Turn left.', meaning: '', situation: '' },
    ]);

    await seedReview(db, firstSentence.id, first.id, '2026-10-01T09:00:00.000Z', 3);
    await seedReview(db, firstSentence.id, first.id, '2026-10-02T09:00:00.000Z', 3);
    await seedReview(db, secondSentence.id, second.id, '2026-10-03T09:00:00.000Z', 3);

    const coffee = await listReviewHistoryForOptimization(db, { topicId: first.id, limit: 1 });

    expect(coffee).toHaveLength(1);
    expect(coffee[0].card_id).toBe(firstSentence.id);

    await db.close();
  });
});
