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
 * these functions decide what "next card" means. Following Anki's learning-step
 * behaviour, every `Again` puts the card back at the end of the current queue —
 * not just the first one. A sentence therefore keeps coming back within the
 * same session until it is graded Good or Easy.
 */
import type {ReviewGrade, SentenceRecord} from '../db/types';

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
    .map(sentence => ({sentence, dueMs: Date.parse(sentence.due_at)}))
    .filter(
      entry =>
        entry.sentence.status !== 'suspended' &&
        Number.isFinite(entry.dueMs) &&
        entry.dueMs <= nowMs,
    )
    .sort(
      (first, second) =>
        first.dueMs - second.dueMs || first.sentence.id - second.sentence.id,
    )
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
 * `learning` status when it comes back.
 *
 * Like Anki's learning steps, `Again` appends the card to the end of the
 * current queue every time it is pressed; only Good or Easy removes it for good.
 */
export function applyPracticeGrade(
  session: PracticeSessionState,
  grade: ReviewGrade,
  updatedCard: SentenceRecord,
): PracticeSessionState {
  const remaining = session.queue.slice(1);
  if (grade !== 'again') {
    return {queue: remaining};
  }
  return {queue: [...remaining, updatedCard]};
}
