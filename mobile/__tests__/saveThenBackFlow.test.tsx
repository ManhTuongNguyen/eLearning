/**
 * Regression tests for the save-then-back flow (TASK-IMPROVEMENT-005 fix):
 *
 * Chat -> Settings -> AI provider editor -> Save (auto-routes back to
 * Settings) -> Back must land on the Chat screen, never on the editor
 * again. The historical bug: a plain `navigate('Settings', …)` from the
 * editor pushed a duplicate Settings row, leaving the editor in the stack,
 * so both the header back button AND the Android system back returned to
 * the editor. `popTo` removes the editor from the stack, which fixes both
 * paths at once: the Android hardware back dispatches the same goBack()
 * through BackHandler (useBackButton.native.js) onto the same stack.
 *
 * Renders the REAL MainNavigator so the router state transitions are
 * exercised end-to-end; the serverless provider layer is stubbed at its
 * storage/catalog seams (no network, no keychain).
 */
import React from 'react';
import {BackHandler} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {setRuntimeApplicationMode} from '../src/mode/runtime';
import {DEFAULT_APPLICATION_MODE} from '../src/mode/types';
import {MainNavigator} from '../src/navigation/MainNavigator';
import {ThemeProvider} from '../src/theme/ThemeContext';
import * as modelCatalog from '../src/serverless/modelCatalog';
import * as serverlessSettings from '../src/serverless/settings';

jest.mock('../src/auth/secureStorage');
jest.mock('../src/serverless/settings');
jest.mock('../src/serverless/modelCatalog');

const mockedStorage = jest.mocked(secureStorage);
const mockedSettings = jest.mocked(serverlessSettings);
const mockedCatalog = jest.mocked(modelCatalog);
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

/** Hardware-back handlers registered by mounted navigation containers. */
let hardwareBackHandlers: Array<() => boolean> = [];

beforeAll(() => {
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((
    _event: string,
    handler: () => boolean,
  ) => {
    hardwareBackHandlers.push(handler);
    return {remove: jest.fn()};
  }) as never);
});

beforeEach(async () => {
  asyncStorage.__resetAsyncStorageStore();
  jest.clearAllMocks();
  hardwareBackHandlers = [];
  mockedStorage.loadTokens.mockResolvedValue(null);
  // The editor opens on a fully-stored configuration so Save is enabled
  // without touching model discovery or the keychain.
  mockedSettings.loadServerlessProvider.mockResolvedValue('openrouter');
  mockedSettings.loadServerlessProviderState.mockResolvedValue({
    apiKey: 'sk-or-v1-regression-key',
    primaryModel: 'vendor/model-a',
    fallbackModels: [],
  });
  mockedSettings.loadServerlessOpenRouterConfig.mockResolvedValue(null);
  mockedCatalog.getCachedModelCatalog.mockResolvedValue(null);
  await saveApplicationMode('serverless');
  setRuntimeApplicationMode('serverless');
});

afterEach(() => {
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

/** Mounts the real main stack and waits for the chat screen. */
async function renderMainStack() {
  await render(
    <ModeProvider>
      <ThemeProvider>
        <AuthProvider>
          <NavigationContainer>
            <MainNavigator />
          </NavigationContainer>
        </AuthProvider>
      </ThemeProvider>
    </ModeProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
}

/** Walks Chat -> Settings -> editor -> Save and asserts the editor is gone. */
async function openEditorAndSave() {
  fireEvent.press(screen.getByTestId('chat-open-settings'));
  expect(await screen.findByTestId('settings-screen')).toBeOnTheScreen();

  fireEvent.press(await screen.findByTestId('settings-ai-provider-card'));
  expect(await screen.findByTestId('ai-provider-settings-screen')).toBeOnTheScreen();
  await waitFor(() =>
    expect(screen.getByTestId('ai-provider-save').props.disabled).toBeFalsy(),
  );

  fireEvent.press(screen.getByTestId('ai-provider-save'));
  await waitFor(() => expect(screen.getByTestId('settings-screen')).toBeOnTheScreen());
  // The editor must be removed from the stack, not merely hidden below the
  // duplicated Settings row (the historical bug).
  expect(screen.queryByTestId('ai-provider-settings-screen')).toBeNull();
}

describe('save in the provider editor, then Back (regression)', () => {
  it('the header back button on Settings lands on Chat, not the editor', async () => {
    await renderMainStack();
    await openEditorAndSave();

    fireEvent.press(screen.getByTestId('settings-back'));

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('ai-provider-settings-screen')).toBeNull();
    expect(screen.queryByTestId('settings-screen')).toBeNull();
  });

  it('the Android system back from Settings lands on Chat, not the editor', async () => {
    await renderMainStack();
    await openEditorAndSave();

    // The navigation container registers exactly one hardware-back handler
    // (useBackButton); invoking it is what the OS back press does.
    expect(hardwareBackHandlers.length).toBeGreaterThan(0);
    await act(async () => {
      hardwareBackHandlers[hardwareBackHandlers.length - 1]();
    });

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('ai-provider-settings-screen')).toBeNull();
    expect(screen.queryByTestId('settings-screen')).toBeNull();
  });
});
