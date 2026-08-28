/**
 * TASK-109 — Mobile authentication tests.
 *
 * Full-journey coverage against the REAL application tree (App →
 * RootNavigator → AuthProvider → real secureStorage module on the persistent
 * keychain mock): registration with auto-login, login through the UI, token
 * restoration across application restarts, expired-token handling at
 * startup, and logout through Settings. Only the network API modules are
 * substituted; every device-persistence round-trip is real.
 *
 * Restarts are simulated by remounting the application through a key change
 * on a single RNTL render instance: identical unmount/remount semantics to
 * relaunching the app, with the same persisted device stores.
 */
import React from 'react';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import App from '../App';
import * as authApi from '../src/api/auth';
import * as profileApi from '../src/api/profile';
import * as Keychain from 'react-native-keychain';

jest.mock('../src/api/auth');
jest.mock('../src/api/profile', () => ({
  ...jest.requireActual('../src/api/profile'),
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
}));

const mockedAuth = jest.mocked(authApi);
const mockedProfile = jest.mocked(profileApi);
const mockedKeychain = Keychain as jest.Mocked<typeof Keychain> & {
  __resetKeychainStore: () => void;
};

const TOKENS = {access: 'access-1', refresh: 'refresh-1'};
const USER = {id: 1, username: 'alice', email: 'alice@example.com'};
const KEYCHAIN_SERVICE = 'com.elearningmobile.auth';

function launch(index: number): React.ReactElement {
  // A new key remounts the whole application: fresh restore effect, same
  // persisted keychain/AsyncStorage stores.
  return <App key={`launch-${index}`} />;
}

async function storedTokens(): Promise<{access: string; refresh: string} | null> {
  const credentials = await mockedKeychain.getGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
  if (!credentials) {
    return null;
  }
  return JSON.parse(credentials.password) as {access: string; refresh: string};
}

async function seedKeychain(tokens: {access: string; refresh: string}) {
  await Keychain.setGenericPassword('elearning-auth', JSON.stringify(tokens), {
    service: KEYCHAIN_SERVICE,
  });
}

async function fillLoginForm(identifier: string, password: string) {
  await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
  await fireEvent.changeText(screen.getByTestId('login-identifier'), identifier);
  await fireEvent.changeText(screen.getByTestId('login-password'), password);
  await fireEvent.press(screen.getByTestId('login-submit'));
}

async function fillRegistrationForm() {
  await fireEvent.press(screen.getByTestId('login-switch-register'));
  await waitFor(() => expect(screen.getByTestId('register-username')).toBeOnTheScreen());
  await fireEvent.changeText(screen.getByTestId('register-username'), 'alice');
  await fireEvent.changeText(screen.getByTestId('register-email'), 'alice@example.com');
  await fireEvent.changeText(screen.getByTestId('register-password'), 'Str0ng-Passw0rd!');
  await fireEvent.press(screen.getByTestId('register-submit'));
}

beforeEach(() => {
  mockedKeychain.__resetKeychainStore();
  jest.clearAllMocks();
  mockedProfile.getProfile.mockResolvedValue({level: 'AUTO'});
});

describe('TASK-109 registration journey', () => {
  it('registers through the UI, auto-logs-in, and lands in the main app', async () => {
    mockedAuth.register.mockResolvedValue(USER);
    mockedAuth.login.mockResolvedValue({...TOKENS, user: USER});
    await render(launch(0));

    await fillRegistrationForm();

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(mockedAuth.register).toHaveBeenCalledWith({
      username: 'alice',
      email: 'alice@example.com',
      password: 'Str0ng-Passw0rd!',
    });
    // Auto-login used the submitted credentials and persisted the tokens.
    expect(mockedAuth.login).toHaveBeenCalledWith('alice', 'Str0ng-Passw0rd!');
    expect(await storedTokens()).toEqual(TOKENS);
  });
});

describe('TASK-109 login journey', () => {
  it('logs in through the UI and persists the tokens in secure storage', async () => {
    mockedAuth.login.mockResolvedValue({...TOKENS, user: USER});
    await render(launch(0));

    await fillLoginForm('alice@example.com', 'secret');

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(mockedAuth.login).toHaveBeenCalledWith('alice@example.com', 'secret');
    expect(await storedTokens()).toEqual(TOKENS);
  });
});

describe('TASK-109 token restoration journey', () => {
  it('restores the session from secure storage after an application restart', async () => {
    mockedAuth.login.mockResolvedValue({...TOKENS, user: USER});
    const view = await render(launch(0));

    await fillLoginForm('alice', 'secret');
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    // ---- Restart with the same persisted keychain store. ---------------
    mockedAuth.getMe.mockClear();
    mockedAuth.login.mockClear();
    mockedAuth.getMe.mockResolvedValue(USER);
    await view.rerender(launch(1));

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    // Session restored via /me against the stored access token; no second
    // login ever happened.
    expect(mockedAuth.getMe).toHaveBeenCalledWith('access-1');
    expect(mockedAuth.login).not.toHaveBeenCalled();
  });
});

describe('TASK-109 expired token handling', () => {
  it('recovers from an expired access token at startup via refresh', async () => {
    await seedKeychain(TOKENS);
    mockedAuth.getMe
      .mockRejectedValueOnce(new Error('401'))
      .mockResolvedValueOnce(USER);
    mockedAuth.refreshAccessToken.mockResolvedValue({access: 'access-2'});
    await render(launch(0));

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(mockedAuth.refreshAccessToken).toHaveBeenCalledWith('refresh-1');
    expect(mockedAuth.getMe).toHaveBeenLastCalledWith('access-2');
    // The rotated access token was persisted for the next launch.
    expect(await storedTokens()).toEqual({access: 'access-2', refresh: 'refresh-1'});
  });

  it('returns to the login screen and wipes credentials when refresh is expired too', async () => {
    await seedKeychain(TOKENS);
    mockedAuth.getMe.mockRejectedValue(new Error('401'));
    mockedAuth.refreshAccessToken.mockRejectedValue(new Error('401'));
    await render(launch(0));

    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
    expect(screen.queryByTestId('chat-screen')).toBeNull();
    expect(await storedTokens()).toBeNull();
  });
});

describe('TASK-109 logout journey', () => {
  it('logs out through Settings, clears credentials, and stays logged out after restart', async () => {
    await seedKeychain(TOKENS);
    mockedAuth.getMe.mockResolvedValue(USER);
    mockedAuth.logout.mockResolvedValue(undefined);
    const view = await render(launch(0));
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    // Logout lives on the Settings screen of the main stack.
    await fireEvent.press(screen.getByTestId('chat-open-settings'));
    await fireEvent.press(await screen.findByTestId('settings-logout'));

    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
    // Server-side invalidation used the stored tokens; local copy is gone.
    expect(mockedAuth.logout).toHaveBeenCalledWith(TOKENS);
    expect(await storedTokens()).toBeNull();

    // ---- Post-logout restart finds no credentials. ---------------------
    mockedAuth.getMe.mockClear();
    mockedAuth.refreshAccessToken.mockClear();
    await view.rerender(launch(1));

    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
    expect(mockedAuth.getMe).not.toHaveBeenCalled();
    expect(mockedAuth.refreshAccessToken).not.toHaveBeenCalled();
  });
});
