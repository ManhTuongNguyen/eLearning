/**
 * Streaming render-profile tests (SPEC TASK-103).
 *
 * Profiling seam: ChatScreen renders every chat row through the MessageRow
 * module, so the test swaps that module for a counting wrapper that is
 * memoized EXACTLY like the real component (React.memo, identical props)
 * and delegates to it. Because the wrapper bails out on precisely the same
 * shallow prop comparison as the real row, its invocation count equals the
 * number of times a row actually re-rendered — React.memo bailouts never
 * invoke the wrapped function. (React.Profiler.onRender is unusable here:
 * it fires even when the whole subtree bails out.)
 *
 * The profile: a loaded conversation streams an assistant turn; between
 * flush ticks the only row allowed to re-render is the streaming bubble.
 * Every untouched row must keep stable prop identities and bail out. The
 * large-list case profiles the same behavior through the failed-response
 * retry pipeline (TASK-054) on a long preloaded conversation.
 */
import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import {streamChatTurn, streamRetryTurn} from '../src/api/chatStream';
import type {
  ChatStreamEvent,
  StreamChatTurnOptions,
  StreamRetryTurnOptions,
} from '../src/api/chatStream';
import * as authApi from '../src/api/auth';
import * as sessionsApi from '../src/api/sessions';
import type {ChatMessage, Paginated, Session} from '../src/api/sessions';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import type {MainStackParamList} from '../src/navigation/types';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {ChatScreen} from '../src/screens/ChatScreen';
import {
  CHAT_LIST_INITIAL_NUM_TO_RENDER,
  STREAM_FLUSH_INTERVAL_MS,
} from '../src/screens/streamingUx';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/api/chatStream');
jest.mock('../src/auth/secureStorage');

/**
 * Per-row render counters, written by the mock factory below and read by
 * the tests. Lives outside the factory's closure through the `mock`
 * prefix so the hoisted factory may reference it.
 */
const mockRenderCounts = new Map<string, number>();

jest.mock('../src/screens/MessageRow', () => {
  const react = require('react');
  const actual = jest.requireActual('../src/screens/MessageRow');
  const ActualRow = actual.MessageRow;
  // MUST stay memoized in sync with the real MessageRow: the wrapper bails
  // out on the same shallow prop comparison, so invocations == renders.
  const CountingRow = react.memo(function CountingRow(props: {item: {id: number}}) {
    const key = String(props.item.id);
    mockRenderCounts.set(key, (mockRenderCounts.get(key) ?? 0) + 1);
    return react.createElement(ActualRow, props);
  });
  return {
    __esModule: true,
    MessageRow: CountingRow,
    createRowStyles: actual.createRowStyles,
  };
});

const mockedAuth = jest.mocked(authApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedStorage = jest.mocked(secureStorage);
const mockedStream = jest.mocked(streamChatTurn);
const mockedStreamRetry = jest.mocked(streamRetryTurn);

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

/** A conversation with `count` preloaded rows. */
function preloadConversation(count: number, failedId?: number): ChatMessage[] {
  return Array.from({length: count}, (_, index) =>
    makeMessage({
      id: 1000 + index,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content:
        failedId === 1000 + index
          ? ''
          : `Loaded message number ${index + 1} with some padding text.`,
      status: failedId === 1000 + index ? 'failed' : 'complete',
      sequence: index + 1,
    }),
  );
}

function pageOf(results: ChatMessage[]): Paginated<ChatMessage> {
  return {count: results.length, next: null, previous: null, results};
}

function makeSession(): Session {
  return {
    id: 5,
    title: 'Traveling',
    topic: 'Talking about favorite destinations, transport and travel plans.',
    topic_hint: '',
    learning_level: 'B1',
    created_at: '2026-08-26T10:00:00Z',
  };
}

function mountedMessageIds(): string[] {
  return screen
    .queryAllByTestId(/^chat-message-/)
    .map(element => element.props.testID as string)
    .map(testId => testId.replace('chat-message-', ''));
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
              <Stack.Screen name="NewConversation">{() => null}</Stack.Screen>
              <Stack.Screen name="History">{() => null}</Stack.Screen>
              <Stack.Screen name="Settings">{() => null}</Stack.Screen>
              <Stack.Screen name="Level">{() => null}</Stack.Screen>
            </Stack.Navigator>
          </NavigationContainer>
        </AuthProvider>
      </ThemeProvider>
    </ModeProvider>,
  );
}

/** Push one SSE application event through the captured turn's callback. */
async function deliver(turn: CapturedTurn, event: ChatStreamEvent): Promise<void> {
  await act(async () => {
    turn.options.onEvent(event);
  });
}

/** Let the TASK-050 delta buffer's deferred flush tick elapse inside act. */
async function flushStreamTick(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve =>
      setTimeout(() => resolve(), STREAM_FLUSH_INTERVAL_MS + 20),
    );
  });
}

function resetRenderCounts(): void {
  mockRenderCounts.clear();
}

function renderCountOf(rowId: string | number): number {
  return mockRenderCounts.get(String(rowId)) ?? 0;
}

beforeEach(async () => {
  jest.clearAllMocks();
  // Server-flow journeys: pin the persisted mode because fresh installs
  // now default to serverless.
  await saveApplicationMode('server');
  mockRenderCounts.clear();
  mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
  mockedSessions.getSession.mockResolvedValue(makeSession());
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

describe('streaming render profile (TASK-103)', () => {
  it('re-renders only the streaming bubble per flush tick; untouched rows bail out', async () => {
    // Eight preloaded rows keep the optimistic echo + pending bubble inside
    // the FlatList initial render window so the streamed bubble is mounted.
    mockedSessions.listMessages.mockResolvedValue(pageOf(preloadConversation(8)));
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    // Initial mount counts once per rendered row; reset so the profile
    // below measures only streaming-driven re-renders.
    resetRenderCounts();

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Hello there');
    await fireEvent.press(screen.getByTestId('chat-send'));

    // The optimistic echo + pending bubble mount here (once each); reset
    // again so the profile isolates delta-flush re-renders.
    resetRenderCounts();
    const turn = turns[0];
    expect(turn).toBeDefined();

    await deliver(turn, {type: 'start', model: 'vendor/model'});
    await deliver(turn, {type: 'delta', text: 'Hello'});
    await flushStreamTick();

    // The bubble content landed exactly once per flush.
    expect(screen.getByText('Hello')).toBeOnTheScreen();
    // The optimistic echo (more positive) precedes the pending reply bubble
    // (more negative); the reply is the last optimistic row in DOM order.
    const optimisticIds = mountedMessageIds().filter(id => id.startsWith('-'));
    const replyRowId = optimisticIds[optimisticIds.length - 1];
    expect(replyRowId).toBeDefined();

    // TARGET: exactly one row re-rendered for this flush — the streaming
    // bubble, exactly once. Every other mounted row must have bailed out.
    expect(mockRenderCounts.size).toBe(1);
    expect(renderCountOf(replyRowId ?? '')).toBe(1);

    // A second flush behaves the same: still only the streaming bubble.
    resetRenderCounts();
    await deliver(turn, {type: 'delta', text: ', how are you?'});
    await flushStreamTick();
    expect(screen.getByText('Hello, how are you?')).toBeOnTheScreen();
    expect(mockRenderCounts.size).toBe(1);
    expect(renderCountOf(replyRowId ?? '')).toBe(1);
  });

  it('keeps a long conversation bounded and streams retry deltas into one row', async () => {
    // 60 preloaded rows: far beyond the initial render window, so only a
    // bounded slice mounts. The failed row sits inside that slice and is
    // retried so streaming renders land on an already-mounted bubble.
    mockedSessions.listMessages.mockResolvedValue(
      pageOf(preloadConversation(60, 1003)),
    );
    await renderChat({sessionId: 5});
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeOnTheScreen());

    // Large-list usability: mounting stays bounded by the initial render
    // window instead of laying out the whole conversation.
    expect(mountedMessageIds().length).toBeLessThanOrEqual(
      CHAT_LIST_INITIAL_NUM_TO_RENDER,
    );
    expect(mountedMessageIds().length).toBeLessThan(60);

    const failedRowId = '1003';
    await fireEvent.press(screen.getByTestId(`chat-retry-${failedRowId}`));
    const turn = turns[0];
    expect(turn).toBeDefined();

    // The retry re-arms the row (pending spinner) and flips the streaming
    // flag; let that settle, then profile only the delta flushes.
    await flushStreamTick();
    resetRenderCounts();

    await deliver(turn, {type: 'delta', text: 'Well'});
    await flushStreamTick();
    expect(screen.getByText('Well')).toBeOnTheScreen();

    // TARGET: only the retried bubble re-rendered for this flush.
    expect(mockRenderCounts.size).toBe(1);
    expect(renderCountOf(failedRowId)).toBe(1);
  });
});
