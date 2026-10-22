/**
 * FSRS scheduler adapter (TASK-SENT-015, SENTENCE_LIVE_V1 §2.2).
 *
 * The repository stores a sentence's FSRS card (`state`, `stability`,
 * `difficulty`, `due_at`, …); this module converts it to the `ts-fsrs` `Card`,
 * runs the official package — the TypeScript port of the model Anki ships — and
 * maps the result back to row fields plus an Anki-shaped review-log entry.
 *
 * Anki parity details:
 *
 * - Four ratings, in Anki order: Again / Hard / Good / Easy.
 * - Day-grained gaps use the learner's local 4 a.m. rollover
 *   (`dayBoundary.ts`) instead of raw 24-hour windows.
 * - Review cards become due at the start of the target study day, like Anki's
 *   day-number queue; learning/relearning cards keep the package's minute-step
 *   timestamps.
 * - Fuzz, desired retention, the interval cap and the learning steps come from
 *   the collection config (`srs_config`, see `config.ts`), so an optimized
 *   weight set can be applied without touching the pure functions.
 *
 * Nothing here reads a clock or storage: `now` and the config are parameters.
 */
import {
  type Card,
  type FSRS,
  fsrs,
  GenSeedStrategyWithCardId,
  type Grade,
  generatorParameters,
  Rating,
  type ReviewLog,
  State,
  StrategyMode,
} from 'ts-fsrs';

import type {
  ReviewGrade,
  SentenceReviewLogInput,
  SentenceReviewState,
  SentenceState,
} from '../db/types';
import { DEFAULT_FSRS_CONFIG, type FsrsConfig } from './config';
import { startOfStudyDayAfter, studyDaysBetween } from './dayBoundary';

const MS_PER_DAY = 86_400_000;

/** Anki button order, used by the practice screen and the preview helper. */
export const REVIEW_GRADES: readonly ReviewGrade[] = ['again', 'hard', 'good', 'easy'];

/** The FSRS rating each button maps to (Anki stores this in `revlog.ease`). */
const RATING_BY_GRADE: Record<ReviewGrade, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const STATE_BY_TS_FSRS: Record<number, SentenceState> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

const TS_FSRS_STATE_BY_NAME: Record<SentenceState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

/** The schedule-relevant half of a sentence row. */
export interface SchedulerState {
  /** Card id; seeds interval fuzz so a preview matches the saved result. */
  id?: number;
  state: SentenceState;
  reps: number;
  lapses: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  due_at: string;
  last_reviewed_at: string;
}

/** One graded review: the persisted schedule plus its revlog entry. */
export interface ReviewOutcome {
  state: SentenceReviewState;
  log: SentenceReviewLogInput;
}

/** The schedule of a sentence that has never been reviewed. */
export function initialSchedule(now: Date): SchedulerState {
  return {
    state: 'new',
    reps: 0,
    lapses: 0,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    due_at: now.toISOString(),
    last_reviewed_at: '',
  };
}

/** Numeric FSRS rating (1–4) for a review button, for the review log. */
export function ratingForGrade(grade: ReviewGrade): number {
  return RATING_BY_GRADE[grade];
}

/**
 * Extract the scheduler's view of a stored sentence row: the content columns
 * are dropped and only the FSRS card fields survive.
 */
export function schedulerStateFrom(row: SchedulerState): SchedulerState {
  return {
    id: row.id,
    state: row.state,
    reps: row.reps,
    lapses: row.lapses,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps,
    due_at: row.due_at,
    last_reviewed_at: row.last_reviewed_at,
  };
}

/** Convert a stored row into the `ts-fsrs` card shape. */
function toCard(row: SchedulerState): Card & { id?: number } {
  const lastReviewedAt = row.last_reviewed_at ? new Date(row.last_reviewed_at) : undefined;
  const state = TS_FSRS_STATE_BY_NAME[row.state] ?? State.New;
  return {
    id: row.id,
    due: parseDate(row.due_at, new Date(0)),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state,
    last_review:
      lastReviewedAt && Number.isFinite(lastReviewedAt.getTime()) ? lastReviewedAt : undefined,
  };
}

function parseDate(value: string, fallback: Date): Date {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

/** The card handed to the package, with elapsed days measured at 4 a.m. */
function preparedCard(row: SchedulerState, now: Date, config: FsrsConfig): Card {
  const card = toCard(row);
  if (!card.last_review || row.state === 'new') {
    return { ...card, last_review: undefined, elapsed_days: 0 };
  }
  const elapsed = studyDaysBetween(card.last_review, now, config.rolloverHour);
  return {
    ...card,
    elapsed_days: elapsed,
    last_review: new Date(now.getTime() - elapsed * MS_PER_DAY),
  };
}

/** The package's `Card` after a grade, in the shape the repository stores. */
function toReviewState(
  card: Card,
  fallbackDue: Date,
  now: Date,
  grade: ReviewGrade,
  config: FsrsConfig,
): SentenceReviewState {
  // Anki's review queue is day-grained: a card due in N days is available when
  // that study day starts, not N×24 h after this exact review.
  const due =
    card.state === State.Review
      ? startOfStudyDayAfter(now, card.scheduled_days, config.rolloverHour)
      : Number.isFinite(card.due.getTime())
        ? card.due
        : fallbackDue;
  return {
    state: STATE_BY_TS_FSRS[card.state] ?? 'new',
    reps: card.reps,
    lapses: card.lapses,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    due_at: due.toISOString(),
    last_grade: grade,
    last_reviewed_at: now.toISOString(),
  };
}

function toReviewLog(
  card: Card,
  log: ReviewLog,
  grade: ReviewGrade,
  now: Date,
  config: FsrsConfig,
  lastElapsedDays: number,
): SentenceReviewLogInput {
  const due =
    card.state === State.Review
      ? startOfStudyDayAfter(now, card.scheduled_days, config.rolloverHour)
      : card.due;
  return {
    grade,
    rating: log.rating,
    state: STATE_BY_TS_FSRS[log.state] ?? 'new',
    due_at: due.toISOString(),
    stability: log.stability,
    difficulty: log.difficulty,
    elapsed_days: log.elapsed_days,
    // The package reads this from the previous card, which we deliberately
    // rebuild with the 4 a.m. elapsed value; use the row's stored value so the
    // log records the gap of the *previous* review, not this one.
    last_elapsed_days: lastElapsedDays,
    scheduled_days: card.scheduled_days,
    learning_steps: log.learning_steps,
    reviewed_at: log.review.toISOString(),
  };
}

const schedulerCache = new Map<string, FSRS>();

/** Weight-vector lengths `ts-fsrs` knows how to migrate (FSRS-4.5/5/6). */
const SUPPORTED_WEIGHT_LENGTHS = new Set([17, 19, 21]);

function schedulerKey(config: FsrsConfig): string {
  return [
    config.weights?.join(',') ?? 'default',
    config.desiredRetention,
    config.maximumInterval,
    config.enableFuzz ? 1 : 0,
    config.enableShortTerm ? 1 : 0,
    config.learningSteps.join(','),
    config.relearningSteps.join(','),
  ].join('|');
}

/** Build (or reuse) the package scheduler for one collection config. */
export function createScheduler(config: FsrsConfig = DEFAULT_FSRS_CONFIG): FSRS {
  const key = schedulerKey(config);
  const cached = schedulerCache.get(key);
  if (cached) {
    return cached;
  }
  const build = (weights: readonly number[] | null): FSRS =>
    fsrs(
      generatorParameters({
        request_retention: config.desiredRetention,
        maximum_interval: config.maximumInterval,
        w: weights ? [...weights] : undefined,
        enable_fuzz: config.enableFuzz,
        enable_short_term: config.enableShortTerm,
        learning_steps: [...config.learningSteps],
        relearning_steps: [...config.relearningSteps],
      }),
    ).useStrategy(StrategyMode.SEED, GenSeedStrategyWithCardId('id'));

  let scheduler: FSRS;
  try {
    // A vector from an unknown model version is ignored rather than logged as
    // a warning on every review; the package's defaults are always usable.
    const usableWeights =
      config.weights && SUPPORTED_WEIGHT_LENGTHS.has(config.weights.length) ? config.weights : null;
    scheduler = build(usableWeights);
  } catch {
    // A stored weight set that the package rejects must never brick practice.
    scheduler = build(null);
  }
  schedulerCache.set(key, scheduler);
  return scheduler;
}

/** Apply one rating to a stored schedule, producing the next row state + log. */
export function reviewSentence(
  state: SchedulerState,
  grade: ReviewGrade,
  now: Date,
  config: FsrsConfig = DEFAULT_FSRS_CONFIG,
): ReviewOutcome {
  const scheduler = createScheduler(config);
  const previous = preparedCard(state, now, config);
  const { card, log } = scheduler.next(previous, now, RATING_BY_GRADE[grade]);
  const nextState = toReviewState(card, log.due, now, grade, config);
  return {
    state: nextState,
    log: toReviewLog(card, log, grade, now, config, state.elapsed_days),
  };
}

export interface GradePreview {
  grade: ReviewGrade;
  state: SentenceReviewState;
  /** Anki-style short interval label shown under the button (e.g. `10m`, `3d`). */
  label: string;
}

/** Preview every button's outcome without mutating anything (Anki buttons). */
export function previewSchedule(
  state: SchedulerState,
  now: Date,
  config: FsrsConfig = DEFAULT_FSRS_CONFIG,
): GradePreview[] {
  const scheduler = createScheduler(config);
  const previous = preparedCard(state, now, config);
  const preview = scheduler.repeat(previous, now);
  return REVIEW_GRADES.map(grade => {
    const item = preview[RATING_BY_GRADE[grade]];
    const nextState = toReviewState(item.card, item.log.due, now, grade, config);
    return { grade, state: nextState, label: formatIntervalLabel(nextState, now) };
  });
}

function roundOne(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/**
 * Anki's button hint: minutes for learning steps, then days, months and years.
 * `Learning`/`Relearning` cards ignore `scheduled_days` (always 0) and use the
 * real minute gap the package computed.
 */
export function formatIntervalLabel(next: SentenceReviewState, now: Date): string {
  if (next.state === 'learning' || next.state === 'relearning') {
    const minutes = Math.round((Date.parse(next.due_at) - now.getTime()) / 60_000);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return 'now';
    }
    return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
  }
  const days = next.scheduled_days;
  if (days < 1) {
    return '<1d';
  }
  if (days < 30) {
    return `${days}d`;
  }
  if (days < 365) {
    return `${roundOne(days / 30)}mo`;
  }
  return `${roundOne(days / 365)}y`;
}
