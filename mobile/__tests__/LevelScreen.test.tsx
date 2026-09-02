import React from 'react';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import * as authApi from '../src/api/auth';
import * as profileApi from '../src/api/profile';
import {ApiError} from '../src/api/client';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import {getLocalDatabase} from '../src/db/database';
import * as profileStore from '../src/db/profileStore';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {setRuntimeApplicationMode} from '../src/mode/runtime';
import {DEFAULT_APPLICATION_MODE} from '../src/mode/types';
import type {MainStackParamList} from '../src/navigation/types';
import {LevelScreen} from '../src/screens/LevelScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/api/profile', () => ({
  ...jest.requireActual('../src/api/profile'),
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
}));
jest.mock('../src/auth/secureStorage');
// Serverless learning-level storage seams (SPEC TASK-091): the SQLite handle
// is opaque here because every read/write flows through profileStore.
jest.mock('../src/db/database');
jest.mock('../src/db/profileStore');

const mockedAuth = jest.mocked(authApi);
const mockedProfile = jest.mocked(profileApi);
const mockedStorage = jest.mocked(secureStorage);
const mockedGetDb = jest.mocked(getLocalDatabase);
const mockedGetLocalProfile = jest.mocked(profileStore.getLearningProfile);
const mockedSaveLocalProfile = jest.mocked(profileStore.saveLearningProfile);
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

function renderScreen() {
  const ref = createNavigationContainerRef<MainStackParamList>();
  const Stack = createNativeStackNavigator<MainStackParamList>();

  render(
    <ModeProvider>
      <ThemeProvider>
        <AuthProvider>
          <NavigationContainer
            ref={ref}
            initialState={{
              index: 1,
              routes: [{name: 'Chat'}, {name: 'Level'}],
            }}>
            <Stack.Navigator screenOptions={{headerShown: false}}>
              <Stack.Screen name="Chat">{() => null}</Stack.Screen>
              <Stack.Screen name="History">{() => null}</Stack.Screen>
              <Stack.Screen name="Settings">{() => null}</Stack.Screen>
              <Stack.Screen name="Level" component={LevelScreen} />
            </Stack.Navigator>
          </NavigationContainer>
        </AuthProvider>
      </ThemeProvider>
    </ModeProvider>,
  );

  return {
    focusedRouteName: (): string | undefined => {
      const state = ref.current?.getRootState();
      return state ? state.routes[state.index]?.name : undefined;
    },
  };
}

function checkedState(testId: string): boolean | undefined {
  const props = screen.getByTestId(testId).props as {accessibilityState?: {checked?: boolean}};
  return props.accessibilityState?.checked;
}

/** Restores a persisted serverless mode before rendering the screen. */
async function enterServerlessMode() {
  await saveApplicationMode('serverless');
  setRuntimeApplicationMode('serverless');
}

beforeEach(async () => {
  asyncStorage.__resetAsyncStorageStore();
  jest.clearAllMocks();
  // Server-flow journeys: pin the persisted mode because fresh installs
  // now default to serverless.
  await saveApplicationMode('server');
  mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
  mockedProfile.getProfile.mockResolvedValue({level: 'B1'});
  mockedGetDb.mockResolvedValue({
    execute: jest.fn(async () => ({rows: [], rowsAffected: 0, insertId: null})),
  } as never);
});

afterEach(() => {
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

describe('LevelScreen', () => {
  it('lists every supported English level including AUTO', async () => {
    renderScreen();

    for (const value of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'AUTO']) {
      await waitFor(() => expect(screen.getByTestId(`level-${value}`)).toBeOnTheScreen());
    }
    expect(screen.getByText('Auto')).toBeOnTheScreen();
    expect(mockedProfile.getProfile).toHaveBeenCalledWith(expect.any(Function));
  });

  it('preselects the level stored on the server', async () => {
    mockedProfile.getProfile.mockResolvedValue({level: 'B2'});
    renderScreen();

    await waitFor(() => expect(checkedState('level-B2')).toBe(true));
    expect(checkedState('level-A1')).toBe(false);
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('persists a newly selected level through the profile API', async () => {
    mockedProfile.updateProfile.mockResolvedValue({level: 'C1'});
    renderScreen();
    await waitFor(() => expect(checkedState('level-B1')).toBe(true));

    await fireEvent.press(screen.getByTestId('level-C1'));

    await waitFor(() => expect(screen.getByText('Saved.')).toBeOnTheScreen());
    expect(mockedProfile.updateProfile).toHaveBeenCalledWith(expect.any(Function), 'C1');
    await waitFor(() => expect(checkedState('level-C1')).toBe(true));
    expect(checkedState('level-B1')).toBe(false);
  });

  it('keeps the confirmed selection and surfaces an error when saving fails', async () => {
    mockedProfile.updateProfile.mockRejectedValue(new ApiError(400, 'level: Invalid level.'));
    renderScreen();
    await waitFor(() => expect(checkedState('level-B1')).toBe(true));

    await fireEvent.press(screen.getByTestId('level-C1'));

    await waitFor(() =>
      expect(screen.getByTestId('form-error')).toHaveTextContent('level: Invalid level.'),
    );
    expect(checkedState('level-B1')).toBe(true);
    expect(checkedState('level-C1')).toBe(false);
  });

  it('still allows saving when loading the current level fails', async () => {
    mockedProfile.getProfile.mockRejectedValue(new ApiError(0, 'Network request failed.'));
    mockedProfile.updateProfile.mockResolvedValue({level: 'A2'});
    renderScreen();

    await waitFor(() =>
      expect(screen.getByTestId('form-error')).toHaveTextContent(
        /server is unreachable right now/,
      ),
    );

    await fireEvent.press(screen.getByTestId('level-A2'));

    await waitFor(() => expect(screen.getByText('Saved.')).toBeOnTheScreen());
    expect(mockedProfile.updateProfile).toHaveBeenCalledWith(expect.any(Function), 'A2');
  });

  it('pops back to the previous route on back', async () => {
    const {focusedRouteName} = renderScreen();
    await waitFor(() => expect(screen.getByTestId('level-A1')).toBeOnTheScreen());
    expect(focusedRouteName()).toBe('Level');

    await fireEvent.press(screen.getByTestId('level-back'));

    await waitFor(() => expect(focusedRouteName()).toBe('Chat'));
  });
});

describe('LevelScreen in serverless mode (SPEC TASK-091)', () => {
  /**
   * Keep the server credential path suspended so its async branch can never
   * win the race against the asynchronous mode restore — mirroring real
   * devices where server traffic is gated off long before it starts.
   */
  beforeEach(() => {
    mockedStorage.loadTokens.mockReturnValue(new Promise(() => {}));
  });

  it('loads the locally stored level without calling the server profile API', async () => {
    mockedGetLocalProfile.mockResolvedValue({level: 'B2', updated_at: '2026-01-01'});
    await enterServerlessMode();
    renderScreen();

    await waitFor(() => expect(checkedState('level-B2')).toBe(true));
    expect(mockedGetLocalProfile).toHaveBeenCalledTimes(1);
    expect(mockedProfile.getProfile).not.toHaveBeenCalled();
  });

  it('persists a new selection through the local profile store only', async () => {
    mockedGetLocalProfile.mockResolvedValue({level: 'B2', updated_at: '2026-01-01'});
    mockedSaveLocalProfile.mockResolvedValue({level: 'C1', updated_at: '2026-01-02'});
    await enterServerlessMode();
    renderScreen();
    await waitFor(() => expect(checkedState('level-B2')).toBe(true));

    await fireEvent.press(screen.getByTestId('level-C1'));

    await waitFor(() => expect(screen.getByText('Saved.')).toBeOnTheScreen());
    expect(mockedSaveLocalProfile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(checkedState('level-C1')).toBe(true));
    expect(checkedState('level-B2')).toBe(false);
    expect(mockedProfile.updateProfile).not.toHaveBeenCalled();
  });

  it('keeps the confirmed selection and surfaces an error when the local write fails', async () => {
    mockedGetLocalProfile.mockResolvedValue({level: 'B1', updated_at: ''});
    mockedSaveLocalProfile.mockRejectedValue(new Error('disk full'));
    await enterServerlessMode();
    renderScreen();
    await waitFor(() => expect(checkedState('level-B1')).toBe(true));

    await fireEvent.press(screen.getByTestId('level-C1'));

    await waitFor(() =>
      expect(screen.getByTestId('form-error')).toHaveTextContent(/disk full/i),
    );
    expect(checkedState('level-B1')).toBe(true);
    expect(checkedState('level-C1')).toBe(false);
  });

  it('works while credentials are unresolved because no backend is ever contacted', async () => {
    mockedGetLocalProfile.mockResolvedValue({level: 'AUTO', updated_at: ''});
    await enterServerlessMode();
    renderScreen();

    await waitFor(() => expect(checkedState('level-AUTO')).toBe(true));
    expect(mockedGetLocalProfile).toHaveBeenCalledTimes(1);
    expect(mockedProfile.getProfile).not.toHaveBeenCalled();
    // No sign-in complaint appears even though credentials never resolve.
    expect(screen.queryByText(/sign in again/i)).toBeNull();
  });
});
