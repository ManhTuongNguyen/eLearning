/**
 * Practice-session rules shared by the sentence bank and the word bank
 * (TASK-SENT-009/012, WORD_BANK_V1 §2.2, TASK-WB-006).
 *
 * The topic screen asks `canPractice` whether a topic holds enough items to
 * open a session; `buildPracticeSession` selects the due cards in the order
 * they should be shown. Both live here so the unlock threshold and the session
 * contents share one source of truth.
 *
 * The stateful half (`createPracticeSessionState` / `applyPracticeGrade`) is
 * still pure: the screen owns the clock, the storage and the React state, while
 * these functions decide what "next card" means. Everything is generic over
 * `SchedulableItem` — the minimal shape both `SentenceRecord` and `WordRecord`
 * satisfy — so words run through exactly the same queue rules as sentences.
 *
 * Anki parity: a card only leaves the session once FSRS graduates it to
 * `review`. While it is in a short-term `learning`/`relearning` step it is
 * appended to the end of the current queue, so an `Again` (1-minute step) or a
 * first `Good` (10-minute step) brings it back — a session is small enough that
 * waiting out 10 minutes mid-session would make practice unusable.
 *
 * The learn-ahead *limit* (Anki's deck option) is the other half: when a
 * session is built, a `learning`/`relearning` card whose `due_at` falls within
 * the topic's `learn_ahead_minutes` window is included even though it is not
 * due yet, so practice does not dead-end on a wait of a few minutes. The
 * ascending-`due_at` order keeps every due-now card ahead of every learn-ahead
 * card, matching Anki's rule that ahead cards are only served once the main
 * queue is empty; `review` cards are never pulled forward. `0` disables the
 * window entirely.
 *
 * Anki's daily deck limits round it out: `new_cards_per_day` and
 * `max_reviews_per_day` cap how many `new`/`review` cards a study day may
 * still serve (counted from the review log since the rollover hour), while
 * short-term learning cards are never limited.
 */
import type { ReviewGrade, SentenceRecord, SentenceState, WordDataStatus } from '../db/types';

/**
 * The minimal item shape the session queue needs. `SentenceRecord` and
 * `WordRecord` both satisfy it structurally.
 */
export interface SchedulableItem {
  id: number;
  suspended: boolean;
  state: SentenceState;
  due_at: string;
  /**
   * Words only: a word stored without dictionary data (`'missing'`) has no
   * meanings to recall and never enters a session. Sentences leave it unset.
   */
  data_status?: WordDataStatus;
}

/** Items a topic must hold before practice unlocks. */
export const MIN_PRACTICE_ITEMS = 5;

/**
 * Default learn-ahead window in minutes. Must stay in sync with the
 * `DEFAULT 10` of `learn_ahead_minutes` in `MIGRATION_008` (existing topics
 * pick the value up from there; new topics default here).
 */
export const DEFAULT_LEARN_AHEAD_MINUTES = 10;

/** Inclusive bounds of the per-topic learn-ahead setting, in minutes. */
export const MIN_LEARN_AHEAD_MINUTES = 0;
export const MAX_LEARN_AHEAD_MINUTES = 50;

/** Clamp and round a learn-ahead value to the bounds above. */
export function clampLearnAheadMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LEARN_AHEAD_MINUTES;
  }
  const rounded = Math.round(value);
  return Math.min(MAX_LEARN_AHEAD_MINUTES, Math.max(MIN_LEARN_AHEAD_MINUTES, rounded));
}

/**
 * Anki's "New cards/day" default. Must stay in sync with the `DEFAULT 20` of
 * `new_cards_per_day` in `MIGRATION_009`.
 */
export const DEFAULT_NEW_CARDS_PER_DAY = 20;
export const MIN_NEW_CARDS_PER_DAY = 0;
export const MAX_NEW_CARDS_PER_DAY = 50;

export function clampNewCardsPerDay(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_NEW_CARDS_PER_DAY;
  }
  return Math.min(MAX_NEW_CARDS_PER_DAY, Math.max(MIN_NEW_CARDS_PER_DAY, Math.round(value)));
}

/**
 * Anki's "Maximum reviews/day" default. Must stay in sync with the
 * `DEFAULT 200` of `max_reviews_per_day` in `MIGRATION_009`.
 */
export const DEFAULT_MAX_REVIEWS_PER_DAY = 200;
export const MIN_MAX_REVIEWS_PER_DAY = 0;
export const MAX_MAX_REVIEWS_PER_DAY = 200;

export function clampMaxReviewsPerDay(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_REVIEWS_PER_DAY;
  }
  return Math.min(MAX_MAX_REVIEWS_PER_DAY, Math.max(MIN_MAX_REVIEWS_PER_DAY, Math.round(value)));
}

/**
 * Per-sitting session cap default (the fixed cap before per-topic settings).
 * Must stay in sync with the `DEFAULT 20` of `max_session_cards` in
 * `MIGRATION_009`.
 */
export const DEFAULT_MAX_SESSION_CARDS = 20;
export const MIN_SESSION_CARDS = 5;
export const MAX_SESSION_CARDS_LIMIT = 50;

export function clampMaxSessionCards(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_SESSION_CARDS;
  }
  return Math.min(MAX_SESSION_CARDS_LIMIT, Math.max(MIN_SESSION_CARDS, Math.round(value)));
}

/**
 * The historical fixed session cap (20), kept for older call sites and tests;
 * per-topic `max_session_cards` overrides it via {@link SessionBuildOptions}.
 */
export const MAX_PRACTICE_SESSION_CARDS = DEFAULT_MAX_SESSION_CARDS;

/**
 * Kept for the sentence call sites; the threshold is shared with words, either
 * kind counts the same way.
 */
export const MIN_PRACTICE_SENTENCES = MIN_PRACTICE_ITEMS;

/**
 * True when a topic holds enough items to practice. `itemCount` is the total
 * number of items in the topic (suspended ones included) — the same count the
 * topic screen shows.
 */
export function canPractice(itemCount: number): boolean {
  return itemCount >= MIN_PRACTICE_ITEMS;
}

/**
 * How a session may be composed. All fields optional; the defaults restore the
 * pre-settings behaviour for plain callers (20-card cap, no learn-ahead,
 * unlimited daily quotas).
 */
export interface SessionBuildOptions {
  /** Per-sitting cap; defaults to `DEFAULT_MAX_SESSION_CARDS` (20). */
  maxCards?: number;
  /** Learn-ahead window for learning-step cards, in minutes; 0 disables. */
  learnAheadMinutes?: number;
  /**
   * How many `new`-state cards may still be introduced today (the topic's
   * "New cards/day" minus what the review log already consumed). `0` hides
   * every remaining new card until the next study day.
   */
  newRemaining?: number;
  /**
   * How many `review`-state cards may still be shown today. `0` hides every
   * remaining review card until the next study day.
   */
  reviewRemaining?: number;
}

/**
 * Select the cards a session may show, mirroring Anki's deck limits:
 *
 * 1. Eligibility: non-suspended items (and, for words, no
 *    `data_status='missing'` rows) whose `due_at` is at or before `now`. A
 *    `learning`/`relearning` item due within `learnAheadMinutes` is eligible
 *    too, and sorts after every due-now card.
 * 2. Daily quotas: at most `newRemaining` new-state and `reviewRemaining`
 *    review-state items pass; short-term learning items are never limited
 *    (Anki does not limit intraday learning either).
 * 3. The result is oldest-due first, ties by ascending id, capped at
 *    `maxCards`.
 *
 * The input array is never mutated.
 */
export function buildPracticeSession<T extends SchedulableItem>(
  items: readonly T[],
  now: Date,
  options: SessionBuildOptions = {},
): T[] {
  const maxCards = options.maxCards ?? DEFAULT_MAX_SESSION_CARDS;
  const learnAheadMinutes = options.learnAheadMinutes ?? MIN_LEARN_AHEAD_MINUTES;
  const newRemaining = options.newRemaining ?? Number.POSITIVE_INFINITY;
  const reviewRemaining = options.reviewRemaining ?? Number.POSITIVE_INFINITY;

  const nowMs = now.getTime();
  const aheadMs = nowMs + learnAheadMinutes * 60_000;
  const byDueOrder = (
    first: { dueMs: number; item: SchedulableItem },
    second: { dueMs: number; item: SchedulableItem },
  ) => first.dueMs - second.dueMs || first.item.id - second.item.id;

  const eligible = items
    .map(item => ({ item, dueMs: Date.parse(item.due_at) }))
    .filter(
      entry =>
        !entry.item.suspended &&
        entry.item.data_status !== 'missing' &&
        Number.isFinite(entry.dueMs) &&
        (entry.dueMs <= nowMs ||
          ((entry.item.state === 'learning' || entry.item.state === 'relearning') &&
            entry.dueMs <= aheadMs)),
    )
    .sort(byDueOrder);

  const newCards = eligible
    .filter(entry => entry.item.state === 'new')
    .slice(0, Math.max(0, newRemaining));
  const learningCards = eligible.filter(
    entry => entry.item.state === 'learning' || entry.item.state === 'relearning',
  );
  const reviewCards = eligible
    .filter(entry => entry.item.state === 'review')
    .slice(0, Math.max(0, reviewRemaining));

  return [...newCards, ...learningCards, ...reviewCards]
    .sort(byDueOrder)
    .slice(0, Math.max(0, maxCards))
    .map(entry => entry.item);
}

/** An in-progress session: the cards still to show, current card first. */
export interface PracticeSessionState<T extends SchedulableItem = SchedulableItem> {
  /** Cards still to show, current card first. */
  readonly queue: readonly T[];
}

/** Start a session from a topic's items at the given moment. */
export function createPracticeSessionState<T extends SchedulableItem>(
  items: readonly T[],
  now: Date,
  options: SessionBuildOptions = {},
): PracticeSessionState<T> {
  return {
    queue: buildPracticeSession(items, now, options),
  };
}

/**
 * Consume the current card after a grade. `updatedCard` is the item with the
 * scheduler's new state applied, so a requeued card already carries its
 * `learning`/`relearning` state when it comes back.
 *
 * Only a card that FSRS graduated to `review` leaves the session; every other
 * outcome (including the first `Good` of a new card, which only advances to the
 * 10-minute step) requeues it.
 */
export function applyPracticeGrade<T extends SchedulableItem>(
  session: PracticeSessionState<T>,
  _grade: ReviewGrade,
  updatedCard: T,
): PracticeSessionState<T> {
  const remaining = session.queue.slice(1);
  const staysInSession = updatedCard.state === 'learning' || updatedCard.state === 'relearning';
  if (!staysInSession) {
    return { queue: remaining };
  }
  return { queue: [...remaining, updatedCard] };
}

// Word-flavoured aliases: the same shared rules with readable call sites.
export const buildWordPracticeSession = buildPracticeSession;
export const createWordPracticeSessionState = createPracticeSessionState;
export const applyWordPracticeGrade = applyPracticeGrade;

/** SentenceRecord is the historical caller; the type connection is asserted. */
type _SentenceSatisfiesItem = SentenceRecord extends SchedulableItem ? true : never;
export type SentenceSatisfiesItem = _SentenceSatisfiesItem;
