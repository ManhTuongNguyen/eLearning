/**
 * History screen tests (SPEC TASK-055/056/057): sessions render
 * most-recent-first exactly as delivered, pagination appends further pages
 * through a guarded Load-more control, tapping a session opens its
 * conversation in chat, and loading/empty/error states are all explicit —
 * including retry after a failed first page and failures that never destroy
 * already-visible rows. Rows also offer an inline rename editor and an
 * inline deletion confirmation; both update local state immediately on
 * success and keep their editors open with a banner on failure.
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
import {Pressable, Text} from 'react-native';

import * as authApi from '../src/api/auth';
import {ApiError} from '../src/api/client';
import * as sessionsApi from '../src/api/sessions';
import type {ChatMessage, Paginated, Session} from '../src/api/sessions';
import {AuthProvider} from '../src/auth/AuthContext';
import {ModeProvider, useApplicationMode} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {setRuntimeApplicationMode} from '../src/mode/runtime';
import {DEFAULT_APPLICATION_MODE} from '../src/mode/types';
import * as secureStorage from '../src/auth/secureStorage';
import type {LocalSession} from '../src/db/types';
import type {MainStackParamList} from '../src/navigation/types';
import {ChatScreen} from '../src/screens/ChatScreen';
import {HistoryScreen} from '../src/screens/HistoryScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/api/chatStream');
jest.mock('../src/auth/secureStorage');

// TASK-090: serverless history goes through the on-device repository seam;
// this mock replaces SQLite entirely so behavior is asserted at the seam.
const mockLocalRepository = {
  listSessions: jest.fn<Promise<LocalSession[]>, []>(),
  renameSession: jest.fn<Promise<void>, [number, string]>(),
  deleteSession: jest.fn<Promise<boolean>, [number]>(),
};

jest.mock('../src/db/conversationRepository', () => ({
  LocalConversationRepository: jest.fn(() => mockLocalRepository),
}));

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

/** TASK-118 harness: flips the application mode from inside the provider. */
function ModeSwitchHarness() {
  const {setMode} = useApplicationMode();
  return (
    <>
      <Pressable
        testID="mode-switch-serverless"
        onPress={() => setMode('serverless')}
      />
      <Pressable testID="mode-switch-server" onPress={() => setMode('server')} />
    </>
  );
}

async function renderHistory(options?: {
  withChatUnderneath?: boolean;
  withModeSwitcher?: boolean;
  withChatBackStub?: boolean;
}) {
  const Stack = createNativeStackNavigator<MainStackParamList>();
  const navigator = (
    <NavigationContainer
      initialState={
        options?.withChatUnderneath
          ? {index: 1, routes: [{name: 'Chat'}, {name: 'History'}]}
          : undefined
      }>
      <Stack.Navigator screenOptions={{headerShown: false}} initialRouteName="History">
        {options?.withChatBackStub ? (
          <Stack.Screen name="Chat">
            {({navigation}) => (
              <Pressable testID="chat-stub-back" onPress={() => navigation.goBack()}>
                <Text>back</Text>
              </Pressable>
            )}
          </Stack.Screen>
        ) : (
          <Stack.Screen name="Chat" component={ChatScreen} />
        )}
        <Stack.Screen name="History" component={HistoryScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );

  return render(
    <ModeProvider>
      <ThemeProvider>
        <AuthProvider>
          {options?.withModeSwitcher ? <ModeSwitchHarness /> : null}
          {navigator}
        </AuthProvider>
      </ThemeProvider>
    </ModeProvider>,
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  // Server-flow journeys: pin the persisted mode because fresh installs
  // now default to serverless.
  await saveApplicationMode('server');
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
    // TASK-AUDIT-005: the screen hands the central authed requester to the
    // binding; signed out, the wrapper rejects before any transport work —
    // simulated here with the exact rejection the wrapper produces.
    mockedSessions.listSessions.mockRejectedValue(
      new ApiError(401, 'You are signed out. Please log in again.', {}, 'authentication'),
    );
    await renderHistory();

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'You are signed out. Please log in again.',
    );
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
      expect(mockedSessions.listMessages).toHaveBeenCalledWith(expect.any(Function), 42),
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
      expect(mockedSessions.listSessions).toHaveBeenCalledWith(expect.any(Function), 2),
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

  it('refreshes from the authoritative source when returning to a mounted History (TASK-AUDIT-008)', async () => {
    let resolveRefresh: (page: Paginated<Session>) => void = () => {};
    mockedSessions.listSessions
      .mockResolvedValueOnce(sessionPage([makeSession({id: 42})]))
      .mockImplementationOnce(
        () =>
          new Promise<Paginated<Session>>(resolve => {
            resolveRefresh = resolve;
          }),
      );
    await renderHistory({withChatBackStub: true});

    await screen.findByTestId('history-item-42');

    // Leave to chat and return; the focus event triggers a silent refresh.
    await fireEvent.press(screen.getByTestId('history-item-42'));
    await screen.findByTestId('chat-stub-back');
    await fireEvent.press(screen.getByTestId('chat-stub-back'));

    // The silent refresh never wipes the visible rows behind a spinner.
    expect(await screen.findByTestId('history-item-42')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-loading')).toBeNull();

    resolveRefresh(
      sessionPage([makeSession({id: 43, title: 'Brand new'}), makeSession({id: 42})]),
    );

    // The authoritative page replaces the visible list in place.
    await waitFor(() => expect(renderedItemIds()).toEqual([43, 42]));
    expect(mockedSessions.listSessions).toHaveBeenCalledTimes(2);
  });

  it('keeps visible rows and the empty truth when the returning refresh fails (TASK-AUDIT-008)', async () => {
    mockedSessions.listSessions
      .mockResolvedValueOnce(sessionPage([makeSession({id: 42})]))
      .mockRejectedValueOnce(new ApiError(0, 'Network request failed.'));
    await renderHistory({withChatBackStub: true});

    await screen.findByTestId('history-item-42');
    await fireEvent.press(screen.getByTestId('history-item-42'));
    await screen.findByTestId('chat-stub-back');
    await fireEvent.press(screen.getByTestId('chat-stub-back'));

    // Rows survive the failed silent refresh — no false empty claim.
    expect(await screen.findByTestId('history-item-42')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-empty')).toBeNull();
    expect(screen.queryByTestId('history-loading')).toBeNull();
  });
});

describe('HistoryScreen rename (TASK-056)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
    mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
    mockedSessions.listMessages.mockResolvedValue(emptyMessagesPage());
    mockedSessions.getSession.mockResolvedValue(makeSession());
  });

  it('persists the new title and reflects it immediately without refetching the list', async () => {
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 42, title: 'Traveling'})]),
    );
    mockedSessions.renameSession.mockResolvedValue(makeSession({id: 42, title: 'Trips abroad'}));
    await renderHistory();
    await screen.findByTestId('history-item-42');

    await fireEvent.press(screen.getByTestId('history-rename-42'));

    const input = await screen.findByTestId('history-rename-input');
    expect(input.props.value).toBe('Traveling');

    await fireEvent.changeText(input, 'Trips in Europe');
    await fireEvent.press(screen.getByTestId('history-rename-save'));

    await waitFor(() =>
      expect(mockedSessions.renameSession).toHaveBeenCalledWith(expect.any(Function), 42, 'Trips in Europe'),
    );
    // The row swaps to the authoritative response; the editor closes.
    expect(await screen.findByText('Trips abroad')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-rename-input')).toBeNull();
    expect(screen.queryByTestId('form-error')).toBeNull();
    // Immediate local update — the list was NOT reloaded.
    expect(mockedSessions.listSessions).toHaveBeenCalledTimes(1);
  });

  it('discards the edit and keeps the original title when cancelled', async () => {
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 7, title: 'Cooking'})]),
    );
    await renderHistory();
    await screen.findByTestId('history-item-7');

    await fireEvent.press(screen.getByTestId('history-rename-7'));
    const input = await screen.findByTestId('history-rename-input');
    await fireEvent.changeText(input, 'Baking');

    await fireEvent.press(screen.getByTestId('history-rename-cancel'));

    expect(await screen.findByTestId('history-item-7')).toBeOnTheScreen();
    expect(screen.getByText('Cooking')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-rename-input')).toBeNull();
    expect(mockedSessions.renameSession).not.toHaveBeenCalled();
  });

  it('explains failures, keeps the editor open, and succeeds on retry', async () => {
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 9, title: 'Movies'})]),
    );
    mockedSessions.renameSession
      .mockRejectedValueOnce(new ApiError(500, 'Boom'))
      .mockResolvedValueOnce(makeSession({id: 9, title: 'Films'}));
    await renderHistory();
    await screen.findByTestId('history-item-9');

    await fireEvent.press(screen.getByTestId('history-rename-9'));
    const input = await screen.findByTestId('history-rename-input');
    await fireEvent.changeText(input, 'Films');
    await fireEvent.press(screen.getByTestId('history-rename-save'));

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'The server is unreachable right now. Please try again later.',
    );
    // Editor stays open with the draft intact for another attempt.
    const retryInput = await screen.findByTestId('history-rename-input');
    expect(retryInput.props.value).toBe('Films');

    await fireEvent.press(screen.getByTestId('history-rename-save'));

    await waitFor(() => expect(mockedSessions.renameSession).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Films')).toBeOnTheScreen();
    expect(screen.queryByTestId('form-error')).toBeNull();
    expect(screen.queryByTestId('history-rename-input')).toBeNull();
  });

  it('disables Save while the name is blank and re-enables it once text exists', async () => {
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 5, title: 'Weekend plans'})]),
    );
    await renderHistory();
    await screen.findByTestId('history-item-5');

    await fireEvent.press(screen.getByTestId('history-rename-5'));

    const input = await screen.findByTestId('history-rename-input');
    expect(await screen.findByTestId('history-rename-save')).toBeEnabled();

    await fireEvent.changeText(input, '   ');
    expect(screen.getByTestId('history-rename-save')).toBeDisabled();

    await fireEvent.changeText(input, 'New plan');
    expect(screen.getByTestId('history-rename-save')).toBeEnabled();
    expect(mockedSessions.renameSession).not.toHaveBeenCalled();
  });

  it('guards Save against double-fires while a rename request is in flight', async () => {
    let resolveRename: (session: Session) => void = () => {};
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 3, title: 'Music'})]),
    );
    mockedSessions.renameSession.mockImplementationOnce(
      () =>
        new Promise<Session>(resolve => {
          resolveRename = resolve;
        }),
    );
    await renderHistory();
    await screen.findByTestId('history-item-3');

    await fireEvent.press(screen.getByTestId('history-rename-3'));
    const input = await screen.findByTestId('history-rename-input');
    await fireEvent.changeText(input, 'Concerts');

    await fireEvent.press(screen.getByTestId('history-rename-save'));

    const save = await screen.findByTestId('history-rename-save');
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('Saving…');
    expect(screen.getByTestId('history-rename-cancel')).toBeDisabled();

    await fireEvent.press(save);
    expect(mockedSessions.renameSession).toHaveBeenCalledTimes(1);

    resolveRename(makeSession({id: 3, title: 'Concerts'}));
    await waitFor(() => expect(screen.queryByTestId('history-rename-input')).toBeNull());
    expect(screen.getByText('Concerts')).toBeOnTheScreen();
  });
});

describe('HistoryScreen delete (TASK-057)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
    mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
    mockedSessions.listMessages.mockResolvedValue(emptyMessagesPage());
    mockedSessions.getSession.mockResolvedValue(makeSession());
  });

  it('asks for confirmation, then removes the session immediately without refetching', async () => {
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 42, title: 'Traveling'}), makeSession({id: 43, title: 'Cooking'})]),
    );
    mockedSessions.deleteSession.mockResolvedValue(undefined);
    await renderHistory();
    await screen.findByTestId('history-item-42');

    await fireEvent.press(screen.getByTestId('history-delete-42'));

    expect(await screen.findByTestId('history-confirm-42')).toBeOnTheScreen();
    expect(screen.getByTestId('history-delete-confirm')).toBeOnTheScreen();
    expect(screen.getByTestId('history-delete-cancel')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('history-delete-confirm'));

    await waitFor(() =>
      expect(mockedSessions.deleteSession).toHaveBeenCalledWith(expect.any(Function), 42),
    );
    // The row vanishes from the list right away; the other row survives.
    await waitFor(() => expect(renderedItemIds()).toEqual([43]));
    expect(screen.queryByTestId('history-confirm-42')).toBeNull();
    expect(screen.queryByTestId('form-error')).toBeNull();
    // Immediate local update — the list was NOT reloaded.
    expect(mockedSessions.listSessions).toHaveBeenCalledTimes(1);
  });

  it('keeps the conversation and makes no API call when confirmation is cancelled', async () => {
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 7, title: 'Cooking'})]),
    );
    await renderHistory();
    await screen.findByTestId('history-item-7');

    await fireEvent.press(screen.getByTestId('history-delete-7'));
    expect(await screen.findByTestId('history-confirm-7')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('history-delete-cancel'));

    expect(await screen.findByTestId('history-item-7')).toBeOnTheScreen();
    expect(screen.getByText('Cooking')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-confirm-7')).toBeNull();
    expect(mockedSessions.deleteSession).not.toHaveBeenCalled();
  });

  it('explains failures, keeps the confirmation open, and succeeds on retry', async () => {
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 9, title: 'Movies'})]),
    );
    mockedSessions.deleteSession
      .mockRejectedValueOnce(new ApiError(500, 'Boom'))
      .mockResolvedValueOnce(undefined);
    await renderHistory();
    await screen.findByTestId('history-item-9');

    await fireEvent.press(screen.getByTestId('history-delete-9'));
    await screen.findByTestId('history-confirm-9');
    await fireEvent.press(screen.getByTestId('history-delete-confirm'));

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'The server is unreachable right now. Please try again later.',
    );
    // The failed conversation keeps its confirmation open for another try
    // (the row renders as the confirm variant until deletion succeeds).
    expect(screen.getByTestId('history-confirm-9')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-item-9')).toBeNull();

    await fireEvent.press(screen.getByTestId('history-delete-confirm'));

    await waitFor(() => expect(mockedSessions.deleteSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('history-confirm-9')).toBeNull());
    expect(screen.queryByTestId('history-item-9')).toBeNull();
    expect(screen.queryByTestId('form-error')).toBeNull();
  });

  it('guards Confirm against double-fires while a delete request is in flight', async () => {
    let resolveDelete: () => void = () => {};
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 3, title: 'Music'})]),
    );
    mockedSessions.deleteSession.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveDelete = resolve;
        }),
    );
    await renderHistory();
    await screen.findByTestId('history-item-3');

    await fireEvent.press(screen.getByTestId('history-delete-3'));
    await screen.findByTestId('history-confirm-3');
    await fireEvent.press(screen.getByTestId('history-delete-confirm'));

    const confirm = await screen.findByTestId('history-delete-confirm');
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveTextContent('Deleting…');
    expect(screen.getByTestId('history-delete-cancel')).toBeDisabled();

    // Second press while deleting must not fire another request.
    await fireEvent.press(confirm);
    expect(mockedSessions.deleteSession).toHaveBeenCalledTimes(1);

    resolveDelete();
    // history-item-3 is already absent while the confirm step is open —
    // completion is observable only through the confirm card disappearing.
    await waitFor(() => expect(screen.queryByTestId('history-confirm-3')).toBeNull());
    expect(screen.queryByTestId('history-item-3')).toBeNull();
  });

  it('returns to the empty state when the last conversation is deleted', async () => {
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 5, title: 'Weekend plans'})]),
    );
    mockedSessions.deleteSession.mockResolvedValue(undefined);
    await renderHistory();
    await screen.findByTestId('history-item-5');

    await fireEvent.press(screen.getByTestId('history-delete-5'));
    await fireEvent.press(await screen.findByTestId('history-delete-confirm'));

    expect(await screen.findByTestId('history-empty')).toBeOnTheScreen();
    expect(screen.queryAllByTestId(/^history-item-/)).toHaveLength(0);
    expect(mockedSessions.deleteSession).toHaveBeenCalledWith(expect.any(Function), 5);
  });
});

describe('HistoryScreen serverless (TASK-090)', () => {
  function makeLocalSession(overrides: Partial<LocalSession> = {}): LocalSession {
    return {
      id: 42,
      title: 'Traveling',
      topic: 'Favorite destinations and travel plans.',
      topic_hint: '',
      learning_level: 'B1',
      created_at: '2026-08-26T10:00:00Z',
      updated_at: '2026-08-26T10:30:00Z',
      ...overrides,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    // Persist serverless mode BEFORE render so ModeProvider restores it —
    // the screen must not touch either backend until the mode is ready.
    await saveApplicationMode('serverless');
    mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
    mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
  });

  afterEach(async () => {
    setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
    await saveApplicationMode(DEFAULT_APPLICATION_MODE);
  });

  it('lists on-device conversations through the local repository without any server call', async () => {
    mockLocalRepository.listSessions.mockResolvedValue([
      makeLocalSession({id: 303, title: 'Latest local chat'}),
      makeLocalSession({id: 301, title: 'Older local chat'}),
    ]);
    await renderHistory();

    await waitFor(() => expect(renderedItemIds()).toEqual([303, 301]));
    expect(mockLocalRepository.listSessions).toHaveBeenCalledTimes(1);
    expect(mockedSessions.listSessions).not.toHaveBeenCalled();
    // Local rows arrive in one shot — no pagination control.
    expect(screen.queryByTestId('history-load-more')).toBeNull();
  });

  it('shows the empty state when no local conversations exist', async () => {
    mockLocalRepository.listSessions.mockResolvedValue([]);
    await renderHistory();

    expect(await screen.findByTestId('history-empty')).toBeOnTheScreen();
    expect(mockedSessions.listSessions).not.toHaveBeenCalled();
  });

  it('surfaces local load failures and recovers through Try again', async () => {
    mockLocalRepository.listSessions
      .mockRejectedValueOnce(new Error('sqlite unavailable'))
      .mockResolvedValueOnce([makeLocalSession({id: 7, title: 'Recovered locally'})]);
    await renderHistory();

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'sqlite unavailable',
    );

    await fireEvent.press(screen.getByTestId('history-retry'));

    expect(await screen.findByText('Recovered locally')).toBeOnTheScreen();
    expect(screen.queryByTestId('form-error')).toBeNull();
    expect(mockLocalRepository.listSessions).toHaveBeenCalledTimes(2);
    expect(mockedSessions.listSessions).not.toHaveBeenCalled();
  });

  it('persists renames through the local repository and updates the row immediately', async () => {
    mockLocalRepository.listSessions.mockResolvedValue([
      makeLocalSession({id: 42, title: 'Traveling'}),
    ]);
    mockLocalRepository.renameSession.mockResolvedValue(undefined);
    await renderHistory();
    await screen.findByTestId('history-item-42');

    await fireEvent.press(screen.getByTestId('history-rename-42'));
    const input = await screen.findByTestId('history-rename-input');
    await fireEvent.changeText(input, 'Trips abroad');
    await fireEvent.press(screen.getByTestId('history-rename-save'));

    await waitFor(() =>
      expect(mockLocalRepository.renameSession).toHaveBeenCalledWith(42, 'Trips abroad'),
    );
    expect(await screen.findByText('Trips abroad')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-rename-input')).toBeNull();
    expect(screen.queryByTestId('form-error')).toBeNull();
    // Immediate update — the list was NOT reloaded.
    expect(mockLocalRepository.listSessions).toHaveBeenCalledTimes(1);
    // The rename never reaches the backend in serverless mode.
    expect(mockedSessions.renameSession).not.toHaveBeenCalled();
  });

  it('deletes conversations through the local repository after confirmation', async () => {
    mockLocalRepository.listSessions.mockResolvedValue([
      makeLocalSession({id: 42, title: 'Traveling'}),
      makeLocalSession({id: 43, title: 'Cooking'}),
    ]);
    mockLocalRepository.deleteSession.mockResolvedValue(true);
    await renderHistory();
    await screen.findByTestId('history-item-43');

    await fireEvent.press(screen.getByTestId('history-delete-42'));
    await fireEvent.press(await screen.findByTestId('history-delete-confirm'));

    await waitFor(() =>
      expect(mockLocalRepository.deleteSession).toHaveBeenCalledWith(42),
    );
    await waitFor(() => expect(renderedItemIds()).toEqual([43]));
    expect(screen.queryByTestId('form-error')).toBeNull();
    expect(mockedSessions.deleteSession).not.toHaveBeenCalled();
  });

  // TASK-118: server history and serverless history are disjoint stores —
  // switching modes swaps the visible list between them without any
  // cross-mode fetch, so neither store is ever shown through the other.
  it('shows server and serverless histories as disjoint lists when switching modes', async () => {
    // Start in server mode: the beforeEach persisted serverless, so this
    // test overrides the stored choice before the provider restores it.
    await saveApplicationMode('server');
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 11, title: 'Server chat'})]),
    );
    mockLocalRepository.listSessions.mockResolvedValue([
      makeLocalSession({id: 303, title: 'Local chat'}),
    ]);

    await renderHistory({withModeSwitcher: true});
    await screen.findByTestId('history-item-11');
    expect(mockedSessions.listSessions).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('mode-switch-serverless'));
    await screen.findByTestId('history-item-303');
    // Server rows are replaced by local rows — never shown together.
    expect(screen.queryByTestId('history-item-11')).toBeNull();
    // The swap re-reads local data only; the backend is not fetched again.
    expect(mockedSessions.listSessions).toHaveBeenCalledTimes(1);
    expect(mockLocalRepository.listSessions).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('mode-switch-server'));
    await screen.findByTestId('history-item-11');
    // Switching back restores the server list without touching local data.
    expect(screen.queryByTestId('history-item-303')).toBeNull();
    expect(mockLocalRepository.listSessions).toHaveBeenCalledTimes(1);
  });
});
