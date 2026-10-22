/**
 * Card-mode selection for a due sentence (SENTENCE_LIVE_V1 §2.6,
 * TASK-SENT-011).
 *
 * In `auto` mode the schedule decides the exercise: cards still being
 * learned (`new`/`learning`/`relearning`) are heard and typed back as
 * dictation, while graduated (`review`) cards are recalled from their
 * situation. A forced `dictation` or `recall` preference overrides the
 * schedule for every card.
 *
 * The function is pure: it takes the FSRS state and the preference, and returns
 * the card shape the practice screen must render. Suspended sentences never
 * reach a session; the flag lives outside this mapping.
 */
import type { ReviewCardMode, SentenceState } from '../db/types';
import type { PracticeMode } from '../preferences/practiceMode';

/** Pick the card shape for one sentence under the given preference. */
export function selectCardMode(
  sentenceState: SentenceState,
  practiceMode: PracticeMode,
): ReviewCardMode {
  if (practiceMode === 'dictation' || practiceMode === 'recall') {
    return practiceMode;
  }
  return sentenceState === 'review' ? 'recall' : 'dictation';
}
