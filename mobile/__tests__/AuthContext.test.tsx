import React from 'react';
import {Text, Pressable} from 'react-native';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import {AuthProvider, useAuth} from '../src/auth/AuthContext';
import * as authApi from '../src/api/auth';
import {ApiError} from '../src/api/client';
import * as secureStorage from '../src/auth/secureStorage';

jest.mock('../src/api/auth');
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedStorage = jest.mocked(secureStorage);

const TOKENS = {access: 'access-1', refresh: 'refresh-1'};
const USER = {id: 1, username: 'alice', email: 'alice@example.com'};

function Probe() {
  const {status, user, error, busy, login, register, logout} = useAuth();
  return (
    <>
      <Text testID="status">{status}</Text>
      <Text testID="user">{user ? `${user.username}:${user.email}` : 'none'}</Text>
      <Text testID="error">{error ?? 'no-error'}</Text>
      <Text testID="busy">{busy ? 'busy' : 'idle'}</Text>
      <Pressable onPress={() => {login('alice', 'secret');}} testID="do-login" />
      <Pressable
        onPress={() => {register({username: 'bob', email: 'b@e.com', password: 'pw'});}}
        testID="do-register"
      />
      <Pressable onPress={() => {logout();}} testID="do-logout" />
    </>
  );
}

function renderAuth() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue(null);
});

describe('AuthContext session restore', () => {
  it('starts unauthenticated when no tokens are stored', async () => {
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(mockedStorage.clearTokens).not.toHaveBeenCalled();
  });

  it('restores an authenticated session via /me', async () => {
    mockedStorage.loadTokens.mockResolvedValue(TOKENS);
    mockedAuth.getMe.mockResolvedValue(USER);
    renderAuth();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('alice:alice@example.com');
    expect(mockedAuth.getMe).toHaveBeenCalledWith('access-1');
  });

  it('falls back to refresh when the access token is expired', async () => {
    mockedStorage.loadTokens.mockResolvedValue(TOKENS);
    mockedAuth.getMe
      .mockRejectedValueOnce(new ApiError(401, 'Token is invalid or expired'))
      .mockResolvedValueOnce(USER);
    mockedAuth.refreshAccessToken.mockResolvedValue({access: 'access-2'});

    renderAuth();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(mockedAuth.refreshAccessToken).toHaveBeenCalledWith('refresh-1');
    expect(mockedStorage.saveTokens).toHaveBeenCalledWith({
      access: 'access-2',
      refresh: 'refresh-1',
    });
    expect(mockedAuth.getMe).toHaveBeenLastCalledWith('access-2');
  });

  it('clears credentials and logs out locally when refresh also fails', async () => {
    mockedStorage.loadTokens.mockResolvedValue(TOKENS);
    mockedAuth.getMe.mockRejectedValue(new ApiError(401, 'expired'));
    mockedAuth.refreshAccessToken.mockRejectedValue(new ApiError(401, 'expired'));

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    );
    expect(mockedStorage.clearTokens).toHaveBeenCalled();
  });
});

describe('AuthContext actions', () => {
  it('login stores tokens and enters the authenticated state', async () => {
    mockedAuth.login.mockResolvedValue({...TOKENS, user: USER});
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await fireEvent.press(screen.getByTestId('do-login'));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(mockedAuth.login).toHaveBeenCalledWith('alice', 'secret');
    expect(mockedStorage.saveTokens).toHaveBeenCalledWith(TOKENS);
    expect(screen.getByTestId('user')).toHaveTextContent('alice:alice@example.com');
  });

  it('surfaces login errors without storing tokens', async () => {
    mockedAuth.login.mockRejectedValue(new ApiError(401, 'No active account found.'));
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await fireEvent.press(screen.getByTestId('do-login'));

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('No active account found.'),
    );
    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    expect(mockedStorage.saveTokens).not.toHaveBeenCalled();
  });

  it('register auto-logs-in with the submitted credentials', async () => {
    mockedAuth.register.mockResolvedValue(USER);
    mockedAuth.login.mockResolvedValue({...TOKENS, user: {...USER, username: 'bob'}});
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await fireEvent.press(screen.getByTestId('do-register'));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(mockedAuth.register).toHaveBeenCalledWith({
      username: 'bob',
      email: 'b@e.com',
      password: 'pw',
    });
    expect(mockedAuth.login).toHaveBeenCalledWith('bob', 'pw');
  });

  it('logout invalidates server-side and removes local credentials', async () => {
    mockedStorage.loadTokens.mockResolvedValue(TOKENS);
    mockedAuth.getMe.mockResolvedValue(USER);
    mockedAuth.logout.mockResolvedValue(undefined);
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await fireEvent.press(screen.getByTestId('do-logout'));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(mockedAuth.logout).toHaveBeenCalledWith(TOKENS);
    expect(mockedStorage.clearTokens).toHaveBeenCalled();
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  it('logs out locally even when the server call fails', async () => {
    mockedStorage.loadTokens.mockResolvedValue(TOKENS);
    mockedAuth.getMe.mockResolvedValue(USER);
    mockedAuth.logout.mockRejectedValue(new ApiError(0, 'Network request failed.'));
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await fireEvent.press(screen.getByTestId('do-logout'));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(mockedStorage.clearTokens).toHaveBeenCalled();
  });
});
