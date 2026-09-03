import React from 'react';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {render, screen, waitFor} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import * as authApi from '../src/api/auth';
import * as profileApi from '../src/api/profile';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import {getLocalDatabase} from '../src/db/database';
import * as profileStore from '../src/db/profileStore';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {setRuntimeApplicationMode} from '../src/mode/runtime';
import {DEFAULT_APPLICATION_MODE} from '../src/mode/types';
import type {MainStackParamList} from '../src/navigation/types';
import {createStyles, LevelScreen} from '../src/screens/LevelScreen';
import {lightColors} from '../src/theme/colors';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/api/profile', () => ({
  ...jest.requireActual('../src/api/profile'),
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
}));
jest.mock('../src/auth/secureStorage');
jest.mock('../src/db/database');
jest.mock('../src/db/profileStore');

const mockedAuth = jest.mocked(authApi);
const mockedProfile = jest.mocked(profileApi);
const mockedStorage = jest.mocked(secureStorage);
const mockedGetDb = jest.mocked(getLocalDatabase);
const mockedGetLocalProfile = jest.mocked(profileStore.getLearningProfile);
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

function flattenStyle(style: unknown): Record<string, unknown> {
  const entries = Array.isArray(style) ? style : [style];
  return Object.assign(
    {},
    ...entries.filter(Boolean).map(s => (typeof s === 'object' ? s : {})),
  );
}

async function renderScreen() {
  const ref = createNavigationContainerRef<MainStackParamList>();
  const Stack = createNativeStackNavigator<MainStackParamList>();

  await render(
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
              <Stack.Screen name="Level" component={LevelScreen} />
            </Stack.Navigator>
          </NavigationContainer>
        </AuthProvider>
      </ThemeProvider>
    </ModeProvider>,
  );
}

/** Restores a persisted serverless mode before rendering the screen. */
async function enterServerlessMode() {
  await saveApplicationMode('serverless');
  setRuntimeApplicationMode('serverless');
}

beforeEach(() => {
  asyncStorage.__resetAsyncStorageStore();
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
  mockedProfile.getProfile.mockResolvedValue({level: 'B1'});
  mockedGetLocalProfile.mockResolvedValue({level: 'B1', updated_at: ''});
  mockedGetDb.mockResolvedValue({
    execute: jest.fn(async () => ({rows: [], rowsAffected: 0, insertId: null})),
  } as never);
});

afterEach(() => {
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

describe('LevelScreen layout (TASK-AUDIT-011)', () => {
  it('uses the shared pushed-screen header spacing on top of the app-shell inset padding', () => {
    const styles = createStyles(lightColors);

    expect(styles.container.paddingTop).toBe(16);
    expect(flattenStyle(styles.container).marginTop).toBeUndefined();
  });

  it('never applies negative margins to the container', () => {
    const flat = flattenStyle(createStyles(lightColors).container);
    for (const [key, value] of Object.entries(flat)) {
      if (key.startsWith('margin')) {
        expect(value).not.toBeLessThan(0);
      }
    }
  });

  it.each(['server', 'serverless'] as const)(
    'renders the fixed header spacing in %s mode (the app shell adds the device inset)',
    async mode => {
      if (mode === 'serverless') {
        await enterServerlessMode();
      }

      await renderScreen();

      const container = screen.getByTestId('level-screen');
      expect(flattenStyle(container.props.style).paddingTop).toBe(16);
      await waitFor(() =>
        expect(screen.getByTestId('level-B1')).toBeOnTheScreen(),
      );
    },
  );
});
