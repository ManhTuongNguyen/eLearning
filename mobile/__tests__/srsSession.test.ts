/**
 * Practice-session tests (TASK-SENT-012, TASK-SENT-015, SENTENCE_LIVE_V1 §2.3).
 *
 * The pure session module decides which cards a learner sees and what a grade
 * does to the queue. These tests pin the due-only filter, the order, the
 * session cap, Anki's learn-ahead window and daily deck limits, and the
 * FSRS/Anki rule that a card only leaves the session once it graduates to
 * `review`.
 */
import type { SentenceRecord } from '../src/db/types';
import {
  applyPracticeGrade,
  buildPracticeSession,
  clampLearnAheadMinutes,
  clampMaxReviewsPerDay,
  clampMaxSessionCards,
  clampNewCardsPerDay,
  createPracticeSessionState,
  DEFAULT_LEARN_AHEAD_MINUTES,
  DEFAULT_MAX_REVIEWS_PER_DAY,
  DEFAULT_MAX_SESSION_CARDS,
  DEFAULT_NEW_CARDS_PER_DAY,
  MAX_LEARN_AHEAD_MINUTES,
  MAX_PRACTICE_SESSION_CARDS,
} from '../src/srs/session';

const NOW = new Date('2026-10-19T09:00:00.000Z');

function sentence(id: number, overrides: Partial<SentenceRecord> = {}): SentenceRecord {
  return {
    id,
    topic_id: 1,
    text: `Sentence ${id}`,
    normalized_text: `sentence ${id}`,
    meaning: `Meaning ${id}`,
    situation: `Situation ${id}`,
    state: 'new',
    suspended: false,
    reps: 0,
    lapses: 0,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    due_at: '2026-10-19T08:00:00.000Z',
    last_grade: '',
    last_reviewed_at: '',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildPracticeSession', () => {
  test('keeps only due, non-suspended sentences in due order then id order', () => {
    const cards = [
      sentence(1, { due_at: '2026-10-19T08:30:00.000Z' }),
      sentence(2, { due_at: '2026-10-19T08:00:00.000Z' }),
      sentence(3, { due_at: '2026-10-19T08:00:00.000Z' }),
      sentence(4, { due_at: '2026-10-19T12:00:00.000Z' }),
      sentence(5, { suspended: true, due_at: '2026-10-19T07:00:00.000Z' }),
    ];

    expect(buildPracticeSession(cards, NOW).map(card => card.id)).toEqual([2, 3, 1]);
  });

  test('caps the session at 20 cards by default and honours a custom cap', () => {
    const cards = Array.from({ length: 25 }, (_, index) => sentence(index + 1));

    expect(MAX_PRACTICE_SESSION_CARDS).toBe(20);
    expect(DEFAULT_MAX_SESSION_CARDS).toBe(20);
    expect(buildPracticeSession(cards, NOW)).toHaveLength(20);
    expect(buildPracticeSession(cards, NOW, { maxCards: 3 }).map(card => card.id)).toEqual([
      1, 2, 3,
    ]);
  });

  test('never mutates the input array', () => {
    const cards = [
      sentence(1, { due_at: '2026-10-19T08:30:00.000Z' }),
      sentence(2, { due_at: '2026-10-19T08:00:00.000Z' }),
    ];
    const snapshot = cards.map(card => card.id);

    buildPracticeSession(cards, NOW);

    expect(cards.map(card => card.id)).toEqual(snapshot);
  });

  test('returns an empty queue when nothing is due', () => {
    expect(
      buildPracticeSession([sentence(1, { due_at: '2026-10-20T09:00:00.000Z' })], NOW),
    ).toEqual([]);
  });
});

describe('buildPracticeSession — learn-ahead window', () => {
  test('pulls a learning card due within the window, after every due-now card', () => {
    const cards = [
      sentence(1, { state: 'learning', due_at: '2026-10-19T09:05:00.000Z' }),
      sentence(2, { state: 'relearning', due_at: '2026-10-19T09:09:00.000Z' }),
      sentence(3, { due_at: '2026-10-19T08:30:00.000Z' }),
    ];

    // With a 10-minute window both short-term cards are due soon enough; the
    // due-now card still comes first (Anki serves ahead cards only once the
    // main queue is empty).
    expect(
      buildPracticeSession(cards, NOW, { learnAheadMinutes: 10 }).map(card => card.id),
    ).toEqual([3, 1, 2]);
    // Exactly-at-the-window counts too.
    expect(buildPracticeSession(cards, NOW, { learnAheadMinutes: 5 }).map(card => card.id)).toEqual(
      [3, 1],
    );
  });

  test('never pulls a review or new card ahead', () => {
    const cards = [
      sentence(1, { state: 'review', due_at: '2026-10-19T09:05:00.000Z' }),
      sentence(2, { state: 'new', due_at: '2026-10-19T09:05:00.000Z' }),
    ];

    expect(buildPracticeSession(cards, NOW, { learnAheadMinutes: 50 })).toEqual([]);
  });

  test('a learning card due beyond the window stays out', () => {
    const cards = [sentence(1, { state: 'learning', due_at: '2026-10-19T09:11:00.000Z' })];

    expect(buildPracticeSession(cards, NOW, { learnAheadMinutes: 10 })).toEqual([]);
    // 0 disables the window entirely.
    expect(buildPracticeSession(cards, NOW, { learnAheadMinutes: 0 })).toEqual([]);
    expect(
      buildPracticeSession(
        [sentence(2, { state: 'learning', due_at: '2026-10-19T09:02:00.000Z' })],
        NOW,
        { learnAheadMinutes: 0 },
      ),
    ).toEqual([]);
  });

  test('ahead cards only fill the session after the cap has room for them', () => {
    const cards = [
      sentence(1, { due_at: '2026-10-19T08:00:00.000Z' }),
      sentence(2, { due_at: '2026-10-19T08:10:00.000Z' }),
      sentence(3, { state: 'learning', due_at: '2026-10-19T09:01:00.000Z' }),
    ];

    expect(
      buildPracticeSession(cards, NOW, { maxCards: 2, learnAheadMinutes: 10 }).map(card => card.id),
    ).toEqual([1, 2]);
  });

  test('suspended cards and words without dictionary data stay out of the ahead window too', () => {
    const cards = [
      sentence(1, { state: 'learning', suspended: true, due_at: '2026-10-19T09:01:00.000Z' }),
    ];
    const datalessWord = {
      ...sentence(2, { state: 'learning', due_at: '2026-10-19T09:01:00.000Z' }),
      data_status: 'missing' as const,
    };

    expect(buildPracticeSession(cards, NOW, { learnAheadMinutes: 10 })).toEqual([]);
    expect(buildPracticeSession([datalessWord], NOW, { learnAheadMinutes: 10 })).toEqual([]);
  });
});

describe('buildPracticeSession — Anki daily deck limits', () => {
  test('caps how many new cards the session may introduce', () => {
    const cards = [
      sentence(1, { state: 'new', due_at: '2026-10-19T08:00:00.000Z' }),
      sentence(2, { state: 'new', due_at: '2026-10-19T08:10:00.000Z' }),
      sentence(3, { state: 'new', due_at: '2026-10-19T08:20:00.000Z' }),
    ];

    expect(buildPracticeSession(cards, NOW, { newRemaining: 2 }).map(card => card.id)).toEqual([
      1, 2,
    ]);
    // 0 hides every remaining new card for the day.
    expect(buildPracticeSession(cards, NOW, { newRemaining: 0 })).toEqual([]);
  });

  test('caps how many review cards the session may show', () => {
    const cards = [
      sentence(1, { state: 'review', due_at: '2026-10-19T08:00:00.000Z' }),
      sentence(2, { state: 'review', due_at: '2026-10-19T08:10:00.000Z' }),
    ];

    expect(buildPracticeSession(cards, NOW, { reviewRemaining: 1 }).map(card => card.id)).toEqual([
      1,
    ]);
    expect(buildPracticeSession(cards, NOW, { reviewRemaining: 0 })).toEqual([]);
  });

  test('learning-step cards are never limited (Anki does not limit intraday learning)', () => {
    const cards = [
      sentence(1, { state: 'learning', due_at: '2026-10-19T08:00:00.000Z' }),
      sentence(2, { state: 'relearning', due_at: '2026-10-19T08:10:00.000Z' }),
    ];

    expect(
      buildPracticeSession(cards, NOW, { newRemaining: 0, reviewRemaining: 0 }).map(
        card => card.id,
      ),
    ).toEqual([1, 2]);
  });

  test('a mixed pool keeps due order across the surviving categories', () => {
    const cards = [
      sentence(1, { state: 'review', due_at: '2026-10-19T08:00:00.000Z' }),
      sentence(2, { state: 'new', due_at: '2026-10-19T08:05:00.000Z' }),
      sentence(3, { state: 'learning', due_at: '2026-10-19T08:10:00.000Z' }),
      sentence(4, { state: 'new', due_at: '2026-10-19T08:15:00.000Z' }),
      sentence(5, { state: 'review', due_at: '2026-10-19T08:20:00.000Z' }),
    ];

    // One new and one review slot left: the oldest of each category shows, the
    // learning card always shows, and the result stays in due order.
    expect(
      buildPracticeSession(cards, NOW, { newRemaining: 1, reviewRemaining: 1 }).map(
        card => card.id,
      ),
    ).toEqual([1, 2, 3]);
  });

  test('the session cap applies after the daily caps', () => {
    const cards = [
      sentence(1, { state: 'new', due_at: '2026-10-19T08:00:00.000Z' }),
      sentence(2, { state: 'new', due_at: '2026-10-19T08:05:00.000Z' }),
      sentence(3, { state: 'new', due_at: '2026-10-19T08:10:00.000Z' }),
    ];

    expect(
      buildPracticeSession(cards, NOW, { maxCards: 2, newRemaining: 3 }).map(card => card.id),
    ).toEqual([1, 2]);
  });
});

describe('setting constants and clamping', () => {
  test('the defaults match the migration defaults', () => {
    expect(DEFAULT_LEARN_AHEAD_MINUTES).toBe(10);
    expect(MAX_LEARN_AHEAD_MINUTES).toBe(50);
    expect(DEFAULT_NEW_CARDS_PER_DAY).toBe(20);
    expect(DEFAULT_MAX_REVIEWS_PER_DAY).toBe(200);
  });

  test('every setting clamps into its bounds and recovers non-finite input', () => {
    expect(clampLearnAheadMinutes(-5)).toBe(0);
    expect(clampLearnAheadMinutes(99)).toBe(50);
    expect(clampLearnAheadMinutes(10.4)).toBe(10);
    expect(clampLearnAheadMinutes(10.6)).toBe(11);
    expect(clampLearnAheadMinutes(Number.NaN)).toBe(DEFAULT_LEARN_AHEAD_MINUTES);

    expect(clampNewCardsPerDay(-1)).toBe(0);
    expect(clampNewCardsPerDay(99)).toBe(50);
    expect(clampNewCardsPerDay(Number.NaN)).toBe(DEFAULT_NEW_CARDS_PER_DAY);

    expect(clampMaxReviewsPerDay(-1)).toBe(0);
    expect(clampMaxReviewsPerDay(999)).toBe(200);
    expect(clampMaxReviewsPerDay(Number.NaN)).toBe(DEFAULT_MAX_REVIEWS_PER_DAY);

    expect(clampMaxSessionCards(0)).toBe(5);
    expect(clampMaxSessionCards(999)).toBe(50);
    expect(clampMaxSessionCards(Number.NaN)).toBe(DEFAULT_MAX_SESSION_CARDS);
  });
});

describe('applyPracticeGrade', () => {
  test('requeues an Again card that is still relearning', () => {
    const first = sentence(1);
    const second = sentence(2);
    const state = createPracticeSessionState([first, second], NOW);

    const afterAgain = applyPracticeGrade(state, 'again', {
      ...first,
      state: 'relearning',
    });

    expect(afterAgain.queue.map(card => card.id)).toEqual([2, 1]);
    expect(afterAgain.queue[1].state).toBe('relearning');
  });

  test('keeps an Again card in the session every time (Anki learning steps)', () => {
    const first = sentence(1);
    const state = createPracticeSessionState([first], NOW);

    const afterFirstAgain = applyPracticeGrade(state, 'again', {
      ...first,
      state: 'learning',
    });
    const afterSecondAgain = applyPracticeGrade(afterFirstAgain, 'again', {
      ...afterFirstAgain.queue[0],
      state: 'learning',
    });

    expect(afterFirstAgain.queue.map(card => card.id)).toEqual([1]);
    expect(afterSecondAgain.queue.map(card => card.id)).toEqual([1]);
  });

  test('keeps a learning card after Good (the 10-minute step) and drops graduated cards', () => {
    const first = sentence(1);
    const second = sentence(2);
    const state = createPracticeSessionState([first, second], NOW);

    // FSRS keeps a new card in Learning after the first Good.
    const afterLearningGood = applyPracticeGrade(state, 'good', { ...first, state: 'learning' });
    expect(afterLearningGood.queue.map(card => card.id)).toEqual([2, 1]);

    // Only a review-state card leaves the queue.
    const afterGraduatingGood = applyPracticeGrade(afterLearningGood, 'good', {
      ...second,
      state: 'review',
    });
    expect(afterGraduatingGood.queue.map(card => card.id)).toEqual([1]);

    const graduated = applyPracticeGrade(afterGraduatingGood, 'easy', {
      ...first,
      state: 'review',
    });
    expect(graduated.queue).toEqual([]);
  });
});
