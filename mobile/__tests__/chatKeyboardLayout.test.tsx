/**
 * TASK-IMPROVEMENT-002 keyboard-avoidance regression tests for the chat
 * screen. The conversation shell must lift the composer above the reported
 * keyboard frame — no hard-coded keyboard height — and anchor it back to
 * the shell bottom on dismissal. The keyboard frame is driven through the
 * same device-event seam the OS uses (Keyboard events), and the shell's
 * measured layout through its onLayout seam, so the real avoidance math
 * in useChatKeyboardAvoidance is exercised: padding = screen-bottom overlap
 * with the keyboard, offset by the status-bar inset the app applies above
 * the screen (edge-to-edge).
 */
import React from 'react';
import {DeviceEventEmitter, Pressable, Text, View} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import {streamChatTurn, streamRetryTurn} from '../src/api/chatStream';
import * as authApi from '../src/api/auth';
import * as sessionsApi from '../src/api/sessions';
import type {ChatMessage, Paginated, Session} from '../src/api/sessions';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import type {MainStackParamList} from '../src/navigation/types';
import {ChatScreen} from '../src/screens/ChatScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/api/chatStream');
jest.mock('../src/api/vocabulary', () => ({
  saveVocabulary: jest.fn(),
}));
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedStream = jest.mocked(streamChatTurn);
const mockedStreamRetry = jest.mocked(streamRetryTurn);
const mockedStorage = jest.mocked(secureStorage);

/**
 * Test seam from jest.setup.js: pretend the device reports different bar
 * geometry (the real insets reach the app through useSafeAreaInsets).
 */
const safeArea = jest.requireMock('react-native-safe-area-context') as {
  __setSafeAreaInsets: (patch: {top?: number; bottom?: number}) => void;
  __resetSafeAreaInsets: () => void;
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 5,
    title: 'Traveling',
    topic: 'Talking about favorite destinations, transport and travel plans.',
    topic_hint: '',
    learning_level: 'B1',
    created_at: '2026-08-26T10:00:00Z',
    ...overrides,
  };
}

function emptyPage(): Paginated<ChatMessage> {
  return {count: 0, next: null, previous: null, results: []};
}

function flattenStyle(style: unknown): Record<string, unknown> {
  const entries = Array.isArray(style) ? style : [style];
  return Object.assign(
    {},
    ...entries.filter(Boolean).map(s => (typeof s === 'object' ? s : {})),
  );
}

/** Current bottom padding of the keyboard-avoiding shell, read once. */
function shellPaddingBottom(): unknown {
  return flattenStyle(screen.getByTestId('chat-screen').props.style)
    .paddingBottom;
}

/** Push one keyboard event through the OS event seam, like a device would. */
async function emitKeyboard(
  name:
    | 'keyboardWillShow'
    | 'keyboardDidShow'
    | 'keyboardWillHide'
    | 'keyboardDidHide',
  endCoordinates: {screenX: number; screenY: number; width: number; height: number},
) {
  await act(async () => {
    DeviceEventEmitter.emit(name, {duration: 0, easing: 'keyboard', endCoordinates});
    await Promise.resolve();
  });
}

async function renderChat(params?: MainStackParamList['Chat']) {
  const Stack = createNativeStackNavigator<MainStackParamList>();

  return render(
    <ModeProvider>
      <ThemeProvider>
        <AuthProvider>
          <NavigationContainer initialState={{index: 0, routes: [{name: 'Chat', params}]}}>
            <Stack.Navigator screenOptions={{headerShown: false}} initialRouteName="Chat">
              <Stack.Screen name="Chat" component={ChatScreen} />
              <Stack.Screen name="NewConversation">
                {() => <View testID="new-conversation-screen" />}
              </Stack.Screen>
              <Stack.Screen name="History">
                {({navigation}) => (
                  <Pressable testID="history-stub-back" onPress={() => navigation.goBack()}>
                    <Text>back</Text>
                  </Pressable>
                )}
              </Stack.Screen>
              <Stack.Screen name="Settings">{() => null}</Stack.Screen>
              <Stack.Screen name="Level">{() => null}</Stack.Screen>
            </Stack.Navigator>
          </NavigationContainer>
        </AuthProvider>
      </ThemeProvider>
    </ModeProvider>,
  );
}

/**
 * Drives the avoidance math for one device geometry: the shell measures
 * `shellHeight` tall and the keyboard reports its top at `keyboardScreenY`,
 * the device's status bar inset being `statusBarInset`. The composer must be
 * lifted by exactly the overlap so its bottom sits on the keyboard top, and
 * everything must return to the un-padded layout when the keyboard hides.
 */
async function expectComposerToRideTheKeyboard(options: {
  statusBarInset: number;
  shellHeight: number;
  keyboardScreenY: number;
  keyboardHeight: number;
}) {
  const {statusBarInset, shellHeight, keyboardScreenY, keyboardHeight} = options;
  safeArea.__setSafeAreaInsets({top: statusBarInset, bottom: 12});

  await renderChat({sessionId: 5});
  await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

  // Keyboard closed: the shell keeps its plain layout (no fixed offset).
  expect(shellPaddingBottom()).toBe(0);

  const shell = screen.getByTestId('chat-screen');
  await fireEvent(shell, 'layout', {
    persist: () => {},
    nativeEvent: {layout: {x: 0, y: 0, width: 400, height: shellHeight}},
  });

  await emitKeyboard('keyboardWillShow', {
    screenX: 0,
    screenY: keyboardScreenY,
    width: 400,
    height: keyboardHeight,
  });

  // The lifted shell must equal the overlap between its own bottom edge and
  // the keyboard top translated into shell coordinates (screenY - inset):
  // composer bottom = shell height - padding = keyboard top exactly.
  const expectedPadding = shellHeight - (keyboardScreenY - statusBarInset);
  await waitFor(() => expect(shellPaddingBottom()).toBe(expectedPadding));
  expect(expectedPadding).toBeGreaterThan(0);
  expect(screen.getByTestId('chat-composer')).toBeOnTheScreen();
  expect(screen.getByTestId('chat-send')).toBeOnTheScreen();
  expect(screen.getByTestId('composer-input')).toBeOnTheScreen();

  await emitKeyboard('keyboardWillHide', {
    screenX: 0,
    screenY: 0,
    width: 400,
    height: 0,
  });

  await waitFor(() => expect(shellPaddingBottom()).toBe(0));
  expect(screen.getByTestId('chat-composer')).toBeOnTheScreen();
}

beforeEach(async () => {
  jest.clearAllMocks();
  safeArea.__resetSafeAreaInsets();
  await saveApplicationMode('server');
  mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
  mockedSessions.getSession.mockResolvedValue(makeSession());
  mockedSessions.listMessages.mockResolvedValue(emptyPage());
  mockedStream.mockImplementation(_options => ({abort: jest.fn()}));
  mockedStreamRetry.mockImplementation(_options => ({abort: jest.fn()}));
});

afterEach(() => {
  safeArea.__resetSafeAreaInsets();
});

describe('chat keyboard avoidance (TASK-IMPROVEMENT-002)', () => {
  it('lifts the composer onto the keyboard top and restores the layout on dismissal', async () => {
    await expectComposerToRideTheKeyboard({
      statusBarInset: 24,
      shellHeight: 700,
      keyboardScreenY: 500,
      keyboardHeight: 300,
    });
  });

  it('follows the device status-bar inset instead of a fixed offset', async () => {
    // A notch-less geometry: with zero status-bar inset the lifted shell is
    // the plain overlap (700 - 500 = 200), which is exactly 24 less than the
    // inset-bearing device above — the offset tracks the real inset.
    await expectComposerToRideTheKeyboard({
      statusBarInset: 0,
      shellHeight: 700,
      keyboardScreenY: 500,
      keyboardHeight: 300,
    });
  });

  it('does not shrink the shell below the keyboard overlap on short screens', async () => {
    // Keyboard taller than the shell: the shell must stop at zero, never go
    // negative, and the composer must stay mounted (edge-to-edge screens
    // report the full keyboard height including the nav-bar region).
    await expectComposerToRideTheKeyboard({
      statusBarInset: 24,
      shellHeight: 200,
      keyboardScreenY: 100,
      keyboardHeight: 400,
    });
  });

  it('keeps the message list interactive while the keyboard is open', async () => {
    safeArea.__setSafeAreaInsets({top: 24, bottom: 12});
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    const list = screen.getByTestId('chat-list');
    expect(list.props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('anchors the composer to the bottom when Android reports the keyboard hidden', async () => {
    // Android (ReactRootView.checkForKeyboardEvents) emits keyboardDidHide
    // with screenY set to the visible display-frame height — a window metric
    // that excludes the status bar and therefore does not match the shell's
    // coordinate frame. Re-deriving the overlap from it leaves a residual
    // status-bar-height padding above the composer after dismissal (the
    // "ghost margin" on Android 16 + Gboard with edge-to-edge). The shell
    // must restore the plain layout exactly, whatever the payload reports.
    safeArea.__setSafeAreaInsets({top: 24, bottom: 12});
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    const shell = screen.getByTestId('chat-screen');
    await fireEvent(shell, 'layout', {
      persist: () => {},
      nativeEvent: {layout: {x: 0, y: 0, width: 400, height: 700}},
    });

    await emitKeyboard('keyboardDidShow', {
      screenX: 0,
      screenY: 500,
      width: 400,
      height: 300,
    });
    await waitFor(() => expect(shellPaddingBottom()).toBe(700 - (500 - 24)));

    // Android reports the hide event's screenY as the visible display-frame
    // height (700 = the shell's own height, measured below the status bar).
    // The old KeyboardAvoidingView formula turned that into
    // 700 - (700 - 24) = 24 residual points of padding — the
    // status-bar-height "ghost margin" seen on Android 16 + Gboard with
    // edge-to-edge. The shell must restore the plain layout (0) exactly,
    // whatever the payload reports.
    await emitKeyboard('keyboardDidHide', {
      screenX: 0,
      screenY: 700,
      width: 400,
      height: 0,
    });
    await waitFor(() => expect(shellPaddingBottom()).toBe(0));
    expect(screen.getByTestId('chat-composer')).toBeOnTheScreen();
  });
});
