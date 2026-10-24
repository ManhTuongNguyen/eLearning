/**
 * Generation review modal tests (WORD_BANK_V1 TASK-WB-010).
 *
 * Modal-level tests pin the row rendering (keep toggle, POS + first sense,
 * cross-topic hint, dictionary-unavailable hint) and the three actions.
 * Screen-level tests drive the real repository against the in-memory sql.js
 * driver: keep-all keeps every candidate, keep-selected removes exactly the
 * toggled-off rows, and discard writes nothing.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import type { WordRecord } from '../src/db/types';
import { createWordTopic, insertWords, listWordsByTopic } from '../src/db/wordRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { WordTopicScreenProps } from '../src/navigation/types';
import { WordReviewModal } from '../src/screens/WordReviewModal';
import { WordTopicScreen } from '../src/screens/WordTopicScreen';
import type { LLMClientConfig } from '../src/serverless/types';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

// --- Modal-level -------------------------------------------------------------

const CANDIDATES: WordRecord[] = [
  {
    id: 1,
    topic_id: 10,
    text: 'bank',
    normalized_text: 'bank',
    senses_json: [
      {
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'An institution that holds money.', example: 'I went to the bank.' },
        ],
      },
    ],
    phonetics_json: ['/bæŋk/'],
    data_source: 'dictionary',
    data_status: 'complete',
    enriched_at: null,
    state: 'new',
    suspended: false,
    reps: 0,
    lapses: 0,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    due_at: '2026-10-24T09:00:00.000Z',
    last_grade: '',
    last_reviewed_at: '',
    created_at: '2026-10-24T09:00:00.000Z',
    updated_at: '2026-10-24T09:00:00.000Z',
  },
  {
    ...CANDIDATE_TEMPLATE(),
    id: 2,
    text: 'simmer',
    normalized_text: 'simmer',
    senses_json: [],
    phonetics_json: [],
    data_status: 'missing',
  },
];

function CANDIDATE_TEMPLATE(): WordRecord {
  return {
    id: 0,
    topic_id: 10,
    text: '',
    normalized_text: '',
    senses_json: [],
    phonetics_json: [],
    data_source: 'dictionary',
    data_status: 'complete',
    enriched_at: null,
    state: 'new',
    suspended: false,
    reps: 0,
    lapses: 0,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    due_at: '2026-10-24T09:00:00.000Z',
    last_grade: '',
    last_reviewed_at: '',
    created_at: '2026-10-24T09:00:00.000Z',
    updated_at: '2026-10-24T09:00:00.000Z',
  };
}

async function renderModal(overrides: Partial<Parameters<typeof WordReviewModal>[0]> = {}) {
  const props: Parameters<typeof WordReviewModal>[0] = {
    visible: true,
    candidates: CANDIDATES,
    duplicateTopicTitles: { 2: 'Finance' },
    busy: false,
    error: null,
    onKeepAll: jest.fn(),
    onKeepSelected: jest.fn(),
    onDiscard: jest.fn(),
    ...overrides,
  };
  await render(
    <ThemeProvider>
      <WordReviewModal {...props} />
    </ThemeProvider>,
  );
  return { props };
}

describe('WordReviewModal — rows', () => {
  test('renders each candidate with word, POS, first sense and a keep toggle', async () => {
    await renderModal();

    expect(screen.getByTestId('word-review-title')).toHaveTextContent('Review new words');
    expect(screen.getByText('bank')).toBeTruthy();
    expect(screen.getByText('noun — An institution that holds money.')).toBeTruthy();
    expect(screen.getByTestId('word-review-keep-1').props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(screen.getByTestId('word-review-keep-2').props.accessibilityState).toMatchObject({
      checked: true,
    });
  });

  test('a cross-topic duplicate shows "already in <topic>" without blocking', async () => {
    await renderModal();

    expect(screen.getByTestId('word-review-duplicate-2')).toHaveTextContent('already in Finance');
    expect(screen.getByTestId('word-review-keep-2').props.accessibilityState).toMatchObject({
      checked: true,
    });
  });

  test('a dataless candidate shows the dictionary-unavailable hint', async () => {
    await renderModal();

    expect(screen.getByTestId('word-review-missing-2')).toHaveTextContent(
      'dictionary unavailable — fetch its data later from Word detail',
    );
  });

  test('renders nothing while closed', async () => {
    await renderModal({ visible: false });
    expect(screen.queryByTestId('word-review-modal')).toBeNull();
  });

  test('the candidate list scrolls inside the card so the actions stay reachable', async () => {
    await renderModal();

    const scroll = screen.getByTestId('word-review-list-scroll');
    expect(scroll.props.nestedScrollEnabled).toBe(true);
    // The buttons live outside the scroll view, so they stay visible even
    // while the list itself overflows.
    expect(screen.getByTestId('word-review-keep-all')).toBeTruthy();
    expect(screen.getByTestId('word-review-discard')).toBeTruthy();
  });
});

describe('WordReviewModal — actions', () => {
  test('keep-all reports every candidate', async () => {
    const { props } = await renderModal();

    fireEvent.press(screen.getByTestId('word-review-keep-all'));

    expect(props.onKeepAll).toHaveBeenCalledTimes(1);
  });

  test('keep-selected reports exactly the kept ids and is disabled when nothing is selected', async () => {
    const { props } = await renderModal();

    const keepSelected = screen.getByTestId('word-review-keep-selected');
    expect(keepSelected.props.accessibilityState).toMatchObject({ disabled: true });

    fireEvent.press(screen.getByTestId('word-review-keep-2'));
    await waitFor(() =>
      expect(screen.getByTestId('word-review-keep-selected')).toHaveTextContent('Keep 1 selected'),
    );
    expect(screen.getByTestId('word-review-keep-selected').props.accessibilityState).toMatchObject({
      disabled: false,
    });

    fireEvent.press(screen.getByTestId('word-review-keep-selected'));
    expect(props.onKeepSelected).toHaveBeenCalledWith([1]);
  });

  test('discard closes without reporting any keeps', async () => {
    const { props } = await renderModal();

    fireEvent.press(screen.getByTestId('word-review-discard'));

    expect(props.onDiscard).toHaveBeenCalledTimes(1);
    expect(props.onKeepAll).not.toHaveBeenCalled();
    expect(props.onKeepSelected).not.toHaveBeenCalled();
  });
});

// --- Screen-level ------------------------------------------------------------

jest.mock('../src/db/database', () => {
  const actualMigrations = jest.requireActual('../src/db/migrations').migrateDatabase;
  const handle: { db: SqlDriver } = { db: undefined as never };
  return {
    getLocalDatabase: jest.fn(async () => {
      await actualMigrations(handle.db);
      return handle.db;
    }),
    resetLocalDatabase: jest.fn(),
    __setDriver: (driver: SqlDriver) => {
      handle.db = driver;
    },
  };
});

jest.mock('../src/serverless/settings', () => ({
  loadServerlessConfig: jest.fn(),
}));

jest.mock('../src/serverless/providerRegistry', () => ({
  createProviderClient: jest.fn(),
}));

jest.mock('../src/serverless/dictionaryApi', () => ({
  ...jest.requireActual('../src/serverless/dictionaryApi'),
  lookupDictionaryWord: jest.fn(),
}));

const database = jest.mocked(require('../src/db/database'));
const settings = jest.mocked(require('../src/serverless/settings'));
const registry = jest.mocked(require('../src/serverless/providerRegistry'));
const dictionaryApi = jest.mocked(require('../src/serverless/dictionaryApi'));
const lookupMock = dictionaryApi.lookupDictionaryWord as jest.Mock;

const CONFIG: LLMClientConfig = {
  provider: 'openrouter',
  apiKey: 'test-key',
  primaryModel: 'test-model',
  fallbackModels: [],
};

const navigate = jest.fn();
let listeners: Record<string, (() => void)[]> = {};

function screenProps(topicId: number): WordTopicScreenProps {
  return {
    navigation: {
      navigate,
      goBack: jest.fn(),
      popToTop: jest.fn(),
      addListener: (event: string, callback: () => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(callback);
        return () => {
          listeners[event] = listeners[event].filter(cb => cb !== callback);
        };
      },
    },
    route: { key: 'word-topic-review-test', name: 'WordTopic', params: { topicId } },
  } as unknown as WordTopicScreenProps;
}

let db: SqlDriver;
let complete: jest.Mock;

async function renderTopicScreen(topicId: number) {
  await saveApplicationMode('serverless');
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <WordTopicScreen {...screenProps(topicId)} />
      </ThemeProvider>
    </ModeProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('word-topic-loading')).toBeFalsy();
  });
  return view;
}

beforeEach(async () => {
  jest.clearAllMocks();
  navigate.mockReset();
  listeners = {};
  db = await openSqlJsDriver();
  await migrateDatabase(db);
  database.__setDriver(db);
  settings.loadServerlessConfig.mockResolvedValue(CONFIG);
  complete = jest.fn();
  registry.createProviderClient.mockReturnValue({ complete } as never);
  lookupMock.mockImplementation(async (word: string) => {
    if (word === 'blurble') {
      return { outcome: 'not-found' };
    }
    return {
      outcome: 'found',
      senses: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] }],
      phonetics: ['/wɜːd/'],
    };
  });
});

afterEach(async () => {
  db?.close?.();
});

async function generateThree(db_: SqlDriver, topicId: number) {
  const other = await createWordTopic(db_, { title: 'Finance' });
  await insertWords(db_, other.id, [{ text: 'ledger' }]);
  complete.mockResolvedValue({
    text: '["bank", "ledger", "blurble", "simmer"]',
    model: 'test-model',
    finishReason: 'stop',
    requestId: null,
  });
  lookupMock.mockImplementation(async (word: string) => {
    if (word === 'blurble') {
      return { outcome: 'not-found' };
    }
    if (word === 'simmer') {
      return { outcome: 'unavailable' };
    }
    return {
      outcome: 'found',
      senses: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] }],
      phonetics: ['/wɜːd/'],
    };
  });

  const view = await renderTopicScreen(topicId);
  await fireEvent.press(view.getByTestId('word-topic-more'));
  await fireEvent.press(view.getByTestId('word-topic-menu-generate'));
  await fireEvent.press(view.getByTestId('word-generate-submit'));
  await waitFor(() => {
    expect(view.queryByTestId('word-review-modal')).toBeTruthy();
  });
  return view;
}

describe('WordTopicScreen — review modal reconciliation', () => {
  test('keep-all persists every candidate; ledger shows its cross-topic hint', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const view = await generateThree(db, topic.id);

    // The cross-topic duplicate is surfaced but not blocking.
    const rows = await listWordsByTopic(db, topic.id);
    const ledger = rows.find(word => word.text === 'ledger');
    expect(ledger).toBeTruthy();
    expect(view.getByTestId(`word-review-duplicate-${ledger?.id}`)).toHaveTextContent(
      'already in Finance',
    );

    await fireEvent.press(view.getByTestId('word-review-keep-all'));

    await waitFor(() => {
      expect(view.queryByTestId('word-review-modal')).toBeFalsy();
    });
    const words = await listWordsByTopic(db, topic.id);
    expect(words.map(word => word.text).sort()).toEqual(['bank', 'ledger', 'simmer']);
  });

  test('keep-selected removes exactly the toggled-off rows', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const view = await generateThree(db, topic.id);
    const rows = await listWordsByTopic(db, topic.id);
    const bank = rows.find(word => word.text === 'bank');
    const ledger = rows.find(word => word.text === 'ledger');

    // Untick bank (found) and ledger (the cross-topic duplicate).
    await fireEvent.press(view.getByTestId(`word-review-keep-${bank?.id}`));
    await fireEvent.press(view.getByTestId(`word-review-keep-${ledger?.id}`));
    await fireEvent.press(view.getByTestId('word-review-keep-selected'));

    await waitFor(() => {
      expect(view.queryByTestId('word-review-modal')).toBeFalsy();
    });
    const words = await listWordsByTopic(db, topic.id);
    expect(words.map(word => word.text).sort()).toEqual(['simmer']);
    const missing = words[0];
    expect(missing.data_status).toBe('missing');
    expect(missing.senses_json).toEqual([]);
    expect(missing.phonetics_json).toEqual([]);
  });

  test('discard closes without writing anything', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const view = await generateThree(db, topic.id);
    const before = await listWordsByTopic(db, topic.id);
    expect(before.map(word => word.text).sort()).toEqual(['bank', 'ledger', 'simmer']);

    await fireEvent.press(view.getByTestId('word-review-discard'));

    await waitFor(() => {
      expect(view.queryByTestId('word-review-modal')).toBeFalsy();
    });
    const after = await listWordsByTopic(db, topic.id);
    expect(after.map(word => word.text).sort()).toEqual(['bank', 'ledger', 'simmer']);
  });
});
