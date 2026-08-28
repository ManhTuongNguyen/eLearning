/**
 * New conversation screen tests (SPEC TASK-051): optional topic hint, Start,
 * Let-AI-choose, empty-input behavior, navigation into Chat with the created
 * session id, loading/disabled state while creating, error banner + retry
 * readiness, and the cancel/back dismissal. Also covers the TASK-053 hand-
 * off: the creation response's sample conversation rides into Chat as a
 * route param and powers the example overlay.
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
import type {
  ChatMessage,
  CreatedSession,
  Paginated,
  SampleTurn,
  Session,
} from '../src/api/sessions';
import {AuthProvider} from '../src/auth/AuthContext';
import {ModeProvider} from '../src/mode/ModeContext';
import * as secureStorage from '../src/auth/secureStorage';
import type {MainStackParamList} from '../src/navigation/types';
import {ChatScreen} from '../src/screens/ChatScreen';
import {NewConversationScreen} from '../src/screens/NewConversationScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/auth/secureStorage');

const mockedAuth = jest.mocked(authApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedStorage = jest.mocked(secureStorage);

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 42,
    title: 'New conversation',
    topic: 'Favorite travel destinations',
    topic_hint: '',
    learning_level: 'B1',
    created_at: '2026-08-26T10:00:00Z',
    ...overrides,
  };
}

function makeCreatedSession(
  sampleTurns?: SampleTurn[],
  overrides: Partial<Session> = {},
): CreatedSession {
  const session: CreatedSession = makeSession(overrides);
  if (sampleTurns !== undefined) {
    session.sample_conversation = {turns: sampleTurns};
  }
  return session;
}

function emptyMessagesPage(): Paginated<ChatMessage> {
  return {count: 0, next: null, previous: null, results: []};
}

async function renderScreen() {
  const Stack = createNativeStackNavigator<MainStackParamList>();
  return render(
    <ModeProvider>
      <ThemeProvider>
        <AuthProvider>
          <NavigationContainer>
            <Stack.Navigator screenOptions={{headerShown: false}} initialRouteName="NewConversation">
              <Stack.Screen name="Chat" component={ChatScreen} />
              <Stack.Screen name="NewConversation" component={NewConversationScreen} />
            </Stack.Navigator>
          </NavigationContainer>
        </AuthProvider>
      </ThemeProvider>
    </ModeProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
  mockedSessions.listMessages.mockResolvedValue(emptyMessagesPage());
  // ChatScreen (the post-create destination) fetches the session detail for
  // its topic bar.
  mockedSessions.getSession.mockResolvedValue(makeSession());
});

describe('NewConversationScreen', () => {
  it('renders the hint input, both start actions and the cancel control', async () => {
    await renderScreen();

    expect(await screen.findByTestId('new-conversation-screen')).toBeOnTheScreen();
    expect(screen.getByTestId('new-conversation-hint')).toBeOnTheScreen();
    expect(screen.getByTestId('new-conversation-start')).toBeOnTheScreen();
    expect(screen.getByTestId('new-conversation-auto')).toBeOnTheScreen();
    expect(screen.getByTestId('new-conversation-back')).toBeOnTheScreen();
  });

  it('starts a conversation with the typed hint and opens chat for the created session', async () => {
    mockedSessions.createSession.mockResolvedValue(makeSession({topic_hint: 'Traveling'}));
    await renderScreen();

    await fireEvent.changeText(screen.getByTestId('new-conversation-hint'), 'Traveling');
    await fireEvent.press(screen.getByTestId('new-conversation-start'));

    await waitFor(() =>
      expect(mockedSessions.createSession).toHaveBeenCalledWith(expect.any(Function), 'Traveling'),
    );
    // The stack swapped to Chat carrying the new session id.
    await screen.findByTestId('chat-screen');
    expect(mockedSessions.listMessages).toHaveBeenCalledWith(expect.any(Function), 42);
  });

  it('creates a session when Start is pressed with an untouched (empty) input', async () => {
    mockedSessions.createSession.mockResolvedValue(makeSession({id: 7}));
    await renderScreen();
    await screen.findByTestId('new-conversation-screen');

    await fireEvent.press(screen.getByTestId('new-conversation-start'));

    await waitFor(() => expect(mockedSessions.createSession).toHaveBeenCalledWith(expect.any(Function), ''));
    await screen.findByTestId('chat-screen');
    expect(mockedSessions.listMessages).toHaveBeenCalledWith(expect.any(Function), 7);
  });

  it('lets AI choose a topic even when a hint has been typed', async () => {
    mockedSessions.createSession.mockResolvedValue(makeSession({id: 9, topic_hint: ''}));
    await renderScreen();
    await screen.findByTestId('new-conversation-screen');

    await fireEvent.changeText(screen.getByTestId('new-conversation-hint'), 'Cooking');
    await fireEvent.press(screen.getByTestId('new-conversation-auto'));

    await waitFor(() => expect(mockedSessions.createSession).toHaveBeenCalledWith(expect.any(Function), ''));
    await screen.findByTestId('chat-screen');
    expect(mockedSessions.listMessages).toHaveBeenCalledWith(expect.any(Function), 9);
  });

  it('shows an inline error and stays on the form when creation fails', async () => {
    mockedSessions.createSession.mockRejectedValue(
      new ApiError(400, 'Topic hint is too long.'),
    );
    await renderScreen();
    await screen.findByTestId('new-conversation-screen');

    await fireEvent.press(screen.getByTestId('new-conversation-auto'));

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'Topic hint is too long.',
    );
    expect(screen.getByTestId('new-conversation-screen')).toBeOnTheScreen();
    expect(screen.queryByTestId('chat-loading')).toBeNull();
    // The form recovers: both actions are enabled again for a retry.
    expect(screen.getByTestId('new-conversation-start')).toBeEnabled();
    expect(screen.getByTestId('new-conversation-auto')).toBeEnabled();
  });

  it('shows a creating spinner and disables both actions until the request settles', async () => {
    let resolveCreate: (session: Session) => void = () => {};
    mockedSessions.createSession.mockImplementation(
      () =>
        new Promise<Session>(resolve => {
          resolveCreate = resolve;
        }),
    );
    await renderScreen();
    await screen.findByTestId('new-conversation-screen');

    await fireEvent.press(screen.getByTestId('new-conversation-auto'));
    expect(await screen.findByTestId('new-conversation-loading')).toBeOnTheScreen();
    expect(screen.getByTestId('new-conversation-start')).toBeDisabled();
    expect(screen.getByTestId('new-conversation-auto')).toBeDisabled();

    // A second press during creation must not fire another request.
    await fireEvent.press(screen.getByTestId('new-conversation-start'));
    expect(mockedSessions.createSession).toHaveBeenCalledTimes(1);

    resolveCreate(makeSession());
    // Settling swaps this screen for the created conversation.
    await screen.findByTestId('chat-screen');
    expect(screen.queryByTestId('new-conversation-loading')).toBeNull();
    expect(mockedSessions.listMessages).toHaveBeenCalledWith(expect.any(Function), 42);
  });

  it('dismisses back to chat via the cancel control', async () => {
    const Stack = createNativeStackNavigator<MainStackParamList>();
    await render(
      <ModeProvider>
        <ThemeProvider>
          <AuthProvider>
            <NavigationContainer
              initialState={{
                index: 1,
                routes: [{name: 'Chat'}, {name: 'NewConversation'}],
              }}>
              <Stack.Navigator screenOptions={{headerShown: false}}>
                <Stack.Screen name="Chat" component={ChatScreen} />
                <Stack.Screen name="NewConversation" component={NewConversationScreen} />
              </Stack.Navigator>
            </NavigationContainer>
          </AuthProvider>
        </ThemeProvider>
      </ModeProvider>,
    );

    await screen.findByTestId('new-conversation-screen');

    await fireEvent.press(screen.getByTestId('new-conversation-back'));

    await waitFor(() => expect(screen.getByTestId('chat-no-session')).toBeOnTheScreen());
  });

  it('hands the generated sample conversation to chat for the example overlay (TASK-053)', async () => {
    mockedSessions.createSession.mockResolvedValue(
      makeCreatedSession([
        {role: 'assistant', content: 'Welcome aboard, traveler!'},
        {role: 'user', content: 'Thanks! Where should we go?'},
      ]),
    );
    await renderScreen();
    await screen.findByTestId('new-conversation-screen');

    await fireEvent.press(screen.getByTestId('new-conversation-auto'));

    // The created conversation opens and exposes the example entry point.
    await screen.findByTestId('chat-screen');
    await waitFor(() =>
      expect(screen.getByTestId('chat-show-example')).toBeOnTheScreen(),
    );

    // The example overlay presents the creation-response turns.
    await fireEvent.press(screen.getByTestId('chat-show-example'));
    expect(screen.getByText('Welcome aboard, traveler!')).toBeOnTheScreen();
    expect(screen.getByText('Thanks! Where should we go?')).toBeOnTheScreen();
  });

  it('opens chat without the example entry when creation carries no sample', async () => {
    mockedSessions.createSession.mockResolvedValue(makeCreatedSession(undefined, {id: 7}));
    await renderScreen();
    await screen.findByTestId('new-conversation-screen');

    await fireEvent.press(screen.getByTestId('new-conversation-start'));

    await screen.findByTestId('chat-screen');
    await waitFor(() =>
      expect(mockedSessions.listMessages).toHaveBeenCalledWith(expect.any(Function), 7),
    );
    expect(screen.queryByTestId('chat-show-example')).toBeNull();
  });
});
