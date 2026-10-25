/**
 * Sentence repository tests (TASK-SENT-004).
 *
 * Runs against real SQL (sql.js) so the aggregate counts, the duplicate-safe
 * batch insert, the due-date queries and the cascading delete are exercised the
 * way the practice screens will use them.
 */
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  applyReviewState,
  countDueSentences,
  countDueSentencesForTopic,
  countNewSentencesIntroducedToday,
  countSentenceReviewsToday,
  countSentencesInTopic,
  createSentenceTopic,
  deleteSentence,
  deleteSentenceTopic,
  getSentenceById,
  getSentenceTopicById,
  insertSentences,
  listDueSentences,
  listReviewLogForSentence,
  listSentencesByTopic,
  listSentenceTopics,
  logSentenceReview,
  recordSentenceReview,
  updateSentenceTopic,
} from '../src/db/sentenceRepository';
import type { SentenceReviewState } from '../src/db/types';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

const EARLIER = '2026-10-19T08:00:00.000Z';
const NOW = '2026-10-19T09:00:00.000Z';
const LATER = '2026-10-20T09:00:00.000Z';

async function freshDb(): Promise<SqlDriver> {
  const db = await openSqlJsDriver();
  await migrateDatabase(db);
  return db;
}

/** A review state that graduates a sentence into the day-scale schedule. */
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

/** Anki suspends a card without touching its FSRS memory state. */
async function suspend(db: SqlDriver, sentenceId: number): Promise<void> {
  await db.execute('UPDATE sentences SET suspended = 1 WHERE id = ?', [sentenceId]);
}

const CANDIDATES = [
  {
    text: 'Nice to meet you.',
    meaning: 'A greeting when you meet someone.',
    situation: 'Meeting a neighbour.',
  },
  {
    text: 'Can I get a flat white?',
    meaning: 'Ordering a coffee.',
    situation: 'At a café counter.',
  },
];

describe('sentence topics', () => {
  test('creates a topic with trimmed fields and an AUTO default level', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, {
      title: '  Meeting someone new  ',
      description: '  first day in a new city  ',
      generation_prompt: '  Use British spelling.  ',
    });

    expect(topic.title).toBe('Meeting someone new');
    expect(topic.description).toBe('first day in a new city');
    expect(topic.generation_prompt).toBe('Use British spelling.');
    expect(topic.english_level).toBe('AUTO');
    expect(await getSentenceTopicById(db, topic.id)).toEqual(topic);

    await db.close();
  });

  test('refuses a blank title', async () => {
    const db = await freshDb();
    await expect(createSentenceTopic(db, { title: '   ' })).rejects.toThrow(/needs a title/);
    await db.close();
  });

  test('lists topics newest first with sentence and due counts', async () => {
    const db = await freshDb();
    const first = await createSentenceTopic(db, { title: 'Coffee', description: '' });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 5));
    const second = await createSentenceTopic(db, { title: 'Neighbours', description: '' });

    // Pin the schedule explicitly: both coffee sentences are due at NOW, the
    // neighbour sentence only later.
    const coffeeSentences = await insertSentences(db, first.id, CANDIDATES);
    for (const sentence of coffeeSentences) {
      await applyReviewState(db, sentence.id, reviewState({ due_at: EARLIER }));
    }
    const [neighbourSentence] = await insertSentences(db, second.id, [CANDIDATES[0]]);
    await applyReviewState(db, neighbourSentence.id, reviewState({ due_at: LATER }));

    const topics = await listSentenceTopics(db, NOW);
    expect(topics.map(topic => topic.title)).toEqual(['Neighbours', 'Coffee']);
    expect(topics[0]).toMatchObject({ sentence_count: 1, due_count: 0 });
    expect(topics[1]).toMatchObject({ sentence_count: 2, due_count: 2 });

    await db.close();
  });

  test('updates title or description independently and rejects a blank title', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee', description: 'order a drink' });

    const renamed = await updateSentenceTopic(db, topic.id, { title: 'Ordering coffee' });
    expect(renamed?.title).toBe('Ordering coffee');
    expect(renamed?.description).toBe('order a drink');

    const described = await updateSentenceTopic(db, topic.id, {
      description: 'barista small talk',
    });
    expect(described?.title).toBe('Ordering coffee');
    expect(described?.description).toBe('barista small talk');

    await expect(updateSentenceTopic(db, topic.id, { title: '  ' })).rejects.toThrow(
      /needs a title/,
    );
    expect(await updateSentenceTopic(db, 9_999, { title: 'Ghost' })).toBeNull();

    await db.close();
  });

  test('creates a topic with the default learn-ahead window and clamps updates into 0–50', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    expect(topic.learn_ahead_minutes).toBe(10);
    expect(await getSentenceTopicById(db, topic.id)).toMatchObject({ learn_ahead_minutes: 10 });

    const updated = await updateSentenceTopic(db, topic.id, { learn_ahead_minutes: 30 });
    expect(updated?.learn_ahead_minutes).toBe(30);

    // Out-of-range values clamp into the bounds rather than throwing.
    expect(
      (await updateSentenceTopic(db, topic.id, { learn_ahead_minutes: 500 }))?.learn_ahead_minutes,
    ).toBe(50);
    expect(
      (await updateSentenceTopic(db, topic.id, { learn_ahead_minutes: -3 }))?.learn_ahead_minutes,
    ).toBe(0);

    // A custom value is honored on creation too.
    expect(
      (await createSentenceTopic(db, { title: 'Neighbours', learn_ahead_minutes: 0 }))
        .learn_ahead_minutes,
    ).toBe(0);

    await db.close();
  });

  test('creates a topic with Anki default daily limits and clamps updates into bounds', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    expect(topic).toMatchObject({
      new_cards_per_day: 20,
      max_reviews_per_day: 200,
      max_session_cards: 20,
    });

    const updated = await updateSentenceTopic(db, topic.id, {
      new_cards_per_day: 5,
      max_reviews_per_day: 60,
      max_session_cards: 35,
    });
    expect(updated).toMatchObject({
      new_cards_per_day: 5,
      max_reviews_per_day: 60,
      max_session_cards: 35,
    });

    // Out-of-range values clamp into each setting's bounds.
    expect(
      await updateSentenceTopic(db, topic.id, {
        new_cards_per_day: 999,
        max_reviews_per_day: 9999,
        max_session_cards: 1,
      }),
    ).toMatchObject({
      new_cards_per_day: 50,
      max_reviews_per_day: 200,
      max_session_cards: 5,
    });

    // A zero daily limit (setting the feature off) is a valid value.
    expect(
      await updateSentenceTopic(db, topic.id, { new_cards_per_day: 0, max_reviews_per_day: 0 }),
    ).toMatchObject({ new_cards_per_day: 0, max_reviews_per_day: 0 });

    await db.close();
  });

  test('deleting a topic removes its sentences and review log', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    const [sentence] = await insertSentences(db, topic.id, [CANDIDATES[1]]);
    await logSentenceReview(db, {
      sentence_id: sentence.id,
      topic_id: topic.id,
      grade: 'good',
      mode: 'dictation',
    });

    await deleteSentenceTopic(db, topic.id);

    expect(await getSentenceTopicById(db, topic.id)).toBeNull();
    expect(await getSentenceById(db, sentence.id)).toBeNull();
    expect(await listReviewLogForSentence(db, sentence.id)).toEqual([]);

    await db.close();
  });
});

describe('sentences', () => {
  test('inserts a batch as immediately due "new" sentences', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });

    const inserted = await insertSentences(db, topic.id, [
      { ...CANDIDATES[0], text: '  Nice to meet you.  ' },
      CANDIDATES[1],
    ]);

    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      text: 'Nice to meet you.',
      normalized_text: 'nice to meet you',
      state: 'new',
      suspended: false,
      reps: 0,
      lapses: 0,
      stability: 0,
      difficulty: 0,
      scheduled_days: 0,
      last_grade: '',
    });
    expect(inserted[0].due_at).toBe(inserted[0].created_at);
    expect(await countDueSentences(db, inserted[0].due_at)).toBe(2);

    await db.close();
  });

  test('skips duplicates within the batch and against stored sentences', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    await insertSentences(db, topic.id, [CANDIDATES[0]]);

    const inserted = await insertSentences(db, topic.id, [
      // Plain duplicate of a stored sentence.
      { text: 'nice to meet you', meaning: 'duplicate' },
      // Contraction/punctuation variant of the same sentence.
      { text: 'NICE TO MEET YOU!!', meaning: 'duplicate again' },
      // Duplicate of an earlier candidate in this same batch.
      { text: 'Can I get a flat white?', meaning: 'ordering coffee' },
      { text: 'can i get a flat white', meaning: 'same again' },
      // Genuinely new.
      { text: 'Could I have the bill, please?', meaning: 'Asking to pay.' },
    ]);

    expect(inserted.map(row => row.text)).toEqual([
      'Can I get a flat white?',
      'Could I have the bill, please?',
    ]);
    expect(await countSentencesInTopic(db, topic.id)).toBe(3);

    await db.close();
  });

  test('ignores blank candidates and normalises blank meanings', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });

    const inserted = await insertSentences(db, topic.id, [
      { text: '   ', meaning: 'nothing' },
      { text: '...', meaning: 'punctuation only' },
      { text: 'Thanks a lot.', meaning: '  ', situation: '  ' },
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ meaning: '', situation: '' });

    await db.close();
  });

  test('lists a topic newest first and deletes one sentence', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    const inserted = await insertSentences(db, topic.id, CANDIDATES);

    const listed = await listSentencesByTopic(db, topic.id);
    expect(listed.map(row => row.text)).toEqual(['Can I get a flat white?', 'Nice to meet you.']);

    await deleteSentence(db, inserted[0].id);
    expect(await getSentenceById(db, inserted[0].id)).toBeNull();
    expect(await countSentencesInTopic(db, topic.id)).toBe(1);

    await db.close();
  });
});

describe('due queries', () => {
  test('returns only what is due, oldest first, capped by the limit', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    const [first, second, third] = await insertSentences(db, topic.id, [
      CANDIDATES[0],
      CANDIDATES[1],
      { text: 'See you tomorrow.', meaning: 'Saying goodbye.' },
    ]);

    await applyReviewState(db, first.id, reviewState({ due_at: LATER }));
    await applyReviewState(db, second.id, reviewState({ due_at: EARLIER, state: 'review' }));
    await applyReviewState(db, third.id, reviewState({ due_at: NOW }));
    await suspend(db, third.id);

    const due = await listDueSentences(db, NOW, 10);
    expect(due.map(row => row.text)).toEqual(['Can I get a flat white?']);

    // Everything due at LATER, oldest due first, and the limit keeps the head.
    const all = await listDueSentences(db, LATER, 10);
    expect(all.map(row => [row.text, row.due_at])).toEqual([
      ['Can I get a flat white?', EARLIER],
      ['Nice to meet you.', LATER],
    ]);
    const capped = await listDueSentences(db, LATER, 1);
    expect(capped).toHaveLength(1);
    expect(capped[0].text).toBe('Can I get a flat white?');
    expect(capped[0].due_at).toBe(EARLIER);

    await db.close();
  });

  test('counts due sentences globally and per topic, excluding suspended', async () => {
    const db = await freshDb();
    const coffee = await createSentenceTopic(db, { title: 'Coffee' });
    const neighbours = await createSentenceTopic(db, { title: 'Neighbours' });

    const [coffeeSentence] = await insertSentences(db, coffee.id, [CANDIDATES[1]]);
    const [neighbourSentence] = await insertSentences(db, neighbours.id, [CANDIDATES[0]]);

    await applyReviewState(db, coffeeSentence.id, reviewState({ due_at: LATER }));
    await applyReviewState(db, neighbourSentence.id, reviewState({ due_at: EARLIER }));
    await suspend(db, neighbourSentence.id);

    expect(await countDueSentences(db, NOW)).toBe(0);
    expect(await countDueSentencesForTopic(db, coffee.id, NOW)).toBe(0);
    expect(await countDueSentencesForTopic(db, neighbours.id, NOW)).toBe(0);
    expect(await countDueSentences(db, LATER)).toBe(1);
    expect(await countDueSentencesForTopic(db, coffee.id, LATER)).toBe(1);

    await db.close();
  });
});

describe('learn-ahead due counts', () => {
  const SOON = '2026-10-19T09:05:00.000Z'; // 5 minutes after NOW
  const LATER_SOON = '2026-10-19T09:20:00.000Z'; // 20 minutes after NOW

  /** A topic whose single sentence sits in the given state, due at `due_at`. */
  async function topicWithCard(
    db: SqlDriver,
    due_at: string,
    state: 'learning' | 'relearning' | 'review',
  ) {
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    const [sentence] = await insertSentences(db, topic.id, [CANDIDATES[0]]);
    await applyReviewState(
      db,
      sentence.id,
      reviewState({ state, due_at, scheduled_days: 0, elapsed_days: 0 }),
    );
    return { topic, sentence };
  }

  test('a learning card due soon counts while inside the topic window', async () => {
    const db = await freshDb();
    const { topic } = await topicWithCard(db, SOON, 'learning');

    // Default window is 10 minutes, so the badge matches what practice serves.
    expect(await countDueSentences(db, NOW)).toBe(1);
    expect(await countDueSentencesForTopic(db, topic.id, NOW)).toBe(1);
    expect((await listSentenceTopics(db, NOW))[0]).toMatchObject({ due_count: 1 });

    // Setting the window to 0 disables it everywhere at once.
    await updateSentenceTopic(db, topic.id, { learn_ahead_minutes: 0 });
    expect(await countDueSentences(db, NOW)).toBe(0);
    expect(await countDueSentencesForTopic(db, topic.id, NOW)).toBe(0);
    expect((await listSentenceTopics(db, NOW))[0]).toMatchObject({ due_count: 0 });

    await db.close();
  });

  test('a learning card due beyond the window only counts once the window covers it', async () => {
    const db = await freshDb();
    const { topic } = await topicWithCard(db, LATER_SOON, 'relearning');

    expect(await countDueSentences(db, NOW)).toBe(0);
    await updateSentenceTopic(db, topic.id, { learn_ahead_minutes: 25 });
    expect(await countDueSentences(db, NOW)).toBe(1);

    await db.close();
  });

  test('review cards and suspended cards never count through the window', async () => {
    const db = await freshDb();
    const review = await topicWithCard(db, SOON, 'review');
    const learning = await topicWithCard(db, SOON, 'learning');

    await updateSentenceTopic(db, review.topic.id, { learn_ahead_minutes: 50 });
    await updateSentenceTopic(db, learning.topic.id, { learn_ahead_minutes: 50 });
    expect(await countDueSentences(db, NOW)).toBe(1);

    await suspend(db, learning.sentence.id);
    expect(await countDueSentences(db, NOW)).toBe(0);

    await db.close();
  });
});

describe('daily limit due counts', () => {
  // NOW is 09:00 UTC; the default rollover hour is 4, so the study day started
  // at 04:00.
  const DAY_START = '2026-10-19T04:00:00.000Z';
  const JUST_BEFORE_ROLLOVER = '2026-10-19T03:59:00.000Z';

  /** One log row with the given pre-review state and timestamp. */
  async function logReview(
    db: SqlDriver,
    sentenceId: number,
    topicId: number,
    state: string,
    reviewedAt: string,
  ) {
    await db.execute(
      `INSERT INTO sentence_review_log (sentence_id, topic_id, grade, mode, state, reviewed_at)
       VALUES (?, ?, 'good', 'dictation', ?, ?)`,
      [sentenceId, topicId, state, reviewedAt],
    );
  }

  test('caps the new-card badge at what the daily limit has left', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee', new_cards_per_day: 2 });
    const sentences = await insertSentences(db, topic.id, CANDIDATES);
    await insertSentences(db, topic.id, [
      { text: 'See you tomorrow.', meaning: 'Saying goodbye.', situation: 'Leaving.' },
    ]);
    // Pin the insertion stamps to a due time before NOW.
    await db.execute('UPDATE sentences SET due_at = ?', [EARLIER]);

    expect(await countDueSentences(db, NOW)).toBe(2);
    expect((await listSentenceTopics(db, NOW))[0]).toMatchObject({ due_count: 2 });

    // Two new cards already introduced today → the daily budget is spent.
    await logReview(db, sentences[0].id, topic.id, 'new', '2026-10-19T08:00:00.000Z');
    await logReview(db, sentences[1].id, topic.id, 'new', '2026-10-19T08:30:00.000Z');
    expect(await countDueSentences(db, NOW)).toBe(0);
    expect(await countDueSentencesForTopic(db, topic.id, NOW)).toBe(0);

    await db.close();
  });

  test('caps the review badge at max reviews per day, learning cards never capped', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee', max_reviews_per_day: 2 });
    const sentences = await insertSentences(db, topic.id, [
      ...CANDIDATES,
      { text: 'See you tomorrow.', meaning: 'Saying goodbye.', situation: 'Leaving.' },
    ]);
    for (const sentence of sentences) {
      await applyReviewState(db, sentence.id, reviewState({ due_at: EARLIER }));
    }

    expect(await countDueSentences(db, NOW)).toBe(2);

    // One review already answered today: one slot left.
    await logReview(db, sentences[0].id, topic.id, 'review', '2026-10-19T08:00:00.000Z');
    expect(await countDueSentences(db, NOW)).toBe(1);

    // A learning-step card is never limited.
    const [learning] = await insertSentences(db, topic.id, [
      { text: 'Take care.', meaning: 'A farewell.', situation: 'Leaving a friend.' },
    ]);
    await applyReviewState(
      db,
      learning.id,
      reviewState({ state: 'learning', due_at: EARLIER, scheduled_days: 0, elapsed_days: 0 }),
    );
    expect(await countDueSentences(db, NOW)).toBe(2);

    await db.close();
  });

  test('the daily counters count only rows since the given day start', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    const [sentence] = await insertSentences(db, topic.id, [CANDIDATES[0]]);

    await logReview(db, sentence.id, topic.id, 'new', JUST_BEFORE_ROLLOVER);
    expect(await countNewSentencesIntroducedToday(db, topic.id, DAY_START)).toBe(0);
    expect(await countSentenceReviewsToday(db, topic.id, DAY_START)).toBe(0);

    await logReview(db, sentence.id, topic.id, 'new', DAY_START);
    await logReview(db, sentence.id, topic.id, 'review', '2026-10-19T08:00:00.000Z');
    expect(await countNewSentencesIntroducedToday(db, topic.id, DAY_START)).toBe(1);
    expect(await countSentenceReviewsToday(db, topic.id, DAY_START)).toBe(1);

    await db.close();
  });

  test('the badge derives its day start from the srs rollover hour', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee', new_cards_per_day: 1 });
    const [sentence, other] = await insertSentences(db, topic.id, CANDIDATES);
    await db.execute('UPDATE sentences SET due_at = ?', [EARLIER]);

    // One new card already introduced before today's 04:00 rollover: it
    // belongs to yesterday's study day, so the budget is untouched.
    await logReview(db, sentence.id, topic.id, 'new', JUST_BEFORE_ROLLOVER);
    expect(await countDueSentences(db, NOW)).toBe(1);

    // The same row after the rollover spends today's budget.
    await logReview(db, other.id, topic.id, 'new', DAY_START);
    expect(await countDueSentences(db, NOW)).toBe(0);

    await db.close();
  });
});

describe('review state and log', () => {
  test('persists the scheduler state on the sentence row', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    const [sentence] = await insertSentences(db, topic.id, [CANDIDATES[0]]);

    await applyReviewState(
      db,
      sentence.id,
      reviewState({ reps: 2, scheduled_days: 2, difficulty: 5.4, stability: 4.2 }),
    );

    const reloaded = await getSentenceById(db, sentence.id);
    expect(reloaded).toMatchObject({
      state: 'review',
      suspended: false,
      reps: 2,
      lapses: 0,
      difficulty: 5.4,
      stability: 4.2,
      scheduled_days: 2,
      due_at: LATER,
      last_grade: 'good',
      last_reviewed_at: EARLIER,
    });
    // The content is untouched by a schedule update.
    expect(reloaded?.text).toBe('Nice to meet you.');
    expect(reloaded?.meaning).toBe(CANDIDATES[0].meaning);
    expect(reloaded?.situation).toBe(CANDIDATES[0].situation);

    await db.close();
  });

  test('logs reviews newest first', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    const [sentence] = await insertSentences(db, topic.id, [CANDIDATES[0]]);

    await logSentenceReview(db, {
      sentence_id: sentence.id,
      topic_id: topic.id,
      grade: 'again',
      mode: 'dictation',
      reviewed_at: EARLIER,
    });
    await logSentenceReview(db, {
      sentence_id: sentence.id,
      topic_id: topic.id,
      grade: 'good',
      mode: 'recall',
      reviewed_at: LATER,
    });

    const log = await listReviewLogForSentence(db, sentence.id);
    expect(log.map(entry => [entry.grade, entry.mode, entry.reviewed_at])).toEqual([
      ['good', 'recall', LATER],
      ['again', 'dictation', EARLIER],
    ]);

    await db.close();
  });

  test('records a graded review atomically (schedule + Anki-shaped log)', async () => {
    const db = await freshDb();
    const topic = await createSentenceTopic(db, { title: 'Coffee' });
    const [sentence] = await insertSentences(db, topic.id, [CANDIDATES[0]]);

    await recordSentenceReview(db, {
      sentence_id: sentence.id,
      topic_id: topic.id,
      grade: 'easy',
      mode: 'recall',
      state: reviewState({ state: 'review', scheduled_days: 4, due_at: LATER, last_grade: 'easy' }),
      log: {
        grade: 'easy',
        rating: 4,
        state: 'review',
        due_at: LATER,
        stability: 9.4,
        difficulty: 4.2,
        elapsed_days: 6,
        last_elapsed_days: 3,
        scheduled_days: 4,
        learning_steps: 0,
        reviewed_at: EARLIER,
      },
      review_duration_ms: 4_800,
    });

    const reloaded = await getSentenceById(db, sentence.id);
    expect(reloaded).toMatchObject({ state: 'review', scheduled_days: 4, last_grade: 'easy' });
    const log = await listReviewLogForSentence(db, sentence.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      grade: 'easy',
      rating: 4,
      state: 'review',
      mode: 'recall',
      due_at: LATER,
      stability: 9.4,
      difficulty: 4.2,
      elapsed_days: 6,
      last_elapsed_days: 3,
      scheduled_days: 4,
      review_duration_ms: 4_800,
      reviewed_at: EARLIER,
    });

    await db.close();
  });
});
