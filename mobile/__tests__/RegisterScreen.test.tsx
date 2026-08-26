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

jest.mock('../src/api/auth');
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedStorage = jest.mocked(secureStorage);

function renderScreen() {
  const Stack = createNativeStackNavigator<AuthStackParamList>();
  return render(
    <AuthProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Register" screenOptions={{headerShown: false}}>
          <Stack.Screen name="Login" component={LoginScreen} />
          <Stack.Screen name="Register" component={RegisterScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </AuthProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue(null);
});

async function fillValidForm() {
  renderScreen();
  await waitFor(() => expect(screen.getByTestId('register-username')).toBeOnTheScreen());
  await fireEvent.changeText(screen.getByTestId('register-username'), 'bob');
  await fireEvent.changeText(screen.getByTestId('register-email'), 'bob@example.com');
  await fireEvent.changeText(screen.getByTestId('register-password'), 'Str0ng-Passw0rd!');
}

describe('RegisterScreen', () => {
  it('renders the registration form with all fields', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByTestId('register-username')).toBeOnTheScreen());
    expect(screen.getByTestId('register-email')).toBeOnTheScreen();
    expect(screen.getByTestId('register-password')).toBeOnTheScreen();
    expect(screen.getByTestId('register-switch-login')).toBeOnTheScreen();
  });

  it('disables submission until every field is filled', async () => {
    await fillValidForm();

    const submit = () => screen.getByTestId('register-submit');
    expect(submit()).toBeEnabled();

    await fireEvent.changeText(screen.getByTestId('register-email'), '');
    expect(submit()).toBeDisabled();
  });

  it('sends registration data to the API', async () => {
    mockedAuth.register.mockResolvedValue({id: 2, username: 'bob', email: 'bob@example.com'});
    mockedAuth.login.mockResolvedValue({
      access: 'a',
      refresh: 'r',
      user: {id: 2, username: 'bob', email: 'bob@example.com'},
    });
    await fillValidForm();

    await fireEvent.press(screen.getByTestId('register-submit'));

    await waitFor(() => expect(mockedAuth.register).toHaveBeenCalled());
    expect(mockedAuth.register).toHaveBeenCalledWith({
      username: 'bob',
      email: 'bob@example.com',
      password: 'Str0ng-Passw0rd!',
    });
    // Auto-login stores the issued tokens securely.
    await waitFor(() => expect(mockedStorage.saveTokens).toHaveBeenCalled());
  });

  it('shows backend validation errors without storing tokens', async () => {
    mockedAuth.register.mockRejectedValue(
      new ApiError(400, 'password: This password is too common.', {
        password: ['This password is too common.'],
      }),
    );
    await fillValidForm();

    await fireEvent.press(screen.getByTestId('register-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('form-error')).toHaveTextContent(
        'password: This password is too common.',
      ),
    );
    expect(mockedStorage.saveTokens).not.toHaveBeenCalled();
  });
});
