/**
 * Shared session-queue tests with word fixtures (WORD_BANK_V1 TASK-WB-006).
 *
 * The sentence queue rules were generalized over `SchedulableItem`; these
 * tests prove `WordRecord` runs through the same queue unchanged: due-only
 * selection, oldest-due order, the 20-card cap, learn-ahead requeue until
 * graduation, suspended exclusion and the word-only `data_status='missing'`
 * exclusion. The sentence expectations live untouched in `srsSession.test.ts`.
 */
import type { WordRecord } from '../src/db/types';
import {
  applyPracticeGrade,
  buildPracticeSession,
  canPractice,
  MAX_PRACTICE_SESSION_CARDS,
  MIN_PRACTICE_ITEMS,
  createPracticeSessionState,
} from '../src/srs/session';

const NOW = new Date('2026-10-24T09:00:00.000Z');

let nextId = 1;

/** A complete, new, immediately due word with default FSRS fields. */
function wordFixture(overrides: Partial<WordRecord> = {}): WordRecord {
  const id = overrides.id ?? nextId++;
  return {
    id,
    topic_id: 1,
    text: `word${id}`,
    normalized_text: `word${id}`,
    senses_json: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] }],
    phonetics_json: ['/wɜːd/'],
    data_source: 'dictionary',
    data_status: 'complete',
    enriched_at: null,
    state: 'new',
    suspended: false,
    reps: 0,
    lapses: 0,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    due_at: '2026-10-24T08:00:00.000Z',
    last_grade: '',
    last_reviewed_at: '',
    created_at: '2026-10-24T08:00:00.000Z',
    updated_at: '2026-10-24T08:00:00.000Z',
    ...overrides,
  };
}

describe('word session queue (TASK-WB-006)', () => {
  test('selects due-only words, oldest due first, ties by id', () => {
    const words = [
      wordFixture({ due_at: '2026-10-24T08:30:00.000Z' }),
      wordFixture({ due_at: '2026-10-24T08:00:00.000Z' }),
      wordFixture({ due_at: '2026-10-24T09:30:00.000Z' }), // future, excluded
      wordFixture({ due_at: '2026-10-24T08:00:00.000Z' }),
    ];
    const session = buildPracticeSession(words, NOW);
    expect(session.map(word => word.id)).toEqual([words[1].id, words[3].id, words[0].id]);
  });

  test('caps the session at 20 cards', () => {
    const words = Array.from({ length: 25 }, () => wordFixture());
    expect(buildPracticeSession(words, NOW)).toHaveLength(MAX_PRACTICE_SESSION_CARDS);
  });

  test('excludes suspended words', () => {
    const words = [
      wordFixture({ suspended: true }),
      wordFixture({ suspended: false }),
    ];
    const session = buildPracticeSession(words, NOW);
    expect(session.map(word => word.id)).toEqual([words[1].id]);
  });

  test('excludes data_status=missing words', () => {
    const words = [
      wordFixture({ data_status: 'missing', senses_json: [], phonetics_json: [] }),
      wordFixture({ data_status: 'complete' }),
    ];
    const session = buildPracticeSession(words, NOW);
    expect(session.map(item => item.data_status)).toEqual(['complete']);
  });

  test('createPracticeSessionState keeps the WordRecord typing on the queue', () => {
    const words = [wordFixture(), wordFixture()];
    const state = createPracticeSessionState(words, NOW);
    expect(state.queue[0]?.text).toMatch(/^word\d+$/);
    expect(state.queue).toHaveLength(2);
  });

  test('a learning/relearning word requeues until FSRS graduates it', () => {
    const first = wordFixture();
    const second = wordFixture();
    let state = createPracticeSessionState([first, second], NOW);
    expect(state.queue.map(word => word.id)).toEqual([first.id, second.id]);

    // First `Good` on a new card advances to the 10-minute learning step:
    // the word comes back at the end of the queue with its new state.
    state = applyPracticeGrade(state, 'good', { ...first, state: 'learning' });
    expect(state.queue.map(word => word.id)).toEqual([second.id, first.id]);

    // A lapse requeues too (relearning step).
    state = applyPracticeGrade(state, 'again', { ...second, state: 'relearning' });
    expect(state.queue.map(word => word.id)).toEqual([first.id, second.id]);

    // Graduation to `review` removes the word from the session.
    state = applyPracticeGrade(state, 'good', { ...first, state: 'review' });
    expect(state.queue.map(word => word.id)).toEqual([second.id]);

    state = applyPracticeGrade(state, 'good', { ...second, state: 'review' });
    expect(state.queue).toEqual([]);
  });

  test('canPractice is the shared 5-item threshold', () => {
    expect(MIN_PRACTICE_ITEMS).toBe(5);
    expect(canPractice(4)).toBe(false);
    expect(canPractice(5)).toBe(true);
  });
});
