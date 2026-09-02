/**
 * Application mode tests (SPEC TASK-080): explicit SERVER/SERVERLESS modes,
 * persistence across application restarts, deterministic switching through
 * ModeContext, and proof that the runtime gate keeps serverless-local data
 * away from every backend transport (REST client and SSE streams).
 */
import React from 'react';
import {Pressable, Text, View} from 'react-native';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {apiRequest} from '../src/api/client';
import {streamChatTurn} from '../src/api/chatStream';
import {ModeProvider, useApplicationMode} from '../src/mode/ModeContext';
import {loadApplicationMode, saveApplicationMode} from '../src/mode/modeStorage';
import {
  ServerApiBlockedError,
  getRuntimeApplicationMode,
  setRuntimeApplicationMode,
} from '../src/mode/runtime';
import {DEFAULT_APPLICATION_MODE, parseApplicationMode} from '../src/mode/types';
import type {SettingsScreenProps} from '../src/navigation/types';
import {SettingsScreen} from '../src/screens/SettingsScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

jest.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({
    user: {id: 1, username: 'alice', email: 'alice@example.com'},
    busy: false,
    logout: jest.fn(),
    getAccessToken: async () => 'token',
  }),
}));

function settingsPropsStub(): SettingsScreenProps {
  return {
    navigation: {navigate: jest.fn(), goBack: jest.fn()},
    route: {key: 'settings-test', name: 'Settings', params: undefined},
  } as unknown as SettingsScreenProps;
}

/** Checked state of a settings mode radio, read once it has settled. */
function checkedStateOf(testID: string): boolean | undefined {
  const state = screen.getByTestId(testID).props.accessibilityState;
  return state ? state.checked : undefined;
}

function resetStorage() {
  asyncStorage.__resetAsyncStorageStore();
}

describe('application mode types', () => {
  it('exposes exactly the two documented modes with serverless as default', () => {
    expect(parseApplicationMode('server')).toBe('server');
    expect(parseApplicationMode('serverless')).toBe('serverless');
    expect(parseApplicationMode('offline')).toBeNull();
    expect(parseApplicationMode(null)).toBeNull();
    expect(parseApplicationMode(undefined)).toBeNull();
    expect(parseApplicationMode(42)).toBeNull();
    expect(DEFAULT_APPLICATION_MODE).toBe('serverless');
  });
});

describe('modeStorage', () => {
  beforeEach(() => {
    resetStorage();
    jest.clearAllMocks();
  });

  it('round-trips a saved mode through AsyncStorage', async () => {
    await saveApplicationMode('serverless');

    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      'app.applicationMode',
      'serverless',
    );
    await expect(loadApplicationMode()).resolves.toBe('serverless');
  });

  it('falls back to the default when nothing was persisted', async () => {
    await expect(loadApplicationMode()).resolves.toBe('serverless');
  });

  it('falls back to the default for corrupted persisted values', async () => {
    await asyncStorage.setItem('app.applicationMode', 'offline-mode');
    await expect(loadApplicationMode()).resolves.toBe('serverless');
  });

  it('falls back to the default when reads fail', async () => {
    (asyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('disk error'));
    await expect(loadApplicationMode()).resolves.toBe('serverless');
  });

  it('keeps the persisted mode readable after an app restart', async () => {
    await saveApplicationMode('serverless');

    // Simulate a restart: drop every JS module inside an isolated registry
    // while device storage persists, then read through a FRESH copy of the
    // storage module.
    let revivedStorage: typeof import('../src/mode/modeStorage') | undefined;
    jest.isolateModules(() => {
      revivedStorage = require('../src/mode/modeStorage');
    });
    const storage = revivedStorage as typeof import('../src/mode/modeStorage');

    await expect(storage.loadApplicationMode()).resolves.toBe('serverless');
  });

  it('stays on the default across a restart once storage is empty', async () => {
    await saveApplicationMode('serverless');
    resetStorage();

    let revivedStorage: typeof import('../src/mode/modeStorage') | undefined;
    jest.isolateModules(() => {
      revivedStorage = require('../src/mode/modeStorage');
    });
    const storage = revivedStorage as typeof import('../src/mode/modeStorage');

    await expect(storage.loadApplicationMode()).resolves.toBe('serverless');
  });
});

function ModeProbe() {
  const {status, mode} = useApplicationMode();
  return (
    <View>
      <Text testID="probe-status">{status}</Text>
      <Text testID="probe-mode">{mode}</Text>
    </View>
  );
}

function ModeControls() {
  const {setMode} = useApplicationMode();
  return (
    <View>
      <Pressable testID="set-serverless" onPress={() => setMode('serverless')} />
      <Pressable testID="set-server" onPress={() => setMode('server')} />
    </View>
  );
}

function Harness() {
  return (
    <ModeProvider>
      <ModeProbe />
      <ModeControls />
    </ModeProvider>
  );
}

describe('ModeProvider', () => {
  beforeEach(() => {
    resetStorage();
    jest.clearAllMocks();
    setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
  });

  it('starts ready in the default mode with empty storage', async () => {
    await render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('probe-status').props.children).toBe('ready'));
    expect(screen.getByTestId('probe-mode').props.children).toBe('serverless');
    expect(getRuntimeApplicationMode()).toBe('serverless');
  });

  it('restores a persisted serverless selection at startup', async () => {
    await saveApplicationMode('serverless');

    await render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('probe-mode').props.children).toBe('serverless'));
    expect(getRuntimeApplicationMode()).toBe('serverless');
  });

  it('switches modes deterministically and persists every transition', async () => {
    await render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('probe-status').props.children).toBe('ready'));

    await fireEvent.press(screen.getByTestId('set-serverless'));
    expect(screen.getByTestId('probe-mode').props.children).toBe('serverless');
    expect(getRuntimeApplicationMode()).toBe('serverless');
    await expect(loadApplicationMode()).resolves.toBe('serverless');

    // Setting the same mode again is an idempotent no-op.
    await fireEvent.press(screen.getByTestId('set-serverless'));
    expect(screen.getByTestId('probe-mode').props.children).toBe('serverless');

    await fireEvent.press(screen.getByTestId('set-server'));
    expect(screen.getByTestId('probe-mode').props.children).toBe('server');
    expect(getRuntimeApplicationMode()).toBe('server');
    await expect(loadApplicationMode()).resolves.toBe('server');
  });

  it('throws a helpful error outside a ModeProvider', async () => {
    function Orphan() {
      useApplicationMode();
      return null;
    }

    await expect(render(<Orphan />)).rejects.toThrow(
      'useApplicationMode must be used within a ModeProvider',
    );
  });
});

describe('server API gate', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    resetStorage();
    jest.clearAllMocks();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
  });

  it('blocks REST requests with a typed error while serverless', async () => {
    setRuntimeApplicationMode('serverless');

    await expect(apiRequest('/api/v1/sessions/')).rejects.toThrow(ServerApiBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets REST requests through while in server mode', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), {status: 200}));
    setRuntimeApplicationMode('server');

    await expect(apiRequest('/api/v1/sessions/')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails SSE turns without opening any connection while serverless', () => {
    setRuntimeApplicationMode('serverless');
    const realXHR = globalThis.XMLHttpRequest;
    const xhrConstructor = jest.fn();
    globalThis.XMLHttpRequest = xhrConstructor as unknown as typeof XMLHttpRequest;

    try {
      const events: unknown[] = [];
      const errors: unknown[] = [];
      const handle = streamChatTurn({
        token: 'token',
        sessionId: 1,
        text: 'local-only message',
        onEvent: event => events.push(event),
        onError: error => errors.push(error),
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(ServerApiBlockedError);
      expect(events).toHaveLength(0);
      expect(xhrConstructor).not.toHaveBeenCalled();

      // Aborting a never-started turn is safe.
      expect(() => handle.abort()).not.toThrow();
    } finally {
      globalThis.XMLHttpRequest = realXHR;
    }
  });
});

describe('Settings application-mode switcher (TASK-090)', () => {
  function renderSettings() {
    return render(
      <ModeProvider>
        <ThemeProvider>
          <SettingsScreen {...settingsPropsStub()} />
        </ThemeProvider>
      </ModeProvider>,
    );
  }

  beforeEach(async () => {
    asyncStorage.__resetAsyncStorageStore();
    jest.clearAllMocks();
    setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
    await saveApplicationMode(DEFAULT_APPLICATION_MODE);
  });

  afterEach(() => {
    setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
  });

  it('explains both modes with the documented copy and checks the current mode', async () => {
    await renderSettings();

    expect(await screen.findByTestId('settings-mode-section')).toBeOnTheScreen();
    expect(screen.getByText('Server mode')).toBeOnTheScreen();
    expect(
      screen.getByText('Your conversations are stored with your account.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Serverless mode')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Conversations stay on this device and AI requests go directly to OpenRouter.',
      ),
    ).toBeOnTheScreen();

    // Restore settles asynchronously; wait for the checked state to reflect
    // the persisted default before asserting.
    await waitFor(() => expect(checkedStateOf('settings-mode-serverless')).toBe(true));
    expect(checkedStateOf('settings-mode-server')).toBe(false);
  });

  it('restores a persisted serverless selection with its radio checked', async () => {
    await saveApplicationMode('serverless');
    await renderSettings();

    await waitFor(() => expect(checkedStateOf('settings-mode-serverless')).toBe(true));
    expect(checkedStateOf('settings-mode-server')).toBe(false);
  });

  it('switching to server flips the radios, persists, and moves the runtime gate', async () => {
    await renderSettings();
    await waitFor(() => expect(checkedStateOf('settings-mode-serverless')).toBe(true));

    await fireEvent.press(screen.getByTestId('settings-mode-server'));

    await waitFor(() => expect(checkedStateOf('settings-mode-server')).toBe(true));
    expect(checkedStateOf('settings-mode-serverless')).toBe(false);
    expect(getRuntimeApplicationMode()).toBe('server');
    await expect(loadApplicationMode()).resolves.toBe('server');

    // Switching back restores serverless data access and persistence.
    await fireEvent.press(screen.getByTestId('settings-mode-serverless'));

    await waitFor(() => expect(getRuntimeApplicationMode()).toBe('serverless'));
    expect(checkedStateOf('settings-mode-serverless')).toBe(true);
    expect(checkedStateOf('settings-mode-server')).toBe(false);
    await expect(loadApplicationMode()).resolves.toBe('serverless');
  });
});
