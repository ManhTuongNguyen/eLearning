/**
 * Chat screen tests (SPEC TASK-048): message list ordering, composer/send
 * interaction, loading/empty/error states and the keyboard-avoiding shell.
 * Streaming consumption is TASK-049 and is deliberately out of scope here —
 * sending is a local optimistic append until that task lands.
 */
import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';

import * as authApi from '../src/api/auth';
import {ApiError} from '../src/api/client';
import * as sessionsApi from '../src/api/sessions';
import type {ChatMessage, Paginated} from '../src/api/sessions';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import type {MainStackParamList} from '../src/navigation/types';
import {ChatScreen} from '../src/screens/ChatScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedStorage = jest.mocked(secureStorage);

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 101,
    role: 'assistant',
    status: 'complete',
    content: 'Hello! Ready to practice?',
    sequence: 1,
    created_at: '2026-08-26T10:00:00Z',
    ...overrides,
  };
}

function emptyPage(): Paginated<ChatMessage> {
  return {count: 0, next: null, previous: null, results: []};
}

function pageOf(results: ChatMessage[]): Paginated<ChatMessage> {
  return {count: results.length, next: null, previous: null, results};
}

async function renderChat(params?: MainStackParamList['Chat']) {
  const Stack = createNativeStackNavigator<MainStackParamList>();

  await render(
    <ThemeProvider>
      <AuthProvider>
        <NavigationContainer initialState={{index: 0, routes: [{name: 'Chat', params}]}}>
          <Stack.Navigator screenOptions={{headerShown: false}} initialRouteName="Chat">
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="History">{() => null}</Stack.Screen>
            <Stack.Screen name="Settings">{() => null}</Stack.Screen>
            <Stack.Screen name="Level">{() => null}</Stack.Screen>
          </Stack.Navigator>
        </NavigationContainer>
      </AuthProvider>
    </ThemeProvider>,
  );
}

function messageTestIds(): string[] {
  return screen
    .queryAllByTestId(/^chat-message-/)
    .map(element => element.props.testID as string);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
});

describe('ChatScreen', () => {
  it('shows a loading state while messages are being fetched', async () => {
    let resolveMessages: (page: Paginated<ChatMessage>) => void = () => {};
    mockedSessions.listMessages.mockReturnValue(
      new Promise<Paginated<ChatMessage>>(resolve => {
        resolveMessages = resolve;
      }),
    );

    await renderChat({sessionId: 5});

    expect(screen.getByTestId('chat-loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('chat-composer')).toBeNull();

    resolveMessages(emptyPage());
    await waitFor(() => expect(screen.queryByTestId('chat-loading')).toBeNull());
    expect(mockedSessions.listMessages).toHaveBeenCalledWith('token-a', 5);
  });

  it('renders an in-conversation empty state when the session has no messages', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());

    await renderChat({sessionId: 5});

    await waitFor(() => expect(screen.getByTestId('chat-empty')).toBeOnTheScreen());
    expect(screen.getByTestId('chat-composer')).toBeOnTheScreen();
  });

  it('renders loaded messages in chronological order regardless of delivery order', async () => {
    mockedSessions.listMessages.mockResolvedValue(
      pageOf([
        makeMessage({id: 103, role: 'assistant', sequence: 3, content: 'Third'}),
        makeMessage({id: 101, role: 'user', sequence: 1, content: 'First'}),
        makeMessage({id: 102, role: 'assistant', sequence: 2, content: 'Second'}),
      ]),
    );

    await renderChat({sessionId: 5});

    await waitFor(() =>
      expect(messageTestIds()).toEqual([
        'chat-message-101',
        'chat-message-102',
        'chat-message-103',
      ]),
    );
  });

  it('sends a typed message by appending it chronologically and clearing the composer', async () => {
    mockedSessions.listMessages.mockResolvedValue(
      pageOf([makeMessage({id: 201, role: 'user', sequence: 1, content: 'Hello'})]),
    );
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-message-201')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Hi there');
    await fireEvent.press(screen.getByTestId('chat-send'));

    expect(messageTestIds()[0]).toBe('chat-message-201');
    expect(screen.getByText('Hi there')).toBeOnTheScreen();
    expect(screen.getByTestId('composer-input').props.value).toBe('');
    // The new bubble sits after every previously loaded message.
    expect(messageTestIds()).toHaveLength(2);
  });

  it('disables send while the draft is blank or whitespace-only', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    const sendDisabled = () =>
      (screen.getByTestId('chat-send').props.accessibilityState ?? {}).disabled;

    expect(sendDisabled()).toBe(true);

    await fireEvent.changeText(screen.getByTestId('composer-input'), '   ');
    expect(sendDisabled()).toBe(true);

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Hello!');
    expect(sendDisabled()).toBe(false);
  });

  it('shows an error state with retry when loading messages fails', async () => {
    mockedSessions.listMessages
      .mockRejectedValueOnce(new ApiError(0, 'Network request failed.'))
      .mockResolvedValueOnce(pageOf([makeMessage({id: 301})]));

    await renderChat({sessionId: 5});

    await waitFor(() =>
      expect(screen.getByTestId('form-error')).toHaveTextContent(
        /server is unreachable right now/i,
      ),
    );

    await fireEvent.press(screen.getByTestId('chat-retry'));

    await waitFor(() => expect(screen.getByTestId('chat-message-301')).toBeOnTheScreen());
    expect(screen.queryByTestId('form-error')).toBeNull();
    expect(mockedSessions.listMessages).toHaveBeenCalledTimes(2);
  });

  it('shows the no-conversation state and skips fetching without a session param', async () => {
    await renderChat(undefined);

    expect(await screen.findByTestId('chat-no-session')).toBeOnTheScreen();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(mockedSessions.listMessages).not.toHaveBeenCalled();
  });

  it('hosts the full conversation shell inside the keyboard-avoiding root', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());
    await renderChat({sessionId: 5});

    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());
    // The screen root is the keyboard-avoiding shell; header, list and
    // composer all live inside it. Actual keyboard animation is a device
    // concern (same treatment as LoginScreen).
    const withinRoot = within(screen.getByTestId('chat-screen'));
    expect(withinRoot.getByTestId('chat-list')).toBeOnTheScreen();
    expect(withinRoot.getByTestId('composer-input')).toBeOnTheScreen();
  });
});
