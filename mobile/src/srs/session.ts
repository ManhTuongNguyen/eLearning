/**
 * Practice-session rules for the real-life sentence bank (TASK-SENT-009,
 * SENTENCE_LIVE_V1 §2.3).
 *
 * The topic screen asks `canPractice` whether a topic holds enough sentences to
 * open a session. The full due-only session builder lands with the practice
 * screen (TASK-SENT-012); keeping the unlock threshold here means the UI and
 * the session builder share one source of truth.
 */

/** Sentences a topic must hold before practice unlocks. */
export const MIN_PRACTICE_SENTENCES = 5;

/**
 * True when a topic holds enough sentences to practice. `sentenceCount` is the
 * total number of sentences in the topic (suspended ones included) — the same
 * count the topic screen shows.
 */
export function canPractice(sentenceCount: number): boolean {
  return sentenceCount >= MIN_PRACTICE_SENTENCES;
}
