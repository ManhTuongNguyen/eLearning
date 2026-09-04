/**
 * TASK-117 — Validate the complete serverless journey.
 *
 * Full-journey coverage against the REAL application tree (App →
 * RootNavigator → providers → real screens), mirroring the SPEC order:
 * enable serverless through Settings → configure the OpenRouter API key →
 * select primary/fallback models → generate a topic ("Let AI choose") →
 * chat → watch the streamed assistant reply → reopen the conversation from
 * History → suggest replies → improve the message → read it aloud (TTS) →
 * clear local data.
 *
 * Substitution seams:
 * - api/auth + api/profile are automocks (startup restore only); every
 *   other server module stays REAL, so any serverless-mode attempt to
 *   reach the backend trips the runtime gate loudly.
 * - The local database is routed to real in-memory SQL (sql.js) through
 *   the nativeDriver seam, so persistence, clearing and mode-restarts are
 *   exercised against an actual SQLite engine.
 * - All OpenRouter traffic goes through the scriptable FakeOpenRouterClient
 *   behind createOpenRouterClient/listOpenRouterModels.
 *
 * Zero-server-traffic is asserted with fetch/XMLHttpRequest spies: in
 * serverless mode NO request may leave the device (ROADMAP Rule 9).
 *
 * Application restarts are simulated by remounting the application through
 * a key change (authJourney pattern): identical unmount/remount semantics
 * to relaunching, with the same persisted device stores.
 */
import React from 'react';
import {Alert} from 'react-native';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import * as Keychain from 'react-native-keychain';

import App from '../App';
import * as authApi from '../src/api/auth';
import * as profileApi from '../src/api/profile';
import * as sessionsApi from '../src/api/sessions';
import {getLocalDatabase, resetLocalDatabase} from '../src/db/database';
import type {SqlDriver, SqlParam} from '../src/db/driver';
import * as nativeDriver from '../src/db/nativeDriver';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {
  getRuntimeApplicationMode,
  setRuntimeApplicationMode,
} from '../src/mode/runtime';
import * as openrouterClient from '../src/serverless/openrouterClient';
import {saveServerlessOpenRouterConfig} from '../src/serverless/settings';
import {getSpeechEngine} from '../src/tts/textToSpeech';
import {FakeOpenRouterClient} from '../testing/fakeOpenRouter';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/api/profile', () => ({
  ...jest.requireActual('../src/api/profile'),
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
}));

/**
 * Route the application's local database to real in-memory SQL: one driver
 * per test via the __resetLocalDriver handle, exactly like a fresh install.
 */
jest.mock('../src/db/nativeDriver', () => {
  const {openSqlJsDriver} = require('../testing/sqlJsDriver');
  let mockDbPromise: Promise<unknown> | null = null;
  return {
    LOCAL_DB_NAME: 'elearning-serverless.db',
    openNativeDriver: () => {
      if (mockDbPromise === null) {
        mockDbPromise = openSqlJsDriver();
      }
      return mockDbPromise;
    },
    __resetLocalDriver: () => {
      mockDbPromise = null;
    },
  };
});

/**
 * Every OpenRouter consumer in the app resolves the shared fake; the model
 * catalog refresh uses the same fake through listOpenRouterModels.
 */
jest.mock('../src/serverless/openrouterClient', () => {
  const actual = jest.requireActual('../src/serverless/openrouterClient');
  const {FakeOpenRouterClient: FakeClientCtor} = require('../testing/fakeOpenRouter');
  let mockFake = new FakeClientCtor();
  return {
    ...actual,
    createOpenRouterClient: jest.fn(() => mockFake),
    listOpenRouterModels: jest.fn(() => mockFake.listModels()),
    __setFake: (next: FakeOpenRouterClient) => {
      mockFake = next;
    },
  };
});

const mockedAuth = jest.mocked(authApi);
const mockedProfile = jest.mocked(profileApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedKeychain = Keychain as jest.Mocked<typeof Keychain> & {
  __resetKeychainStore: () => void;
};
const mockedNativeDriver = nativeDriver as typeof nativeDriver & {
  __resetLocalDriver: () => void;
};
const mockedClientModule = openrouterClient as typeof openrouterClient & {
  __setFake: (next: FakeOpenRouterClient) => void;
};

const TOKENS = {access: 'access-1', refresh: 'refresh-1'};
const USER = {id: 1, username: 'alice', email: 'alice@example.com'};
const AUTH_SERVICE = 'com.elearningmobile.auth';
const SERVERLESS_SERVICE = 'com.elearningmobile.serverless';
const API_KEY = 'sk-or-v1-journey-key';
const TOPIC = {
  title: 'Travel plans',
  description:
    'Talk about a dream trip: where to go, what to pack and who to take along.',
};
const SAMPLE_TURNS = {
  turns: [
    {role: 'assistant', content: 'Hi! Have you ever planned a big trip?'},
    {role: 'user', content: 'Yes, I visited Japan last spring.'},
    {role: 'assistant', content: 'That sounds wonderful! What did you enjoy most?'},
    {role: 'user', content: 'The food and the temples were amazing.'},
  ],
};
/**
 * TASK-093: the topic and its example conversation arrive together in ONE
 * combined completion.
 */
const COMBINED_TOPIC_AND_SAMPLE = JSON.stringify({
  topic: TOPIC,
  sample_conversation: SAMPLE_TURNS,
});
const USER_TEXT = 'Hello! How are you?';
const ASSISTANT_TEXT = 'Hello there! Nice to meet you.';
const SUGGESTIONS = {
  replies: [
    'I would love to visit Japan someday.',
    'What is your dream destination?',
    'Have you ever traveled abroad?',
  ],
};
const IMPROVEMENT = {
  improved: 'Hello! How are you doing today?',
  explanation: 'Added "doing" for a natural greeting.',
  severity: 'minor',
};

interface CapturedAlertButton {
  text?: string;
  onPress?: () => void;
}

let launchCount = 0;
let lastAlertButtons: CapturedAlertButton[] = [];
let fetchSpy: jest.SpyInstance;
let xhrConstructorSpy: jest.Mock;
const realXHR = globalThis.XMLHttpRequest;

function launch(index: number): React.ReactElement {
  return <App key={`launch-${index}`} />;
}

/** The stack keeps earlier Chat instances mounted; resolve the topmost. */
function top(testId: string): ReturnType<typeof screen.getAllByTestId>[number] {
  const matches = screen.getAllByTestId(testId);
  return matches[matches.length - 1];
}

function pressTop(testId: string): Promise<void> {
  // Awaited so the act queue drains before the next interaction — a press
  // against a not-yet-re-rendered disabled control would be swallowed.
  return fireEvent.press(top(testId));
}

function checkedOf(testId: string): boolean | undefined {
  const props = top(testId).props as {accessibilityState?: {checked?: boolean}};
  return props.accessibilityState?.checked;
}

async function seedAuthKeychain(): Promise<void> {
  await Keychain.setGenericPassword('elearning-auth', JSON.stringify(TOKENS), {
    service: AUTH_SERVICE,
  });
}

async function sqlRows(
  sql: string,
  params: readonly SqlParam[] = [],
): Promise<Array<Record<string, unknown>>> {
  const db: SqlDriver = await getLocalDatabase();
  const result = await db.execute(sql, params);
  return result.rows;
}

/** Confirm the native clear-data dialog captured by the Alert spy. */
async function confirmClearLocalData(): Promise<void> {
  lastAlertButtons = [];
  await pressTop('settings-clear-local');
  const clear = lastAlertButtons.find(button => button.text === 'Clear');
  expect(clear).toBeDefined();
  await act(async () => {
    clear?.onPress?.();
  });
}

/**
 * Boot the app in a fully configured serverless mode (pre-seeded stores).
 *
 * TASK-AUDIT-003: no server credentials are involved — a serverless cold
 * start boots straight into the main application without any authentication.
 */
async function bootConfiguredServerlessApp(
  fake: FakeOpenRouterClient,
): Promise<ReactTestRendererLike> {
  await saveApplicationMode('serverless');
  await saveServerlessOpenRouterConfig({
    apiKey: API_KEY,
    primaryModel: 'vendor/model-a',
    fallbackModels: ['vendor/model-b'],
  });
  mockedClientModule.__setFake(fake);
  return render(launch(launchCount++));
}

type ReactTestRendererLike = ReturnType<typeof render>;

/**
 * TASK-093: serverless session creation runs ONE combined completion that
 * returns the topic and its example conversation together.
 */
function enqueueTopicAndSample(fake: FakeOpenRouterClient): void {
  fake.enqueueComplete({
    text: COMBINED_TOPIC_AND_SAMPLE,
    model: 'vendor/model-a',
    finishReason: 'stop',
    requestId: 'topic-and-sample-1',
  });
}

/** Create one serverless conversation and stream one assistant reply. */
async function startConversationWithReply(fake: FakeOpenRouterClient): Promise<void> {
  enqueueTopicAndSample(fake);
  await pressTop('chat-open-new');
  await waitFor(() =>
    expect(screen.getByTestId('new-conversation-screen')).toBeOnTheScreen(),
  );
  await pressTop('new-conversation-start');
  await waitFor(() => expect(screen.getByTestId('chat-topic-title')).toBeOnTheScreen());
  fake.enqueueStream({type: 'success', deltas: [ASSISTANT_TEXT]});
  await fireEvent.changeText(top('composer-input'), USER_TEXT);
  await waitFor(() => expect(top('composer-input').props.value).toBe(USER_TEXT));
  await pressTop('chat-send');
  await waitFor(() =>
    expect(within(top('chat-screen')).getByText(ASSISTANT_TEXT)).toBeOnTheScreen(),
  );
}

beforeEach(async () => {
  mockedKeychain.__resetKeychainStore();
  mockedNativeDriver.__resetLocalDriver();
  resetLocalDatabase();
  // Server-flow journeys: pin the persisted mode because fresh installs
  // now default to serverless.
  await saveApplicationMode('server');
  setRuntimeApplicationMode('server');
  jest.clearAllMocks();
  mockedProfile.getProfile.mockResolvedValue({level: 'AUTO'});
  // The server-mode phase of these journeys boots into the no-session
  // landing route, whose authoritative history check (TASK-AUDIT-008) goes
  // through the substituted sessions module — never the real transport.
  mockedSessions.listSessions.mockResolvedValue({
    count: 0,
    next: null,
    previous: null,
    results: [],
  });
  lastAlertButtons = [];
  jest
    .spyOn(Alert, 'alert')
    .mockImplementation(
      (_title: string, _message?: string, buttons?: CapturedAlertButton[]) => {
        lastAlertButtons = buttons ?? [];
      },
    );
  fetchSpy = jest.spyOn(globalThis, 'fetch');
  // No XHR may ever be constructed: the serverless SSE gate throws before
  // the transport layer, so any backend streaming attempt is observable.
  xhrConstructorSpy = jest.fn();
  globalThis.XMLHttpRequest = xhrConstructorSpy as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  globalThis.XMLHttpRequest = realXHR;
  jest.restoreAllMocks();
});

describe('TASK-117 serverless journey', () => {
  it('runs the complete serverless journey end to end', async () => {
    await seedAuthKeychain();
    mockedAuth.getMe.mockResolvedValue(USER);
    const fake = new FakeOpenRouterClient();
    mockedClientModule.__setFake(fake);
    const view = await render(launch(launchCount++));
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    // ---- Enable serverless mode through Settings. ----------------------
    await pressTop('chat-open-settings');
    await waitFor(() => expect(top('settings-screen')).toBeOnTheScreen());
    expect(screen.getByTestId('settings-open-vocabulary')).toBeOnTheScreen();
    await pressTop('settings-mode-serverless');
    await waitFor(() => expect(checkedOf('settings-mode-serverless')).toBe(true));
    expect(getRuntimeApplicationMode()).toBe('serverless');
    // Server-only features are hidden while serverless is active, but the
    // learning-level row stays (TASK-091: it edits the local SQLite profile).
    expect(screen.queryByTestId('settings-open-vocabulary')).toBeNull();
    expect(screen.getByTestId('settings-open-level')).toBeOnTheScreen();
    expect(top('settings-ai-provider-card')).toBeOnTheScreen();

    // ---- Configure the API key and select models. ----------------------
    await pressTop('settings-ai-provider-card');
    await waitFor(() =>
      expect(screen.getByTestId('ai-provider-settings-screen')).toBeOnTheScreen(),
    );
    await fireEvent.changeText(screen.getByTestId('ai-provider-api-key-input'), API_KEY);
    await pressTop('ai-provider-models-refresh');
    await waitFor(() =>
      expect(screen.getByTestId('ai-provider-model-count')).toBeOnTheScreen(),
    );
    await pressTop('ai-provider-model-primary-vendor/model-a');
    await waitFor(() => expect(checkedOf('ai-provider-model-primary-vendor/model-a')).toBe(true));
    await pressTop('ai-provider-model-fallback-vendor/model-b');
    await waitFor(() => expect(checkedOf('ai-provider-model-fallback-vendor/model-b')).toBe(true));
    await pressTop('ai-provider-save');
    // TASK-IMPROVEMENT-005: the save itself navigates back to Settings with
    // the one-shot saved flag, and the Settings card flashes the success
    // toast while refreshing to the persisted configuration. The editor
    // instance stays mounted below, so resolve the topmost screens.
    await waitFor(() => expect(top('settings-screen')).toBeOnTheScreen());
    expect(top('settings-saved-toast')).toHaveTextContent(
      'Configuration saved successfully.',
    );
    await waitFor(() =>
      expect(
        top('settings-ai-provider-key-status'),
      ).toHaveTextContent('Saved on this device'),
    );
    expect(top('settings-ai-provider-primary-status')).toHaveTextContent(
      'vendor/model-a',
    );
    expect(top('settings-ai-provider-fallback-status')).toHaveTextContent(
      '1 selected',
    );

    // ---- Relaunch: the persisted serverless mode is restored. ----------
    await view.rerender(launch(launchCount++));
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(getRuntimeApplicationMode()).toBe('serverless');

    // ---- Generate a topic ("Let AI choose") and open the chat. ---------
    await pressTop('chat-open-new');
    await waitFor(() =>
      expect(screen.getByTestId('new-conversation-screen')).toBeOnTheScreen(),
    );
    enqueueTopicAndSample(fake);
    await pressTop('new-conversation-start');
    await waitFor(() => expect(screen.getByTestId('chat-topic-title')).toBeOnTheScreen());
    expect(within(top('chat-screen')).getByText(TOPIC.title)).toBeOnTheScreen();
    // TASK-093: one combined completion returns topic + example, and the
    // example entry point is offered exactly like in server mode.
    expect(fake.completeRequests).toHaveLength(1);
    expect(fake.completeRequests[0].messages[0].role).toBe('system');
    await waitFor(() =>
      expect(within(top('chat-screen')).getByTestId('chat-show-example')).toBeOnTheScreen(),
    );
    await pressTop('chat-show-example');
    expect(screen.getByTestId('sample-modal')).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('sample-modal')).getByText(SAMPLE_TURNS.turns[0].content),
    ).toBeOnTheScreen();
    await pressTop('sample-close');
    expect(screen.queryByTestId('sample-modal')).toBeNull();
    expect(fake.streamRequests).toHaveLength(0);

    // ---- Chat: stream the assistant response. --------------------------
    fake.enqueueStream({
      type: 'success',
      deltas: ['Hello', ' there', '!', ' Nice to meet you.'],
    });
    await fireEvent.changeText(top('composer-input'), USER_TEXT);
    await pressTop('chat-send');
    await waitFor(() =>
      expect(within(top('chat-screen')).getByText(ASSISTANT_TEXT)).toBeOnTheScreen(),
    );
    expect(fake.streamRequests).toHaveLength(1);
    const chatRequest = fake.streamRequests[0];
    expect(chatRequest.messages[chatRequest.messages.length - 1].content).toBe(USER_TEXT);
    // Both rows are already persisted locally, terminal statuses included.
    const rows = await sqlRows(
      'SELECT role, status, content FROM messages ORDER BY sequence ASC',
    );
    expect(rows).toEqual([
      {role: 'user', status: 'complete', content: USER_TEXT},
      {role: 'assistant', status: 'complete', content: ASSISTANT_TEXT},
    ]);

    // ---- History: the local conversation is listed and reopens. --------
    await pressTop('chat-open-history');
    await waitFor(() => expect(top('history-screen')).toBeOnTheScreen());
    await waitFor(() => expect(screen.getByTestId('history-item-1')).toBeOnTheScreen());
    expect(
      within(screen.getByTestId('history-item-1')).getByText(TOPIC.title),
    ).toBeOnTheScreen();
    await pressTop('history-item-1');
    await waitFor(() =>
      expect(within(top('chat-screen')).getByText(ASSISTANT_TEXT)).toBeOnTheScreen(),
    );

    // ---- Suggest replies: three chips, tap fills the composer. ---------
    // Suggest replies is a user-message action: it drafts what the learner
    // could say NEXT, so the menu offers it on the learner's own row.
    await fireEvent(top('chat-message-1'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('chat-menu-modal')).toBeOnTheScreen());
    fake.enqueueComplete({
      text: JSON.stringify(SUGGESTIONS),
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: 'suggestions-1',
    });
    await pressTop('chat-menu-suggest-replies');
    await waitFor(() => expect(top('chat-suggestions')).toBeOnTheScreen());
    expect(screen.getByTestId('chat-suggestion-0')).toBeOnTheScreen();
    expect(screen.getByTestId('chat-suggestion-1')).toBeOnTheScreen();
    expect(screen.getByTestId('chat-suggestion-2')).toBeOnTheScreen();
    await pressTop('chat-suggestion-0');
    await waitFor(() => expect(top('composer-input').props.value).toBe(SUGGESTIONS.replies[0]));
    // Selecting a suggestion never sends the message.
    expect(fake.streamRequests).toHaveLength(1);

    // ---- Improve my English on the user message. -----------------------
    await fireEvent(top('chat-message-1'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('chat-menu-modal')).toBeOnTheScreen());
    fake.enqueueComplete({
      text: JSON.stringify(IMPROVEMENT),
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: 'improve-1',
    });
    await pressTop('chat-menu-improve-english');
    await waitFor(() =>
      expect(within(top('chat-screen')).getByTestId('chat-improvement')).toBeOnTheScreen(),
    );
    expect(
      within(top('chat-screen')).getByText('Hello! How are you doing today?'),
    ).toBeOnTheScreen();
    expect(within(top('chat-screen')).getByText(IMPROVEMENT.explanation)).toBeOnTheScreen();
    await pressTop('chat-improvement-close');

    // ---- TTS: Read aloud runs through the speech seam. -----------------
    const speechSpy = jest.spyOn(getSpeechEngine(), 'speak');
    await fireEvent(top('chat-message-2'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('chat-menu-modal')).toBeOnTheScreen());
    await pressTop('chat-menu-speak');
    expect(speechSpy).toHaveBeenCalledWith(ASSISTANT_TEXT);

    // ---- No server dependency anywhere in the journey. -----------------
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrConstructorSpy).not.toHaveBeenCalled();
  });

  it('keeps serverless vocabulary functionality unavailable (TASK-AUDIT-016)', async () => {
    const fake = new FakeOpenRouterClient();
    const view = await bootConfiguredServerlessApp(fake);
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    // Settings hides the server-side vocabulary entry while serverless.
    await pressTop('chat-open-settings');
    await waitFor(() => expect(top('settings-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('settings-open-vocabulary')).toBeNull();

    // Settings has no back control; a relaunch returns to Chat.
    await view.rerender(launch(launchCount++));
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    await startConversationWithReply(fake);

    // The message menu no longer offers Select text in serverless mode:
    // saving words is a server-only flow, so the entry disappears instead
    // of presenting an action that could only fail against the gate.
    await fireEvent(top('chat-message-1'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('chat-menu-modal')).toBeOnTheScreen());
    expect(screen.queryByTestId('chat-menu-select-text')).toBeNull();
    // The rest of the menu keeps working; the assistant menu additionally
    // never offers the learner-only Suggest replies action.
    expect(screen.getByTestId('chat-menu-copy')).toBeOnTheScreen();
    expect(screen.getByTestId('chat-menu-suggest-replies')).toBeOnTheScreen();
    await pressTop('chat-menu-copy');
    await fireEvent(top('chat-message-2'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('chat-menu-modal')).toBeOnTheScreen());
    expect(screen.queryByTestId('chat-menu-suggest-replies')).toBeNull();
    expect(screen.getByTestId('chat-menu-copy')).toBeOnTheScreen();

    // And the selection sheet can never be reached through the UI.
    expect(screen.queryByTestId('chat-selection')).toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrConstructorSpy).not.toHaveBeenCalled();
  });

  it('clear local data removes all local data but leaves the server account intact', async () => {
    const fake = new FakeOpenRouterClient();
    // Server credentials exist on the device from an earlier server session;
    // serverless mode must not use them, but clearing local data must not
    // remove them either.
    await seedAuthKeychain();
    await bootConfiguredServerlessApp(fake);
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    await startConversationWithReply(fake);

    await pressTop('chat-open-settings');
    await waitFor(() => expect(top('settings-screen')).toBeOnTheScreen());

    await confirmClearLocalData();
    await waitFor(() =>
      expect(
        screen.getByTestId('settings-ai-provider-key-status'),
      ).toHaveTextContent('Not configured'),
    );

    // Every serverless table is empty after the clear.
    const counts = await sqlRows(
      'SELECT (SELECT COUNT(*) FROM sessions) AS sessions, ' +
        '(SELECT COUNT(*) FROM messages) AS messages, ' +
        '(SELECT COUNT(*) FROM summaries) AS summaries, ' +
        '(SELECT COUNT(*) FROM settings) AS settings, ' +
        '(SELECT COUNT(*) FROM learning_profile) AS profiles',
    );
    expect(counts[0]).toEqual({
      sessions: 0,
      messages: 0,
      summaries: 0,
      settings: 0,
      profiles: 0,
    });

    // The secure API key was removed along with the data.
    expect(await Keychain.getGenericPassword({service: SERVERLESS_SERVICE})).toBe(false);

    // Auth credentials survive untouched even though serverless mode never
    // read them (no authentication request was made during the session).
    const auth = await Keychain.getGenericPassword({service: AUTH_SERVICE});
    expect(auth).toBeTruthy();
    expect(JSON.parse((auth as {password: string}).password)).toEqual(TOKENS);
    expect(mockedAuth.getMe).not.toHaveBeenCalled();
    expect(getRuntimeApplicationMode()).toBe('serverless');

    // Clearing never contacted the server.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrConstructorSpy).not.toHaveBeenCalled();
    expect(mockedAuth.logout).not.toHaveBeenCalled();
  });

  it('cold start with persisted serverless mode boots straight into the app without login (TASK-AUDIT-003)', async () => {
    const fake = new FakeOpenRouterClient();
    // No auth keychain seeding at all: serverless is independent of server
    // authentication. Only the mode flag and OpenRouter config are stored.
    await saveApplicationMode('serverless');
    await saveServerlessOpenRouterConfig({
      apiKey: API_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: [],
    });
    mockedClientModule.__setFake(fake);

    const view = await render(launch(launchCount++));

    // The main application mounts directly; the login screen is never shown.
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('login-identifier')).toBeNull();
    expect(getRuntimeApplicationMode()).toBe('serverless');

    // No authentication request was made merely to initialize the app.
    expect(mockedAuth.getMe).not.toHaveBeenCalled();

    // No server-only account UI exists in serverless mode.
    await pressTop('chat-open-settings');
    await waitFor(() => expect(top('settings-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('settings-account-section')).toBeNull();
    expect(screen.queryByText('Signed in as')).toBeNull();
    expect(screen.queryByTestId('settings-logout')).toBeNull();

    // Closing and reopening keeps serverless mode active without login.
    await view.rerender(launch(launchCount++));
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('login-identifier')).toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrConstructorSpy).not.toHaveBeenCalled();
  });
});
