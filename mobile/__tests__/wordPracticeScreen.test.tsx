/**
 * Word practice screen tests (WORD_BANK_V1 TASK-WB-012).
 *
 * Drives the real repository against the in-memory sql.js driver and the
 * shared session queue: due-only selection, dictation vs recall card shapes,
 * the typed-answer pre-suggestion, grading persistence (schedule + review log
 * with the right mode and memory state), requeue-until-review, masked recall
 * fronts and the caught-up empty state. TTS runs through an injected engine
 * double.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  applyWordReviewState,
  createWordTopic,
  insertWords,
  listWordReviewLog,
  listWordsByTopic,
} from '../src/db/wordRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { WordPracticeScreenProps } from '../src/navigation/types';
import type { WordRecord } from '../src/db/types';
import { WordPracticeScreen } from '../src/screens/WordPracticeScreen';
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

jest.mock('../src/serverless/settings', () => ({
  loadServerlessConfig: jest.fn(),
}));

const database = jest.mocked(require('../src/db/database'));

const navigate = jest.fn();
const goBack = jest.fn();
let listeners: Record<string, (() => void)[]> = {};

function screenProps(topicId: number): WordPracticeScreenProps {
  return {
    navigation: {
      navigate,
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
    route: { key: 'word-practice-test', name: 'WordPractice', params: { topicId } },
  } as unknown as WordPracticeScreenProps;
}

function makeDeferredEngine(): {
  engine: TextToSpeechEngine;
  spoken: string[];
  stopMock: jest.Mock;
} {
  const spoken: string[] = [];
  const stopMock = jest.fn();
  const engine: TextToSpeechEngine = {
    speak(text: string) {
      spoken.push(text);
      // Resolve immediately; the one-playback contract is exercised in the
      // topic screen tests, here only auto-play and replay matter.
      return Promise.resolve();
    },
    stop: stopMock,
  };
  return { engine, spoken, stopMock };
}

const SENSES = [
  {
    partOfSpeech: 'noun',
    definitions: [{ definition: 'A financial institution.', example: 'I went to the bank.' }],
  },
];

async function createTopicWithWords(count: number, title = 'Cooking'): Promise<number> {
  const topic = await createWordTopic(db, { title, description: 'test topic' });
  if (count > 0) {
    await insertWords(
      db,
      topic.id,
      Array.from({ length: count }, (_, index) => ({
        text: `word${index + 1}`,
        senses_json: SENSES,
        phonetics_json: ['/wɜːd/'],
      })),
    );
  }
  return topic.id;
}

async function renderPractice(topicId: number, speech?: TextToSpeechEngine) {
  await saveApplicationMode('serverless');
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <WordPracticeScreen {...screenProps(topicId)} speech={speech} />
      </ThemeProvider>
    </ModeProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('word-practice-loading')).toBeFalsy();
  });
  return view;
}

/** Promote a word into the review state so its card shape becomes recall. */
async function promoteToReview(word: WordRecord): Promise<void> {
  await applyWordReviewState(db, word.id, {
    state: 'review',
    reps: 1,
    lapses: 0,
    stability: 3,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 0,
    due_at: new Date(Date.now() - 86_400_000).toISOString(), // due yesterday
    last_grade: 'good',
    last_reviewed_at: new Date(Date.now() - 86_400_000).toISOString(),
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  navigate.mockReset();
  goBack.mockReset();
  listeners = {};
  db = await openSqlJsDriver();
  await migrateDatabase(db);
  database.__setDriver(db);
});

afterEach(async () => {
  db?.close?.();
});

describe('WordPracticeScreen — session build', () => {
  test('empty topic shows the caught-up state with no next-due line', async () => {
    const topicId = await createTopicWithWords(0);

    const view = await renderPractice(topicId);

    expect(view.getByTestId('word-practice-summary')).toBeTruthy();
    expect(view.getByText('All caught up')).toBeTruthy();
    expect(view.queryByTestId('word-practice-next-due')).toBeFalsy();
  });

  test('shows the progress counter and only due words enter the session', async () => {
    const topicId = await createTopicWithWords(3);
    const words = await listWordsByTopic(db, topicId);
    // Push word1 into the future: only word2/word3 are due.
    const word1 = words.find(w => w.text === 'word1');
    await applyWordReviewState(db, word1?.id ?? -1, {
      state: 'review',
      reps: 1,
      lapses: 0,
      stability: 3,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 5,
      learning_steps: 0,
      due_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      last_grade: 'good',
      last_reviewed_at: new Date().toISOString(),
    });

    const view = await renderPractice(topicId);

    expect(view.getByTestId('word-practice-progress')).toHaveTextContent('1 / 2');
    expect(view.getByTestId('word-practice-replay')).toBeTruthy(); // dictation card
  });
});

describe('WordPracticeScreen — dictation card', () => {
  test('auto-plays the word once, replays, and Check pre-suggests Good for a typo', async () => {
    const topicId = await createTopicWithWords(1);
    const { engine, spoken } = makeDeferredEngine();

    const view = await renderPractice(topicId, engine);
    await waitFor(() => {
      expect(spoken).toEqual(['word1']);
    });

    await fireEvent.changeText(view.getByTestId('word-practice-answer'), 'word2');
    await fireEvent.press(view.getByTestId('word-practice-check'));

    // One typo-sized edit → Good is pre-suggested.
    await waitFor(() => {
      expect(view.getByTestId('word-practice-grade-good')).toHaveTextContent(/✓/);
    });

    await act(async () => {
      fireEvent.press(view.getByTestId('word-practice-replay'));
    });
    expect(spoken).toEqual(['word1', 'word1']);
  });

  test('grading persists the schedule and the review log with the dictation mode', async () => {
    const topicId = await createTopicWithWords(1);
    const view = await renderPractice(topicId);

    await fireEvent.changeText(view.getByTestId('word-practice-answer'), 'word1');
    await fireEvent.press(view.getByTestId('word-practice-check'));
    await fireEvent.press(view.getByTestId('word-practice-grade-good'));

    // The first Good advances a new card to the 10-minute learning step.
    await waitFor(async () => {
      const words = await listWordsByTopic(db, topicId);
      expect(words[0].state).toBe('learning');
    });
    const words = await listWordsByTopic(db, topicId);
    expect(words[0].reps).toBe(1);
    expect(words[0].last_grade).toBe('good');

    const log = await listWordReviewLog(db, words[0].id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      grade: 'good',
      rating: 3,
      state: 'new',
      mode: 'dictation',
    });
  });

  test('a learning word requeues until FSRS graduates it', async () => {
    const topicId = await createTopicWithWords(1);
    const view = await renderPractice(topicId);

    // First Good advances to the 10-minute learning step: the card requeues
    // and the session grows by one presentation (same formula as sentences).
    await fireEvent.changeText(view.getByTestId('word-practice-answer'), 'word1');
    await fireEvent.press(view.getByTestId('word-practice-check'));
    await fireEvent.press(view.getByTestId('word-practice-grade-good'));

    await waitFor(() => {
      expect(view.getByTestId('word-practice-progress')).toHaveTextContent('2 / 2');
    });
    let words = await listWordsByTopic(db, topicId);
    expect(words[0].state).toBe('learning');

    // Grading the requeued card again graduates it and ends the session.
    await fireEvent.changeText(view.getByTestId('word-practice-answer'), 'word1');
    await fireEvent.press(view.getByTestId('word-practice-check'));
    await fireEvent.press(view.getByTestId('word-practice-grade-good'));

    await waitFor(() => {
      expect(view.queryByTestId('word-practice-summary')).toBeTruthy();
    });
    words = await listWordsByTopic(db, topicId);
    expect(words[0].state).toBe('review');
  });
});

describe('WordPracticeScreen — recall card', () => {
  test('review words get a recall card whose front masks the word', async () => {
    const topicId = await createTopicWithWords(0);
    await insertWords(db, topicId, [
      {
        text: 'bank',
        senses_json: [
          {
            partOfSpeech: 'noun',
            definitions: [{ definition: 'The bank holds money.', example: 'I went to the bank.' }],
          },
        ],
        phonetics_json: ['/bæŋk/'],
      },
    ]);
    const words = await listWordsByTopic(db, topicId);
    await promoteToReview(words[0]);

    const view = await renderPractice(topicId);

    expect(view.getByTestId('word-practice-recall-front')).toBeTruthy();
    // Both occurrences render as first letter + underscores…
    expect(view.getAllByText('b___')).toHaveLength(2);
    // …and the unmasked surface form appears nowhere on the front.
    expect(view.queryByText('bank')).toBeNull();
  });

  test('the reveal unmasks, plays the audio and shows the full data', async () => {
    const topicId = await createTopicWithWords(1);
    const words = await listWordsByTopic(db, topicId);
    await promoteToReview(words[0]);
    const { engine, spoken } = makeDeferredEngine();

    const view = await renderPractice(topicId, engine);
    await fireEvent.changeText(view.getByTestId('word-practice-answer'), 'bank');
    await fireEvent.press(view.getByTestId('word-practice-check'));

    await waitFor(() => {
      expect(view.getByTestId('word-practice-recall-reveal')).toBeTruthy();
    });
    expect(spoken).toEqual(['word1']);
    expect(view.getByText('word1')).toBeTruthy();

    await fireEvent.press(view.getByTestId('word-practice-grade-easy'));
    await waitFor(() => {
      expect(view.queryByTestId('word-practice-summary')).toBeTruthy();
    });
    const log = await listWordReviewLog(db, words[0].id);
    expect(log[0]).toMatchObject({ grade: 'easy', mode: 'recall', rating: 4 });
  });
});
