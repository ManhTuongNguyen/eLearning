/**
 * Spaced-repetition scheduler (SENTENCE_LIVE_V1 §2.2, TASK-SENT-005).
 *
 * A sentence the learner remembers comes back after a longer gap; one they
 * forget comes back in ten minutes. The whole decision is this one pure
 * function: `scheduleNext(state, grade, now)` takes the current schedule, the
 * learner's rating and the moment of the review, and returns the next schedule.
 * There is no clock read, no storage and no React here — which is what makes
 * the behaviour exactly testable and keeps the repository dumb.
 *
 * The three buttons:
 *
 * | Grade | Meaning | Effect |
 * | --- | --- | --- |
 * | Again | "I did not remember it" | back to the 10-minute learning step, lapse counted, ease −0.20 |
 * | Good | "I remembered it" | interval × ease (a learning card graduates to 1 day) |
 * | Easy | "That was easy" | interval × ease × 1.3, ease +0.15 |
 *
 * Ease is clamped to [1.3, 3.0] and intervals never shrink and never exceed a
 * year.
 */
import type {ReviewGrade, SentenceReviewState, SentenceStatus} from '../db/types';

/** Minutes a forgotten sentence waits before it is shown again. */
export const LEARNING_STEP_MINUTES = 10;

/** Interval a learning card graduates to on Good. */
export const GRADUATING_INTERVAL_DAYS = 1;

/** Interval a learning card graduates to on Easy. */
export const EASY_INTERVAL_DAYS = 4;

/** Extra multiplier applied to a review card on Easy, on top of its ease. */
export const EASY_BONUS = 1.3;

export const EASE_DEFAULT = 2.5;
export const EASE_MIN = 1.3;
export const EASE_MAX = 3.0;
export const EASE_AGAIN_DELTA = -0.2;
export const EASE_EASY_DELTA = 0.15;

/** Longest gap the scheduler will ever schedule. */
export const INTERVAL_MAX_DAYS = 365;

/** The schedule-relevant half of a sentence row. */
export interface SchedulerState {
  status: SentenceStatus;
  reps: number;
  lapses: number;
  ease: number;
  interval_days: number;
}

/** Schedule of a sentence that has never been reviewed. */
export const INITIAL_SCHEDULE: SchedulerState = {
  status: 'new',
  reps: 0,
  lapses: 0,
  ease: EASE_DEFAULT,
  interval_days: 0,
};

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

function clampEase(ease: number): number {
  return Math.min(EASE_MAX, Math.max(EASE_MIN, ease));
}

/** Round to two decimals so long chains of multiplication stay comparable. */
function roundInterval(days: number): number {
  return Math.round(days * 100) / 100;
}

function clampInterval(days: number): number {
  return roundInterval(Math.min(INTERVAL_MAX_DAYS, days));
}

/**
 * The next interval for a graduated card: the current interval scaled by the
 * ease (and the Easy bonus), never below the current interval, never above the
 * cap.
 */
function grownInterval(state: SchedulerState, multiplier: number): number {
  const scaled = state.interval_days * multiplier;
  return clampInterval(Math.max(state.interval_days, scaled, GRADUATING_INTERVAL_DAYS));
}

/**
 * Advance one sentence by one review.
 *
 * @param state Current schedule (`INITIAL_SCHEDULE` for a fresh sentence).
 * @param grade The learner's rating.
 * @param now Moment of the review; the returned `due_at` is relative to it.
 */
export function scheduleNext(
  state: SchedulerState,
  grade: ReviewGrade,
  now: Date,
): SentenceReviewState {
  const reviewedAt = now.toISOString();

  if (grade === 'again') {
    return {
      status: 'learning',
      reps: state.reps,
      lapses: state.lapses + 1,
      ease: clampEase(state.ease + EASE_AGAIN_DELTA),
      interval_days: 0,
      due_at: new Date(now.getTime() + LEARNING_STEP_MINUTES * MS_PER_MINUTE).toISOString(),
      last_grade: 'again',
      last_reviewed_at: reviewedAt,
    };
  }

  if (grade === 'good') {
    if (state.status === 'review') {
      const interval = grownInterval(state, state.ease);
      return {
        status: 'review',
        reps: state.reps + 1,
        lapses: state.lapses,
        ease: clampEase(state.ease),
        interval_days: interval,
        due_at: new Date(now.getTime() + interval * MS_PER_DAY).toISOString(),
        last_grade: 'good',
        last_reviewed_at: reviewedAt,
      };
    }
    return {
      status: 'review',
      reps: state.reps + 1,
      lapses: state.lapses,
      ease: clampEase(state.ease),
      interval_days: GRADUATING_INTERVAL_DAYS,
      due_at: new Date(now.getTime() + GRADUATING_INTERVAL_DAYS * MS_PER_DAY).toISOString(),
      last_grade: 'good',
      last_reviewed_at: reviewedAt,
    };
  }

  // Easy: the only grade that moves the ease up.
  const ease = clampEase(state.ease + EASE_EASY_DELTA);
  if (state.status === 'review') {
    const interval = grownInterval(state, state.ease * EASY_BONUS);
    return {
      status: 'review',
      reps: state.reps + 1,
      lapses: state.lapses,
      ease,
      interval_days: interval,
      due_at: new Date(now.getTime() + interval * MS_PER_DAY).toISOString(),
      last_grade: 'easy',
      last_reviewed_at: reviewedAt,
    };
  }
  return {
    status: 'review',
    reps: state.reps + 1,
    lapses: state.lapses,
    ease,
    interval_days: EASY_INTERVAL_DAYS,
    due_at: new Date(now.getTime() + EASY_INTERVAL_DAYS * MS_PER_DAY).toISOString(),
    last_grade: 'easy',
    last_reviewed_at: reviewedAt,
  };
}

/** Extract the scheduler's view of a stored sentence row. */
export function schedulerStateFrom(record: SchedulerState): SchedulerState {
  return {
    status: record.status,
    reps: record.reps,
    lapses: record.lapses,
    ease: record.ease,
    interval_days: record.interval_days,
  };
}