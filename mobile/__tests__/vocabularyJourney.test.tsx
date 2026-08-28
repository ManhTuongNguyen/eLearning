/**
 * TASK-112 — Mobile vocabulary tests.
 *
 * Full-journey coverage against the REAL application tree (App →
 * RootNavigator → MainNavigator → real screens): an authenticated user
 * opens a conversation from History, long-presses an assistant message,
 * captures a word through the text-selection sheet (TASK-069) and saves it
 * immediately (TASK-AUDIT-007 — no confirmation popup; the vocabulary API
 * call fires at once and a self-dismissing toast confirms), then reaches the
 * vocabulary list through Settings where the saved expression renders
 * with its enrichment status and the export action hands the Anki CSV
 * to the native share seam behind a confirmation toast (TASK-075).
 * A second journey proves a failed save never produces a saved row.
 *
 * Only the network API modules and the native share seam are
 * substituted; navigation, providers and secure storage are real.
 */
import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';

import App from '../App';
import * as authApi from '../src/api/auth';
import * as profileApi from '../src/api/profile';
import * as sessionsApi from '../src/api/sessions';
import type {ChatMessage, Paginated, Session} from '../src/api/sessions';
import * as vocabularyApi from '../src/api/vocabulary';
import type {VocabularyItem} from '../src/api/vocabulary';
import * as Keychain from 'react-native-keychain';
import {VOCAB_TOAST_DURATION_MS} from '../src/screens/ChatScreen';
import * as ankiShare from '../src/utils/ankiShare';

jest.mock('../src/api/auth');
jest.mock('../src/api/profile', () => ({
  ...jest.requireActual('../src/api/profile'),
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
}));
jest.mock('../src/api/sessions');
jest.mock('../src/api/vocabulary');
jest.mock('../src/utils/ankiShare');

const mockedAuth = jest.mocked(authApi);
const mockedProfile = jest.mocked(profileApi);
const mockedSessions = jest.mocked(sessionsApi);
const mockedVocabulary = jest.mocked(vocabularyApi);
const mockedShare = jest.mocked(ankiShare);
const mockedKeychain = Keychain as jest.Mocked<typeof Keychain> & {
  __resetKeychainStore: () => void;
};

const TOKENS = {access: 'access-1', refresh: 'refresh-1'};
const USER = {id: 1, username: 'alice', email: 'alice@example.com'};
const KEYCHAIN_SERVICE = 'com.elearningmobile.auth';
const MESSAGE_CONTENT = 'The early bird catches the worm.';
const EXPORT_CSV = 'Front,Back,Example,Pronunciation\n"early",,,\n';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 5,
    title: 'Traveling',
    topic: 'Talking about favorite destinations and travel plans.',
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

function messagePage(results: ChatMessage[]): Paginated<ChatMessage> {
  return {count: results.length, next: null, previous: null, results};
}

function sessionPage(results: Session[]): Paginated<Session> {
  return {count: results.length, next: null, previous: null, results};
}

function itemPage(results: VocabularyItem[]): Paginated<VocabularyItem> {
  return {count: results.length, next: null, previous: null, results};
}

async function seedKeychain(tokens: {access: string; refresh: string}) {
  await Keychain.setGenericPassword('elearning-auth', JSON.stringify(tokens), {
    service: KEYCHAIN_SERVICE,
  });
}

/** Simulate a native selection span over the pinned selection input. */
async function selectRange(start: number, end: number): Promise<void> {
  await fireEvent(
    screen.getByTestId('chat-selection-input'),
    'selectionChange',
    {nativeEvent: {selection: {start, end}}},
  );
}

/**
 * The Chat route may be mounted more than once (opening a session from
 * History pushes a second Chat instance), so screen-level controls are
 * resolved against the topmost mounted instance.
 */
function topScreenByTestId(
  testId: string,
): ReturnType<typeof screen.getAllByTestId>[number] {
  const matches = screen.getAllByTestId(testId);
  return matches[matches.length - 1];
}

/** Capture the word "early" out of the assistant message (sheet stays open). */
async function captureWordFromMessage(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId('chat-message-810')).toBeOnTheScreen(),
  );
  await fireEvent(screen.getByTestId('chat-message-810'), 'longPress');
  await fireEvent.press(screen.getByTestId('chat-menu-select-text'));
  expect(screen.getByTestId('chat-selection-input').props.value).toBe(
    MESSAGE_CONTENT,
  );
  await selectRange(4, 9);
  expect(screen.getByTestId('chat-selection-preview')).toHaveTextContent(
    'early',
  );
}

beforeEach(() => {
  mockedKeychain.__resetKeychainStore();
  jest.clearAllMocks();
});

describe('TASK-112 vocabulary journey', () => {
  it('saves a selected expression from chat and exports it from the vocabulary list', async () => {
    await seedKeychain(TOKENS);
    mockedAuth.getMe.mockResolvedValue(USER);
    mockedProfile.getProfile.mockResolvedValue({level: 'AUTO'});
    mockedSessions.listSessions.mockResolvedValue(sessionPage([makeSession()]));
    mockedSessions.getSession.mockResolvedValue(makeSession());
    mockedSessions.listMessages.mockResolvedValue(messagePage([makeMessage()]));
    mockedVocabulary.saveVocabulary.mockResolvedValue(makeItem());
    mockedVocabulary.listVocabulary.mockResolvedValue(itemPage([makeItem()]));
    mockedVocabulary.exportVocabulary.mockResolvedValue(EXPORT_CSV);
    mockedShare.shareAnkiCsv.mockResolvedValue(undefined);

    await render(<App />);

    // The restored session lands in the chat without a conversation open.
    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());

    // Enter the conversation through History.
    await fireEvent.press(screen.getByTestId('chat-open-history'));
    const sessionRow = await screen.findByTestId('history-item-5');
    await fireEvent.press(sessionRow);
    expect(mockedSessions.listMessages).toHaveBeenCalledWith(expect.any(Function), 5);

    // Text selection flow: long-press → Select text → capture "early".
    await captureWordFromMessage();

    // Pressing Save word starts the save immediately (TASK-AUDIT-007):
    // no confirmation popup, one API call with the trimmed expression and
    // its source message, then a self-dismissing confirmation toast —
    // enrichment is never awaited here (ROADMAP §9).
    jest.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.press(screen.getByTestId('chat-selection-save'));
      });

      expect(mockedVocabulary.saveVocabulary).toHaveBeenCalledTimes(1);
      expect(mockedVocabulary.saveVocabulary).toHaveBeenCalledWith(expect.any(Function), 'early', 810);
      expect(screen.queryByTestId('chat-vocab-modal')).toBeNull();
      expect(screen.getByTestId('chat-toast')).toHaveTextContent('Saved to vocabulary');

      await act(async () => {
        jest.advanceTimersByTime(VOCAB_TOAST_DURATION_MS);
      });
      expect(screen.queryByTestId('chat-toast')).toBeNull();
    } finally {
      jest.useRealTimers();
    }

    // Reach the vocabulary list through Settings.
    await fireEvent.press(topScreenByTestId('chat-open-settings'));
    await waitFor(() => expect(screen.getByTestId('settings-screen')).toBeOnTheScreen());
    await fireEvent.press(screen.getByTestId('settings-open-vocabulary'));

    // The saved expression is in the list, still enriching.
    expect(mockedVocabulary.listVocabulary).toHaveBeenCalledWith(expect.any(Function), 1);
    const savedRow = await screen.findByTestId('vocabulary-item-42');
    expect(within(savedRow).getByText('early')).toBeOnTheScreen();
    expect(within(savedRow).getByTestId('vocab-badge-pending')).toHaveTextContent(
      'Enriching…',
    );

    // The export action fetches the Anki CSV and hands it to the native
    // share seam, then confirms with its own toast.
    await fireEvent.press(screen.getByTestId('vocabulary-export'));
    await waitFor(() =>
      expect(mockedVocabulary.exportVocabulary).toHaveBeenCalledWith('access-1'),
    );
    await waitFor(() => expect(mockedShare.shareAnkiCsv).toHaveBeenCalledWith(EXPORT_CSV));
    expect(await screen.findByTestId('vocabulary-toast')).toHaveTextContent(
      'Vocabulary exported — choose where to save or share it',
    );
    expect(mockedShare.shareAnkiCsv).toHaveBeenCalledTimes(1);
  });

  it('a failed save surfaces an error toast and the vocabulary list stays empty', async () => {
    await seedKeychain(TOKENS);
    mockedAuth.getMe.mockResolvedValue(USER);
    mockedProfile.getProfile.mockResolvedValue({level: 'AUTO'});
    mockedSessions.listSessions.mockResolvedValue(sessionPage([makeSession()]));
    mockedSessions.getSession.mockResolvedValue(makeSession());
    mockedSessions.listMessages.mockResolvedValue(messagePage([makeMessage()]));
    mockedVocabulary.saveVocabulary.mockRejectedValue(
      new Error('Network request failed.'),
    );
    mockedVocabulary.listVocabulary.mockResolvedValue(itemPage([]));

    await render(<App />);

    await waitFor(() => expect(screen.getByTestId('chat-screen')).toBeOnTheScreen());
    await fireEvent.press(screen.getByTestId('chat-open-history'));
    await fireEvent.press(await screen.findByTestId('history-item-5'));

    await captureWordFromMessage();
    await fireEvent.press(screen.getByTestId('chat-selection-save'));

    // The failure surfaces as an alert toast (no confirmation popup ever
    // appears); nothing is stored and no success toast flashes.
    expect(await screen.findByTestId('chat-toast')).toBeOnTheScreen();
    expect(screen.getByTestId('chat-toast')).toHaveTextContent(
      'Network request failed.',
    );
    expect(screen.getByTestId('chat-toast-text').props.role).toBe('alert');
    expect(screen.queryByTestId('chat-vocab-modal')).toBeNull();
    expect(mockedVocabulary.saveVocabulary).toHaveBeenCalledTimes(1);

    // Nothing was stored: the vocabulary list renders its empty state.
    await fireEvent.press(topScreenByTestId('chat-open-settings'));
    await waitFor(() => expect(screen.getByTestId('settings-screen')).toBeOnTheScreen());
    await fireEvent.press(screen.getByTestId('settings-open-vocabulary'));

    expect(await screen.findByTestId('vocabulary-empty')).toBeOnTheScreen();
    expect(screen.queryAllByTestId(/^vocabulary-item-/)).toHaveLength(0);
  });
});
