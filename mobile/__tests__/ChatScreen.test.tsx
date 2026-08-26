/**
 * Chat screen tests (SPEC TASK-048/049/050/052/053/054): message list
 * ordering, composer/send interaction, loading/empty/error states and the
 * keyboard-avoiding shell — plus the SSE streaming round-trip: incremental
 * assistant deltas, completion swap-in, error frames, transport failures and
 * abort-on-exit, the TASK-050 smooth-streaming behavior (coalesced delta
 * commits, scroll stick/detach transitions, ghost-delta suppression), the
 * TASK-052 collapsible topic header, the TASK-053 sample-conversation
 * overlay entry, the TASK-054 failed-response retry control, the
 * TASK-060 message long-press menu, the TASK-061 suggested-replies
 * chips (tap-to-insert, never auto-send, loading/error states), the
 * TASK-064 improvement sheet (loading/error/result round-trip, Copy
 * improved text, untouched original bubble) and the TASK-069 text
 * selection flow (Select text opens the vocabulary sheet over that
 * message's content; capture closes it; dismissal never captures).
 */
import React from 'react';
import {View} from 'react-native';
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

import type {
  ChatStreamEvent,
  StreamChatTurnOptions,
  StreamRetryTurnOptions,
} from '../src/api/chatStream';
import {streamChatTurn, streamRetryTurn} from '../src/api/chatStream';
import * as authApi from '../src/api/auth';
import {ApiError} from '../src/api/client';
import * as sessionsApi from '../src/api/sessions';
import type {
  ChatMessage,
  MessageImprovement,
  MessageSuggestions,
  Paginated,
  SampleTurn,
  Session,
} from '../src/api/sessions';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import type {MainStackParamList} from '../src/navigation/types';
import {ChatScreen} from '../src/screens/ChatScreen';
import {STREAM_FLUSH_INTERVAL_MS} from '../src/screens/streamingUx';
import {ThemeProvider} from '../src/theme/ThemeContext';
import {copyText} from '../src/utils/clipboard';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/api/chatStream');
jest.mock('../src/auth/secureStorage');
jest.mock('../src/utils/clipboard');

const mockedCopy = jest.mocked(copyText);

const mockedAuth = jest.mocked(authApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedStorage = jest.mocked(secureStorage);
const mockedStream = jest.mocked(streamChatTurn);
const mockedStreamRetry = jest.mocked(streamRetryTurn);

/** One captured stream invocation (send or retry) plus its abort spy. */
interface CapturedTurn {
  options: StreamChatTurnOptions | StreamRetryTurnOptions;
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

function makeSampleTurn(overrides: Partial<SampleTurn> = {}): SampleTurn {
  return {role: 'assistant', content: 'Example line', ...overrides};
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
            <Stack.Screen name="NewConversation">
              {() => <View testID="new-conversation-screen" />}
            </Stack.Screen>
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

/**
 * Let the TASK-050 delta buffer's deferred flush tick elapse inside act so
 * the resulting state update stays wrapped.
 */
async function flushStreamTick(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve =>
      setTimeout(() => resolve(), STREAM_FLUSH_INTERVAL_MS + 20),
    );
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
  mockedSessions.getSession.mockResolvedValue(makeSession());
  mockedSessions.getMessageSuggestions.mockResolvedValue({
    replies: ['Default reply one', 'Default reply two', 'Default reply three'],
  });
  mockedSessions.improveMessage.mockResolvedValue({
    original: 'Default original',
    improved: 'Default improved',
    explanation: 'Default explanation',
  });
  turns = [];
  mockedStream.mockImplementation(options => {
    const handle = {abort: jest.fn()};
    turns.push({options, handle});
    return handle;
  });
  mockedStreamRetry.mockImplementation(options => {
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

    // Chunks append incrementally while streaming (visible after the
    // buffer's flush tick — commits are coalesced, not per-delta).
    await deliver(turn, {type: 'start', model: 'vendor/model'});
    await deliver(turn, {type: 'delta', text: 'Hello'});
    await waitFor(() => expect(screen.getByText('Hello')).toBeOnTheScreen());
    await deliver(turn, {type: 'delta', text: ', how are you?'});
    await waitFor(() =>
      expect(screen.getByText('Hello, how are you?')).toBeOnTheScreen(),
    );

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

  it('coalesces a rapid delta burst into one deferred commit, then swaps in the completed text', async () => {
    const fullText = 'Otters are semiaquatic mammals that juggle stones.';
    mockedSessions.listMessages
      .mockResolvedValueOnce(emptyPage())
      .mockResolvedValueOnce(
        pageOf([
          makeMessage({id: 701, role: 'user', sequence: 1, content: 'Tell me about otters'}),
          makeMessage({
            id: 702,
            role: 'assistant',
            status: 'complete',
            sequence: 2,
            content: fullText,
          }),
        ]),
      );
    await renderChat({sessionId: 7});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Tell me about otters');
    await fireEvent.press(screen.getByTestId('chat-send'));
    const turn = turns[0];

    // A whole token volley lands before any flush tick: nothing renders yet
    // because commits are coalesced instead of one state update per delta.
    await act(async () => {
      for (const part of [
        'Otters ',
        'are ',
        'semiaquatic ',
        'mammals ',
        'that ',
        'juggle ',
        'stones.',
      ]) {
        turn.options.onEvent({type: 'delta', text: part});
      }
    });
    expect(screen.queryByText(fullText)).toBeNull();

    // One tick later the burst appears exactly once, fully concatenated.
    await flushStreamTick();
    expect(screen.getAllByText(fullText)).toHaveLength(1);

    // Deltas buffered behind a completed frame are superseded by its
    // authoritative text — no duplication and no lost tail.
    await deliver(turn, {type: 'delta', text: ' EXTRA-NOT-PERSISTED'});
    await deliver(turn, {
      type: 'completed',
      text: fullText,
      model: 'vendor/model',
      deltaCount: 7,
    });
    await waitFor(() =>
      expect(screen.getByTestId('chat-message-702')).toBeOnTheScreen(),
    );
    expect(screen.getByTestId('chat-message-701')).toBeOnTheScreen();
    expect(screen.queryByText(/EXTRA-NOT-PERSISTED/)).toBeNull();
    expect(screen.getAllByText(fullText)).toHaveLength(1);
  });

  it('detaches auto-scroll when the user scrolls up and re-sticks via jump-to-latest', async () => {
    // Six rows keeps the optimistic pair inside the FlatList render window
    // (the test environment mounts only the first ~10 items).
    mockedSessions.listMessages.mockResolvedValue(
      pageOf(
        Array.from({length: 6}, (_, i) =>
          makeMessage({
            id: 800 + i,
            role: i % 2 === 0 ? 'user' : 'assistant',
            sequence: i + 1,
            content: `Line ${i}`,
          }),
        ),
      ),
    );
    await renderChat({sessionId: 9});
    await waitFor(() => expect(screen.getByTestId('chat-message-805')).toBeOnTheScreen());

    // Reading the tail: no detaching pill.
    expect(screen.queryByTestId('chat-jump-latest')).toBeNull();

    // An intentional scroll far above the bottom flips to detached…
    const scrollUp = {
      nativeEvent: {
        contentOffset: {x: 0, y: 100},
        contentSize: {height: 2400, width: 0},
        layoutMeasurement: {height: 400, width: 0},
      },
    };
    await fireEvent.scroll(screen.getByTestId('chat-list'), scrollUp);
    expect(screen.getByTestId('chat-jump-latest')).toBeOnTheScreen();

    // …and streamed growth while detached still lands in the bubble without
    // forcing the viewport back down.
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Still there?');
    await fireEvent.press(screen.getByTestId('chat-send'));
    await deliver(turns[0], {type: 'delta', text: 'Yes.'});
    await flushStreamTick();
    expect(screen.getByText('Yes.')).toBeOnTheScreen();
    expect(screen.getByTestId('chat-jump-latest')).toBeOnTheScreen();

    // Scrolling back into the threshold window re-sticks and hides the pill.
    await fireEvent.scroll(screen.getByTestId('chat-list'), {
      nativeEvent: {
        contentOffset: {x: 0, y: 1880},
        contentSize: {height: 2400, width: 0},
        layoutMeasurement: {height: 400, width: 0},
      },
    });
    expect(screen.queryByTestId('chat-jump-latest')).toBeNull();

    // Detaching again offers the way back; pressing it restores the tail.
    await fireEvent.scroll(screen.getByTestId('chat-list'), scrollUp);
    expect(screen.getByTestId('chat-jump-latest')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('chat-jump-latest'));
    expect(screen.queryByTestId('chat-jump-latest')).toBeNull();
  });

  it('drops unflushed deltas when the turn fails so no ghost text lands afterwards', async () => {
    mockedSessions.listMessages
      .mockResolvedValueOnce(emptyPage())
      .mockResolvedValueOnce(
        pageOf([
          makeMessage({id: 901, role: 'user', sequence: 1, content: 'Hello'}),
          makeMessage({
            id: 902,
            role: 'assistant',
            status: 'failed',
            sequence: 2,
            content: '',
          }),
        ]),
      );
    await renderChat({sessionId: 11});
    await waitFor(() => expect(screen.getByTestId('chat-empty')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Hello');
    await fireEvent.press(screen.getByTestId('chat-send'));
    await deliver(turns[0], {type: 'delta', text: 'ghost-text-never-committed'});
    await deliver(turns[0], {
      type: 'error',
      message: 'Generation failed.',
      retryable: true,
    });
    expect(screen.getByTestId('chat-stream-error')).toHaveTextContent(
      'Generation failed.',
    );

    // The pending tick finds no target row anymore: the dropped delta never
    // renders — neither now…
    await flushStreamTick();
    expect(screen.queryByText(/ghost-text-never-committed/)).toBeNull();

    // …nor once the server-truth resync has completed.
    await waitFor(() => expect(screen.getByTestId('chat-message-902')).toBeOnTheScreen());
    expect(screen.queryByText(/ghost-text-never-committed/)).toBeNull();
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

  it('opens the new conversation flow from the header link (TASK-051)', async () => {
    mockedSessions.listMessages.mockResolvedValue(pageOf([makeMessage()]));
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('chat-open-new'));

    expect(screen.getByTestId('new-conversation-screen')).toBeOnTheScreen();
  });

  it('offers starting a new conversation from the no-session empty state', async () => {
    await renderChat(undefined);

    await screen.findByTestId('chat-no-session');

    await fireEvent.press(screen.getByTestId('chat-start-new'));

    expect(screen.getByTestId('new-conversation-screen')).toBeOnTheScreen();
  });

  it('shows a compact collapsed topic header once the session detail loads (TASK-052)', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());
    mockedSessions.getSession.mockResolvedValue(
      makeSession({id: 5, title: 'Traveling', topic: 'A long topic description'}),
    );

    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-topic')).toBeOnTheScreen());

    // Compact by default: only the title line, never the full description.
    expect(mockedSessions.getSession).toHaveBeenCalledWith('token-a', 5);
    expect(screen.getByTestId('chat-topic-title')).toHaveTextContent('Traveling');
    expect(screen.queryByTestId('chat-topic-text')).toBeNull();
    expect(
      (screen.getByTestId('chat-topic').props.accessibilityState ?? {}).expanded,
    ).toBe(false);
  });

  it('expands and collapses the full topic description on toggle', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());
    mockedSessions.getSession.mockResolvedValue(
      makeSession({
        id: 5,
        title: 'Traveling',
        topic: 'Talking about favorite destinations and travel plans.',
      }),
    );
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-topic')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('chat-topic'));

    expect(screen.getByTestId('chat-topic-text')).toHaveTextContent(
      'Talking about favorite destinations and travel plans.',
    );
    expect(
      (screen.getByTestId('chat-topic').props.accessibilityState ?? {}).expanded,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('chat-topic'));

    expect(screen.queryByTestId('chat-topic-text')).toBeNull();
    expect(
      (screen.getByTestId('chat-topic').props.accessibilityState ?? {}).expanded,
    ).toBe(false);
    expect(screen.getByTestId('chat-topic-title')).toBeOnTheScreen();
  });

  it('renders no topic bar without a session and skips the detail fetch', async () => {
    await renderChat(undefined);

    expect(await screen.findByTestId('chat-no-session')).toBeOnTheScreen();
    expect(screen.queryByTestId('chat-topic')).toBeNull();
    expect(mockedSessions.getSession).not.toHaveBeenCalled();
  });

  it('keeps the conversation usable when the session detail fetch fails', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());
    mockedSessions.getSession.mockRejectedValueOnce(new ApiError(0, 'Network request failed.'));

    await renderChat({sessionId: 5});

    // Messages win over metadata: composer present, no error banner, the
    // topic bar is simply absent.
    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());
    expect(screen.queryByTestId('form-error')).toBeNull();
    expect(screen.queryByTestId('chat-topic')).toBeNull();
  });

  it('hides the example entry when no sample turns were provided (TASK-053)', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());

    await renderChat({sessionId: 5});

    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());
    expect(screen.queryByTestId('chat-show-example')).toBeNull();
  });

  it('hides the example entry for an explicitly empty turn list', async () => {
    mockedSessions.listMessages.mockResolvedValue(emptyPage());

    await renderChat({sessionId: 5, sampleTurns: []});

    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());
    expect(screen.queryByTestId('chat-show-example')).toBeNull();
  });

  it('opens the sample overlay from "Show me an example" separate from chat history', async () => {
    mockedSessions.listMessages.mockResolvedValue(
      pageOf([makeMessage({id: 201, role: 'user', sequence: 1, content: 'Hello'})]),
    );
    await renderChat({
      sessionId: 5,
      sampleTurns: [
        makeSampleTurn({role: 'assistant', content: 'Coach greeting example'}),
        makeSampleTurn({role: 'user', content: 'Learner reply example'}),
      ],
    });
    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());

    // The entry point is visible, but none of the example text leaks into
    // the conversation tree before it is opened.
    expect(screen.getByTestId('chat-show-example')).toBeOnTheScreen();
    expect(screen.queryByText('Coach greeting example')).toBeNull();
    expect(messageTestIds()).toEqual(['chat-message-201']);

    // Opening presents both lines inside the overlay; the history is
    // untouched underneath.
    await fireEvent.press(screen.getByTestId('chat-show-example'));
    const overlay = screen.getByTestId('sample-modal');
    expect(within(overlay).getByText('Coach greeting example')).toBeOnTheScreen();
    expect(within(overlay).getByText('Learner reply example')).toBeOnTheScreen();
    expect(messageTestIds()).toEqual(['chat-message-201']);

    // Dismissing via Close removes the overlay entirely.
    await fireEvent.press(screen.getByTestId('sample-close'));
    expect(screen.queryByTestId('sample-modal')).toBeNull();
    expect(screen.queryByText('Coach greeting example')).toBeNull();
    expect(screen.getByTestId('composer-input')).toBeOnTheScreen();
  });

  it('shows a retry control only on failed assistant rows (TASK-054)', async () => {
    mockedSessions.listMessages.mockResolvedValue(
      pageOf([
        makeMessage({id: 401, role: 'user', sequence: 1, content: 'Hi'}),
        makeMessage({
          id: 402,
          role: 'assistant',
          status: 'complete',
          sequence: 2,
          content: 'All good.',
        }),
        makeMessage({id: 403, role: 'assistant', status: 'failed', sequence: 3, content: ''}),
      ]),
    );

    await renderChat({sessionId: 5});

    const failedBubble = await screen.findByTestId('chat-message-403');
    expect(within(failedBubble).getByText('The response failed to generate.')).toBeOnTheScreen();
    expect(screen.getByTestId('chat-retry-403')).toBeOnTheScreen();
    expect(
      (screen.getByTestId('chat-retry-403').props.accessibilityState ?? {}).disabled,
    ).toBe(false);
    expect(screen.queryByTestId('chat-retry-401')).toBeNull();
    expect(screen.queryByTestId('chat-retry-402')).toBeNull();
  });

  it('pressing Retry invokes the backend retry for that exact row and re-arms it', async () => {
    mockedSessions.listMessages.mockResolvedValue(
      pageOf([
        makeMessage({id: 901, role: 'user', sequence: 1, content: 'Hello'}),
        makeMessage({id: 902, role: 'assistant', status: 'failed', sequence: 2, content: ''}),
      ]),
    );
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-retry-902')).toBeOnTheScreen());

    // A pending draft proves sending is blocked by the running retry, not
    // by an empty composer.
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Next message');
    await fireEvent.press(screen.getByTestId('chat-retry-902'));

    expect(mockedStreamRetry).toHaveBeenCalledTimes(1);
    expect(mockedStream).not.toHaveBeenCalled();
    expect(turns[0]?.options).toMatchObject({
      token: 'token-a',
      sessionId: 5,
      messageId: 902,
    });
    // The failed row is re-armed locally exactly like the backend does:
    // pending + blank renders as the streaming spinner and the control is
    // gone while the attempt runs.
    await waitFor(() => expect(screen.queryByTestId('chat-retry-902')).toBeNull());
    const bubble = screen.getByTestId('chat-message-902');
    expect(within(bubble).queryByText('The response failed to generate.')).toBeNull();
    expect((screen.getByTestId('chat-send').props.accessibilityState ?? {}).disabled).toBe(true);
  });

  it('streams the replacement into the same row and removes the failure state on completion', async () => {
    mockedSessions.listMessages
      .mockResolvedValueOnce(
        pageOf([
          makeMessage({id: 901, role: 'user', sequence: 1, content: 'Hello'}),
          makeMessage({id: 902, role: 'assistant', status: 'failed', sequence: 2, content: ''}),
        ]),
      )
      .mockResolvedValueOnce(
        pageOf([
          makeMessage({id: 901, role: 'user', sequence: 1, content: 'Hello'}),
          makeMessage({
            id: 902,
            role: 'assistant',
            status: 'complete',
            sequence: 2,
            content: 'A fresh successful answer.',
          }),
        ]),
      );
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-retry-902')).toBeOnTheScreen());

    // A pending draft proves sending is blocked by the running retry, not
    // by an empty composer.
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Next message');
    await fireEvent.press(screen.getByTestId('chat-retry-902'));
    const turn = turns[0];

    // Deltas grow the very same (persisted) row in place.
    await deliver(turn, {type: 'delta', text: 'A fresh '});
    await flushStreamTick();
    expect(screen.getByText('A fresh ')).toBeOnTheScreen();

    await deliver(turn, {
      type: 'completed',
      text: 'A fresh successful answer.',
      model: 'vendor/model',
      deltaCount: 2,
    });
    await waitFor(() => expect(screen.getByText('A fresh successful answer.')).toBeOnTheScreen());
    expect(mockedSessions.listMessages).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('chat-retry-902')).toBeNull();
    expect(screen.queryByTestId('chat-stream-error')).toBeNull();
    // The pending draft from before the retry is sendable again.
    expect((screen.getByTestId('chat-send').props.accessibilityState ?? {}).disabled).toBe(false);
  });

  it('keeps the failure state usable when the retried attempt fails again', async () => {
    mockedSessions.listMessages
      .mockResolvedValueOnce(
        pageOf([
          makeMessage({id: 901, role: 'user', sequence: 1, content: 'Hello'}),
          makeMessage({id: 902, role: 'assistant', status: 'failed', sequence: 2, content: ''}),
        ]),
      )
      .mockResolvedValueOnce(
        pageOf([
          makeMessage({id: 901, role: 'user', sequence: 1, content: 'Hello'}),
          makeMessage({id: 902, role: 'assistant', status: 'failed', sequence: 2, content: ''}),
        ]),
      );
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-retry-902')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('chat-retry-902'));
    await deliver(turns[0], {
      type: 'error',
      message: 'The provider is unavailable right now.',
      retryable: true,
    });

    expect(screen.getByTestId('chat-stream-error')).toHaveTextContent(
      'The provider is unavailable right now.',
    );
    // Server truth restores the still-failed row; the control is available
    // for another attempt.
    await waitFor(() =>
      expect(within(screen.getByTestId('chat-message-902')).getByText('The response failed to generate.')).toBeOnTheScreen(),
    );
    const control = screen.getByTestId('chat-retry-902');
    expect(control.props.accessibilityState?.disabled ?? false).toBe(false);

    await fireEvent.press(control);
    expect(mockedStreamRetry).toHaveBeenCalledTimes(2);
  });

  it('surfaces transport failures of a retry as friendly unreachable errors', async () => {
    mockedSessions.listMessages.mockResolvedValue(
      pageOf([makeMessage({id: 905, role: 'assistant', status: 'failed', sequence: 1})]),
    );
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-retry-905')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('chat-retry-905'));
    await failTransport(turns[0], new ApiError(0, 'Network request failed.'));

    expect(screen.getByTestId('chat-stream-error')).toHaveTextContent(
      /server is unreachable right now/i,
    );
  });

  it('does not start another stream while one is already running', async () => {
    mockedSessions.listMessages.mockResolvedValue(
      pageOf([
        makeMessage({id: 701, role: 'assistant', status: 'failed', sequence: 1}),
        makeMessage({id: 702, role: 'assistant', status: 'failed', sequence: 2}),
      ]),
    );
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-retry-701')).toBeOnTheScreen());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Draft waiting');
    await fireEvent.press(screen.getByTestId('chat-retry-701'));
    expect(mockedStreamRetry).toHaveBeenCalledTimes(1);
    // The retried row re-arms into the spinner; its control is gone…
    expect(screen.queryByTestId('chat-retry-701')).toBeNull();

    // …and the other failed row's control is visible but inert: pressing it
    // cannot start a second stream while one is running.
    const other = screen.getByTestId('chat-retry-702');
    expect((other.props.accessibilityState ?? {}).disabled).toBe(true);
    await fireEvent.press(other);
    expect(mockedStreamRetry).toHaveBeenCalledTimes(1);

    await deliver(turns[0], {type: 'completed', text: 'Recovered.', model: 'm', deltaCount: 1});
    // After completion the untouched row re-enables, the resync restores
    // 701 as still-failed with its control back, and the draft is sendable.
    await waitFor(() =>
      expect((screen.getByTestId('chat-send').props.accessibilityState ?? {}).disabled).toBe(false),
    );
    expect((screen.getByTestId('chat-retry-702').props.accessibilityState ?? {}).disabled).toBe(false);
    expect(screen.getByTestId('chat-retry-701')).toBeOnTheScreen();
  });

  describe('message long-press menu (TASK-060)', () => {
    function visibleMenuActionTestIds(): string[] {
      return screen
        .getAllByTestId(/^chat-menu-/)
        .map(element => element.props.testID as string)
        .filter(testId =>
          /^chat-menu-(suggest-replies|improve-english|select-text|copy|speak)$/.test(testId),
        );
    }

    it('keeps the menu closed until a message is long-pressed', async () => {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([
          makeMessage({id: 801, role: 'user', sequence: 1, content: 'Hi there'}),
          makeMessage({id: 802, role: 'assistant', sequence: 2}),
        ]),
      );
      await renderChat({sessionId: 5});
      await waitFor(() => expect(screen.getByTestId('chat-message-802')).toBeOnTheScreen());

      expect(screen.queryByTestId('chat-menu-modal')).toBeNull();
    });

    it('offers assistant-message actions on long-press without the improvement entry', async () => {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([makeMessage({id: 802, role: 'assistant', sequence: 1})]),
      );
      await renderChat({sessionId: 5});
      await waitFor(() => expect(screen.getByTestId('chat-message-802')).toBeOnTheScreen());

      await fireEvent(screen.getByTestId('chat-message-802'), 'longPress');

      expect(screen.getByTestId('chat-menu-modal')).toBeOnTheScreen();
      expect(visibleMenuActionTestIds()).toEqual([
        'chat-menu-suggest-replies',
        'chat-menu-select-text',
        'chat-menu-copy',
        'chat-menu-speak',
      ]);
    });

    it('offers user-message actions including Improve my English on long-press', async () => {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([makeMessage({id: 801, role: 'user', sequence: 1, content: 'I go to store yesterday.'})]),
      );
      await renderChat({sessionId: 5});
      await waitFor(() => expect(screen.getByTestId('chat-message-801')).toBeOnTheScreen());

      await fireEvent(screen.getByTestId('chat-message-801'), 'longPress');

      expect(visibleMenuActionTestIds()).toEqual([
        'chat-menu-suggest-replies',
        'chat-menu-improve-english',
        'chat-menu-select-text',
        'chat-menu-copy',
        'chat-menu-speak',
      ]);
    });

    it('copies the chosen message and dismisses when Copy is selected', async () => {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([makeMessage({id: 803, role: 'assistant', sequence: 1, content: 'Copy me!'})]),
      );
      await renderChat({sessionId: 5});
      await waitFor(() => expect(screen.getByTestId('chat-message-803')).toBeOnTheScreen());

      await fireEvent(screen.getByTestId('chat-message-803'), 'longPress');
      await fireEvent.press(screen.getByTestId('chat-menu-copy'));

      expect(mockedCopy).toHaveBeenCalledWith('Copy me!');
      expect(screen.queryByTestId('chat-menu-modal')).toBeNull();
    });

    it('dismisses without copying when another action is selected', async () => {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([makeMessage({id: 804, role: 'assistant', sequence: 1})]),
      );
      await renderChat({sessionId: 5});
      await waitFor(() => expect(screen.getByTestId('chat-message-804')).toBeOnTheScreen());

      await fireEvent(screen.getByTestId('chat-message-804'), 'longPress');
      await fireEvent.press(screen.getByTestId('chat-menu-suggest-replies'));

      expect(mockedCopy).not.toHaveBeenCalled();
      expect(screen.queryByTestId('chat-menu-modal')).toBeNull();
    });

    it('dismisses through the menu Close control after a long-press', async () => {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([makeMessage({id: 805, role: 'assistant', sequence: 1})]),
      );
      await renderChat({sessionId: 5});
      await waitFor(() => expect(screen.getByTestId('chat-message-805')).toBeOnTheScreen());

      await fireEvent(screen.getByTestId('chat-message-805'), 'longPress');
      await fireEvent.press(screen.getByTestId('chat-menu-close'));

      expect(screen.queryByTestId('chat-menu-modal')).toBeNull();
      expect(mockedCopy).not.toHaveBeenCalled();
    });

    it('does not open the menu for rows without actionable text', async () => {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([
          makeMessage({
            id: 902,
            role: 'assistant',
            status: 'failed',
            sequence: 1,
            content: '',
          }),
          makeMessage({
            id: 903,
            role: 'assistant',
            status: 'complete',
            sequence: 2,
            content: '   ',
          }),
        ]),
      );
      await renderChat({sessionId: 5});
      await waitFor(() => expect(screen.getByTestId('chat-message-902')).toBeOnTheScreen());

      await fireEvent(screen.getByTestId('chat-message-902'), 'longPress');
      await fireEvent(screen.getByTestId('chat-message-903'), 'longPress');

      expect(screen.queryByTestId('chat-menu-modal')).toBeNull();
    });
  });

  describe('suggestion UI (TASK-061)', () => {
    const REPLIES = ['How about you?', 'That sounds great!', 'Could you explain that?'];

    function renderOneMessage() {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([
          makeMessage({
            id: 801,
            role: 'user',
            sequence: 1,
            content: 'I went to the store yesterday.',
          }),
          makeMessage({
            id: 802,
            role: 'assistant',
            sequence: 2,
            content: 'Nice! What did you buy?',
          }),
        ]),
      );
      return renderChat({sessionId: 5});
    }

    /** Long-press the assistant row and pick Suggest replies from its menu. */
    async function requestSuggestionsForAssistant(): Promise<void> {
      await fireEvent(screen.getByTestId('chat-message-802'), 'longPress');
      await fireEvent.press(screen.getByTestId('chat-menu-suggest-replies'));
    }

    async function expectChips(values: string[]): Promise<void> {
      await waitFor(() => expect(screen.getByTestId('chat-suggestions')).toBeOnTheScreen());
      for (const [index, value] of values.entries()) {
        expect(within(screen.getByTestId(`chat-suggestion-${index}`)).getByText(value)).toBeTruthy();
      }
      expect(screen.queryByTestId(`chat-suggestion-${values.length}`)).toBeNull();
    }

    it('renders no suggestion strip until the menu action requests one', async () => {
      await renderOneMessage();
      await waitFor(() => expect(screen.getByTestId('chat-message-802')).toBeOnTheScreen());

      expect(screen.queryByTestId('chat-suggestions')).toBeNull();
      expect(screen.queryByTestId('chat-suggestions-loading')).toBeNull();
      expect(screen.queryByTestId('chat-suggestions-error')).toBeNull();
      expect(mockedSessions.getMessageSuggestions).not.toHaveBeenCalled();
    });

    it('requests suggestions for the selected message and shows a loading state first', async () => {
      await renderOneMessage();
      await waitFor(() => expect(screen.getByTestId('chat-message-802')).toBeOnTheScreen());
      let resolve!: (value: MessageSuggestions) => void;
      mockedSessions.getMessageSuggestions.mockReturnValueOnce(
        new Promise<MessageSuggestions>(res => {
          resolve = res;
        }),
      );

      await requestSuggestionsForAssistant();

      // The menu dismissed and the read-only endpoint was asked for exactly
      // this conversation + message with the current token.
      expect(screen.queryByTestId('chat-menu-modal')).toBeNull();
      expect(mockedSessions.getMessageSuggestions).toHaveBeenCalledWith('token-a', 5, 802);
      expect(mockedStream).not.toHaveBeenCalled();
      expect(screen.getByTestId('chat-suggestions-loading')).toBeOnTheScreen();

      resolve({replies: REPLIES});
      await expectChips(REPLIES);
      expect(screen.queryByTestId('chat-suggestions-loading')).toBeNull();
    });

    it('inserts a tapped suggestion into the composer without sending it', async () => {
      mockedSessions.getMessageSuggestions.mockResolvedValueOnce({replies: REPLIES});
      await renderOneMessage();
      await waitFor(() => expect(screen.getByTestId('chat-message-802')).toBeOnTheScreen());
      await requestSuggestionsForAssistant();
      await expectChips(REPLIES);

      await fireEvent.press(screen.getByTestId('chat-suggestion-1'));

      // Draft only: nothing streams, the composer carries the reply.
      expect(mockedStream).not.toHaveBeenCalled();
      expect(turns).toHaveLength(0);
      expect(screen.getByTestId('composer-input').props.value).toBe(REPLIES[1]);
      // The strip served its purpose once a suggestion was chosen.
      expect(screen.queryByTestId('chat-suggestions')).toBeNull();
      // The inserted draft makes Send available like any typed text.
      expect(
        (screen.getByTestId('chat-send').props.accessibilityState ?? {}).disabled,
      ).toBe(false);
    });

    it('surfaces suggestion failures as an error state and recovers on retry', async () => {
      await renderOneMessage();
      await waitFor(() => expect(screen.getByTestId('chat-message-802')).toBeOnTheScreen());
      mockedSessions.getMessageSuggestions
        .mockRejectedValueOnce(new ApiError(503, 'Provider temporarily unavailable.'))
        .mockResolvedValueOnce({replies: REPLIES});

      await requestSuggestionsForAssistant();

      const banner = await screen.findByTestId('chat-suggestions-error');
      expect(banner).toHaveTextContent(/server is unreachable right now/i);
      expect(screen.queryByTestId('chat-suggestions')).toBeNull();

      await requestSuggestionsForAssistant();

      await expectChips(REPLIES);
      expect(screen.queryByTestId('chat-suggestions-error')).toBeNull();
    });

    it('replaces displayed suggestions when another message requests new ones', async () => {
      const olderReplies = ['Old A', 'Old B', 'Old C'];
      mockedSessions.getMessageSuggestions
        .mockResolvedValueOnce({replies: olderReplies})
        .mockResolvedValueOnce({replies: REPLIES});
      await renderOneMessage();
      await waitFor(() => expect(screen.getByTestId('chat-message-801')).toBeOnTheScreen());

      await requestSuggestionsForAssistant();
      await expectChips(olderReplies);

      await fireEvent(screen.getByTestId('chat-message-801'), 'longPress');
      await fireEvent.press(screen.getByTestId('chat-menu-suggest-replies'));
      await expectChips(REPLIES);
      expect(screen.queryByText('Old B')).toBeNull();
      expect(mockedSessions.getMessageSuggestions).toHaveBeenLastCalledWith('token-a', 5, 801);
    });

    it('clears the suggestion strip when the user sends a message', async () => {
      mockedSessions.getMessageSuggestions.mockResolvedValueOnce({replies: REPLIES});
      await renderOneMessage();
      await waitFor(() => expect(screen.getByTestId('chat-message-802')).toBeOnTheScreen());
      await requestSuggestionsForAssistant();
      await expectChips(REPLIES);

      await fireEvent.changeText(screen.getByTestId('composer-input'), 'My own message');
      await fireEvent.press(screen.getByTestId('chat-send'));

      expect(mockedStream).toHaveBeenCalledTimes(1);
      // The stale chips are gone; the sent turn renders underneath.
      expect(screen.queryByTestId('chat-suggestions')).toBeNull();
      await waitFor(() =>
        expect(screen.getByText('My own message')).toBeOnTheScreen(),
      );
    });
  });

  describe('improvement UI (TASK-064)', () => {
    const IMPROVEMENT: MessageImprovement = {
      original: 'I go to store yesterday.',
      improved: 'I went to the store yesterday.',
      explanation: 'Use the past tense "went" and add the article "the".',
    };

    function renderOneConversation() {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([
          makeMessage({
            id: 801,
            role: 'user',
            sequence: 1,
            content: 'I go to store yesterday.',
          }),
          makeMessage({
            id: 802,
            role: 'assistant',
            sequence: 2,
            content: 'Nice! What did you buy?',
          }),
        ]),
      );
      return renderChat({sessionId: 5});
    }

    /** Long-press the user row and pick Improve my English from its menu. */
    async function requestImprovementForUserMessage(): Promise<void> {
      await fireEvent(screen.getByTestId('chat-message-801'), 'longPress');
      await fireEvent.press(screen.getByTestId('chat-menu-improve-english'));
    }

    async function expectResultShown(): Promise<void> {
      // Wait on a result-only element: the sheet root is shared by every
      // round-trip state, so waiting on it would not prove completion.
      const original = await screen.findByTestId('chat-improvement-original');
      expect(within(original).getByText(IMPROVEMENT.original)).toBeTruthy();
      expect(
        within(screen.getByTestId('chat-improvement-improved')).getByText(
          IMPROVEMENT.improved,
        ),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId('chat-improvement-explanation')).getByText(
          IMPROVEMENT.explanation,
        ),
      ).toBeTruthy();
      expect(screen.queryByTestId('chat-improvement-loading')).toBeNull();
      expect(screen.queryByTestId('chat-improvement-error')).toBeNull();
    }

    it('renders no improvement sheet until the menu action requests one', async () => {
      await renderOneConversation();
      await waitFor(() => expect(screen.getByTestId('chat-message-801')).toBeOnTheScreen());

      expect(screen.queryByTestId('chat-improvement-modal')).toBeNull();
      expect(mockedSessions.improveMessage).not.toHaveBeenCalled();
    });

    it('requests an improvement for the selected message and shows a loading state first', async () => {
      await renderOneConversation();
      await waitFor(() => expect(screen.getByTestId('chat-message-801')).toBeOnTheScreen());
      let resolve!: (value: MessageImprovement) => void;
      mockedSessions.improveMessage.mockReturnValueOnce(
        new Promise<MessageImprovement>(res => {
          resolve = res;
        }),
      );

      await requestImprovementForUserMessage();

      // The menu dismissed and the read-only endpoint was asked for exactly
      // this conversation + message with the current token.
      expect(screen.queryByTestId('chat-menu-modal')).toBeNull();
      expect(mockedSessions.improveMessage).toHaveBeenCalledWith('token-a', 5, 801);
      expect(mockedStream).not.toHaveBeenCalled();
      expect(screen.getByTestId('chat-improvement-loading')).toBeOnTheScreen();

      resolve(IMPROVEMENT);
      await expectResultShown();
    });

    it('leaves the original chat bubble unchanged while showing the result', async () => {
      mockedSessions.improveMessage.mockResolvedValueOnce(IMPROVEMENT);
      await renderOneConversation();
      await waitFor(() => expect(screen.getByTestId('chat-message-801')).toBeOnTheScreen());
      await requestImprovementForUserMessage();
      await expectResultShown();

      // The conversation itself is untouched: same rows, original text
      // still rendered verbatim in its bubble.
      expect(messageTestIds()).toEqual(['chat-message-801', 'chat-message-802']);
      expect(
        within(screen.getByTestId('chat-message-801')).getByText(IMPROVEMENT.original),
      ).toBeTruthy();
    });

    it('copies the improved version without altering it or the original bubble', async () => {
      mockedSessions.improveMessage.mockResolvedValueOnce(IMPROVEMENT);
      await renderOneConversation();
      await waitFor(() => expect(screen.getByTestId('chat-message-801')).toBeOnTheScreen());
      await requestImprovementForUserMessage();
      await expectResultShown();

      await fireEvent.press(screen.getByTestId('chat-improvement-copy'));

      expect(mockedCopy).toHaveBeenCalledTimes(1);
      expect(mockedCopy).toHaveBeenCalledWith(IMPROVEMENT.improved);
      // The result stays available for re-copying; nothing was dismissed
      // by copying.
      expect(screen.getByTestId('chat-improvement-modal')).toBeOnTheScreen();
    });

    it('surfaces improvement failures as an error state and recovers on retry', async () => {
      await renderOneConversation();
      await waitFor(() => expect(screen.getByTestId('chat-message-801')).toBeOnTheScreen());
      mockedSessions.improveMessage
        .mockRejectedValueOnce(new ApiError(503, 'Provider temporarily unavailable.'))
        .mockResolvedValueOnce(IMPROVEMENT);

      await requestImprovementForUserMessage();

      const banner = await screen.findByTestId('chat-improvement-error');
      expect(banner).toHaveTextContent(/server is unreachable right now/i);
      expect(screen.queryByTestId('chat-improvement-original')).toBeNull();
      expect(mockedCopy).not.toHaveBeenCalled();

      await requestImprovementForUserMessage();

      await expectResultShown();
      expect(screen.queryByTestId('chat-improvement-error')).toBeNull();
    });

    it('dismisses through the Close control and stays closed when a late response lands', async () => {
      await renderOneConversation();
      await waitFor(() => expect(screen.getByTestId('chat-message-801')).toBeOnTheScreen());
      let resolve!: (value: MessageImprovement) => void;
      mockedSessions.improveMessage.mockReturnValueOnce(
        new Promise<MessageImprovement>(res => {
          resolve = res;
        }),
      );

      await requestImprovementForUserMessage();
      expect(screen.getByTestId('chat-improvement-loading')).toBeOnTheScreen();

      await fireEvent.press(screen.getByTestId('chat-improvement-close'));

      expect(screen.queryByTestId('chat-improvement-modal')).toBeNull();
      // The response arriving after dismissal must not reopen the sheet —
      // the explicit close invalidates the in-flight request.
      resolve(IMPROVEMENT);
      await act(async () => {});
      expect(screen.queryByTestId('chat-improvement-modal')).toBeNull();
      expect(screen.queryByTestId('chat-improvement-loading')).toBeNull();
    });

    it('replaces the shown result when another message requests a new improvement', async () => {
      mockedSessions.listMessages.mockResolvedValue(
        pageOf([
          makeMessage({
            id: 801,
            role: 'user',
            sequence: 1,
            content: 'I go to store yesterday.',
          }),
          makeMessage({
            id: 803,
            role: 'user',
            sequence: 2,
            content: "She don't like it.",
          }),
        ]),
      );
      mockedSessions.improveMessage
        .mockResolvedValueOnce(IMPROVEMENT)
        .mockResolvedValueOnce({
          original: "She don't like it.",
          improved: "She doesn't like it.",
          explanation: 'Third-person singular subjects take "does not" in the present tense.',
        });
      await renderChat({sessionId: 5});
      await waitFor(() => expect(screen.getByTestId('chat-message-801')).toBeOnTheScreen());

      await requestImprovementForUserMessage();
      await expectResultShown();

      await fireEvent(screen.getByTestId('chat-message-803'), 'longPress');
      await fireEvent.press(screen.getByTestId('chat-menu-improve-english'));

      const original = await screen.findByTestId('chat-improvement-original');
      expect(within(original).getByText("She don't like it.")).toBeTruthy();
      // The previous result is fully replaced, not appended.
      expect(within(original).queryByText(IMPROVEMENT.improved)).toBeNull();
      expect(mockedSessions.improveMessage).toHaveBeenLastCalledWith('token-a', 5, 803);
    });
  });

  describe('text selection flow (TASK-069)', () => {
    function renderWithMessages(messages: ChatMessage[]) {
      mockedSessions.listMessages.mockResolvedValue(pageOf(messages));
      return renderChat({sessionId: 5});
    }

    async function openSelectionSheet(testId: string): Promise<void> {
      await fireEvent(screen.getByTestId(testId), 'longPress');
      await fireEvent.press(screen.getByTestId('chat-menu-select-text'));
    }

    /** Simulate a native selection span over the pinned input. */
    async function selectRange(start: number, end: number): Promise<void> {
      await fireEvent(
        screen.getByTestId('chat-selection-input'),
        'selectionChange',
        {nativeEvent: {selection: {start, end}}},
      );
    }

    it('renders no selection sheet until Select text is chosen', async () => {
      await renderWithMessages([
        makeMessage({
          id: 810,
          role: 'assistant',
          sequence: 1,
          content: 'The early bird catches the worm.',
        }),
      ]);
      await waitFor(() => expect(screen.getByTestId('chat-message-810')).toBeOnTheScreen());

      expect(screen.queryByTestId('chat-selection-modal')).toBeNull();
      expect(screen.queryByTestId('chat-menu-select-text')).toBeNull();
    });

    it('opens the selection surface over the long-pressed message content', async () => {
      await renderWithMessages([
        makeMessage({
          id: 810,
          role: 'assistant',
          sequence: 1,
          content: 'The early bird catches the worm.',
        }),
      ]);
      await waitFor(() => expect(screen.getByTestId('chat-message-810')).toBeOnTheScreen());

      await openSelectionSheet('chat-message-810');

      // The menu dismissed and the sheet pins exactly this message's text;
      // the conversation itself stays mounted underneath.
      expect(screen.queryByTestId('chat-menu-modal')).toBeNull();
      expect(screen.getByTestId('chat-selection-modal')).toBeOnTheScreen();
      expect(screen.getByTestId('chat-selection-input').props.value).toBe(
        'The early bird catches the worm.',
      );
      expect(messageTestIds()).toEqual(['chat-message-810']);
      expect(screen.getByTestId('composer-input')).toBeOnTheScreen();
    });

    it('works for user messages as well as assistant ones', async () => {
      await renderWithMessages([
        makeMessage({
          id: 811,
          role: 'user',
          sequence: 1,
          content: 'I learned a new phrase today.',
        }),
      ]);
      await waitFor(() => expect(screen.getByTestId('chat-message-811')).toBeOnTheScreen());

      await openSelectionSheet('chat-message-811');

      expect(screen.getByTestId('chat-selection-modal')).toBeOnTheScreen();
      expect(screen.getByTestId('chat-selection-input').props.value).toBe(
        'I learned a new phrase today.',
      );
    });

    it('a confirmed selection closes the sheet and leaves the conversation intact', async () => {
      await renderWithMessages([
        makeMessage({
          id: 810,
          role: 'assistant',
          sequence: 1,
          content: 'The early bird catches the worm.',
        }),
      ]);
      await waitFor(() => expect(screen.getByTestId('chat-message-810')).toBeOnTheScreen());
      await openSelectionSheet('chat-message-810');
      await selectRange(4, 9);
      expect(screen.getByTestId('chat-selection-preview')).toHaveTextContent('early');

      await fireEvent.press(screen.getByTestId('chat-selection-save'));

      // The capture hands the trimmed expression to the save-flow seam
      // (payload proven by the sheet's own unit tests) and dismisses the
      // sheet without disturbing the conversation.
      expect(screen.queryByTestId('chat-selection-modal')).toBeNull();
      expect(messageTestIds()).toEqual(['chat-message-810']);
      expect(screen.queryByTestId('chat-stream-error')).toBeNull();
    });

    it('dismissing through Cancel captures nothing and restores the chat', async () => {
      await renderWithMessages([
        makeMessage({
          id: 810,
          role: 'assistant',
          sequence: 1,
          content: 'The early bird catches the worm.',
        }),
      ]);
      await waitFor(() => expect(screen.getByTestId('chat-message-810')).toBeOnTheScreen());
      await openSelectionSheet('chat-message-810');

      await fireEvent.press(screen.getByTestId('chat-selection-cancel'));

      expect(screen.queryByTestId('chat-selection-modal')).toBeNull();
      expect(messageTestIds()).toEqual(['chat-message-810']);
    });
  });
});
