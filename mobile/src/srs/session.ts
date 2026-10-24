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
 * first `Good` (10-minute step) brings it back. Anki calls this the *learn
 * ahead* limit; a session is small enough that waiting out 10 minutes would
 * make practice unusable, so the card is shown as soon as it reaches the end of
 * the queue.
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

/** Hard cap on cards in one practice session. */
export const MAX_PRACTICE_SESSION_CARDS = 20;

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
 * Select the due cards of a topic: non-suspended items (and, for words, no
 * `data_status='missing'` rows) whose `due_at` is at or before `now`, oldest
 * due first, ties broken by ascending id, capped at `limit` (20 by default).
 * The input array is never mutated.
 */
export function buildPracticeSession<T extends SchedulableItem>(
  items: readonly T[],
  now: Date,
  limit = MAX_PRACTICE_SESSION_CARDS,
): T[] {
  const nowMs = now.getTime();
  return items
    .map(item => ({ item, dueMs: Date.parse(item.due_at) }))
    .filter(
      entry =>
        !entry.item.suspended &&
        entry.item.data_status !== 'missing' &&
        Number.isFinite(entry.dueMs) &&
        entry.dueMs <= nowMs,
    )
    .sort((first, second) => first.dueMs - second.dueMs || first.item.id - second.item.id)
    .slice(0, Math.max(0, limit))
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
  limit = MAX_PRACTICE_SESSION_CARDS,
): PracticeSessionState<T> {
  return {
    queue: buildPracticeSession(items, now, limit),
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
