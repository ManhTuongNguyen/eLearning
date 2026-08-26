/**
 * Navigation structure tests (SPEC TASK-043): the root switch between auth
 * stack and main stack, in-stack navigation, and direct assertions on the
 * navigation state itself.
 */
import React from 'react';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import * as authApi from '../src/api/auth';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import type {AuthTokens} from '../src/auth/tokens';
import {RootNavigator} from '../src/navigation/RootNavigator';
import type {AuthStackParamList, MainStackParamList} from '../src/navigation/types';

jest.mock('../src/api/auth');
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedStorage = jest.mocked(secureStorage);

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
    <AuthProvider>
      <NavigationContainer ref={ref}>
        <RootNavigator />
      </NavigationContainer>
    </AuthProvider>,
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
