/**
 * Persistence for the selected application mode (SPEC TASK-080).
 *
 * The flag is a tiny non-secret preference, so plain AsyncStorage is the
 * right home; missing, corrupted or unreadable values fall back
 * deterministically to the default (server) mode instead of failing startup.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {DEFAULT_APPLICATION_MODE, parseApplicationMode} from './types';
import type {ApplicationMode} from './types';

const MODE_STORAGE_KEY = 'app.applicationMode';

export async function saveApplicationMode(mode: ApplicationMode): Promise<void> {
  await AsyncStorage.setItem(MODE_STORAGE_KEY, mode);
}

/** Load the persisted mode; absent/invalid values resolve to the default. */
export async function loadApplicationMode(): Promise<ApplicationMode> {
  try {
    const raw = await AsyncStorage.getItem(MODE_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_APPLICATION_MODE;
    }
    return parseApplicationMode(raw) ?? DEFAULT_APPLICATION_MODE;
  } catch {
    return DEFAULT_APPLICATION_MODE;
  }
}
