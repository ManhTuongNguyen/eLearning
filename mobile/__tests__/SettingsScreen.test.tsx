/**
 * Settings screen tests (SPEC TASK-091): every documented control renders,
 * and only the options relevant to the active application mode are shown.
 * Server mode exposes the server-backed learning-level and vocabulary
 * entries; serverless replaces them with an OpenRouter status card that
 * reports configuration presence without ever revealing the API key value.
 * Account identity, theme segments, application-mode switcher and logout are
 * visible in both modes.
 */
import React from 'react';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {useAuth} from '../src/auth/AuthContext';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {setRuntimeApplicationMode} from '../src/mode/runtime';
import {DEFAULT_APPLICATION_MODE} from '../src/mode/types';
import type {SettingsScreenProps} from '../src/navigation/types';
import {SettingsScreen} from '../src/screens/SettingsScreen';
import * as serverlessSettings from '../src/serverless/settings';
import type {OpenRouterClientConfig} from '../src/serverless/types';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/auth/AuthContext', () => ({
  __esModule: true,
  useAuth: jest.fn(),
  toErrorMessage: (err: unknown) => String(err),
  AuthProvider: ({children}: {children: React.ReactNode}) => children,
}));
jest.mock('../src/serverless/settings');

const mockedConfig = jest.mocked(serverlessSettings.loadServerlessOpenRouterConfig);
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

const SECRET_KEY = 'sk-or-v1-totally-secret-value';
const mockLogout = jest.fn();
const mockedUseAuth = jest.mocked(useAuth);

function stubAuth() {
  mockedUseAuth.mockReturnValue({
    status: 'authenticated',
    user: {id: 1, username: 'alice', email: 'alice@example.com'},
    error: null,
    busy: false,
    logout: mockLogout,
    getAccessToken: async () => 'token',
    authedRequest: async <T,>() => undefined as T,
    login: async () => undefined,
    register: async () => undefined,
  });
}

function configuredStub(): OpenRouterClientConfig {
  return {
    apiKey: SECRET_KEY,
    primaryModel: 'openai/gpt-4o-mini',
    fallbackModels: ['anthropic/claude-3-haiku', 'meta-llama/llama-3.1-8b-instruct'],
  };
}

function settingsProps(): SettingsScreenProps {
  return {
    navigation: {navigate: jest.fn(), goBack: jest.fn()},
    route: {key: 'settings-test', name: 'Settings', params: undefined},
  } as unknown as SettingsScreenProps;
}

/** Checked state of one of the settings radio controls, read once settled. */
function checkedStateOf(testID: string): boolean | undefined {
  const state = screen.getByTestId(testID).props.accessibilityState;
  return state ? state.checked : undefined;
}

/**
 * Renders the screen inside the providers it consumes, restoring the given
 * application mode exactly like an app start would (persisted flag -> Mode).
 */
async function renderSettings(mode: 'server' | 'serverless') {
  await saveApplicationMode(mode);
  const props = settingsProps();

  render(
    <ModeProvider>
      <ThemeProvider>
        <SettingsScreen {...props} />
      </ThemeProvider>
    </ModeProvider>,
  );

  // Wait until the restored mode is reflected by the switcher.
  await waitFor(() => {
    expect(checkedStateOf(mode === 'server' ? 'settings-mode-server' : 'settings-mode-serverless')).toBe(true);
  });

  return props;
}

beforeEach(() => {
  asyncStorage.__resetAsyncStorageStore();
  jest.clearAllMocks();
  stubAuth();
  // Default to an unconfigured device; individual tests override this.
  mockedConfig.mockResolvedValue(null);
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

afterEach(() => {
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

describe('controls present in every mode', () => {
  it.each(['server', 'serverless'] as const)(
    'shows the signed-in account identity in %s mode',
    async mode => {
      await renderSettings(mode);

      expect(screen.getByTestId('settings-account-email')).toHaveTextContent(
        'alice@example.com',
      );
      expect(screen.getByText('Signed in as')).toBeOnTheScreen();
    },
  );

  it.each(['server', 'serverless'] as const)(
    'shows the three theme choices and marks system as the default in %s mode',
    async mode => {
      await renderSettings(mode);

      expect(screen.getByTestId('settings-theme-light')).toBeOnTheScreen();
      expect(screen.getByTestId('settings-theme-dark')).toBeOnTheScreen();
      expect(screen.getByTestId('settings-theme-system')).toBeOnTheScreen();
      expect(checkedStateOf('settings-theme-system')).toBe(true);
      expect(checkedStateOf('settings-theme-light')).toBe(false);
    },
  );

  it('selecting a theme updates the active segment', async () => {
    await renderSettings('server');

    fireEvent.press(screen.getByTestId('settings-theme-dark'));

    await waitFor(() => expect(checkedStateOf('settings-theme-dark')).toBe(true));
    expect(checkedStateOf('settings-theme-system')).toBe(false);
  });

  it('routes the logout press into the auth context', async () => {
    await renderSettings('server');

    fireEvent.press(screen.getByTestId('settings-logout'));

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});

describe('server-mode visibility', () => {
  it('offers learning level and vocabulary and hides OpenRouter settings', async () => {
    const props = await renderSettings('server');

    expect(screen.getByTestId('settings-open-level')).toBeOnTheScreen();
    expect(screen.getByTestId('settings-open-vocabulary')).toBeOnTheScreen();
    expect(screen.queryByTestId('settings-openrouter-card')).toBeNull();

    fireEvent.press(screen.getByTestId('settings-open-level'));
    expect(props.navigation.navigate).toHaveBeenCalledWith('Level');
  });

  it('opens the vocabulary list entry point toward its own route', async () => {
    const props = await renderSettings('server');

    fireEvent.press(screen.getByTestId('settings-open-vocabulary'));

    expect(props.navigation.navigate).toHaveBeenCalledWith('Vocabulary');
  });

  it('never queries serverless configuration while in server mode', async () => {
    await renderSettings('server');

    expect(mockedConfig).not.toHaveBeenCalled();
  });
});

describe('serverless-mode visibility (TASK-091)', () => {
  it('replaces server-backed rows with the OpenRouter settings card', async () => {
    mockedConfig.mockResolvedValue(configuredStub());
    await renderSettings('serverless');

    expect(screen.queryByTestId('settings-open-level')).toBeNull();
    expect(screen.queryByTestId('settings-open-vocabulary')).toBeNull();
    expect(screen.getByTestId('settings-openrouter-card')).toBeOnTheScreen();
    expect(mockedConfig).toHaveBeenCalledTimes(1);
  });

  it('summarizes a fully-configured OpenRouter setup without exposing the key', async () => {
    mockedConfig.mockResolvedValue(configuredStub());
    await renderSettings('serverless');

    expect(await screen.findByTestId('settings-openrouter-key-status')).toHaveTextContent(
      'Saved on this device',
    );
    expect(screen.getByTestId('settings-openrouter-primary-status')).toHaveTextContent(
      'openai/gpt-4o-mini',
    );
    expect(screen.getByTestId('settings-openrouter-fallback-status')).toHaveTextContent(
      '2 selected',
    );
    expect(screen.getByTestId('settings-openrouter-badge')).toHaveTextContent('Ready');
    // The secret itself must never be rendered anywhere on the screen.
    expect(screen.queryByText(SECRET_KEY)).toBeNull();
  });

  it('reports an unconfigured setup when nothing has been stored yet', async () => {
    mockedConfig.mockResolvedValue(null);
    await renderSettings('serverless');

    expect(await screen.findByTestId('settings-openrouter-key-status')).toHaveTextContent(
      'Not configured',
    );
    expect(screen.getByTestId('settings-openrouter-primary-status')).toHaveTextContent(
      'Not selected',
    );
    expect(screen.getByTestId('settings-openrouter-fallback-status')).toHaveTextContent('None');
    expect(screen.getByTestId('settings-openrouter-badge')).toHaveTextContent('Not set up');
  });

  it('degrades storage failures to an unconfigured report instead of crashing', async () => {
    mockedConfig.mockRejectedValue(new Error('sqlite unavailable'));
    await renderSettings('serverless');

    expect(await screen.findByTestId('settings-openrouter-key-status')).toHaveTextContent(
      'Not configured',
    );
  });

  it('keeps the documentation copy for both modes on the switcher cards', async () => {
    mockedConfig.mockResolvedValue(null);
    await renderSettings('serverless');

    expect(screen.getByText('Your conversations are stored with your account.')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Conversations stay on this device and AI requests go directly to OpenRouter.',
      ),
    ).toBeOnTheScreen();
  });

  it('opens the OpenRouter editor from the serverless status card (TASK-092)', async () => {
    mockedConfig.mockResolvedValue(configuredStub());
    const props = await renderSettings('serverless');

    fireEvent.press(await screen.findByTestId('settings-openrouter-card'));

    expect(props.navigation.navigate).toHaveBeenCalledWith('OpenRouterSettings');
  });
});
