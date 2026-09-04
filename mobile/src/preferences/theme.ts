/**
 * Persistence for the visual theme preference (SPEC TASK-044).
 *
 * A tiny non-secret enum stored in plain AsyncStorage (the same seam as the
 * application mode and the grammar toggle), because it applies in BOTH
 * modes. Missing, corrupted or unreadable values fall back deterministically
 * to 'system', so a fresh install (or a wiped store) keeps tracking the OS
 * preference instead of failing startup.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type {ThemeMode} from '../theme/ThemeContext';

export const DEFAULT_THEME_MODE: ThemeMode = 'system';

const THEME_STORAGE_KEY = 'app.themeMode';

const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

/** Narrow untrusted stored values to a valid mode; anything else is default. */
export function parseThemeMode(raw: string): ThemeMode {
  return (THEME_MODES as readonly string[]).includes(raw)
    ? (raw as ThemeMode)
    : DEFAULT_THEME_MODE;
}

export async function saveThemeMode(mode: ThemeMode): Promise<void> {
  await AsyncStorage.setItem(THEME_STORAGE_KEY, mode);
}

/** Load the persisted theme; absent/invalid values resolve to the default. */
export async function loadThemeMode(): Promise<ThemeMode> {
  try {
    const raw = await AsyncStorage.getItem(THEME_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_THEME_MODE;
    }
    return parseThemeMode(raw);
  } catch {
    return DEFAULT_THEME_MODE;
  }
}
