/**
 * TASK-046 acceptance lifecycle: authentication tokens live in secure device
 * storage (keychain-backed), survive application restarts, and disappear on
 * logout. Runs against the REAL src/auth/secureStorage module and the
 * persistent in-memory keychain mock from jest.setup.js — only the network
 * API is substituted.
 *
 * Restarts are simulated by remounting AuthProvider through a key change on
 * a single RNTL render instance: identical unmount/remount semantics to
 * relaunching the application, with one unambiguous query scope.
 */
import React from 'react';
import {Text, Pressable} from 'react-native';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import {AuthProvider, useAuth} from '../src/auth/AuthContext';
import * as authApi from '../src/api/auth';
import * as Keychain from 'react-native-keychain';

jest.mock('../src/api/auth');

const mockedAuth = jest.mocked(authApi);
const mockedKeychain = Keychain as jest.Mocked<typeof Keychain> & {
  __resetKeychainStore: () => void;
};

const TOKENS = {access: 'access-1', refresh: 'refresh-1'};
const USER = {id: 1, username: 'alice', email: 'alice@example.com'};

function Probe() {
  const {status, user, login, logout} = useAuth();
  return (
    <>
      <Text testID="status">{status}</Text>
      <Text testID="user">{user ? user.username : 'none'}</Text>
      <Pressable onPress={() => {login('alice', 'secret');}} testID="do-login" />
      <Pressable onPress={() => {logout();}} testID="do-logout" />
    </>
  );
}

function launch(launchIndex: number): React.ReactElement {
  // A new key remounts AuthProvider: fresh restore effect, same device store.
  return (
    <AuthProvider key={`launch-${launchIndex}`}>
      <Probe />
    </AuthProvider>
  );
}

beforeEach(() => {
  mockedKeychain.__resetKeychainStore();
  jest.clearAllMocks();
});

describe('token lifecycle across application restarts', () => {
  it('login persists tokens that survive restart until logout removes them', async () => {
    const view = await render(launch(0));

    // ---- Launch 1: fresh install, no stored credentials. ---------------
    mockedAuth.login.mockResolvedValue({...TOKENS, user: USER});
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    );
    expect(mockedAuth.getMe).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('do-login'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    );
    expect(mockedAuth.login).toHaveBeenCalledTimes(1);

    // Tokens were written through the secure keychain path.
    expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
      'elearning-auth',
      JSON.stringify(TOKENS),
      {service: 'com.elearningmobile.auth'},
    );

    // ---- Launch 2: application restart with the same device store. -----
    mockedAuth.logout.mockResolvedValue(undefined);
    mockedAuth.getMe.mockResolvedValue(USER);
    await view.rerender(launch(1));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    );
    // Session restored from storage: /me ran against the stored access
    // token and NO second login ever happened.
    expect(mockedAuth.getMe).toHaveBeenCalledWith('access-1');
    expect(mockedAuth.login).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('user')).toHaveTextContent('alice');

    await fireEvent.press(screen.getByTestId('do-logout'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    );
    expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
      service: 'com.elearningmobile.auth',
    });
  });

  it('a post-logout restart finds no credentials and stays logged out', async () => {
    // Seed the device store as if the user had been logged in previously.
    await Keychain.setGenericPassword(
      'elearning-auth',
      JSON.stringify(TOKENS),
      {service: 'com.elearningmobile.auth'},
    );
    mockedAuth.getMe.mockResolvedValue(USER);
    mockedAuth.logout.mockResolvedValue(undefined);

    const view = await render(launch(0));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    );
    expect(mockedAuth.getMe).toHaveBeenCalledWith('access-1');

    await fireEvent.press(screen.getByTestId('do-logout'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    );

    // Drop call history so the post-logout restart is judged in isolation.
    mockedAuth.getMe.mockClear();
    await view.rerender(launch(1));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    );
    // No credential material reaches any API after logout.
    expect(mockedAuth.getMe).not.toHaveBeenCalled();
    expect(mockedAuth.refreshAccessToken).not.toHaveBeenCalled();
  });
});
