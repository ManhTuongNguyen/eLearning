/**
 * Persistence for the word-bank practice-mode preference (WORD_BANK_V1 §2.7,
 * TASK-WB-007).
 *
 * The learner can let the app pick the card shape from the word's schedule
 * (`auto` — dictation for new/learning/relearning, recall for review) or force
 * every card to be a dictation or a recall. The preference is a small
 * non-secret string stored in plain AsyncStorage, exactly like the sentence
 * practice mode, because it only affects the on-device practice screen.
 *
 * Any missing, corrupted or unreadable stored value falls back to `auto` so a
 * bad write can never leave the word practice screen without a valid mode.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const WORD_PRACTICE_MODE_STORAGE_KEY = 'app.wordPracticeMode';

/** How a word practice card is chosen: automatically or forced to one shape. */
export type WordPracticeMode = 'auto' | 'dictation' | 'recall';

/** The automatic mix is the documented default (WORD_BANK_V1 §1.4). */
export const DEFAULT_WORD_PRACTICE_MODE: WordPracticeMode = 'auto';

const WORD_PRACTICE_MODES: readonly WordPracticeMode[] = ['auto', 'dictation', 'recall'];

/** Narrow an arbitrary stored value to a supported word practice mode. */
export function isWordPracticeMode(value: unknown): value is WordPracticeMode {
  return (
    typeof value === 'string' && (WORD_PRACTICE_MODES as readonly string[]).includes(value)
  );
}

/** Read the persisted mode; missing or invalid values mean `auto`. */
export async function loadWordPracticeMode(): Promise<WordPracticeMode> {
  try {
    const raw = await AsyncStorage.getItem(WORD_PRACTICE_MODE_STORAGE_KEY);
    return isWordPracticeMode(raw) ? raw : DEFAULT_WORD_PRACTICE_MODE;
  } catch {
    return DEFAULT_WORD_PRACTICE_MODE;
  }
}

/** Persist the chosen mode. */
export async function saveWordPracticeMode(mode: WordPracticeMode): Promise<void> {
  await AsyncStorage.setItem(WORD_PRACTICE_MODE_STORAGE_KEY, mode);
}
