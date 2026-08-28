import React from 'react';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import App from '../App';
import * as authApi from '../src/api/auth';
import * as profileApi from '../src/api/profile';
import * as sessionsApi from '../src/api/sessions';
import * as secureStorage from '../src/auth/secureStorage';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/api/profile', () => ({
  ...jest.requireActual('../src/api/profile'),
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
}));
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedProfile = jest.mocked(profileApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedStorage = jest.mocked(secureStorage);

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue(null);
  // The no-session landing route checks the authoritative history before it
  // may claim the empty state (TASK-AUDIT-008); default to an empty one.
  mockedSessions.listSessions.mockResolvedValue({
    count: 0,
    next: null,
    previous: null,
    results: [],
  });
});

describe('App authentication flow', () => {
  it('shows the login screen for unauthenticated users', async () => {
    await render(<App />);

    await waitFor(() => expect(screen.getByText(/Practice English/i)).toBeOnTheScreen());
    expect(screen.getByTestId('login-identifier')).toBeOnTheScreen();
    expect(mockedStorage.loadTokens).toHaveBeenCalled();
  });

  it('navigates between login and register screens', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('login-switch-register'));
    expect(screen.getByTestId('register-username')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('register-switch-login'));
    expect(screen.getByTestId('login-identifier')).toBeOnTheScreen();
  });

  it('restores the authenticated session after restart and logs out', async () => {
    const tokens = {access: 'a', refresh: 'r'};
    mockedStorage.loadTokens.mockResolvedValue(tokens);
    mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
    mockedAuth.logout.mockResolvedValue(undefined);

    render(<App />);

    // Session restored from secure storage survives an app restart.
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    // Logout lives on the Settings screen of the main stack.
    await fireEvent.press(screen.getByTestId('chat-open-settings'));
    await fireEvent.press(await screen.findByTestId('settings-logout'));

    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
    expect(mockedAuth.logout).toHaveBeenCalledWith(tokens);
    expect(mockedStorage.clearTokens).toHaveBeenCalled();
  });

  it('opens the learning level screen from settings and returns back', async () => {
    mockedStorage.loadTokens.mockResolvedValue({access: 'a', refresh: 'r'});
    mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
    mockedProfile.getProfile.mockResolvedValue({level: 'AUTO'});

    render(<App />);
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('chat-open-settings'));
    await fireEvent.press(await screen.findByTestId('settings-open-level'));
    expect(screen.getByTestId('level-AUTO')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('level-back'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-open-level')).toBeOnTheScreen(),
    );
  });
});
