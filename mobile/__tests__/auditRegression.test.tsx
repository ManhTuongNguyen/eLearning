/**
 * TASK-AUDIT-018 — focused regression suite for the confirmed audit bugs.
 *
 * One suite that pins every confirmed mobile audit bug at the same boundary
 * where it was found, so a future change cannot silently resurrect any of
 * them:
 *
 * - TASK-AUDIT-003 — serverless mode is entered from the login screen,
 *   survives application restarts, and never routes to login.
 * - TASK-AUDIT-016 — server-only Account UI is absent in serverless mode.
 * - TASK-AUDIT-008 — existing history appears after login.
 * - TASK-AUDIT-007 — saving a word is immediate (no confirmation popup).
 * - TASK-AUDIT-009 — chat bubble width cap and role alignment.
 * - TASK-AUDIT-005 — the access-token refresh wrapper refreshes exactly
 *   once and retries the original request exactly once, and a failed
 *   refresh clears credentials and returns the user to login.
 * - TASK-AUDIT-010 — environment configuration is loaded, never hard-coded.
 * - TASK-AUDIT-013/004 — provider strategy selection works, with keyless
 *   discovery for public catalogs.
 *
 * External APIs are fully mocked (auth/sessions/vocabulary automocks,
 * fetch spies); no test uses real OpenRouter credentials. Restarts are
 * simulated by remounting the application through a key change (authJourney
 * pattern) on the same persistent in-memory device stores.
 */
import React from 'react';
import type {TestInstance} from 'test-renderer';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import App from '../App';
import * as authApi from '../src/api/auth';
import * as profileApi from '../src/api/profile';
import * as sessionsApi from '../src/api/sessions';
import type {ChatMessage, Paginated, Session} from '../src/api/sessions';
import * as vocabularyApi from '../src/api/vocabulary';
import type {VocabularyItem} from '../src/api/vocabulary';
import {ApiError} from '../src/api/client';
import * as client from '../src/api/client';
import {createAuthedRequester} from '../src/auth/authedRequest';
import type {AuthedRequestOptions} from '../src/auth/authedRequest';
import {API_BASE_URL, resolveApiBaseUrl} from '../src/config';
import {resetLocalDatabase} from '../src/db/database';
import * as nativeDriver from '../src/db/nativeDriver';
import {getRuntimeApplicationMode, setRuntimeApplicationMode} from '../src/mode/runtime';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {
  createProviderClient,
  listProviderModels,
  resolveProviderId,
  SUPPORTED_PROVIDER_IDS,
} from '../src/serverless/providerRegistry';
import type {LLMClientConfig} from '../src/serverless/types';
import {createRowStyles, MessageRow} from '../src/screens/MessageRow';
import {lightColors} from '../src/theme/colors';
import type {AuthTokens} from '../src/auth/tokens';

jest.mock('../src/api/auth');
jest.mock('../src/api/sessions');
jest.mock('../src/api/vocabulary');
jest.mock('../src/api/client', () => ({
  ...jest.requireActual('../src/api/client'),
  apiRequest: jest.fn(),
}));
jest.mock('../src/api/profile', () => ({
  ...jest.requireActual('../src/api/profile'),
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
}));

/**
 * Route the application's local database to real in-memory SQL (sql.js)
 * through the nativeDriver seam — one fresh driver per test, exactly like
 * a fresh install.
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

const mockedAuth = jest.mocked(authApi);
const mockedProfile = jest.mocked(profileApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedVocabulary = jest.mocked(vocabularyApi);
const mockedApiRequest = jest.mocked(client.apiRequest);
const mockedKeychain = Keychain as jest.Mocked<typeof Keychain> & {
  __resetKeychainStore: () => void;
};
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};
const mockedNativeDriver = nativeDriver as typeof nativeDriver & {
  __resetLocalDriver: () => void;
};

const TOKENS: AuthTokens = {access: 'access-1', refresh: 'refresh-1'};
const USER = {id: 1, username: 'alice', email: 'alice@example.com'};
const KEYCHAIN_SERVICE = 'com.elearningmobile.auth';
const MESSAGE_CONTENT = 'The early bird catches the worm.';

let launchCount = 0;
let fetchSpy: jest.SpyInstance;
let xhrConstructorSpy: jest.Mock;
const realXHR = globalThis.XMLHttpRequest;

function launch(index: number): React.ReactElement {
  // A new key remounts the whole application: fresh restore effect, same
  // persisted device stores (authJourney restart pattern).
  return <App key={`launch-${index}`} />;
}

/** Stacks keep earlier instances mounted; resolve the topmost. */
function top(testId: string): TestInstance {
  const matches = screen.getAllByTestId(testId);
  return matches[matches.length - 1];
}

async function pressTop(testId: string): Promise<void> {
  return fireEvent.press(top(testId));
}

async function seedKeychain(tokens: AuthTokens): Promise<void> {
  await Keychain.setGenericPassword('elearning-auth', JSON.stringify(tokens), {
    service: KEYCHAIN_SERVICE,
  });
}

async function storedTokens(): Promise<AuthTokens | null> {
  const credentials = await mockedKeychain.getGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
  if (!credentials) {
    return null;
  }
  return JSON.parse(credentials.password) as AuthTokens;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 9,
    title: 'Traveling',
    topic: 'Talking about favorite destinations.',
    topic_hint: '',
    learning_level: 'B1',
    created_at: '2026-08-26T10:00:00Z',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 810,
    role: 'assistant',
    status: 'complete',
    content: MESSAGE_CONTENT,
    sequence: 1,
    created_at: '2026-08-26T10:00:00Z',
    ...overrides,
  };
}

function makeItem(overrides: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    id: 42,
    expression: 'early',
    normalized_expression: 'early',
    definition: '',
    translation: '',
    pronunciation: '',
    part_of_speech: '',
    example: '',
    status: 'pending',
    source_message: 810,
    source_session: 5,
    created_at: '2026-08-26T10:05:00Z',
    ...overrides,
  };
}

function sessionPage(results: Session[]): Paginated<Session> {
  return {count: results.length, next: null, previous: null, results};
}

function messagePage(results: ChatMessage[]): Paginated<ChatMessage> {
  return {count: results.length, next: null, previous: null, results};
}

async function fillLoginForm(identifier: string, password: string): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
  await fireEvent.changeText(screen.getByTestId('login-identifier'), identifier);
  await fireEvent.changeText(screen.getByTestId('login-password'), password);
  await fireEvent.press(screen.getByTestId('login-submit'));
}

/** Simulate a native selection span over the pinned selection input. */
async function selectRange(start: number, end: number): Promise<void> {
  await fireEvent(
    screen.getByTestId('chat-selection-input'),
    'selectionChange',
    {nativeEvent: {selection: {start, end}}},
  );
}

beforeEach(async () => {
  mockedKeychain.__resetKeychainStore();
  asyncStorage.__resetAsyncStorageStore();
  mockedNativeDriver.__resetLocalDriver();
  resetLocalDatabase();
  // Server-flow journeys: pin the persisted mode because fresh installs
  // now default to serverless.
  await saveApplicationMode('server');
  setRuntimeApplicationMode('server');
  jest.clearAllMocks();
  mockedProfile.getProfile.mockResolvedValue({level: 'AUTO'});
  // The no-session landing route checks the authoritative history before it
  // may claim the empty state (TASK-AUDIT-008); default to an empty one.
  mockedSessions.listSessions.mockResolvedValue(sessionPage([]));
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

// ---------------------------------------------------------------------------
// TASK-AUDIT-003 / TASK-AUDIT-016 — serverless entry, restart, and UI.
// ---------------------------------------------------------------------------

describe('serverless mode regression (TASK-AUDIT-003/016)', () => {
  it('can be entered from the login screen without any account', async () => {
    await render(launch(launchCount++));
    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());

    await fireEvent.press(screen.getByTestId('login-serverless'));

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('login-identifier')).toBeNull();
    expect(getRuntimeApplicationMode()).toBe('serverless');
    // No authentication request was made: serverless needs no account.
    expect(mockedAuth.getMe).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrConstructorSpy).not.toHaveBeenCalled();
  });

  it('survives an application restart, never routes to login, and hides the account UI', async () => {
    const view = await render(launch(launchCount++));
    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
    await fireEvent.press(screen.getByTestId('login-serverless'));
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    // ---- Restart: the persisted mode is restored, still without login. --
    mockedAuth.getMe.mockClear();
    await view.rerender(launch(launchCount++));

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('login-identifier')).toBeNull();
    expect(getRuntimeApplicationMode()).toBe('serverless');
    expect(mockedAuth.getMe).not.toHaveBeenCalled();

    // ---- Server-only Account UI is absent in serverless mode. -----------
    await pressTop('chat-open-settings');
    await waitFor(() => expect(top('settings-screen')).toBeOnTheScreen());
    expect(screen.queryByTestId('settings-account-section')).toBeNull();
    expect(screen.queryByText('Signed in as')).toBeNull();
    expect(screen.queryByTestId('settings-logout')).toBeNull();
    expect(screen.queryByTestId('settings-open-vocabulary')).toBeNull();
    expect(top('settings-openrouter-card')).toBeOnTheScreen();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrConstructorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TASK-AUDIT-008 — history after login.
// ---------------------------------------------------------------------------

describe('history after login regression (TASK-AUDIT-008)', () => {
  it('lists the existing server history after logging in', async () => {
    mockedAuth.login.mockResolvedValue({...TOKENS, user: USER});
    mockedSessions.listSessions.mockResolvedValue(
      sessionPage([makeSession({id: 9}), makeSession({id: 7})]),
    );
    mockedSessions.getSession.mockResolvedValue(makeSession({id: 9}));
    mockedSessions.listMessages.mockResolvedValue(messagePage([]));

    await render(launch(launchCount++));

    await fillLoginForm('alice@example.com', 'secret');

    // The most recent conversation opens in place after login; the landing
    // route never claims an empty history while the server has sessions.
    await waitFor(() => expect(top('composer-input')).toBeOnTheScreen());
    expect(screen.queryByTestId('chat-no-session')).toBeNull();
    expect(mockedSessions.listSessions).toHaveBeenCalledWith(expect.any(Function), 1);

    // The history screen lists every existing conversation.
    await pressTop('chat-open-history');
    await waitFor(() => expect(top('history-screen')).toBeOnTheScreen());
    expect(screen.getByTestId('history-item-9')).toBeOnTheScreen();
    expect(screen.getByTestId('history-item-7')).toBeOnTheScreen();
  });
});

// ---------------------------------------------------------------------------
// TASK-AUDIT-007 — immediate vocabulary save.
// ---------------------------------------------------------------------------

describe('immediate vocabulary save regression (TASK-AUDIT-007)', () => {
  it('saves the selected word at once with a toast and no confirmation popup', async () => {
    await seedKeychain(TOKENS);
    mockedAuth.getMe.mockResolvedValue(USER);
    mockedSessions.listSessions.mockResolvedValue(sessionPage([makeSession({id: 5})]));
    mockedSessions.getSession.mockResolvedValue(makeSession({id: 5}));
    mockedSessions.listMessages.mockResolvedValue(messagePage([makeMessage()]));
    mockedVocabulary.saveVocabulary.mockResolvedValue(makeItem());

    await render(launch(launchCount++));
    await waitFor(() => expect(top('composer-input')).toBeOnTheScreen());

    // Reach the conversation through History (a second Chat instance mounts).
    await pressTop('chat-open-history');
    await fireEvent.press(await screen.findByTestId('history-item-5'));
    await waitFor(() =>
      expect(top('chat-message-810')).toBeOnTheScreen(),
    );

    // Capture the word "early" out of the assistant message.
    await fireEvent(top('chat-message-810'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('chat-menu-modal')).toBeOnTheScreen());
    await fireEvent.press(screen.getByTestId('chat-menu-select-text'));
    expect(screen.getByTestId('chat-selection-input').props.value).toBe(MESSAGE_CONTENT);
    await selectRange(4, 9);
    expect(screen.getByTestId('chat-selection-preview')).toHaveTextContent('early');

    // Pressing Save word starts the save immediately: one API call, no
    // confirmation popup, then a self-dismissing confirmation toast.
    jest.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.press(screen.getByTestId('chat-selection-save'));
      });

      expect(mockedVocabulary.saveVocabulary).toHaveBeenCalledTimes(1);
      expect(mockedVocabulary.saveVocabulary).toHaveBeenCalledWith(
        expect.any(Function),
        'early',
        810,
      );
      expect(screen.queryByTestId('chat-vocab-modal')).toBeNull();
      expect(screen.getByTestId('chat-toast')).toHaveTextContent('Saved to vocabulary');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-AUDIT-009 — chat message widths and alignment.
// ---------------------------------------------------------------------------

const rowStyles = createRowStyles(lightColors);

function flattenStyle(style: unknown): Record<string, unknown> {
  const entries = Array.isArray(style) ? style : [style];
  return Object.assign(
    {},
    ...entries.filter(Boolean).map(s => (typeof s === 'object' ? s : {})),
  );
}

function parentOf(element: TestInstance): TestInstance {
  const parent = element.parent;
  if (!parent) {
    throw new Error('Expected the element to have a parent');
  }
  return parent;
}

async function renderRow(role: ChatMessage['role']): Promise<TestInstance> {
  const item = makeMessage({role});
  await render(
    <MessageRow
      item={item}
      styles={rowStyles}
      streaming={false}
      speaking={false}
      spinnerColor={lightColors.textMuted}
      onMessageLongPress={jest.fn()}
      onRetry={jest.fn()}
      onStopSpeech={jest.fn()}
    />,
  );
  return screen.getByTestId(`chat-message-${item.id}`);
}

describe('chat message layout regression (TASK-AUDIT-009)', () => {
  it('caps the bubble width on the wrapper with a definite parent row', async () => {
    const bubble = await renderRow('assistant');

    const wrapperStyle = flattenStyle(parentOf(bubble).props.style);
    expect(wrapperStyle).toMatchObject({maxWidth: '85%', flexShrink: 1});

    const rowStyle = flattenStyle(parentOf(parentOf(bubble)).props.style);
    expect(rowStyle).toMatchObject({flexDirection: 'row'});
  });

  it('aligns user messages right and assistant messages left', async () => {
    const userBubble = await renderRow('user');
    const userRowStyle = flattenStyle(parentOf(parentOf(userBubble)).props.style);
    expect(userRowStyle).toMatchObject({
      flexDirection: 'row',
      justifyContent: 'flex-end',
    });

    const assistantBubble = await renderRow('assistant');
    const assistantRowStyle = flattenStyle(parentOf(parentOf(assistantBubble)).props.style);
    expect(assistantRowStyle).toMatchObject({flexDirection: 'row'});
    expect(assistantRowStyle).not.toHaveProperty('justifyContent', 'flex-end');
  });
});

// ---------------------------------------------------------------------------
// TASK-AUDIT-005 — one-time refresh wrapper and logout on refresh failure.
// ---------------------------------------------------------------------------

/** Session hooks shaped like AuthProvider's (single-flight refresh). */
function makeHarness(initialTokens: AuthTokens | null = TOKENS) {
  let tokens = initialTokens;
  let inFlight: Promise<string | null> | null = null;
  const refreshFn = jest.fn(async (): Promise<string> => 'access-2');

  function refresh(): Promise<string | null> {
    if (inFlight) {
      return inFlight;
    }
    const current = tokens;
    if (!current) {
      return Promise.resolve(null);
    }
    const attempt = refreshFn()
      .then(async access => {
        tokens = {...current, access};
        return access;
      })
      .catch(async () => {
        tokens = null;
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = attempt;
    return attempt;
  }

  const authedRequest = createAuthedRequester({
    whenReady: async () => undefined,
    getTokens: () => tokens,
    refresh,
  });

  return {authedRequest, refreshFn, currentTokens: () => tokens};
}

function unauthorized(): ApiError {
  return new ApiError(401, 'Token is invalid or expired', {}, 'authentication');
}

describe('one-time refresh wrapper regression (TASK-AUDIT-005)', () => {
  it('retries the original request exactly once after one refresh', async () => {
    const harness = makeHarness();
    mockedApiRequest
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce({level: 'A2'});
    const options: AuthedRequestOptions = {method: 'PATCH', body: {level: 'B1'}};

    await expect(
      harness.authedRequest<{level: string}>('/api/v1/profile/', options),
    ).resolves.toEqual({level: 'A2'});

    expect(harness.refreshFn).toHaveBeenCalledTimes(1);
    expect(mockedApiRequest).toHaveBeenCalledTimes(2);
    expect(mockedApiRequest).toHaveBeenNthCalledWith(2, '/api/v1/profile/', {
      ...options,
      token: 'access-2',
    });
  });

  it('never loops when the retried request is unauthorized again', async () => {
    const harness = makeHarness();
    mockedApiRequest.mockRejectedValue(unauthorized());

    await expect(harness.authedRequest('/api/v1/sessions/')).rejects.toMatchObject({
      status: 401,
    });

    // Exactly one refresh and two attempts: original + single retry.
    expect(harness.refreshFn).toHaveBeenCalledTimes(1);
    expect(mockedApiRequest).toHaveBeenCalledTimes(2);
  });

  it('logs the user out through the whole app when the refresh fails', async () => {
    await seedKeychain(TOKENS);
    mockedAuth.getMe.mockRejectedValue(new Error('401'));
    mockedAuth.refreshAccessToken.mockRejectedValue(new Error('401'));

    await render(launch(launchCount++));

    // Refresh failure cleared the credentials and routed back to login.
    await waitFor(() => expect(screen.getByTestId('login-identifier')).toBeOnTheScreen());
    expect(screen.queryByTestId('chat-screen')).toBeNull();
    expect(await storedTokens()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TASK-AUDIT-010 — environment configuration.
// ---------------------------------------------------------------------------

describe('environment configuration regression (TASK-AUDIT-010)', () => {
  it('loads the backend URL from the environment, never hard-coded', () => {
    // Jest runs with NODE_ENV=test, so the babel plugin loads .env.test
    // (see .env.test; update both together).
    expect(API_BASE_URL).toBe('http://test.local:8000');
    expect(API_BASE_URL.endsWith('/')).toBe(false);

    expect(resolveApiBaseUrl('  http://10.0.2.2:8000  ')).toBe('http://10.0.2.2:8000');
    for (const bad of [undefined, '', '   ', '10.0.2.2:8000', 'ftp://host']) {
      expect(() => resolveApiBaseUrl(bad)).toThrow('API_BASE_URL is not configured');
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-AUDIT-013/004 — provider strategy selection and keyless discovery.
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: {get: () => null},
  } as unknown as Response;
}

function providerConfig(provider: LLMClientConfig['provider']): LLMClientConfig {
  return {provider, apiKey: 'user-key', primaryModel: 'vendor/primary'};
}

describe('provider strategy selection regression (TASK-AUDIT-013/004)', () => {
  it('resolves provider ids and builds a client for every strategy', () => {
    expect(resolveProviderId(null)).toBe('openrouter');
    expect(resolveProviderId(' Gemini ')).toBe('gemini');
    expect(() => resolveProviderId('anthropic')).toThrow(/Unknown serverless provider/);

    for (const provider of SUPPORTED_PROVIDER_IDS) {
      const llmClient = createProviderClient(providerConfig(provider));
      expect(typeof llmClient.complete).toBe('function');
      expect(typeof llmClient.streamCompletion).toBe('function');
      expect(typeof llmClient.listModels).toBe('function');
    }
  });

  it('discovers models keylessly for public catalogs and authed otherwise', async () => {
    const catalog = {data: [{id: 'vendor/model-a'}, {id: 'vendor/model-b'}]};
    fetchSpy.mockResolvedValue(jsonResponse(200, catalog));

    const models = await listProviderModels('openrouter');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/models');
    // TASK-AUDIT-004: no token is required — not even an Authorization header.
    expect(init?.headers).toBeUndefined();
    expect(models.map(model => model.id)).toEqual(['vendor/model-a', 'vendor/model-b']);

    await listProviderModels('openai', {apiKey: 'sk-openai-key'});
    expect(fetchSpy.mock.calls[1][1]?.headers).toEqual({
      Authorization: 'Bearer sk-openai-key',
    });
  });
});
