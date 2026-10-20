/**
 * Practice-session tests (TASK-SENT-012, SENTENCE_LIVE_V1 §2.3).
 *
 * The pure session module decides which cards a learner sees and what an
 * `Again` grade does to the queue. These tests pin the due-only filter, the
 * order, the 20-card cap and the Anki-style requeue-every-Again rule without
 * touching SQLite or React.
 */
import type {SentenceRecord} from '../src/db/types';
import {
  applyPracticeGrade,
  buildPracticeSession,
  createPracticeSessionState,
  MAX_PRACTICE_SESSION_CARDS,
} from '../src/srs/session';

const NOW = new Date('2026-10-19T09:00:00.000Z');

function sentence(
  id: number,
  overrides: Partial<SentenceRecord> = {},
): SentenceRecord {
  return {
    id,
    topic_id: 1,
    text: `Sentence ${id}`,
    normalized_text: `sentence ${id}`,
    meaning: `Meaning ${id}`,
    situation: `Situation ${id}`,
    status: 'new',
    reps: 0,
    lapses: 0,
    ease: 2.5,
    interval_days: 0,
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
      sentence(1, {due_at: '2026-10-19T08:30:00.000Z'}),
      sentence(2, {due_at: '2026-10-19T08:00:00.000Z'}),
      sentence(3, {due_at: '2026-10-19T08:00:00.000Z'}),
      sentence(4, {due_at: '2026-10-19T12:00:00.000Z'}),
      sentence(5, {status: 'suspended', due_at: '2026-10-19T07:00:00.000Z'}),
    ];

    expect(buildPracticeSession(cards, NOW).map(card => card.id)).toEqual([2, 3, 1]);
  });

  test('caps the session at 20 cards by default and honours a custom limit', () => {
    const cards = Array.from({length: 25}, (_, index) => sentence(index + 1));

    expect(MAX_PRACTICE_SESSION_CARDS).toBe(20);
    expect(buildPracticeSession(cards, NOW)).toHaveLength(20);
    expect(buildPracticeSession(cards, NOW, 3).map(card => card.id)).toEqual([
      1, 2, 3,
    ]);
  });

  test('never mutates the input array', () => {
    const cards = [
      sentence(1, {due_at: '2026-10-19T08:30:00.000Z'}),
      sentence(2, {due_at: '2026-10-19T08:00:00.000Z'}),
    ];
    const snapshot = cards.map(card => card.id);

    buildPracticeSession(cards, NOW);

    expect(cards.map(card => card.id)).toEqual(snapshot);
  });

  test('returns an empty queue when nothing is due', () => {
    expect(
      buildPracticeSession(
        [sentence(1, {due_at: '2026-10-20T09:00:00.000Z'})],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('applyPracticeGrade', () => {
  test('requeues an Again card at the end of the session', () => {
    const first = sentence(1);
    const second = sentence(2);
    const state = createPracticeSessionState([first, second], NOW);

    const afterAgain = applyPracticeGrade(state, 'again', {
      ...first,
      status: 'learning',
    });

    expect(afterAgain.queue.map(card => card.id)).toEqual([2, 1]);
    expect(afterAgain.queue[1].status).toBe('learning');
  });

  test('keeps requeueing the same sentence after every Again (Anki learning steps)', () => {
    const first = sentence(1);
    const state = createPracticeSessionState([first], NOW);

    const afterFirstAgain = applyPracticeGrade(state, 'again', {
      ...first,
      status: 'learning',
    });
    const afterSecondAgain = applyPracticeGrade(
      afterFirstAgain,
      'again',
      {...afterFirstAgain.queue[0], status: 'learning'},
    );

    expect(afterFirstAgain.queue.map(card => card.id)).toEqual([1]);
    expect(afterSecondAgain.queue.map(card => card.id)).toEqual([1]);
  });

  test('drops a Good or Easy card without requeueing it', () => {
    const first = sentence(1);
    const second = sentence(2);
    const state = createPracticeSessionState([first, second], NOW);

    const afterGood = applyPracticeGrade(state, 'good', first);
    const afterEasy = applyPracticeGrade(afterGood, 'easy', second);

    expect(afterGood.queue.map(card => card.id)).toEqual([2]);
    expect(afterEasy.queue).toEqual([]);
  });
});
