import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import {AuthProvider} from '../src/auth/AuthContext';
import * as authApi from '../src/api/auth';
import {ApiError} from '../src/api/client';
import * as secureStorage from '../src/auth/secureStorage';
import type {AuthStackParamList} from '../src/navigation/types';
import {LoginScreen} from '../src/screens/LoginScreen';
import {RegisterScreen} from '../src/screens/RegisterScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedStorage = jest.mocked(secureStorage);

function renderScreen() {
  const Stack = createNativeStackNavigator<AuthStackParamList>();
  return render(
    <ThemeProvider>
      <AuthProvider>
        <NavigationContainer>
          <Stack.Navigator screenOptions={{headerShown: false}}>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="Register" component={RegisterScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </AuthProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue(null);
});

describe('LoginScreen', () => {
  it('renders the login form', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
    expect(screen.getByTestId('login-password')).toBeOnTheScreen();
    expect(screen.getByText('Log in')).toBeOnTheScreen();
    expect(screen.getByTestId('login-switch-register')).toBeOnTheScreen();
  });

  it('keeps the submit button disabled until both fields have values', async () => {
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('login-identifier')).toBeOnTheScreen(),
    );

    const submit = () => screen.getByTestId('login-submit');

    await fireEvent.changeText(screen.getByTestId('login-identifier'), 'alice');
    expect(submit()).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('login-password'), 'hunter2!');
    expect(submit()).toBeEnabled();
  });

  it('submits credentials to the login endpoint and shows errors on failure', async () => {
    mockedAuth.login.mockRejectedValue(new ApiError(401, 'No active account found.'));
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('login-identifier'), 'alice@example.com');
    await fireEvent.changeText(screen.getByTestId('login-password'), 'wrong-pass');
    await fireEvent.press(screen.getByTestId('login-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('form-error')).toHaveTextContent('No active account found.'),
    );
    expect(mockedAuth.login).toHaveBeenCalledWith('alice@example.com', 'wrong-pass');
    expect(mockedStorage.saveTokens).not.toHaveBeenCalled();
  });
});
