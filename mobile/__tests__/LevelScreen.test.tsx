import React from 'react';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import * as authApi from '../src/api/auth';
import * as profileApi from '../src/api/profile';
import {ApiError} from '../src/api/client';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
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

const mockedAuth = jest.mocked(authApi);
const mockedProfile = jest.mocked(profileApi);
const mockedStorage = jest.mocked(secureStorage);

function renderScreen() {
  const ref = createNavigationContainerRef<MainStackParamList>();
  const Stack = createNativeStackNavigator<MainStackParamList>();

  render(
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
    </ThemeProvider>,
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

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
  mockedProfile.getProfile.mockResolvedValue({level: 'B1'});
});

describe('LevelScreen', () => {
  it('lists every supported English level including AUTO', async () => {
    renderScreen();

    for (const value of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'AUTO']) {
      await waitFor(() => expect(screen.getByTestId(`level-${value}`)).toBeOnTheScreen());
    }
    expect(screen.getByText('Auto')).toBeOnTheScreen();
    expect(mockedProfile.getProfile).toHaveBeenCalledWith('token-a');
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
    expect(mockedProfile.updateProfile).toHaveBeenCalledWith('token-a', 'C1');
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
    expect(mockedProfile.updateProfile).toHaveBeenCalledWith('token-a', 'A2');
  });

  it('pops back to the previous route on back', async () => {
    const {focusedRouteName} = renderScreen();
    await waitFor(() => expect(screen.getByTestId('level-A1')).toBeOnTheScreen());
    expect(focusedRouteName()).toBe('Level');

    await fireEvent.press(screen.getByTestId('level-back'));

    await waitFor(() => expect(focusedRouteName()).toBe('Chat'));
  });
});
