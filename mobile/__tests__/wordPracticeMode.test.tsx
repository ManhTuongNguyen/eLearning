/**
 * Word practice-mode preference and Settings-row tests (WORD_BANK_V1
 * TASK-WB-007).
 *
 * The preference is a tiny persisted string with the same contract as the
 * sentence practice mode: `auto` by default, invalid or unreadable stored
 * values fall back to `auto`, and the row is visible in serverless mode only.
 * `selectCardMode` is reused unchanged from the sentence feature, so the
 * mapping table itself is pinned in `sentencePracticeMode.test.ts`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type React from 'react';

import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import { setRuntimeApplicationMode } from '../src/mode/runtime';
import { DEFAULT_APPLICATION_MODE } from '../src/mode/types';
import type { SettingsScreenProps } from '../src/navigation/types';
import {
  DEFAULT_WORD_PRACTICE_MODE,
  isWordPracticeMode,
  loadWordPracticeMode,
  saveWordPracticeMode,
} from '../src/preferences/wordPracticeMode';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import * as serverlessSettings from '../src/serverless/settings';
import { ThemeProvider } from '../src/theme/ThemeContext';

jest.mock('../src/auth/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({
    status: 'authenticated',
    user: { id: 1, username: 'alice', email: 'alice@example.com' },
    error: null,
    busy: false,
    logout: jest.fn(),
    getAccessToken: async () => 'token',
    authedRequest: async <T,>() => undefined as T,
    login: async () => undefined,
    register: async () => undefined,
  }),
  toErrorMessage: (err: unknown) => String(err),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/serverless/settings');

const mockedConfig = jest.mocked(serverlessSettings.loadServerlessConfig);
const mockedLoadProvider = jest.mocked(serverlessSettings.loadServerlessProvider);
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

function checkedStateOf(testID: string): boolean | undefined {
  const state = screen.getByTestId(testID).props.accessibilityState;
  return state ? state.checked : undefined;
}

async function renderSettings(mode: 'server' | 'serverless') {
  await saveApplicationMode(mode);
  const props = {
    navigation: {
      navigate: jest.fn(),
      goBack: jest.fn(),
      popToTop: jest.fn(),
      setParams: jest.fn(),
    },
    route: { key: 'settings-test', name: 'Settings', params: undefined },
  } as unknown as SettingsScreenProps;

  await render(
    <ModeProvider>
      <ThemeProvider>
        <SettingsScreen {...props} />
      </ThemeProvider>
    </ModeProvider>,
  );

  await waitFor(() => {
    expect(
      checkedStateOf(mode === 'server' ? 'settings-mode-server' : 'settings-mode-serverless'),
    ).toBe(true);
  });
}

beforeEach(() => {
  asyncStorage.__resetAsyncStorageStore();
  jest.clearAllMocks();
  mockedConfig.mockResolvedValue(null);
  mockedLoadProvider.mockResolvedValue('openrouter');
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

afterEach(() => {
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

describe('word practice-mode preference', () => {
  test('defaults to auto when nothing has been saved', async () => {
    await expect(loadWordPracticeMode()).resolves.toBe('auto');
    expect(DEFAULT_WORD_PRACTICE_MODE).toBe('auto');
  });

  test('persists a chosen mode and reads it back across a remount', async () => {
    await saveWordPracticeMode('recall');
    await expect(loadWordPracticeMode()).resolves.toBe('recall');

    await saveWordPracticeMode('dictation');
    await expect(loadWordPracticeMode()).resolves.toBe('dictation');
  });

  test('falls back to auto for invalid persisted values', async () => {
    await AsyncStorage.setItem('app.wordPracticeMode', 'bogus');
    await expect(loadWordPracticeMode()).resolves.toBe('auto');

    await AsyncStorage.setItem('app.wordPracticeMode', '');
    await expect(loadWordPracticeMode()).resolves.toBe('auto');
  });

  test('falls back to auto when storage cannot be read', async () => {
    jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(loadWordPracticeMode()).resolves.toBe('auto');
  });

  test('recognises exactly the three supported modes', () => {
    expect(isWordPracticeMode('auto')).toBe(true);
    expect(isWordPracticeMode('dictation')).toBe(true);
    expect(isWordPracticeMode('recall')).toBe(true);
    expect(isWordPracticeMode('Auto')).toBe(false);
    expect(isWordPracticeMode(null)).toBe(false);
    expect(isWordPracticeMode(1)).toBe(false);
  });
});

describe('word practice-mode Settings row', () => {
  test('renders in serverless mode, defaults to auto and persists a change', async () => {
    await renderSettings('serverless');

    expect(await screen.findByTestId('settings-word-practice-mode-section')).toBeOnTheScreen();
    expect(checkedStateOf('settings-word-practice-mode-auto')).toBe(true);
    expect(checkedStateOf('settings-word-practice-mode-dictation')).toBe(false);
    expect(checkedStateOf('settings-word-practice-mode-recall')).toBe(false);

    fireEvent.press(screen.getByTestId('settings-word-practice-mode-dictation'));
    await waitFor(() => expect(checkedStateOf('settings-word-practice-mode-dictation')).toBe(true));
    await expect(loadWordPracticeMode()).resolves.toBe('dictation');
  });

  test('reflects a previously persisted mode on load', async () => {
    await saveWordPracticeMode('recall');
    await renderSettings('serverless');

    expect(await screen.findByTestId('settings-word-practice-mode-section')).toBeOnTheScreen();
    await waitFor(() => expect(checkedStateOf('settings-word-practice-mode-recall')).toBe(true));
    expect(checkedStateOf('settings-word-practice-mode-auto')).toBe(false);
  });

  test('is hidden in server mode', async () => {
    await renderSettings('server');

    expect(screen.queryByTestId('settings-word-practice-mode-section')).toBeNull();
    expect(screen.queryByTestId('settings-word-practice-mode-auto')).toBeNull();
    expect(screen.queryByTestId('settings-word-practice-mode-dictation')).toBeNull();
    expect(screen.queryByTestId('settings-word-practice-mode-recall')).toBeNull();
  });
});
