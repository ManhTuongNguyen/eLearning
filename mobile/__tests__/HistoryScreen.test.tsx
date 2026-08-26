/**
 * History screen tests (SPEC TASK-055): sessions render most-recent-first
 * exactly as delivered, pagination appends further pages through a guarded
 * Load-more control, tapping a session opens its conversation in chat, and
 * loading/empty/error states are all explicit — including retry after a
 * failed first page and failures that never destroy already-visible rows.
 */
import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import * as authApi from '../src/api/auth';
import {ApiError} from '../src/api/client';
import * as sessionsApi from '../src/api/sessions';
import type {ChatMessage, Paginated, Session} from '../src/api/sessions';
import {AuthProvider} from '../src/auth/AuthContext';
import * as secureStorage from '../src/auth/secureStorage';
import type {MainStackParamList} from '../src/navigation/types';
import {ChatScreen} from '../src/screens/ChatScreen';
import {HistoryScreen} from '../src/screens/HistoryScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/api/chatStream');
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedStorage = jest.mocked(secureStorage);

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 42,
    title: 'Traveling',
    topic: 'Favorite destinations and travel plans.',
    topic_hint: '',
    learning_level: 'B1',
    created_at: '2026-08-26T10:00:00Z',
    ...overrides,
  };
}

function sessionPage(
  results: Session[],
  next: string | null = null,
): Paginated<Session> {
  return {count: results.length, next, previous: null, results};
}

function emptyMessagesPage(): Paginated<ChatMessage> {
  return {count: 0, next: null, previous: null, results: []};
}

function renderedItemIds(): number[] {
  return screen
    .queryAllByTestId(/^history-item-/)
    .map(element => element.props.testID as string)
    .map(testId => Number(testId.replace('history-item-', '')));
}

async function renderHistory(options?: {withChatUnderneath?: boolean}) {
  const Stack = createNativeStackNavigator<MainStackParamList>();
  const navigator = (
    <NavigationContainer
      initialState={
        options?.withChatUnderneath
          ? {index: 1, routes: [{name: 'Chat'}, {name: 'History'}]}
          : undefined
      }>
      <Stack.Navigator screenOptions={{headerShown: false}} initialRouteName="History">
        <Stack.Screen name="Chat" component={ChatScreen} />
        <Stack.Screen name="History" component={HistoryScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );

  return render(
    <ThemeProvider>
      <AuthProvider>{navigator}</AuthProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
  // ChatScreen (the tap destination) loads messages and the session detail.
  mockedSessions.listMessages.mockResolvedValue(emptyMessagesPage());
  mockedSessions.getSession.mockResolvedValue(makeSession());
});

describe('HistoryScreen', () => {
  it('shows a loading state, then renders sessions in delivered (most recent first) order', async () => {
    let resolveFirstPage: (page: Paginated<Session>) => void = () => {};
    mockedSessions.listSessions.mockImplementation(
      () =>
        new Promise<Paginated<Session>>(resolve => {
          resolveFirstPage = resolve;
        }),
    );
    await renderHistory();

    expect(await screen.findByTestId('history-loading')).toBeOnTheScreen();

    resolveFirstPage(
      sessionPage([
        makeSession({id: 302, title: 'Latest chat'}),
        makeSession({id: 301, title: 'Middle chat'}),
        makeSession({id: 300, title: 'Oldest chat'}),
      ]),
    );

    await waitFor(() => expect(renderedItemIds()).toEqual([302, 301, 300]));
    expect(screen.getByText('Latest chat')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-loading')).toBeNull();
  });

  it('shows an empty state when the user has no conversations yet', async () => {
    mockedSessions.listSessions.mockResolvedValue(sessionPage([]));
    await renderHistory();

    expect(await screen.findByTestId('history-empty')).toBeOnTheScreen();
    expect(screen.queryAllByTestId(/^history-item-/)).toHaveLength(0);
    expect(screen.queryByTestId('history-load-more')).toBeNull();
  });

  it('surfaces load failures and recovers through Try again', async () => {
    mockedSessions.listSessions
      .mockRejectedValueOnce(new ApiError(0, 'Network request failed.'))
      .mockResolvedValueOnce(sessionPage([makeSession({id: 5, title: 'Recovered'})]));
    await renderHistory();

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'The server is unreachable right now. Please try again later.',
    );
    expect(mockedSessions.listSessions).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('history-retry'));

    await waitFor(() =>
      expect(mockedSessions.listSessions).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText('Recovered')).toBeOnTheScreen();
    expect(screen.queryByTestId('form-error')).toBeNull();
  });

  it('asks the user to sign in again when no access token is available', async () => {
    mockedStorage.loadTokens.mockResolvedValue(null);
    await renderHistory();

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'You need to sign in again to see your history.',
    );
    expect(mockedSessions.listSessions).not.toHaveBeenCalled();
  });

  it('opens the tapped session in chat', async () => {
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 42}), makeSession({id: 43, title: 'Cooking'})]),
    );
    await renderHistory();
    await screen.findByTestId('history-item-43');

    await fireEvent.press(screen.getByTestId('history-item-42'));

    await screen.findByTestId('chat-screen');
    await waitFor(() =>
      expect(mockedSessions.listMessages).toHaveBeenCalledWith('token-a', 42),
    );
  });

  it('appends further pages in order and hides Load more once exhausted', async () => {
    mockedSessions.listSessions
      .mockResolvedValueOnce(
        sessionPage(
          [
            makeSession({id: 12, title: 'Page one A'}),
            makeSession({id: 11, title: 'Page one B'}),
          ],
          'http://api.test/api/v1/sessions/?page=2',
        ),
      )
      .mockResolvedValueOnce(sessionPage([makeSession({id: 10, title: 'Page two A'})]));

    await renderHistory();
    const loadMore = await screen.findByTestId('history-load-more');
    expect(loadMore).toBeOnTheScreen();

    await fireEvent.press(loadMore);

    await waitFor(() =>
      expect(mockedSessions.listSessions).toHaveBeenCalledWith('token-a', 2),
    );
    await waitFor(() => expect(renderedItemIds()).toEqual([12, 11, 10]));
    expect(screen.queryByTestId('history-load-more')).toBeNull();
  });

  it('guards Load more against double-fires while a page is loading', async () => {
    let resolveSecondPage: (page: Paginated<Session>) => void = () => {};
    mockedSessions.listSessions
      .mockResolvedValueOnce(
        sessionPage([makeSession({id: 9})], 'http://api.test/api/v1/sessions/?page=2'),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Paginated<Session>>(resolve => {
            resolveSecondPage = resolve;
          }),
      );

    await renderHistory();
    await screen.findByTestId('history-item-9');

    await fireEvent.press(screen.getByTestId('history-load-more'));
    expect(await screen.findByTestId('history-load-more')).toBeDisabled();

    // Second press while loading must not fire another request.
    await fireEvent.press(screen.getByTestId('history-load-more'));
    expect(mockedSessions.listSessions).toHaveBeenCalledTimes(2);

    // A further page keeps the control; it must be re-enabled after settle.
    resolveSecondPage(
      sessionPage([makeSession({id: 8})], 'http://api.test/api/v1/sessions/?page=3'),
    );
    await waitFor(() => expect(renderedItemIds()).toEqual([9, 8]));
    expect(screen.getByTestId('history-load-more')).toBeEnabled();
  });

  it('keeps loaded rows when loading another page fails', async () => {
    mockedSessions.listSessions
      .mockResolvedValueOnce(
        sessionPage([makeSession({id: 6})], 'http://api.test/api/v1/sessions/?page=2'),
      )
      .mockRejectedValueOnce(new ApiError(500, 'Boom'));

    await renderHistory();
    await screen.findByTestId('history-item-6');

    await fireEvent.press(screen.getByTestId('history-load-more'));

    expect(await screen.findByTestId('form-error')).toBeOnTheScreen();
    expect(renderedItemIds()).toEqual([6]);
    // Rows survive; the control re-enables so the user can try again.
    expect(screen.getByTestId('history-load-more')).toBeEnabled();
  });

  it('dismisses back to the underlying chat via the close control', async () => {
    mockedSessions.listSessions.mockResolvedValue(sessionPage([]));
    await renderHistory({withChatUnderneath: true});

    await screen.findByTestId('history-empty');

    await fireEvent.press(screen.getByTestId('history-back'));

    await waitFor(() => expect(screen.getByTestId('chat-no-session')).toBeOnTheScreen());
  });
});
