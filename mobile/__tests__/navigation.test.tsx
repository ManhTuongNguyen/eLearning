/**
 * Navigation structure tests (SPEC TASK-043): the root switch between auth
 * stack and main stack, in-stack navigation, and direct assertions on the
 * navigation state itself. Includes the mode-aware root switch
 * (TASK-AUDIT-003): a restored serverless selection mounts the main
 * application without ever routing through login.
 */
import React from 'react';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import * as authApi from '../src/api/auth';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import type {AuthTokens} from '../src/auth/tokens';
import * as vocabularyApi from '../src/api/vocabulary';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {RootNavigator} from '../src/navigation/RootNavigator';
import type {AuthStackParamList, MainStackParamList} from '../src/navigation/types';
import {ModeProvider} from '../src/mode/ModeContext';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/api/vocabulary');
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedVocabulary = jest.mocked(vocabularyApi);
const mockedStorage = jest.mocked(secureStorage);
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

type RootParamList = AuthStackParamList & MainStackParamList;

async function renderRoot() {
  const ref = createNavigationContainerRef<RootParamList>();

  const focusedRouteName = (): string | undefined => {
    const state = ref.current?.getRootState();
    if (!state) {
      return undefined;
    }
    return state.routes[state.index]?.name;
  };

  await render(
    <ModeProvider>
      <ThemeProvider>
        <AuthProvider>
          <NavigationContainer ref={ref}>
            <RootNavigator />
          </NavigationContainer>
        </AuthProvider>
      </ThemeProvider>
    </ModeProvider>,
  );

  return {focusedRouteName};
}

async function renderAuthenticated(tokens?: AuthTokens) {
  mockedStorage.loadTokens.mockResolvedValue(
    tokens ?? {access: 'token-a', refresh: 'token-r'},
  );
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
  return renderRoot();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue(null);
  mockedVocabulary.listVocabulary.mockResolvedValue({
    count: 0,
    next: null,
    previous: null,
    results: [],
  });
  asyncStorage.__resetAsyncStorageStore();
});

describe('root switch', () => {
  it('shows only the splash screen while the session is being restored', async () => {
    let resolveRestore: (tokens: AuthTokens | null) => void = () => {};
    mockedStorage.loadTokens.mockReturnValue(
      new Promise<AuthTokens | null>(resolve => {
        resolveRestore = resolve;
      }),
    );

    await renderRoot();

    expect(screen.getByTestId('splash')).toBeOnTheScreen();
    expect(screen.queryByTestId('login-identifier')).toBeNull();
    expect(screen.queryByTestId('chat-screen')).toBeNull();

    // Cleanup: let the pending restore settle so teardown does not warn.
    resolveRestore(null);
    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
  });

  it('unauthenticated users see the auth screens', async () => {
    await renderRoot();

    await waitFor(() =>
      expect(screen.getByTestId('login-identifier')).toBeOnTheScreen(),
    );
    expect(screen.queryByTestId('chat-screen')).toBeNull();
  });

  it('authenticated users see the main application with Chat as entry', async () => {
    const {focusedRouteName} = await renderAuthenticated();

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('login-identifier')).toBeNull();
    expect(focusedRouteName()).toBe('Chat');
  });

  it('a restored serverless mode mounts the main application without authentication (TASK-AUDIT-003)', async () => {
    await saveApplicationMode('serverless');
    const {focusedRouteName} = await renderRoot();

    // Cold start lands directly in the main application: no login screen is
    // ever shown and no authentication request is made.
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('login-identifier')).toBeNull();
    expect(focusedRouteName()).toBe('Chat');
    expect(mockedStorage.loadTokens).not.toHaveBeenCalled();
    expect(mockedAuth.getMe).not.toHaveBeenCalled();
  });

  it('a serverless user with stored credentials still bypasses the auth stack (TASK-AUDIT-003)', async () => {
    await saveApplicationMode('serverless');
    mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
    mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
    const {focusedRouteName} = await renderRoot();

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('login-identifier')).toBeNull();
    expect(focusedRouteName()).toBe('Chat');
    // Serverless initialization makes no authentication requests; stored
    // credentials are simply left untouched.
    expect(mockedAuth.getMe).not.toHaveBeenCalled();
  });
});

describe('main stack navigation', () => {
  it('navigates Chat -> History and back through the stack state', async () => {
    const {focusedRouteName} = await renderAuthenticated();
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('chat-open-history'));
    expect(await screen.findByTestId('history-screen')).toBeOnTheScreen();
    expect(focusedRouteName()).toBe('History');

    await fireEvent.press(screen.getByTestId('history-back'));

    await waitFor(() => expect(focusedRouteName()).toBe('Chat'));
  });

  it('reaches Settings and returns to it after editing the learning level', async () => {
    const {focusedRouteName} = await renderAuthenticated();
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('chat-open-settings'));
    expect(await screen.findByTestId('settings-screen')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('settings-open-level'));
    expect(await screen.findByTestId('level-AUTO')).toBeOnTheScreen();
    expect(focusedRouteName()).toBe('Level');

    await fireEvent.press(screen.getByTestId('level-back'));

    await waitFor(() => expect(focusedRouteName()).toBe('Settings'));
    expect(screen.getByTestId('settings-screen')).toBeOnTheScreen();
  });

  it('opens the saved vocabulary list from Settings and returns after closing (TASK-072)', async () => {
    const {focusedRouteName} = await renderAuthenticated();
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('chat-open-settings'));
    expect(await screen.findByTestId('settings-screen')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('settings-open-vocabulary'));

    expect(await screen.findByTestId('vocabulary-empty')).toBeOnTheScreen();
    expect(focusedRouteName()).toBe('Vocabulary');
    await waitFor(() =>
      expect(mockedVocabulary.listVocabulary).toHaveBeenCalledWith('token-a', 1),
    );

    await fireEvent.press(screen.getByTestId('vocabulary-back'));

    await waitFor(() => expect(focusedRouteName()).toBe('Settings'));
    expect(screen.getByTestId('settings-screen')).toBeOnTheScreen();
  });

  it('logging out from Settings returns the user to the auth stack', async () => {
    const tokens = {access: 'token-a', refresh: 'token-r'};
    const {focusedRouteName} = await renderAuthenticated(tokens);
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('chat-open-settings'));
    await fireEvent.press(await screen.findByTestId('settings-logout'));

    await waitFor(() =>
      expect(screen.getByTestId('login-identifier')).toBeOnTheScreen(),
    );
    expect(mockedAuth.logout).toHaveBeenCalledWith(tokens);
    expect(mockedStorage.clearTokens).toHaveBeenCalled();
    expect(focusedRouteName()).toBe('Login');
  });
});
