/**
 * Card-mode selection for a due sentence (SENTENCE_LIVE_V1 §2.6,
 * TASK-SENT-011).
 *
 * In `auto` mode the schedule decides the exercise: sentences still being
 * learned (`new`/`learning`) are heard and typed back as dictation, while
 * graduated (`review`) sentences are recalled from their situation. A forced
 * `dictation` or `recall` preference overrides the schedule for every card.
 *
 * The function is pure: it takes the status and the preference, and returns the
 * card shape the practice screen must render. Suspended sentences never reach a
 * session, but they are mapped like the other non-review states so the function
 * stays total.
 */
import type {ReviewCardMode, SentenceStatus} from '../db/types';
import type {PracticeMode} from '../preferences/practiceMode';

/** Pick the card shape for one sentence under the given preference. */
export function selectCardMode(
  sentenceStatus: SentenceStatus,
  practiceMode: PracticeMode,
): ReviewCardMode {
  if (practiceMode === 'dictation' || practiceMode === 'recall') {
    return practiceMode;
  }
  return sentenceStatus === 'review' ? 'recall' : 'dictation';
}
