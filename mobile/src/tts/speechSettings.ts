/**
 * Persistence for TTS preferences (TASK-TTS-001). Speech settings are tiny
 * non-secret device preferences, so plain AsyncStorage is the right home —
 * the same policy as the application-mode flag (modeStorage.ts). Missing,
 * corrupted or unreadable values fall back deterministically to the defaults
 * instead of failing speech playback.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {normalizeSpeechPreferences} from './types';
import type {SpeechPreferences} from './types';

const SPEECH_SETTINGS_KEY = 'app.speechPreferences';

/** Persist the current preferences; partial writes replace the whole entry. */
export async function saveSpeechPreferences(
  preferences: SpeechPreferences,
): Promise<void> {
  await AsyncStorage.setItem(SPEECH_SETTINGS_KEY, JSON.stringify(preferences));
}

/** Load the persisted preferences; anything invalid resolves to defaults. */
export async function loadSpeechPreferences(): Promise<SpeechPreferences> {
  try {
    const raw = await AsyncStorage.getItem(SPEECH_SETTINGS_KEY);
    if (raw === null) {
      return normalizeSpeechPreferences(null);
    }
    return normalizeSpeechPreferences(JSON.parse(raw));
  } catch {
    return normalizeSpeechPreferences(null);
  }
}

/** Remove stored preferences (used by local-data clearing flows). */
export async function clearSpeechPreferences(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SPEECH_SETTINGS_KEY);
  } catch {
    // Removing an absent/unreadable entry is not an error.
  }
}
