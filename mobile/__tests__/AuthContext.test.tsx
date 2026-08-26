import React, {useState} from 'react';
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function Probe() {
  const {status, user, error, busy, login, register, logout, authedRequest} = useAuth();
  const [request, setRequest] = useState('idle');
  return (
    <>
      <Text testID="status">{status}</Text>
      <Text testID="user">{user ? `${user.username}:${user.email}` : 'none'}</Text>
      <Text testID="error">{error ?? 'no-error'}</Text>
      <Text testID="busy">{busy ? 'busy' : 'idle'}</Text>
      <Text testID="request">{request}</Text>
      <Pressable onPress={() => {login('alice', 'secret');}} testID="do-login" />
      <Pressable
        onPress={() => {register({username: 'bob', email: 'b@e.com', password: 'pw'});}}
        testID="do-register"
      />
      <Pressable onPress={() => {logout();}} testID="do-logout" />
      <Pressable
        onPress={() => {
          authedRequest<{level: string}>('/api/v1/profile/')
            .then(payload => setRequest(`ok:${JSON.stringify(payload)}`))
            .catch((err: unknown) =>
              setRequest(`fail:${err instanceof ApiError ? err.status : 'unknown'}`),
            );
        }}
        testID="do-request"
      />
      <Pressable
        onPress={() => {
          Promise.all([
            authedRequest<{level: string}>('/api/v1/profile/'),
            authedRequest<{level: string}>('/api/v1/sessions/'),
          ])
            .then(([a, b]) =>
              setRequest(`ok:${JSON.stringify(a)}|${JSON.stringify(b)}`),
            )
            .catch((err: unknown) =>
              setRequest(`fail:${err instanceof ApiError ? err.status : 'unknown'}`),
            );
        }}
        testID="do-request-twice"
      />
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

describe('AuthContext authorized requests (TASK-047)', () => {
  async function renderAuthenticated() {
    mockedStorage.loadTokens.mockResolvedValue(TOKENS);
    mockedAuth.getMe.mockResolvedValue(USER);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  }

  it('sends the restored access token as Bearer without refreshing', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, {level: 'B2'}));
    await renderAuthenticated();

    await fireEvent.press(screen.getByTestId('do-request'));

    await waitFor(() =>
      expect(screen.getByTestId('request')).toHaveTextContent('ok:{"level":"B2"}'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/profile/'),
      expect.objectContaining({
        headers: expect.objectContaining({Authorization: 'Bearer access-1'}),
      }),
    );
    expect(mockedAuth.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes once on 401 and retries with the new access token', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(401, {detail: 'Token is invalid or expired'}))
      .mockResolvedValueOnce(jsonResponse(200, {level: 'A2'}));
    mockedAuth.refreshAccessToken.mockResolvedValue({access: 'access-2'});
    await renderAuthenticated();

    await fireEvent.press(screen.getByTestId('do-request'));

    await waitFor(() =>
      expect(screen.getByTestId('request')).toHaveTextContent('ok:{"level":"A2"}'),
    );
    expect(mockedAuth.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mockedAuth.refreshAccessToken).toHaveBeenCalledWith('refresh-1');
    expect(mockedStorage.saveTokens).toHaveBeenCalledWith({
      access: 'access-2',
      refresh: 'refresh-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/v1/profile/'),
      expect.objectContaining({
        headers: expect.objectContaining({Authorization: 'Bearer access-2'}),
      }),
    );
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  });

  it('returns the user to login when refresh credentials are invalid', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, {detail: 'Token is invalid or expired'}));
    mockedAuth.refreshAccessToken.mockRejectedValue(
      new ApiError(401, 'Token is invalid or expired'),
    );
    await renderAuthenticated();

    await fireEvent.press(screen.getByTestId('do-request'));

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('request')).toHaveTextContent('fail:401'),
    );
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(mockedStorage.clearTokens).toHaveBeenCalled();
    // No retry after the refresh died; exactly one refresh attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockedAuth.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for non-authentication failures', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(500, {detail: 'Server error.'}));
    await renderAuthenticated();

    await fireEvent.press(screen.getByTestId('do-request'));

    await waitFor(() =>
      expect(screen.getByTestId('request')).toHaveTextContent('fail:500'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockedAuth.refreshAccessToken).not.toHaveBeenCalled();
    expect(mockedStorage.clearTokens).not.toHaveBeenCalled();
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  });

  it('retries only once when the retried request still fails', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, {detail: 'Token is invalid or expired'}));
    mockedAuth.refreshAccessToken.mockResolvedValue({access: 'access-2'});
    await renderAuthenticated();

    await fireEvent.press(screen.getByTestId('do-request'));

    await waitFor(() =>
      expect(screen.getByTestId('request')).toHaveTextContent('fail:401'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockedAuth.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('shares a single refresh across concurrent 401 failures', async () => {
    let releaseRefresh!: (value: {access: string}) => void;
    mockedAuth.refreshAccessToken.mockReturnValue(
      new Promise(resolve => {
        releaseRefresh = resolve;
      }),
    );
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(401, {detail: 'expired'}))
      .mockResolvedValueOnce(jsonResponse(401, {detail: 'expired'}))
      .mockResolvedValue(jsonResponse(200, {level: 'B1'}));
    await renderAuthenticated();

    await fireEvent.press(screen.getByTestId('do-request-twice'));
    await waitFor(() => expect(mockedAuth.refreshAccessToken).toHaveBeenCalledTimes(1));

    // Drain every pending microtask while the shared refresh is still held:
    // if the second caller had started its own refresh the count would grow.
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), 0);
    });
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), 0);
    });
    expect(mockedAuth.refreshAccessToken).toHaveBeenCalledTimes(1);

    releaseRefresh({access: 'access-2'});

    await waitFor(() =>
      expect(screen.getByTestId('request')).toHaveTextContent(
        'ok:{"level":"B1"}|{"level":"B1"}',
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects without network access when signed out', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await fireEvent.press(screen.getByTestId('do-request'));

    await waitFor(() =>
      expect(screen.getByTestId('request')).toHaveTextContent('fail:401'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedAuth.refreshAccessToken).not.toHaveBeenCalled();
    expect(mockedStorage.clearTokens).not.toHaveBeenCalled();
  });
});
