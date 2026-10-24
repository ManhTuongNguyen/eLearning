/**
 * Word detail screen tests (WORD_BANK_V1 TASK-WB-013).
 *
 * The screen reads from the real repository on the in-memory sql.js driver:
 * all stored data renders (multiple POS groups, definitions with and without
 * examples, the schedule block), the fetch action exists only for dataless
 * words and resolves or keeps them via the injected dictionary seam, delete
 * asks for confirmation and removes the row with its review log, and the TTS
 * play button speaks through the injected engine.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  applyWordReviewState,
  createWordTopic,
  getWordById,
  insertWords,
  listWordReviewLog,
  logWordReview,
} from '../src/db/wordRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { WordDetailScreenProps } from '../src/navigation/types';
import { WordDetailScreen } from '../src/screens/WordDetailScreen';
import { ThemeProvider } from '../src/theme/ThemeContext';
import type { TextToSpeechEngine } from '../src/tts/textToSpeech';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

let db: SqlDriver;

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

jest.mock('../src/serverless/dictionaryApi', () => ({
  ...jest.requireActual('../src/serverless/dictionaryApi'),
  lookupDictionaryWord: jest.fn(),
}));

const database = jest.mocked(require('../src/db/database'));
const lookupMock = jest.mocked(require('../src/serverless/dictionaryApi').lookupDictionaryWord);

const goBack = jest.fn();
let listeners: Record<string, (() => void)[]> = {};

function screenProps(wordId: number): WordDetailScreenProps {
  return {
    navigation: {
      navigate: jest.fn(),
      goBack,
      popToTop: jest.fn(),
      addListener: (event: string, callback: () => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(callback);
        return () => {
          listeners[event] = listeners[event].filter(cb => cb !== callback);
        };
      },
    },
    route: { key: 'word-detail-test', name: 'WordDetail', params: { wordId } },
  } as unknown as WordDetailScreenProps;
}

function makeEngine(): { engine: TextToSpeechEngine; spoken: string[]; stopMock: jest.Mock } {
  const spoken: string[] = [];
  const stopMock = jest.fn();
  const engine: TextToSpeechEngine = {
    speak(text: string) {
      spoken.push(text);
      return Promise.resolve();
    },
    stop: stopMock,
  };
  return { engine, spoken, stopMock };
}

const SENSES = [
  {
    partOfSpeech: 'noun',
    definitions: [
      { definition: 'An institution that holds money.', example: 'I went to the bank.' },
      { definition: 'The land alongside a river.' },
    ],
  },
  {
    partOfSpeech: 'verb',
    definitions: [{ definition: 'To rely on.', example: 'You can bank on it.' }],
  },
];

async function renderDetail(wordId: number, speech?: TextToSpeechEngine) {
  await saveApplicationMode('serverless');
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <WordDetailScreen {...screenProps(wordId)} speech={speech} />
      </ThemeProvider>
    </ModeProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('word-detail-loading')).toBeFalsy();
  });
  return view;
}

beforeEach(async () => {
  jest.clearAllMocks();
  goBack.mockReset();
  listeners = {};
  db = await openSqlJsDriver();
  await migrateDatabase(db);
  database.__setDriver(db);
  lookupMock.mockResolvedValue({
    outcome: 'found',
    senses: SENSES,
    phonetics: ['/bæŋk/'],
  });
});

afterEach(async () => {
  db?.close?.();
});

describe('WordDetailScreen — rendering', () => {
  test('renders the word, phonetics, play button and every sense', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [
      { text: 'bank', senses_json: SENSES, phonetics_json: ['/bæŋk/', '/bæŋks/'] },
    ]);
    const { engine, spoken } = makeEngine();

    const view = await renderDetail(word.id, engine);

    expect(view.getByTestId('word-detail-word')).toHaveTextContent('bank');
    expect(view.getByTestId('word-detail-phonetics')).toHaveTextContent('/bæŋk/  /bæŋks/');
    expect(view.getAllByText('noun')).toHaveLength(1);
    expect(view.getAllByText('verb')).toHaveLength(1);
    expect(view.getByText('An institution that holds money.')).toBeTruthy();
    expect(view.getByText('I went to the bank.')).toBeTruthy();
    // A definition without an example renders without one.
    expect(view.getByText('The land alongside a river.')).toBeTruthy();

    await act(async () => {
      fireEvent.press(view.getByTestId('word-detail-play'));
    });
    expect(spoken).toEqual(['bank']);
  });

  test('renders the FSRS schedule block from the stored row', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [{ text: 'bank', senses_json: SENSES }]);
    await logWordReview(db, {
      word_id: word.id,
      topic_id: topic.id,
      grade: 'good',
      mode: 'dictation',
      reviewed_at: new Date().toISOString(),
    });
    await applyWordReviewState(db, word.id, {
      state: 'review',
      reps: 2,
      lapses: 1,
      stability: 4.2,
      difficulty: 5.5,
      elapsed_days: 1,
      scheduled_days: 3,
      learning_steps: 0,
      due_at: new Date(Date.now() + 86_400_000).toISOString(),
      last_grade: 'good',
      last_reviewed_at: new Date().toISOString(),
    });

    const view = await renderDetail(word.id);

    expect(view.getByTestId('word-detail-schedule-state')).toHaveTextContent('review');
    expect(view.getByTestId('word-detail-schedule-reps')).toHaveTextContent('2');
    expect(view.getByTestId('word-detail-schedule-lapses')).toHaveTextContent('1');
    expect(view.getByTestId('word-detail-schedule-stability')).toHaveTextContent('4.2');
    expect(view.getByTestId('word-detail-schedule-difficulty')).toHaveTextContent('5.5');
    expect(view.getByTestId('word-detail-schedule-last-grade')).toHaveTextContent(/good/);
  });
});

describe('WordDetailScreen — fetch dictionary data', () => {
  test('is absent for complete words, shown for missing words, and fills on success', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [complete] = await insertWords(db, topic.id, [
      { text: 'bank', senses_json: SENSES, phonetics_json: ['/bæŋk/'] },
    ]);
    const [missing] = await insertWords(db, topic.id, [{ text: 'blanch', data_status: 'missing' }]);

    const completeView = await renderDetail(complete.id);
    expect(completeView.queryByTestId('word-detail-fetch')).toBeNull();
    expect(completeView.getByTestId('word-detail-enrich').props.accessibilityState).toMatchObject({
      disabled: false,
    });

    const missingView = await renderDetail(missing.id);
    expect(missingView.getByTestId('word-detail-fetch')).toBeTruthy();
    // Enrich stays disabled until the data exists.
    expect(missingView.getByTestId('word-detail-enrich').props.accessibilityState).toMatchObject({
      disabled: true,
    });

    await fireEvent.press(missingView.getByTestId('word-detail-fetch'));
    await waitFor(() => {
      expect(missingView.getByTestId('word-detail-fetch-message')).toHaveTextContent(
        'Dictionary data saved.',
      );
    });
    const updated = await getWordById(db, missing.id);
    expect(updated?.data_status).toBe('complete');
    expect(updated?.senses_json).toEqual(SENSES);
    expect(updated?.phonetics_json).toEqual(['/bæŋk/']);
  });

  test('a 404 keeps the word missing with a not-found message', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [missing] = await insertWords(db, topic.id, [
      { text: 'blurble', data_status: 'missing' },
    ]);
    lookupMock.mockResolvedValue({ outcome: 'not-found' });

    const view = await renderDetail(missing.id);
    await fireEvent.press(view.getByTestId('word-detail-fetch'));

    await waitFor(() => {
      expect(view.getByTestId('word-detail-fetch-message')).toHaveTextContent(
        'Not found in the dictionary. The word stays without data.',
      );
    });
    const updated = await getWordById(db, missing.id);
    expect(updated?.data_status).toBe('missing');
  });

  test('a transient dictionary error surfaces an actionable message and keeps the word missing', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [missing] = await insertWords(db, topic.id, [{ text: 'blanch', data_status: 'missing' }]);
    lookupMock.mockResolvedValue({ outcome: 'unavailable' });

    const view = await renderDetail(missing.id);
    await fireEvent.press(view.getByTestId('word-detail-fetch'));

    await waitFor(() => {
      expect(view.getByTestId('word-detail-fetch-error')).toBeTruthy();
    });
    expect(await getWordById(db, missing.id)).toMatchObject({ data_status: 'missing' });
  });
});

describe('WordDetailScreen — delete', () => {
  test('confirms, then removes the word with its review log and navigates back', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [{ text: 'bank', senses_json: SENSES }]);
    await logWordReview(db, {
      word_id: word.id,
      topic_id: topic.id,
      grade: 'good',
      mode: 'dictation',
      reviewed_at: new Date().toISOString(),
    });

    const view = await renderDetail(word.id);
    await fireEvent.press(view.getByTestId('word-detail-delete'));

    expect(view.getByTestId('word-detail-delete-modal')).toBeTruthy();
    expect(view.getByTestId('word-detail-delete-title')).toHaveTextContent('Delete word?');

    // Nothing is removed until confirmation.
    expect(await getWordById(db, word.id)).not.toBeNull();

    await fireEvent.press(view.getByTestId('word-detail-delete-confirm'));
    await waitFor(() => {
      expect(goBack).toHaveBeenCalled();
    });
    expect(await getWordById(db, word.id)).toBeNull();
    expect(await listWordReviewLog(db, word.id)).toEqual([]);
  });

  test('cancelling keeps the word', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [{ text: 'bank', senses_json: SENSES }]);

    const view = await renderDetail(word.id);
    await fireEvent.press(view.getByTestId('word-detail-delete'));
    await fireEvent.press(view.getByTestId('word-detail-delete-cancel'));

    await waitFor(() => {
      expect(view.queryByTestId('word-detail-delete-modal')).toBeFalsy();
    });
    expect(goBack).not.toHaveBeenCalled();
    expect(await getWordById(db, word.id)).not.toBeNull();
  });
});
