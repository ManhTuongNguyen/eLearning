/**
 * Practice-mode preference and card-selection tests (TASK-SENT-011).
 *
 * The preference is a tiny persisted string, but a corrupted value must never
 * break the practice screen, so the load path is pinned against missing,
 * invalid and unreadable storage. The pure `selectCardMode` table is pinned
 * separately: auto follows the schedule, forced modes override it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type {SentenceStatus} from '../src/db/types';
import {selectCardMode} from '../src/srs/cardMode';
import {
  DEFAULT_PRACTICE_MODE,
  isPracticeMode,
  loadPracticeMode,
  savePracticeMode,
} from '../src/preferences/practiceMode';

const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

beforeEach(() => {
  asyncStorage.__resetAsyncStorageStore();
  jest.clearAllMocks();
});

describe('practice-mode preference', () => {
  test('defaults to auto when nothing has been saved', async () => {
    await expect(loadPracticeMode()).resolves.toBe('auto');
    expect(DEFAULT_PRACTICE_MODE).toBe('auto');
  });

  test('persists a chosen mode and reads it back', async () => {
    await savePracticeMode('recall');
    await expect(loadPracticeMode()).resolves.toBe('recall');

    await savePracticeMode('dictation');
    await expect(loadPracticeMode()).resolves.toBe('dictation');
  });

  test('falls back to auto for invalid persisted values', async () => {
    await AsyncStorage.setItem('app.sentencePracticeMode', 'bogus');
    await expect(loadPracticeMode()).resolves.toBe('auto');

    await AsyncStorage.setItem('app.sentencePracticeMode', '');
    await expect(loadPracticeMode()).resolves.toBe('auto');
  });

  test('falls back to auto when storage cannot be read', async () => {
    jest
      .mocked(AsyncStorage.getItem)
      .mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(loadPracticeMode()).resolves.toBe('auto');
  });

  test('recognises exactly the three supported modes', () => {
    expect(isPracticeMode('auto')).toBe(true);
    expect(isPracticeMode('dictation')).toBe(true);
    expect(isPracticeMode('recall')).toBe(true);
    expect(isPracticeMode('Auto')).toBe(false);
    expect(isPracticeMode(null)).toBe(false);
    expect(isPracticeMode(undefined)).toBe(false);
    expect(isPracticeMode(1)).toBe(false);
  });
});

describe('selectCardMode', () => {
  const statuses: SentenceStatus[] = ['new', 'learning', 'review', 'suspended'];

  test.each(statuses)('auto maps %s from its schedule state', status => {
    expect(selectCardMode(status, 'auto')).toBe(
      status === 'review' ? 'recall' : 'dictation',
    );
  });

  test.each(statuses)('forced dictation overrides %s', status => {
    expect(selectCardMode(status, 'dictation')).toBe('dictation');
  });

  test.each(statuses)('forced recall overrides %s', status => {
    expect(selectCardMode(status, 'recall')).toBe('recall');
  });
});
