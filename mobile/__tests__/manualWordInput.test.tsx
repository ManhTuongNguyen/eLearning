/**
 * Manual word input tests (WORD_BANK_V1 TASK-WB-011).
 *
 * Parsing is pinned as a pure helper (comma split, whitespace strip, empty
 * tokens dropped, duplicates dropped, 30-word bound enforced) and the modal is
 * pinned at the UI level: fixed-height internally-scrolling input, live
 * counter, submit disabled for empty or over-bound input, and a submission
 * running the same dictionary pipeline as generation.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import { createWordTopic, insertWords, listWordsByTopic } from '../src/db/wordRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { WordTopicScreenProps } from '../src/navigation/types';
import { WordTopicScreen } from '../src/screens/WordTopicScreen';
import { parseManualWordInput } from '../src/serverless/wordGeneration';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

// --- Parsing -----------------------------------------------------------------

describe('parseManualWordInput', () => {
  test('splits on commas, strips whitespace and drops empty tokens', () => {
    expect(parseManualWordInput(' bank , simmer,,  ,whisk ')).toEqual({
      words: ['bank', 'simmer', 'whisk'],
      total: 3,
    });
  });

  test('drops duplicates within the input and against existing words', () => {
    expect(parseManualWordInput('bank, Bank, BANK, whisk', ['whisk'])).toEqual({
      words: ['bank'],
      total: 1,
    });
    // Normalisation collapses punctuation, matching the stored key.
    expect(parseManualWordInput('"bank"', ['bank'])).toEqual({ words: [], total: 0 });
  });

  test('enforces the 30-word bound without hiding the true count', () => {
    const raw = Array.from({ length: 32 }, (_, index) => `word${index + 1}`).join(', ');
    const parsed = parseManualWordInput(raw);
    expect(parsed.words).toHaveLength(30);
    expect(parsed.total).toBe(32);
  });
});

// --- Modal / pipeline ----------------------------------------------------------

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
const lookupMock = jest.mocked(require('../src/serverless/dictionaryApi').lookupDictionaryWord);

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
    route: { key: 'word-topic-manual-test', name: 'WordTopic', params: { topicId } },
  } as unknown as WordTopicScreenProps;
}

let db: SqlDriver;

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
  lookupMock.mockResolvedValue({
    outcome: 'found',
    senses: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] }],
    phonetics: ['/wɜːd/'],
  });
});

afterEach(async () => {
  db?.close?.();
});

describe('WordTopicScreen — manual input modal', () => {
  test('an input of only commas and whitespace cannot be submitted', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const view = await renderTopicScreen(topic.id);

    await fireEvent.press(view.getByTestId('word-topic-add-words'));
    expect(view.getByTestId('word-manual-modal')).toBeTruthy();

    // Empty input: submit disabled.
    expect(view.getByTestId('word-manual-submit').props.accessibilityState).toMatchObject({
      disabled: true,
    });

    await fireEvent.changeText(view.getByTestId('word-manual-input'), ' , , ,   ');
    expect(view.getByTestId('word-manual-count')).toHaveTextContent('0 words');
    expect(view.getByTestId('word-manual-submit').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(view.queryByTestId('word-manual-count-error')).toBeFalsy();
  });

  test('the input keeps a fixed height and scrolls internally', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const view = await renderTopicScreen(topic.id);

    await fireEvent.press(view.getByTestId('word-topic-add-words'));
    const input = view.getByTestId('word-manual-input');
    expect(input.props.multiline).toBe(true);
    expect(input.props.scrollEnabled).toBe(true);
    expect(input.props.textAlignVertical).toBe('top');
    expect(input.props.placeholder).toBe('type, words, separated, by, commas');
  });

  test('submission inserts words exactly like generation and reports the summary', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
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
        phonetics: ['/bæŋk/'],
      };
    });

    const view = await renderTopicScreen(topic.id);
    await fireEvent.press(view.getByTestId('word-topic-add-words'));
    await fireEvent.changeText(view.getByTestId('word-manual-input'), ' bank , Bank , blurble , simmer ');

    // Duplicates within the input collapse into the counter.
    expect(view.getByTestId('word-manual-count')).toHaveTextContent('3 words');

    await fireEvent.press(view.getByTestId('word-manual-submit'));
    await waitFor(() => {
      expect(view.queryByTestId('word-review-modal')).toBeTruthy();
    });

    // The review modal carries the same candidates as a generation run.
    await fireEvent.press(view.getByTestId('word-review-keep-all'));
    await waitFor(() => {
      expect(view.queryByTestId('word-topic-summary')).toBeTruthy();
    });
    expect(view.getByTestId('word-topic-summary')).toHaveTextContent(
      'Kept 1 word with dictionary data, 1 without data (fetch it later from Word detail), 1 not found in the dictionary.',
    );

    const words = await listWordsByTopic(db, topic.id);
    expect(words.map(word => word.text).sort()).toEqual(['bank', 'simmer']);
    const missing = words.find(word => word.text === 'simmer');
    expect(missing?.data_status).toBe('missing');
    expect(missing?.senses_json).toEqual([]);
  });

  test('an input exceeding the 30-word bound cannot be submitted', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const view = await renderTopicScreen(topic.id);

    await fireEvent.press(view.getByTestId('word-topic-add-words'));
    const raw = Array.from({ length: 31 }, (_, index) => `word${index + 1}`).join(', ');
    await fireEvent.changeText(view.getByTestId('word-manual-input'), raw);

    expect(view.getByTestId('word-manual-count')).toHaveTextContent('31 words');
    expect(view.getByTestId('word-manual-count-error')).toHaveTextContent('Up to 30 words at a time.');
    expect(view.getByTestId('word-manual-submit').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(await listWordsByTopic(db, topic.id)).toEqual([]);
  });

  test('existing topic words are deduplicated from the input', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    await insertWords(db, topic.id, [{ text: 'bank' }]);
    const view = await renderTopicScreen(topic.id);

    await fireEvent.press(view.getByTestId('word-topic-add-words'));
    await fireEvent.changeText(view.getByTestId('word-manual-input'), 'bank, whisk');
    expect(view.getByTestId('word-manual-count')).toHaveTextContent('1 word');

    await fireEvent.press(view.getByTestId('word-manual-submit'));
    await waitFor(() => {
      expect(view.queryByTestId('word-review-modal')).toBeTruthy();
    });
    await fireEvent.press(view.getByTestId('word-review-keep-all'));

    const words = await listWordsByTopic(db, topic.id);
    expect(words.map(word => word.text).sort()).toEqual(['bank', 'whisk']);
  });
});
