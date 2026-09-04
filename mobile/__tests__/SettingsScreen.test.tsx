/**
 * Settings screen tests (SPEC TASK-091): every documented control renders,
 * and only the options relevant to the active application mode are shown.
 * Server mode exposes the server-backed learning-level and vocabulary
 * entries; serverless replaces them with an OpenRouter status card that
 * reports configuration presence without ever revealing the API key value.
 * Account identity and logout are server-mode only (TASK-AUDIT-003):
 * serverless mode is independent of server accounts, so no account
 * information is displayed there. Theme segments and the application-mode
 * switcher are visible in both modes.
 */
import React from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {useAuth} from '../src/auth/AuthContext';
import {
  loadGrammarCheckEnabled,
  saveGrammarCheckEnabled,
} from '../src/preferences/grammarCheck';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {setRuntimeApplicationMode} from '../src/mode/runtime';
import {DEFAULT_APPLICATION_MODE} from '../src/mode/types';
import type {MainStackParamList, SettingsScreenProps} from '../src/navigation/types';
import {
  CONFIG_SAVED_TOAST_DURATION_MS,
  createStyles,
  SettingsScreen,
} from '../src/screens/SettingsScreen';
import * as serverlessSettings from '../src/serverless/settings';
import type {OpenRouterClientConfig} from '../src/serverless/types';
import {lightColors} from '../src/theme/colors';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/auth/AuthContext', () => ({
  __esModule: true,
  useAuth: jest.fn(),
  toErrorMessage: (err: unknown) => String(err),
  AuthProvider: ({children}: {children: React.ReactNode}) => children,
}));
jest.mock('../src/serverless/settings');
jest.mock('../src/preferences/grammarCheck');

const mockedGrammarCheckEnabled = jest.mocked(loadGrammarCheckEnabled);
const mockedSaveGrammarCheckEnabled = jest.mocked(saveGrammarCheckEnabled);

const mockedConfig = jest.mocked(serverlessSettings.loadServerlessOpenRouterConfig);
const mockedLoadProvider = jest.mocked(serverlessSettings.loadServerlessProvider);
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

function settingsProps(params?: MainStackParamList['Settings']): SettingsScreenProps {
  return {
    navigation: {navigate: jest.fn(), goBack: jest.fn(), popToTop: jest.fn(), setParams: jest.fn()},
    route: {key: 'settings-test', name: 'Settings', params},
  } as unknown as SettingsScreenProps;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  const entries = Array.isArray(style) ? style : [style];
  return Object.assign(
    {},
    ...entries.filter(Boolean).map(s => (typeof s === 'object' ? s : {})),
  );
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
async function renderSettings(mode: 'server' | 'serverless', params?: MainStackParamList['Settings']) {
  await saveApplicationMode(mode);
  const props = settingsProps(params);

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
  // Default to an unconfigured device on the historic default provider;
  // individual tests override this.
  mockedConfig.mockResolvedValue(null);
  mockedLoadProvider.mockResolvedValue('openrouter');
  // Grammar auto-check is off until the user explicitly enables it.
  mockedGrammarCheckEnabled.mockResolvedValue(false);
  mockedSaveGrammarCheckEnabled.mockResolvedValue(undefined);
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

afterEach(() => {
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

describe('controls present in every mode', () => {
  it('shows the signed-in account identity in server mode', async () => {
    await renderSettings('server');

    expect(screen.getByTestId('settings-account-email')).toHaveTextContent(
      'alice@example.com',
    );
    expect(screen.getByText('Signed in as')).toBeOnTheScreen();
  });

  it('hides all account information in serverless mode (TASK-AUDIT-003)', async () => {
    await renderSettings('serverless');

    expect(screen.queryByTestId('settings-account-section')).toBeNull();
    expect(screen.queryByText('Signed in as')).toBeNull();
    expect(screen.queryByTestId('settings-account-email')).toBeNull();
  });

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

  it.each(['server', 'serverless'] as const)(
    'shows the back affordance and routes back to the chat screen when pressed in %s mode (TASK-AUDIT-006)',
    async mode => {
      const props = await renderSettings(mode);

      expect(screen.getByTestId('settings-back')).toBeOnTheScreen();
      expect(screen.getByLabelText('Go back')).toBeOnTheScreen();

      fireEvent.press(screen.getByTestId('settings-back'));

      // Settings always pops the stack down to Chat (the stack root), so
      // leaving it can never land on a screen stacked below — e.g. the AI
      // provider editor after a completed save.
      expect(props.navigation.popToTop).toHaveBeenCalledTimes(1);
      expect(props.navigation.goBack).not.toHaveBeenCalled();
      expect(props.navigation.navigate).not.toHaveBeenCalled();
    },
  );

  it('hides the server logout control in serverless mode (TASK-AUDIT-003)', async () => {
    await renderSettings('serverless');

    expect(screen.queryByTestId('settings-logout')).toBeNull();
  });
});

describe('server-mode visibility', () => {
  it('offers learning level and vocabulary and hides OpenRouter settings', async () => {
    const props = await renderSettings('server');

    expect(screen.getByTestId('settings-open-level')).toBeOnTheScreen();
    expect(screen.getByTestId('settings-open-vocabulary')).toBeOnTheScreen();
    expect(screen.queryByTestId('settings-ai-provider-card')).toBeNull();

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
    expect(screen.getByTestId('settings-ai-provider-card')).toBeOnTheScreen();
    expect(mockedConfig).toHaveBeenCalledTimes(1);
  });

  it('summarizes a fully-configured OpenRouter setup without exposing the key', async () => {
    mockedConfig.mockResolvedValue(configuredStub());
    await renderSettings('serverless');

    expect(await screen.findByTestId('settings-ai-provider-key-status')).toHaveTextContent(
      'Saved on this device',
    );
    expect(screen.getByTestId('settings-ai-provider-title')).toHaveTextContent('OpenRouter');
    expect(screen.getByTestId('settings-ai-provider-primary-status')).toHaveTextContent(
      'openai/gpt-4o-mini',
    );
    expect(screen.getByTestId('settings-ai-provider-fallback-status')).toHaveTextContent(
      '2 selected',
    );
    expect(screen.getByTestId('settings-ai-provider-badge')).toHaveTextContent('Ready');
    // The secret itself must never be rendered anywhere on the screen.
    expect(screen.queryByText(SECRET_KEY)).toBeNull();
  });

  it('labels the card with the persisted provider after switching the agent (TASK-AUDIT-013)', async () => {
    mockedConfig.mockResolvedValue({
      apiKey: SECRET_KEY,
      provider: 'gemini',
      primaryModel: 'models/gemini-2.0-flash',
      fallbackModels: [],
    });
    mockedLoadProvider.mockResolvedValue('gemini');
    await renderSettings('serverless');

    expect(await screen.findByTestId('settings-ai-provider-title')).toHaveTextContent(
      'Google Gemini',
    );
    expect(screen.getByTestId('settings-ai-provider-primary-status')).toHaveTextContent(
      'models/gemini-2.0-flash',
    );
    expect(screen.getByTestId('settings-ai-provider-badge')).toHaveTextContent('Ready');
  });

  it('reports an unconfigured setup when nothing has been stored yet', async () => {
    mockedConfig.mockResolvedValue(null);
    await renderSettings('serverless');

    expect(await screen.findByTestId('settings-ai-provider-key-status')).toHaveTextContent(
      'Not configured',
    );
    expect(screen.getByTestId('settings-ai-provider-primary-status')).toHaveTextContent(
      'Not selected',
    );
    expect(screen.getByTestId('settings-ai-provider-fallback-status')).toHaveTextContent('None');
    expect(screen.getByTestId('settings-ai-provider-badge')).toHaveTextContent('Not set up');
  });

  it('degrades storage failures to an unconfigured report instead of crashing', async () => {
    mockedConfig.mockRejectedValue(new Error('sqlite unavailable'));
    await renderSettings('serverless');

    expect(await screen.findByTestId('settings-ai-provider-key-status')).toHaveTextContent(
      'Not configured',
    );
  });

  it('keeps the documentation copy for both modes on the switcher cards', async () => {
    mockedConfig.mockResolvedValue(null);
    await renderSettings('serverless');

    expect(screen.getByText('Your conversations are stored with your account.')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Conversations stay on this device and AI requests go directly to your configured provider.',
      ),
    ).toBeOnTheScreen();
  });

  it('opens the OpenRouter editor from the serverless status card (TASK-092)', async () => {
    mockedConfig.mockResolvedValue(configuredStub());
    const props = await renderSettings('serverless');

    fireEvent.press(await screen.findByTestId('settings-ai-provider-card'));

    expect(props.navigation.navigate).toHaveBeenCalledWith('AIProviderSettings');
  });
});

describe('SettingsScreen scrollbar anchoring (TASK-IMPROVEMENT-001)', () => {
  // On Android the scroll indicator draws at the ScrollView's own frame
  // edge (ReactScrollView uses SCROLLBARS_OUTSIDE_OVERLAY), so the screen
  // gutter must never sit on an ancestor of the ScrollView: it belongs on
  // the header and the scroll content container so the indicator stays
  // anchored to the right screen edge.
  it('keeps horizontal padding off the container and the ScrollView frame', () => {
    const flatContainer = flattenStyle(createStyles(lightColors).container);

    expect(flatContainer.paddingHorizontal).toBeUndefined();
    expect(flatContainer.paddingLeft).toBeUndefined();
    expect(flatContainer.paddingRight).toBeUndefined();
    expect(flatContainer.padding).toBeUndefined();
  });

  it('applies the screen gutter to the header and the scroll content container', () => {
    const styles = createStyles(lightColors);

    expect(styles.header.paddingHorizontal).toBe(24);
    expect(styles.content.padding).toBe(24);
    expect(styles.content.paddingBottom).toBe(40);
  });
});

// TASK-IMPROVEMENT-005: the agent configuration editor hands back a
// one-shot `configSaved` flag only after its save resolved; Settings
// answers with a self-dismissing success toast. Without the flag — which
// includes every failed save, since those never navigate — no toast may
// ever appear.
describe('configuration-saved toast (TASK-IMPROVEMENT-005)', () => {
  it('flashes the success toast when the editor reports a completed save', async () => {
    const props = await renderSettings('serverless', {configSaved: true});

    const toast = await screen.findByTestId('settings-saved-toast');
    expect(toast).toHaveTextContent('Configuration saved successfully.');
    expect(screen.getByTestId('settings-saved-toast-text').props.role).toBe('status');
    // The one-shot flag is dropped from the route immediately, so a later
    // revisit or refocus can never replay a stale success toast.
    expect(props.navigation.setParams).toHaveBeenCalledWith({configSaved: undefined});
  });

  it('shows no toast when returning without the saved flag', async () => {
    await renderSettings('serverless');

    await waitFor(() =>
      expect(screen.getByTestId('settings-ai-provider-key-status')).toBeOnTheScreen(),
    );
    expect(screen.queryByTestId('settings-saved-toast')).toBeNull();
  });

  it('ignores an explicitly false saved flag', async () => {
    await renderSettings('serverless', {configSaved: false});

    await waitFor(() =>
      expect(screen.getByTestId('settings-ai-provider-key-status')).toBeOnTheScreen(),
    );
    expect(screen.queryByTestId('settings-saved-toast')).toBeNull();
  });

  it('dismisses the toast by itself after the fixed delay', async () => {
    // Mount without the flag and settle under real timers first, so the
    // save hand-over can be replayed on the live instance while the fake
    // clock controls the toast's scheduled dismissal.
    const view = await render(
      <ModeProvider>
        <ThemeProvider>
          <SettingsScreen {...settingsProps()} />
        </ThemeProvider>
      </ModeProvider>,
    );
    await waitFor(() => expect(checkedStateOf('settings-mode-serverless')).toBe(true));
    expect(screen.queryByTestId('settings-saved-toast')).toBeNull();

    jest.useFakeTimers();
    try {
      await act(async () => {
        view.rerender(
          <ModeProvider>
            <ThemeProvider>
              <SettingsScreen {...settingsProps({configSaved: true})} />
            </ThemeProvider>
          </ModeProvider>,
        );
      });
      expect(screen.getByTestId('settings-saved-toast')).toBeOnTheScreen();

      await act(async () => {
        jest.advanceTimersByTime(CONFIG_SAVED_TOAST_DURATION_MS);
      });
      expect(screen.queryByTestId('settings-saved-toast')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('grammar auto-check toggle', () => {
  it('appears in both modes and defaults to off', async () => {
    await renderSettings('server');
    expect(screen.getByTestId('settings-grammar-section')).toBeOnTheScreen();
    expect(checkedStateOf('settings-grammar-toggle')).toBe(false);

    await renderSettings('serverless');
    expect(screen.getByTestId('settings-grammar-section')).toBeOnTheScreen();
    expect(checkedStateOf('settings-grammar-toggle')).toBe(false);
  });

  it('warns that enabling consumes extra AI requests per message', async () => {
    await renderSettings('server');

    expect(
      screen.getByText(/extra AI request per message/i),
    ).toBeOnTheScreen();
  });

  it('persists the enabled state through the preference store', async () => {
    await renderSettings('server');

    fireEvent.press(screen.getByTestId('settings-grammar-toggle'));

    await waitFor(() => expect(checkedStateOf('settings-grammar-toggle')).toBe(true));
    expect(saveGrammarCheckEnabled).toHaveBeenCalledWith(true);
  });

  it('toggling off persists the disabled state', async () => {
    mockedGrammarCheckEnabled.mockResolvedValue(true);
    await renderSettings('serverless');
    expect(checkedStateOf('settings-grammar-toggle')).toBe(true);

    fireEvent.press(screen.getByTestId('settings-grammar-toggle'));

    await waitFor(() => expect(checkedStateOf('settings-grammar-toggle')).toBe(false));
    expect(saveGrammarCheckEnabled).toHaveBeenCalledWith(false);
  });
});
