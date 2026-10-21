/**
 * Scheduler tests (TASK-SENT-005).
 *
 * The scheduler is the whole learning model, so the transition table from
 * SENTENCE_LIVE_V1 §2.2 is pinned here grade by grade, together with the three
 * invariants that keep the schedule sane over months of use: ease stays inside
 * its bounds, intervals only ever grow, and nothing is scheduled beyond a year.
 */
import {
  EASE_AGAIN_DELTA,
  EASE_DEFAULT,
  EASE_EASY_DELTA,
  EASE_MAX,
  EASE_MIN,
  EASY_BONUS,
  EASY_INTERVAL_DAYS,
  GRADUATING_INTERVAL_DAYS,
  INITIAL_SCHEDULE,
  INTERVAL_MAX_DAYS,
  LEARNING_STEP_MINUTES,
  type SchedulerState,
  scheduleNext,
  schedulerStateFrom,
} from '../src/srs/scheduler';

const NOW = new Date('2026-10-19T09:00:00.000Z');

const TEN_MINUTES_LATER = '2026-10-19T09:10:00.000Z';
const ONE_DAY_LATER = '2026-10-20T09:00:00.000Z';

/** A graduated card, i.e. one already in the day-scale schedule. */
function reviewCard(overrides: Partial<SchedulerState> = {}): SchedulerState {
  return {
    status: 'review',
    reps: 3,
    lapses: 0,
    ease: EASE_DEFAULT,
    interval_days: 6.25,
    ...overrides,
  };
}

function daysUntil(isoTimestamp: string): number {
  return (new Date(isoTimestamp).getTime() - NOW.getTime()) / 86_400_000;
}

describe('scheduleNext — Again', () => {
  test('sends a new sentence back to the ten-minute learning step', () => {
    const next = scheduleNext(INITIAL_SCHEDULE, 'again', NOW);

    expect(next).toMatchObject({
      status: 'learning',
      reps: 0,
      lapses: 1,
      ease: EASE_DEFAULT + EASE_AGAIN_DELTA,
      interval_days: 0,
      due_at: TEN_MINUTES_LATER,
      last_grade: 'again',
      last_reviewed_at: NOW.toISOString(),
    });
    expect(LEARNING_STEP_MINUTES).toBe(10);
  });

  test('keeps a learning card in the learning step and counts the lapse again', () => {
    const learning: SchedulerState = {
      status: 'learning',
      reps: 0,
      lapses: 1,
      ease: EASE_DEFAULT + EASE_AGAIN_DELTA,
      interval_days: 0,
    };

    const next = scheduleNext(learning, 'again', NOW);

    expect(next.status).toBe('learning');
    expect(next.lapses).toBe(2);
    expect(next.due_at).toBe(TEN_MINUTES_LATER);
  });

  test('demotes a graduated card and drops its ease', () => {
    const next = scheduleNext(reviewCard(), 'again', NOW);

    expect(next.status).toBe('learning');
    expect(next.interval_days).toBe(0);
    expect(next.reps).toBe(3);
    expect(next.lapses).toBe(1);
    expect(next.ease).toBeCloseTo(EASE_DEFAULT + EASE_AGAIN_DELTA, 5);
    expect(next.due_at).toBe(TEN_MINUTES_LATER);
  });
});

describe('scheduleNext — Good', () => {
  test('graduates a new sentence to one day', () => {
    const next = scheduleNext(INITIAL_SCHEDULE, 'good', NOW);

    expect(next).toMatchObject({
      status: 'review',
      reps: 1,
      lapses: 0,
      ease: EASE_DEFAULT,
      interval_days: GRADUATING_INTERVAL_DAYS,
      due_at: ONE_DAY_LATER,
      last_grade: 'good',
    });
  });

  test('graduates a learning sentence to one day', () => {
    const learning: SchedulerState = {
      status: 'learning',
      reps: 0,
      lapses: 2,
      ease: 2.3,
      interval_days: 0,
    };

    const next = scheduleNext(learning, 'good', NOW);

    expect(next).toMatchObject({ status: 'review', interval_days: 1, reps: 1, lapses: 2 });
    expect(next.ease).toBeCloseTo(2.3, 5);
    expect(next.due_at).toBe(ONE_DAY_LATER);
  });

  test('multiplies a graduated interval by the ease and leaves the ease alone', () => {
    const next = scheduleNext(reviewCard(), 'good', NOW);

    // Intervals are rounded to two decimals so long chains stay comparable.
    expect(next.interval_days).toBe(15.63);
    expect(next.ease).toBeCloseTo(EASE_DEFAULT, 5);
    expect(next.reps).toBe(4);
    expect(daysUntil(next.due_at)).toBeCloseTo(15.63, 5);
  });
});

describe('scheduleNext — Easy', () => {
  test('graduates a new sentence to four days and raises the ease', () => {
    const next = scheduleNext(INITIAL_SCHEDULE, 'easy', NOW);

    expect(next).toMatchObject({
      status: 'review',
      reps: 1,
      lapses: 0,
      interval_days: EASY_INTERVAL_DAYS,
      last_grade: 'easy',
    });
    expect(next.ease).toBeCloseTo(EASE_DEFAULT + EASE_EASY_DELTA, 5);
    expect(daysUntil(next.due_at)).toBeCloseTo(EASY_INTERVAL_DAYS, 5);
  });

  test('applies the easy bonus on top of the ease for a graduated card', () => {
    const next = scheduleNext(reviewCard(), 'easy', NOW);

    expect(next.interval_days).toBeCloseTo(6.25 * EASE_DEFAULT * EASY_BONUS, 2);
    expect(next.ease).toBeCloseTo(EASE_DEFAULT + EASE_EASY_DELTA, 5);
    expect(next.reps).toBe(4);
  });
});

describe('invariants', () => {
  test('repeated Good grows the interval every time', () => {
    let state: SchedulerState = INITIAL_SCHEDULE;
    const intervals: number[] = [];

    for (let review = 0; review < 8; review += 1) {
      const next = scheduleNext(state, 'good', NOW);
      intervals.push(next.interval_days);
      state = schedulerStateFrom(next);
    }

    // The documented shape: 1 → 2.5 → 6.25 → 15.63 → 39.06 → ...
    expect(intervals.slice(0, 4)).toEqual([1, 2.5, 6.25, 15.63]);
    for (let index = 1; index < intervals.length; index += 1) {
      expect(intervals[index]).toBeGreaterThan(intervals[index - 1]);
    }
  });

  test('never shrinks an interval, even from an inconsistent state', () => {
    const inconsistent = reviewCard({ interval_days: 0, ease: EASE_MIN });

    const good = scheduleNext(inconsistent, 'good', NOW);
    const easy = scheduleNext(inconsistent, 'easy', NOW);

    expect(good.interval_days).toBeGreaterThanOrEqual(GRADUATING_INTERVAL_DAYS);
    expect(easy.interval_days).toBeGreaterThanOrEqual(GRADUATING_INTERVAL_DAYS);
  });

  test('clamps the ease at both ends', () => {
    let low: SchedulerState = INITIAL_SCHEDULE;
    for (let review = 0; review < 12; review += 1) {
      low = schedulerStateFrom(scheduleNext(low, 'again', NOW));
    }
    expect(low.ease).toBe(EASE_MIN);

    let high: SchedulerState = INITIAL_SCHEDULE;
    for (let review = 0; review < 12; review += 1) {
      high = schedulerStateFrom(scheduleNext(high, 'easy', NOW));
    }
    expect(high.ease).toBe(EASE_MAX);
  });

  test('caps the interval at one year', () => {
    const nearlyMaxed = reviewCard({ interval_days: 300, ease: EASE_MAX });

    const good = scheduleNext(nearlyMaxed, 'good', NOW);
    const easy = scheduleNext(nearlyMaxed, 'easy', NOW);

    expect(good.interval_days).toBe(INTERVAL_MAX_DAYS);
    expect(easy.interval_days).toBe(INTERVAL_MAX_DAYS);
    expect(daysUntil(good.due_at)).toBeCloseTo(INTERVAL_MAX_DAYS, 5);
  });

  test('is pure: the same inputs always produce the same output', () => {
    const state = reviewCard();

    expect(scheduleNext(state, 'good', NOW)).toEqual(scheduleNext(state, 'good', NOW));
    expect(state).toEqual(reviewCard());
  });

  test('schedulerStateFrom keeps only the schedule half of a row', () => {
    const row = {
      ...reviewCard({ interval_days: 2.5 }),
      id: 7,
      text: 'Nice to meet you.',
      meaning: 'A greeting.',
    };

    expect(schedulerStateFrom(row)).toEqual(reviewCard({ interval_days: 2.5 }));
  });
});
