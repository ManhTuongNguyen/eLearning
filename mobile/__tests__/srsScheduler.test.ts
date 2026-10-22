/**
 * FSRS scheduler tests (TASK-SENT-015).
 *
 * The scheduler is a thin adapter over `ts-fsrs`, so these tests pin the three
 * things the adapter owns: the four-rating mapping (Anki's buttons), the local
 * 4 a.m. study-day boundary that feeds FSRS's `elapsed_days`, and the
 * day-grained due dates of graduated cards. The package's own formulas are
 * covered upstream; fuzz is disabled here so the numbers are deterministic.
 */
import { Rating } from 'ts-fsrs';

import type { ReviewGrade } from '../src/db/types';
import { DEFAULT_FSRS_CONFIG, type FsrsConfig } from '../src/srs/config';
import { studyDaysBetween } from '../src/srs/dayBoundary';
import {
  formatIntervalLabel,
  initialSchedule,
  previewSchedule,
  ratingForGrade,
  reviewSentence,
  type SchedulerState,
  schedulerStateFrom,
} from '../src/srs/scheduler';

/** Deterministic config: fuzz off, otherwise the Anki defaults. */
const CONFIG: FsrsConfig = { ...DEFAULT_FSRS_CONFIG, enableFuzz: false };

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const NOW = new Date(2026, 9, 19, 9, 0, 0, 0); // local time, TZ-independent

function minutesLater(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MS_PER_MINUTE);
}

function daysBetweenStudyDays(earlier: Date, later: Date): number {
  return studyDaysBetween(earlier, later, CONFIG.rolloverHour);
}

/** A graduated card reviewed six study days ago. */
function reviewCard(now: Date = NOW, overrides: Partial<SchedulerState> = {}): SchedulerState {
  return {
    state: 'review',
    reps: 4,
    lapses: 0,
    stability: 3.5,
    difficulty: 5.1,
    elapsed_days: 6,
    scheduled_days: 6,
    learning_steps: 0,
    due_at: now.toISOString(),
    last_reviewed_at: new Date(now.getTime() - 6 * MS_PER_DAY).toISOString(),
    ...overrides,
  };
}

function dueDate(state: { due_at: string }): Date {
  return new Date(state.due_at);
}

describe('button → rating mapping', () => {
  test.each([
    ['again', Rating.Again],
    ['hard', Rating.Hard],
    ['good', Rating.Good],
    ['easy', Rating.Easy],
  ] as Array<[ReviewGrade, Rating]>)('%s maps to FSRS rating %i', (grade, rating) => {
    expect(ratingForGrade(grade)).toBe(rating);
  });
});

describe('reviewSentence — new card', () => {
  test('Again starts the 1-minute learning step', () => {
    const { state, log } = reviewSentence(initialSchedule(NOW), 'again', NOW, CONFIG);

    expect(state.state).toBe('learning');
    expect(state.learning_steps).toBe(0);
    expect(state.reps).toBe(1);
    expect(state.lapses).toBe(0);
    expect(dueDate(state).getTime()).toBe(minutesLater(NOW, 1).getTime());
    expect(state.stability).toBeGreaterThan(0);
    expect(log).toMatchObject({ grade: 'again', rating: Rating.Again, state: 'new' });
  });

  test('Hard starts the 6-minute learning step', () => {
    const { state, log } = reviewSentence(initialSchedule(NOW), 'hard', NOW, CONFIG);

    expect(state.state).toBe('learning');
    expect(dueDate(state).getTime()).toBe(minutesLater(NOW, 6).getTime());
    expect(log.rating).toBe(Rating.Hard);
  });

  test('Good advances to the 10-minute learning step and stays in learning', () => {
    const { state, log } = reviewSentence(initialSchedule(NOW), 'good', NOW, CONFIG);

    expect(state.state).toBe('learning');
    expect(state.learning_steps).toBe(1);
    expect(dueDate(state).getTime()).toBe(minutesLater(NOW, 10).getTime());
    expect(log.rating).toBe(Rating.Good);
  });

  test('Easy graduates straight to review at the next 4 a.m. boundary + N days', () => {
    const { state } = reviewSentence(initialSchedule(NOW), 'easy', NOW, CONFIG);

    expect(state.state).toBe('review');
    expect(state.scheduled_days).toBe(8);
    expect(dueDate(state).getHours()).toBe(4);
    expect(dueDate(state).getMinutes()).toBe(0);
    expect(daysBetweenStudyDays(NOW, dueDate(state))).toBe(8);
  });
});

describe('reviewSentence — graduated card', () => {
  test('Again lapses into relearning with a 10-minute step', () => {
    const current = reviewCard();
    const { state, log } = reviewSentence(current, 'again', NOW, CONFIG);

    expect(state.state).toBe('relearning');
    expect(state.lapses).toBe(1);
    expect(dueDate(state).getTime()).toBe(minutesLater(NOW, 10).getTime());
    // The log records the state and gap *before* the grade, like Anki's revlog.
    expect(log).toMatchObject({ state: 'review', rating: Rating.Again, elapsed_days: 6 });
  });

  test.each([
    ['hard', Rating.Hard],
    ['good', Rating.Good],
    ['easy', Rating.Easy],
  ] as Array<[ReviewGrade, Rating]>)(
    '%s keeps the card in review and grows it',
    (grade, rating) => {
      const { state, log } = reviewSentence(reviewCard(), grade, NOW, CONFIG);

      expect(state.state).toBe('review');
      expect(state.scheduled_days).toBeGreaterThan(6);
      expect(dueDate(state).getHours()).toBe(4);
      expect(dueDate(state).getMinutes()).toBe(0);
      expect(log.rating).toBe(rating);
      expect(log.scheduled_days).toBe(state.scheduled_days);
    },
  );

  test('Easy schedules at least as far out as Hard', () => {
    const hard = reviewSentence(reviewCard(), 'hard', NOW, CONFIG).state;
    const easy = reviewSentence(reviewCard(), 'easy', NOW, CONFIG).state;

    expect(easy.scheduled_days).toBeGreaterThanOrEqual(hard.scheduled_days);
  });
});

describe('study day starts at 4 a.m. local time', () => {
  const lateNight = new Date(2026, 9, 19, 22, 0, 0, 0);
  const beforeRollover = new Date(2026, 9, 20, 2, 0, 0, 0);
  const afterRollover = new Date(2026, 9, 20, 4, 30, 0, 0);

  test('a 2 a.m. review is still the same study day', () => {
    const card = reviewCard(lateNight, { last_reviewed_at: lateNight.toISOString() });
    const { log } = reviewSentence(card, 'good', beforeRollover, CONFIG);

    expect(log.elapsed_days).toBe(0);
    // The log keeps the gap of the *previous* review, not this one.
    expect(log.last_elapsed_days).toBe(card.elapsed_days);
    expect(studyDaysBetween(lateNight, beforeRollover, CONFIG.rolloverHour)).toBe(0);
  });

  test('4:30 a.m. belongs to the next study day', () => {
    const card = reviewCard(lateNight, { last_reviewed_at: lateNight.toISOString() });
    const { log } = reviewSentence(card, 'good', afterRollover, CONFIG);

    expect(log.elapsed_days).toBe(1);
    expect(studyDaysBetween(lateNight, afterRollover, CONFIG.rolloverHour)).toBe(1);
  });

  test('the rollover hour is configurable', () => {
    const midnightConfig: FsrsConfig = { ...CONFIG, rolloverHour: 0 };
    const card = reviewCard(lateNight, { last_reviewed_at: lateNight.toISOString() });

    expect(studyDaysBetween(lateNight, beforeRollover, 0)).toBe(1);
    expect(reviewSentence(card, 'good', beforeRollover, midnightConfig).log.elapsed_days).toBe(1);
  });
});

describe('repeated Good through the package', () => {
  test('a new card needs two Good presses to graduate, then intervals grow', () => {
    let now = NOW;
    let state = initialSchedule(now);

    const first = reviewSentence(state, 'good', now, CONFIG);
    expect(first.state.state).toBe('learning');
    state = { ...state, ...first.state };
    now = dueDate(first.state);

    const second = reviewSentence(state, 'good', now, CONFIG);
    expect(second.state.state).toBe('review');

    const intervals = [second.state.scheduled_days];
    let current = second.state;
    for (let review = 0; review < 3; review += 1) {
      now = dueDate(current);
      const next = reviewSentence(current, 'good', now, CONFIG);
      intervals.push(next.state.scheduled_days);
      current = next.state;
    }

    // Documented Anki/FSRS shape: 2 → 11 → 46 days and still growing.
    expect(intervals[0]).toBeGreaterThanOrEqual(1);
    for (let index = 1; index < intervals.length; index += 1) {
      expect(intervals[index]).toBeGreaterThan(intervals[index - 1]);
    }
  });
});

describe('configuration', () => {
  test('caps the interval at the configured maximum', () => {
    const capped: FsrsConfig = { ...CONFIG, maximumInterval: 30 };
    const card = reviewCard(NOW, { stability: 500, difficulty: 5 });

    const hard = reviewSentence(card, 'hard', NOW, capped).state;
    const good = reviewSentence(card, 'good', NOW, capped).state;
    const easy = reviewSentence(card, 'easy', NOW, capped).state;

    // The package keeps Hard ≤ Good ≤ Easy, so it may overshoot the cap by the
    // 1-day steps it adds to keep the buttons ordered.
    expect(hard.scheduled_days).toBe(30);
    expect(good.scheduled_days).toBeLessThanOrEqual(31);
    expect(easy.scheduled_days).toBeLessThanOrEqual(32);
  });

  test('higher desired retention schedules sooner (or equal)', () => {
    const low: FsrsConfig = { ...CONFIG, desiredRetention: 0.8 };
    const high: FsrsConfig = { ...CONFIG, desiredRetention: 0.95 };

    const lowInterval = reviewSentence(reviewCard(), 'good', NOW, low).state.scheduled_days;
    const highInterval = reviewSentence(reviewCard(), 'good', NOW, high).state.scheduled_days;

    expect(highInterval).toBeLessThanOrEqual(lowInterval);
  });

  test('an unusable weight set falls back to the package defaults', () => {
    const broken: FsrsConfig = { ...CONFIG, weights: [1, 2, 3] };

    expect(() => reviewSentence(reviewCard(), 'good', NOW, broken)).not.toThrow();
  });

  test('no fuzz keeps the same inputs deterministic', () => {
    const first = reviewSentence(reviewCard(), 'good', NOW, CONFIG);
    const second = reviewSentence(reviewCard(), 'good', NOW, CONFIG);

    expect(first).toEqual(second);
  });
});

describe('previewSchedule and labels', () => {
  test('previews every button in Anki order with its interval hint', () => {
    const preview = previewSchedule(initialSchedule(NOW), NOW, CONFIG);

    expect(preview.map(item => item.grade)).toEqual(['again', 'hard', 'good', 'easy']);
    expect(preview.map(item => item.label)).toEqual(['1m', '6m', '10m', '8d']);
    expect(preview.map(item => item.state.state)).toEqual([
      'learning',
      'learning',
      'learning',
      'review',
    ]);
  });

  test('formats minute, day, month and year hints', () => {
    const learning = reviewSentence(initialSchedule(NOW), 'again', NOW, CONFIG).state;
    expect(formatIntervalLabel(learning, NOW)).toBe('1m');

    expect(
      formatIntervalLabel(
        { ...learning, state: 'review', scheduled_days: 3, due_at: NOW.toISOString() },
        NOW,
      ),
    ).toBe('3d');
    expect(
      formatIntervalLabel(
        { ...learning, state: 'review', scheduled_days: 45, due_at: NOW.toISOString() },
        NOW,
      ),
    ).toBe('1.5mo');
    expect(
      formatIntervalLabel(
        { ...learning, state: 'review', scheduled_days: 730, due_at: NOW.toISOString() },
        NOW,
      ),
    ).toBe('2.0y');
  });

  test('previewing does not mutate the card', () => {
    const card = reviewCard();

    previewSchedule(card, NOW, CONFIG);

    expect(card).toEqual(reviewCard());
  });
});

describe('schedulerStateFrom', () => {
  test('keeps only the schedule half of a row', () => {
    const row = {
      ...reviewCard(NOW, { scheduled_days: 2 }),
      id: 7,
      text: 'Nice to meet you.',
      meaning: 'A greeting.',
    };

    expect(schedulerStateFrom(row)).toEqual({
      id: 7,
      state: 'review',
      reps: 4,
      lapses: 0,
      stability: 3.5,
      difficulty: 5.1,
      elapsed_days: 6,
      scheduled_days: 2,
      learning_steps: 0,
      due_at: NOW.toISOString(),
      last_reviewed_at: new Date(NOW.getTime() - 6 * MS_PER_DAY).toISOString(),
    });
  });
});
