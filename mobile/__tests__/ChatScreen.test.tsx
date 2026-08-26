/**
 * Chat screen tests (SPEC TASK-048/049): message list ordering, composer/
 * send interaction, loading/empty/error states and the keyboard-avoiding
 * shell — plus the SSE streaming round-trip: incremental assistant deltas,
 * completion swap-in, error frames, transport failures and abort-on-exit.
 */
import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';

import type {ChatStreamEvent, StreamChatTurnOptions} from '../src/api/chatStream';
import {streamChatTurn} from '../src/api/chatStream';
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
jest.mock('../src/api/chatStream');
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedStorage = jest.mocked(secureStorage);
const mockedStream = jest.mocked(streamChatTurn);

/** One captured streamChatTurn invocation plus its abort spy. */
interface CapturedTurn {
  options: StreamChatTurnOptions;
  handle: {abort: () => void};
}

let turns: CapturedTurn[] = [];

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

  return render(
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

/** Push one SSE application event through the captured turn's callback. */
async function deliver(turn: CapturedTurn, event: ChatStreamEvent): Promise<void> {
  await act(async () => {
    turn.options.onEvent(event);
  });
}

/** Surface a transport-level failure through the captured turn's callback. */
async function failTransport(turn: CapturedTurn, error: unknown): Promise<void> {
  await act(async () => {
    turn.options.onError(error);
  });
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
  turns = [];
  mockedStream.mockImplementation(options => {
    const handle = {abort: jest.fn()};
    turns.push({options, handle});
    return handle;
  });
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
    // The optimistic echo plus its pending assistant bubble sit after every
    // previously loaded message.
    expect(messageTestIds()).toHaveLength(3);
    expect(messageTestIds()[1].startsWith('chat-message--')).toBe(true);
    expect(messageTestIds()[2].startsWith('chat-message--')).toBe(true);
    // Sending consumes the SSE stream endpoint with the trimmed text.
    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(turns[0]?.options).toMatchObject({
      token: 'token-a',
      sessionId: 5,
      text: 'Hi there',
    });
    expect(typeof turns[0]?.options.onEvent).toBe('function');
    expect(typeof turns[0]?.options.onError).toBe('function');
  });

  it('streams assistant deltas into one growing bubble then swaps in persisted rows', async () => {
    const finalRows = pageOf([
      makeMessage({id: 501, role: 'user', sequence: 1, content: 'Hello AI'}),
      makeMessage({
        id: 502,
        role: 'assistant',
        sequence: 2,
        status: 'complete',
        content: 'Hello, how are you?',
      }),
    ]);
    mockedSessions.listMessages
      .mockResolvedValueOnce(emptyPage())
      .mockResolvedValueOnce(finalRows);
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Hello AI');
    await fireEvent.press(screen.getByTestId('chat-send'));
    const turn = turns[0];

    // Chunks append incrementally while streaming.
    await deliver(turn, {type: 'start', model: 'vendor/model'});
    await deliver(turn, {type: 'delta', text: 'Hello'});
    expect(screen.getByText('Hello')).toBeOnTheScreen();
    await deliver(turn, {type: 'delta', text: ', how are you?'});
    expect(screen.getByText('Hello, how are you?')).toBeOnTheScreen();

    // Completion finalizes and silently reloads canonical (persisted) rows.
    await deliver(turn, {
      type: 'completed',
      text: 'Hello, how are you?',
      model: 'vendor/model',
      deltaCount: 2,
    });
    await waitFor(() => expect(screen.getByTestId('chat-message-502')).toBeOnTheScreen());
    expect(screen.getByTestId('chat-message-501')).toBeOnTheScreen();
    expect(messageTestIds()).toEqual(['chat-message-501', 'chat-message-502']);
    expect(screen.queryByText(/chat-message--/)).toBeNull();
    expect(mockedSessions.listMessages).toHaveBeenCalledTimes(2);

    // The turn is over: composing a new message is possible again.
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Next');
    expect(
      (screen.getByTestId('chat-send').props.accessibilityState ?? {}).disabled,
    ).toBe(false);
  });

  it('shows an empty pending bubble while waiting for the first delta', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-empty')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Hi');
    await fireEvent.press(screen.getByTestId('chat-send'));

    // The optimistic echo plus its placeholder assistant bubble exist before
    // any delta arrives; the placeholder carries no text yet.
    expect(messageTestIds()).toHaveLength(2);
    const placeholder = screen.getByTestId(messageTestIds()[1]);
    expect(within(placeholder).queryAllByText(/.+/)).toHaveLength(0);
  });

  it('displays error frames inline and re-syncs server truth afterwards', async () => {
    mockedSessions.listMessages
      .mockResolvedValueOnce(emptyPage())
      .mockResolvedValueOnce(
        pageOf([
          makeMessage({id: 601, role: 'user', sequence: 1, content: 'Hi'}),
          makeMessage({
            id: 602,
            role: 'assistant',
            sequence: 2,
            status: 'failed',
            content: '',
          }),
        ]),
      );
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-empty')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Hi');
    await fireEvent.press(screen.getByTestId('chat-send'));
    await deliver(turns[0], {
      type: 'error',
      message: 'The provider is unavailable right now.',
      retryable: true,
    });

    expect(screen.getByTestId('chat-stream-error')).toHaveTextContent(
      'The provider is unavailable right now.',
    );
    // Optimistic rows are dropped; the reload restores committed rows.
    await waitFor(() => expect(screen.getByTestId('chat-message-602')).toBeOnTheScreen());
    expect(screen.getByTestId('chat-message-601')).toBeOnTheScreen();
    expect(messageTestIds()).toEqual(['chat-message-601', 'chat-message-602']);

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Trying again');
    expect(
      (screen.getByTestId('chat-send').props.accessibilityState ?? {}).disabled,
    ).toBe(false);
  });

  it('surfaces transport failures as friendly unreachable errors', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Hello?');
    await fireEvent.press(screen.getByTestId('chat-send'));
    await failTransport(turns[0], new ApiError(0, 'Network request failed.'));

    expect(screen.getByTestId('chat-stream-error')).toHaveTextContent(
      /server is unreachable right now/i,
    );
  });

  it('aborts the in-flight stream when leaving the screen', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());
    const utils = await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Still here?');
    await fireEvent.press(screen.getByTestId('chat-send'));
    expect(turns[0].handle.abort).not.toHaveBeenCalled();

    await act(async () => {
      utils.unmount();
    });

    expect(turns[0].handle.abort).toHaveBeenCalledTimes(1);
  });

  it('prevents sending again while a turn is still streaming', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'One');
    await fireEvent.press(screen.getByTestId('chat-send'));

    const sendDisabled = () =>
      (screen.getByTestId('chat-send').props.accessibilityState ?? {}).disabled;
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Two');
    expect(sendDisabled()).toBe(true);

    await fireEvent.press(screen.getByTestId('chat-send'));
    expect(mockedStream).toHaveBeenCalledTimes(1);

    await deliver(turns[0], {type: 'completed', text: 'Done.', model: 'm', deltaCount: 1});
    await waitFor(() => expect(sendDisabled()).toBe(false));
    expect(mockedStream).toHaveBeenCalledTimes(1);
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
