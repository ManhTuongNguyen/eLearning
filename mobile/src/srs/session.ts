/**
 * Practice-session rules for the real-life sentence bank (TASK-SENT-009/012,
 * SENTENCE_LIVE_V1 §2.3).
 *
 * The topic screen asks `canPractice` whether a topic holds enough sentences to
 * open a session; `buildPracticeSession` selects the due cards in the order
 * they should be shown. Both live here so the unlock threshold and the session
 * contents share one source of truth.
 *
 * The stateful half (`createPracticeSessionState` / `applyPracticeGrade`) is
 * still pure: the screen owns the clock, the storage and the React state, while
 * these functions decide what "next card" means.
 *
 * Anki parity: a card only leaves the session once FSRS graduates it to
 * `review`. While it is in a short-term `learning`/`relearning` step it is
 * appended to the end of the current queue, so an `Again` (1-minute step) or a
 * first `Good` (10-minute step) brings it back. Anki calls this the *learn
 * ahead* limit; a session is small enough that waiting out 10 minutes would
 * make practice unusable, so the card is shown as soon as it reaches the end of
 * the queue.
 */
import type { ReviewGrade, SentenceRecord } from '../db/types';

/** Sentences a topic must hold before practice unlocks. */
export const MIN_PRACTICE_SENTENCES = 5;

/** Hard cap on cards in one practice session. */
export const MAX_PRACTICE_SESSION_CARDS = 20;

/**
 * True when a topic holds enough sentences to practice. `sentenceCount` is the
 * total number of sentences in the topic (suspended ones included) — the same
 * count the topic screen shows.
 */
export function canPractice(sentenceCount: number): boolean {
  return sentenceCount >= MIN_PRACTICE_SENTENCES;
}

/**
 * Select the due cards of a topic: non-suspended sentences whose `due_at` is at
 * or before `now`, oldest due first, ties broken by ascending id, capped at
 * `limit` (20 by default). The input array is never mutated.
 */
export function buildPracticeSession(
  sentences: readonly SentenceRecord[],
  now: Date,
  limit = MAX_PRACTICE_SESSION_CARDS,
): SentenceRecord[] {
  const nowMs = now.getTime();
  return sentences
    .map(sentence => ({ sentence, dueMs: Date.parse(sentence.due_at) }))
    .filter(
      entry => !entry.sentence.suspended && Number.isFinite(entry.dueMs) && entry.dueMs <= nowMs,
    )
    .sort((first, second) => first.dueMs - second.dueMs || first.sentence.id - second.sentence.id)
    .slice(0, Math.max(0, limit))
    .map(entry => entry.sentence);
}

/** An in-progress session: the cards still to show, current card first. */
export interface PracticeSessionState {
  /** Cards still to show, current card first. */
  readonly queue: readonly SentenceRecord[];
}

/** Start a session from a topic's sentences at the given moment. */
export function createPracticeSessionState(
  sentences: readonly SentenceRecord[],
  now: Date,
  limit = MAX_PRACTICE_SESSION_CARDS,
): PracticeSessionState {
  return {
    queue: buildPracticeSession(sentences, now, limit),
  };
}

/**
 * Consume the current card after a grade. `updatedCard` is the sentence with
 * the scheduler's new state applied, so a requeued card already carries its
 * `learning`/`relearning` state when it comes back.
 *
 * Only a card that FSRS graduated to `review` leaves the session; every other
 * outcome (including the first `Good` of a new card, which only advances to the
 * 10-minute step) requeues it.
 */
export function applyPracticeGrade(
  session: PracticeSessionState,
  _grade: ReviewGrade,
  updatedCard: SentenceRecord,
): PracticeSessionState {
  const remaining = session.queue.slice(1);
  const staysInSession = updatedCard.state === 'learning' || updatedCard.state === 'relearning';
  if (!staysInSession) {
    return { queue: remaining };
  }
  return { queue: [...remaining, updatedCard] };
}
