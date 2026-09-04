/**
 * Persistence for the grammar auto-check preference.
 *
 * A tiny non-secret on/off flag stored in plain AsyncStorage (the same seam
 * as the application mode), because it applies in BOTH modes: server mode
 * asks the backend improvement endpoint after each sent message, serverless
 * mode runs the identical check through the user's own provider key.
 * Missing, corrupted or unreadable values fall back deterministically to
 * the default (disabled), so enabling it always costs an extra provider
 * request per sent message — a deliberate, explicit choice.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const GRAMMAR_CHECK_STORAGE_KEY = 'app.grammarCheckEnabled';

/** The feature is opt-in: every absent/unreadable value means "off". */
export async function loadGrammarCheckEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(GRAMMAR_CHECK_STORAGE_KEY)) === 'true';
  } catch {
    return false;
  }
}

export async function saveGrammarCheckEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(GRAMMAR_CHECK_STORAGE_KEY, enabled ? 'true' : 'false');
}
