/**
 * Theme system tests (SPEC TASK-044): mode resolution (light/dark/system),
 * live tracking of the OS preference, palette integrity, the Settings
 * switcher, and proof that screens consume tokens instead of hard-coded
 * colors.
 */
import React from 'react';
import {Pressable, Text, View} from 'react-native';
import {act, fireEvent, render, screen} from '@testing-library/react-native';

import {darkColors, lightColors} from '../src/theme/colors';
import {ModeProvider} from '../src/mode/ModeContext';
import {ThemeProvider, useTheme} from '../src/theme/ThemeContext';
import type {LoginScreenProps, SettingsScreenProps} from '../src/navigation/types';
import {ChatScreen} from '../src/screens/ChatScreen';
import {LoginScreen} from '../src/screens/LoginScreen';
import {SettingsScreen} from '../src/screens/SettingsScreen';

type SystemScheme = 'light' | 'dark' | null;

// `mock`-prefixed so the hoisted jest.mock factory may close over them.
const mockSystemState: {
  current: SystemScheme;
  listeners: Array<(next: SystemScheme) => void>;
} = {current: 'light', listeners: []};

// Stable identity across renders: consumers may key effects on it.
const mockGetAccessToken = async () => 'token';

jest.mock('../src/theme/system', () => ({
  __setSystemScheme: (scheme: SystemScheme) => {
    mockSystemState.current = scheme;
    for (const notify of mockSystemState.listeners) {
      notify(scheme);
    }
  },
  useSystemColorScheme: () => {
    const react = require('react');
    const [scheme, setScheme] = react.useState(mockSystemState.current);
    react.useEffect(() => {
      const notify = (next: SystemScheme) => setScheme(next);
      mockSystemState.listeners.push(notify);
      return () => {
        const index = mockSystemState.listeners.indexOf(notify);
        if (index >= 0) {
          mockSystemState.listeners.splice(index, 1);
        }
      };
    }, []);
    return scheme;
  },
}));

jest.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({
    user: {id: 1, username: 'alice', email: 'alice@example.com'},
    busy: false,
    logout: jest.fn(),
    getAccessToken: mockGetAccessToken,
  }),
}));


function ThemeProbe() {
  const {mode, resolvedScheme, colors} = useTheme();
  return (
    <View>
      <Text testID="probe-mode">{mode}</Text>
      <Text testID="probe-resolved">{resolvedScheme}</Text>
      <Text testID="probe-background">{colors.background}</Text>
    </View>
  );
}

function ModeControls() {
  const {setMode} = useTheme();
  return (
    <View>
      <Pressable testID="set-light" onPress={() => setMode('light')} />
      <Pressable testID="set-dark" onPress={() => setMode('dark')} />
      <Pressable testID="set-system" onPress={() => setMode('system')} />
    </View>
  );
}

function Harness() {
  return (
    <ThemeProvider>
      <ThemeProbe />
      <ModeControls />
    </ThemeProvider>
  );
}

function backgroundOf(testID: string): unknown {
  const style = screen.getByTestId(testID).props.style;
  const flat = Array.isArray(style)
    ? Object.assign({}, ...style.filter(Boolean).map(s => (typeof s === 'object' ? s : {})))
    : style;
  return flat?.backgroundColor;
}

function navigationStub() {
  return {navigate: jest.fn(), goBack: jest.fn(), replace: jest.fn()};
}

const settingsProps = {
  navigation: navigationStub(),
  route: {key: 'settings-test', name: 'Settings', params: undefined},
} as unknown as SettingsScreenProps;

const loginProps = {
  navigation: navigationStub(),
  route: {key: 'login-test', name: 'Login', params: undefined},
} as unknown as LoginScreenProps;

type ChatScreenProps = React.ComponentProps<typeof ChatScreen>;
const chatProps = {
  navigation: navigationStub(),
  route: {key: 'chat-test', name: 'Chat', params: undefined},
} as unknown as ChatScreenProps;

function setSystemScheme(scheme: SystemScheme) {
  mockSystemState.current = scheme;
  for (const notify of mockSystemState.listeners) {
    notify(scheme);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  setSystemScheme('light');
});

describe('theme resolution', () => {
  it('defaults to system mode and follows a light OS preference', async () => {
    await render(<Harness />);

    expect(screen.getByTestId('probe-mode').props.children).toBe('system');
    expect(screen.getByTestId('probe-resolved').props.children).toBe('light');
    expect(screen.getByTestId('probe-background').props.children).toBe(lightColors.background);
  });

  it('follows a dark OS preference while in system mode', async () => {
    setSystemScheme('dark');
    await render(<Harness />);

    expect(screen.getByTestId('probe-resolved').props.children).toBe('dark');
    expect(screen.getByTestId('probe-background').props.children).toBe(darkColors.background);
  });

  it('an explicit light mode overrides a dark OS preference', async () => {
    setSystemScheme('dark');
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId('set-light'));

    expect(screen.getByTestId('probe-mode').props.children).toBe('light');
    expect(screen.getByTestId('probe-resolved').props.children).toBe('light');
  });

  it('an explicit dark mode overrides a light OS preference', async () => {
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId('set-dark'));

    expect(screen.getByTestId('probe-mode').props.children).toBe('dark');
    expect(screen.getByTestId('probe-resolved').props.children).toBe('dark');
    expect(screen.getByTestId('probe-background').props.children).toBe(darkColors.background);
  });

  it('returning to system mode re-follows the OS preference', async () => {
    setSystemScheme('dark');
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId('set-light'));
    expect(screen.getByTestId('probe-resolved').props.children).toBe('light');

    await fireEvent.press(screen.getByTestId('set-system'));

    expect(screen.getByTestId('probe-mode').props.children).toBe('system');
    expect(screen.getByTestId('probe-resolved').props.children).toBe('dark');
  });

  it('tracks live OS scheme changes while in system mode', async () => {
    await render(<Harness />);
    expect(screen.getByTestId('probe-resolved').props.children).toBe('light');

    await act(async () => {
      setSystemScheme('dark');
    });

    expect(screen.getByTestId('probe-resolved').props.children).toBe('dark');
    expect(screen.getByTestId('probe-background').props.children).toBe(darkColors.background);
  });

  it('ignores live OS scheme changes while pinned to an explicit mode', async () => {
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId('set-dark'));
    expect(screen.getByTestId('probe-resolved').props.children).toBe('dark');

    await act(async () => {
      setSystemScheme('light');
    });

    expect(screen.getByTestId('probe-mode').props.children).toBe('dark');
    expect(screen.getByTestId('probe-resolved').props.children).toBe('dark');
  });

  it('falls back to light when the OS reports no preference', async () => {
    setSystemScheme(null);
    await render(<Harness />);

    expect(screen.getByTestId('probe-resolved').props.children).toBe('light');
  });
});

describe('palettes', () => {
  it('light and dark palettes expose identical token sets with non-empty values', () => {
    const lightKeys = Object.keys(lightColors).sort();
    const darkKeys = Object.keys(darkColors).sort();

    expect(lightKeys).toEqual(darkKeys);
    expect(lightKeys.length).toBeGreaterThan(0);
    for (const key of lightKeys) {
      const token = key as keyof typeof lightColors;
      expect(typeof lightColors[token]).toBe('string');
      expect(lightColors[token].length).toBeGreaterThan(0);
      expect(typeof darkColors[token]).toBe('string');
      expect(darkColors[token].length).toBeGreaterThan(0);
    }
  });
});

describe('useTheme', () => {
  it('throws a helpful error outside a ThemeProvider', async () => {
    function Orphan() {
      useTheme();
      return null;
    }

    await expect(render(<Orphan />)).rejects.toThrow(
      'useTheme must be used within a ThemeProvider',
    );
  });
});

describe('settings theme switcher', () => {
  it('shows all three modes with system checked by default', async () => {
    await render(
      <ThemeProvider>
        <SettingsScreen {...settingsProps} />
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('settings-theme-system').props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(screen.getByTestId('settings-theme-light').props.accessibilityState).toMatchObject({
      checked: false,
    });
    expect(screen.getByTestId('settings-theme-dark').props.accessibilityState).toMatchObject({
      checked: false,
    });
  });

  it('selecting Dark re-themes the whole tree and moves the checked state', async () => {
    await render(
      <ThemeProvider>
        <SettingsScreen {...settingsProps} />
        <ThemeProbe />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('settings-theme-dark'));

    expect(screen.getByTestId('settings-theme-dark').props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(screen.getByTestId('settings-theme-system').props.accessibilityState).toMatchObject({
      checked: false,
    });
    expect(screen.getByTestId('probe-resolved').props.children).toBe('dark');
  });

  it('selecting Light wins over a dark OS preference', async () => {
    setSystemScheme('dark');
    await render(
      <ThemeProvider>
        <SettingsScreen {...settingsProps} />
        <ThemeProbe />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('settings-theme-light'));

    expect(screen.getByTestId('probe-resolved').props.children).toBe('light');
  });
});

describe('screens consume theme tokens', () => {
  it('the login screen background follows the active palette', async () => {
    await render(
      <ThemeProvider>
        <LoginScreen {...loginProps} />
        <ModeControls />
      </ThemeProvider>,
    );

    expect(backgroundOf('login-screen')).toBe(lightColors.background);

    await fireEvent.press(screen.getByTestId('set-dark'));

    expect(backgroundOf('login-screen')).toBe(darkColors.background);
  });

  it('the chat screen background follows the active palette', async () => {
    await render(
      <ModeProvider>
        <ThemeProvider>
          <ChatScreen {...chatProps} />
          <ModeControls />
        </ThemeProvider>
      </ModeProvider>,
    );

    expect(backgroundOf('chat-screen')).toBe(lightColors.background);

    await fireEvent.press(screen.getByTestId('set-dark'));

    expect(backgroundOf('chat-screen')).toBe(darkColors.background);
  });
});
