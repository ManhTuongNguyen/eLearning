/**
 * Persistence for the real-life sentence practice-mode preference.
 *
 * The learner can let the app pick the card shape from the sentence's schedule
 * (`auto`) or force every card to be a dictation or a recall. The preference
 * is a small non-secret string stored in plain AsyncStorage, exactly like the
 * grammar auto-check flag, because it only affects the on-device practice
 * screen.
 *
 * Any missing, corrupted or unreadable stored value falls back to `auto` so a
 * bad write can never leave the practice screen without a valid mode.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const PRACTICE_MODE_STORAGE_KEY = 'app.sentencePracticeMode';

/** How a practice card is chosen: automatically or forced to one shape. */
export type PracticeMode = 'auto' | 'dictation' | 'recall';

/** The automatic mix is the documented default (SENTENCE_LIVE_V1 §2.6). */
export const DEFAULT_PRACTICE_MODE: PracticeMode = 'auto';

const PRACTICE_MODES: readonly PracticeMode[] = ['auto', 'dictation', 'recall'];

/** Narrow an arbitrary stored value to a supported practice mode. */
export function isPracticeMode(value: unknown): value is PracticeMode {
  return typeof value === 'string' && (PRACTICE_MODES as readonly string[]).includes(value);
}

/** Read the persisted mode; missing or invalid values mean `auto`. */
export async function loadPracticeMode(): Promise<PracticeMode> {
  try {
    const raw = await AsyncStorage.getItem(PRACTICE_MODE_STORAGE_KEY);
    return isPracticeMode(raw) ? raw : DEFAULT_PRACTICE_MODE;
  } catch {
    return DEFAULT_PRACTICE_MODE;
  }
}

/** Persist the chosen mode. */
export async function savePracticeMode(mode: PracticeMode): Promise<void> {
  await AsyncStorage.setItem(PRACTICE_MODE_STORAGE_KEY, mode);
}
