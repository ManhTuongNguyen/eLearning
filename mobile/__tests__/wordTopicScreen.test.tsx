/**
 * Word topic screen tests (WORD_BANK_V1 TASK-WB-009).
 *
 * Exercises the real repository against the in-memory sql.js driver: the list
 * renders from storage, the search box filters client-side and restores on
 * clear, deleting from a filtered view removes the row from the database, and
 * generation flows through the injected provider completion + dictionary
 * lookup seams into the kept/missing/not-found summary. TTS is verified
 * through an injected engine double, including one-playback-at-a-time and
 * blur silencing.
 */

import { act, fireEvent, type RenderResult, render, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  createWordTopic,
  getSystemWordTopic,
  insertWords,
  listWordsByTopic,
} from '../src/db/wordRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { WordTopicScreenProps } from '../src/navigation/types';
import { WordTopicScreen } from '../src/screens/WordTopicScreen';
import type { LLMClientConfig } from '../src/serverless/types';
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
const goBack = jest.fn();
let listeners: Record<string, (() => void)[]> = {};

function flushBlur(): Promise<void> {
  return act(async () => {
    (listeners.blur ?? []).forEach(callback => {
      callback();
    });
  });
}

function screenProps(topicId: number): WordTopicScreenProps {
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
    route: {
      key: 'word-topic-test',
      name: 'WordTopic',
      params: { topicId },
    },
  } as unknown as WordTopicScreenProps;
}

function makeDeferredEngine(): {
  engine: TextToSpeechEngine;
  spoken: { text: string; release: () => void }[];
  stopMock: jest.Mock;
} {
  const spoken: { text: string; release: () => void }[] = [];
  const stopMock = jest.fn();
  const engine: TextToSpeechEngine = {
    speak(text: string) {
      return new Promise<void>(resolve => {
        spoken.push({ text, release: resolve });
      });
    },
    stop: stopMock,
  };
  return { engine, spoken, stopMock };
}

async function renderScreen(topicId: number, speech?: TextToSpeechEngine) {
  await saveApplicationMode('serverless');
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <WordTopicScreen {...screenProps(topicId)} speech={speech} />
      </ThemeProvider>
    </ModeProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('word-topic-loading')).toBeFalsy();
  });
  return view;
}

async function createTopicWithWords(count: number, title = 'Cooking') {
  const topic = await createWordTopic(db, {
    title,
    description: "I'm a chef, I often read cooking blogs.",
  });
  if (count > 0) {
    await insertWords(
      db,
      topic.id,
      Array.from({ length: count }, (_, index) => ({
        text: `word${index + 1}`,
        senses_json: [
          { partOfSpeech: 'noun', definitions: [{ definition: `Sense ${index + 1}.` }] },
        ],
        phonetics_json: ['/wɜːd/'],
      })),
    );
  }
  return topic;
}

let complete: jest.Mock;

/** The seeded collected-words topic, with the null check the linter wants. */
async function requireSystemTopic() {
  const system = await getSystemWordTopic(db);
  if (!system) {
    throw new Error('expected the seeded system topic');
  }
  return system;
}

beforeEach(async () => {
  jest.clearAllMocks();
  navigate.mockReset();
  goBack.mockReset();
  listeners = {};
  db = await openSqlJsDriver();
  await migrateDatabase(db);
  database.__setDriver(db);
  settings.loadServerlessConfig.mockResolvedValue(CONFIG);
  complete = jest.fn();
  registry.createProviderClient.mockReturnValue({ complete } as never);
  lookupMock.mockResolvedValue({
    outcome: 'found',
    senses: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] }],
    phonetics: ['/wɜːd/'],
  });
});

afterEach(async () => {
  db?.close?.();
});

describe('WordTopicScreen — word list', () => {
  test('renders the topic header, words, POS labels and status hints', async () => {
    const topic = await createTopicWithWords(2);
    const words = await listWordsByTopic(db, topic.id);

    const view = await renderScreen(topic.id);

    // The header matches the sentence topic screen: small title beside the
    // back link, description in its own scrollable box below (no shared
    // margins).
    expect(view.getByTestId('word-topic-title')).toHaveTextContent('Cooking');
    expect(view.getByText('‹ Back')).toBeTruthy();
    expect(view.getByTestId('word-topic-description')).toHaveTextContent(
      "I'm a chef, I often read cooking blogs.",
    );
    expect(view.getByTestId('word-topic-description-scroll').props.nestedScrollEnabled).toBe(true);
    expect(view.getByText('word1')).toBeTruthy();
    expect(view.getByText('word2')).toBeTruthy();
    expect(view.getAllByText('noun').length).toBe(2);
    // A fresh word is immediately due, so the hint reads "due".
    expect(view.getByTestId(`word-${words[0].id}-status`)).toHaveTextContent('due');
  });

  test('plays a word through TTS, one at a time, and stops on blur', async () => {
    const topic = await createTopicWithWords(2);
    const words = await listWordsByTopic(db, topic.id);
    const first = words.find(word => word.text === 'word1');
    const second = words.find(word => word.text === 'word2');
    const { engine, spoken, stopMock } = makeDeferredEngine();

    const view = await renderScreen(topic.id, engine);

    await act(async () => {
      fireEvent.press(view.getByTestId(`word-speak-${first?.id}`));
    });
    expect(spoken.map(entry => entry.text)).toEqual(['word1']);

    // Starting the second halts the first (one playback at a time).
    await act(async () => {
      fireEvent.press(view.getByTestId(`word-speak-${second?.id}`));
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(spoken.map(entry => entry.text)).toEqual(['word1', 'word2']);

    // Blur silences the engine while the second utterance is still in flight.
    await flushBlur();
    expect(stopMock).toHaveBeenCalledTimes(2);

    // Settle the pending utterance so the test ends cleanly.
    await act(async () => {
      for (const entry of spoken) {
        entry.release();
      }
    });
  });
});

describe('WordTopicScreen — search', () => {
  test('filters case-insensitively, shows the count and restores on clear', async () => {
    const topic = await createTopicWithWords(3);
    const words = await listWordsByTopic(db, topic.id);

    const view = await renderScreen(topic.id);
    expect(view.getByText('word1')).toBeTruthy();

    await fireEvent.changeText(view.getByTestId('word-topic-search'), 'WORD2');
    await waitFor(() => {
      expect(view.queryByText('word1')).toBeFalsy();
    });
    expect(view.getByText('word2')).toBeTruthy();
    expect(view.getByTestId('word-topic-search-count')).toHaveTextContent('1 match');

    await fireEvent.changeText(view.getByTestId('word-topic-search'), 'zzz');
    await waitFor(() => {
      expect(view.getByTestId('word-topic-no-match')).toBeTruthy();
    });
    expect(view.getByTestId('word-topic-search-count')).toHaveTextContent('0 matches');

    await fireEvent.changeText(view.getByTestId('word-topic-search'), '');
    await waitFor(() => {
      expect(view.getByText('word1')).toBeTruthy();
      expect(view.getByText('word3')).toBeTruthy();
    });
    expect(view.queryByTestId('word-topic-search-count')).toBeFalsy();
    expect(words).toHaveLength(3);
  });

  test('deleting from a filtered view removes the row from the database', async () => {
    const topic = await createTopicWithWords(3);
    const words = await listWordsByTopic(db, topic.id);
    const victim = words[1]; // word2

    const view = await renderScreen(topic.id);
    await fireEvent.changeText(view.getByTestId('word-topic-search'), 'word2');
    await waitFor(() => {
      expect(view.getByTestId(`word-delete-${victim.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`word-delete-${victim.id}`));
    expect(view.getByTestId('word-delete-modal')).toBeTruthy();
    await fireEvent.press(view.getByTestId('word-delete-confirm'));

    await waitFor(() => {
      expect(view.queryByTestId(`word-${victim.id}`)).toBeFalsy();
    });
    const remaining = await listWordsByTopic(db, topic.id);
    expect(remaining.map(word => word.text)).toEqual(['word3', 'word1']);

    // Clearing the search shows the full underlying list, victim gone.
    await fireEvent.changeText(view.getByTestId('word-topic-search'), '');
    await waitFor(() => {
      expect(view.queryByText('word2')).toBeFalsy();
      expect(view.getByText('word1')).toBeTruthy();
    });
  });
});

describe('WordTopicScreen — practice unlock', () => {
  test('is disabled below 5 words and explains how many more are needed', async () => {
    const topic = await createTopicWithWords(3);

    const view = await renderScreen(topic.id);

    expect(view.getByTestId('word-topic-practice').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(view.getByTestId('word-topic-practice-hint')).toHaveTextContent(
      'Practice unlocks at 5 words — add 2 more.',
    );
  });

  test('is enabled at 5 words and navigates to practice', async () => {
    const topic = await createTopicWithWords(5);

    const view = await renderScreen(topic.id);

    expect(view.getByTestId('word-topic-practice').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    expect(view.queryByTestId('word-topic-practice-hint')).toBeFalsy();

    await fireEvent.press(view.getByTestId('word-topic-practice'));
    expect(navigate).toHaveBeenCalledWith('WordPractice', { topicId: topic.id });
  });
});

/** Generation now lives behind the header's three-dot overflow menu. */
async function openGenerate(view: RenderResult) {
  await fireEvent.press(view.getByTestId('word-topic-more'));
  await fireEvent.press(view.getByTestId('word-topic-menu-generate'));
}

describe('WordTopicScreen — overflow menu', () => {
  test('the three-dot menu offers Generate and Add words and closes on backdrop', async () => {
    const topic = await createTopicWithWords(0);
    const view = await renderScreen(topic.id);

    await fireEvent.press(view.getByTestId('word-topic-more'));
    expect(view.getByTestId('word-topic-menu-sheet')).toBeTruthy();
    expect(view.getByTestId('word-topic-menu-generate')).toBeTruthy();
    expect(view.getByTestId('word-topic-menu-add-words')).toBeTruthy();

    await fireEvent.press(view.getByTestId('word-topic-menu-backdrop'));
    await waitFor(() => {
      expect(view.queryByTestId('word-topic-menu-sheet')).toBeFalsy();
    });
  });
});

describe('WordTopicScreen — generation', () => {
  test('the count input validates 1-30 and disables an invalid submit', async () => {
    const topic = await createTopicWithWords(0);

    const view = await renderScreen(topic.id);
    await openGenerate(view);
    expect(view.getByTestId('word-generate-modal')).toBeTruthy();

    // Default is 10 and valid.
    expect(view.getByTestId('word-generate-count').props.value).toBe('10');
    expect(view.getByTestId('word-generate-submit').props.accessibilityState).toMatchObject({
      disabled: false,
    });

    await fireEvent.changeText(view.getByTestId('word-generate-count'), '31');
    expect(view.getByTestId('word-generate-count-error')).toHaveTextContent(
      'Enter a number between 1 and 30.',
    );
    expect(view.getByTestId('word-generate-submit').props.accessibilityState).toMatchObject({
      disabled: true,
    });

    await fireEvent.changeText(view.getByTestId('word-generate-count'), 'abc');
    expect(view.getByTestId('word-generate-submit').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  test('generation requests N words, inserts found words and reports the summary', async () => {
    const topic = await createTopicWithWords(0);
    complete.mockResolvedValue({
      text: '["bank", "simmer"]',
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderScreen(topic.id);
    await openGenerate(view);
    await fireEvent.changeText(view.getByTestId('word-generate-count'), '2');
    await fireEvent.press(view.getByTestId('word-generate-submit'));

    await waitFor(() => {
      expect(view.queryByTestId('word-topic-summary')).toBeTruthy();
    });
    // The AI was asked for 2 words through the provider seam.
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0];
    const userPrompt = request.messages.find((m: { role: string }) => m.role === 'user').content;
    expect(userPrompt).toContain('Choose 2 English words');

    // Found words are inserted with dictionary data.
    const words = await listWordsByTopic(db, topic.id);
    expect(words.map(word => word.text).sort()).toEqual(['bank', 'simmer']);
    expect(words[0].data_status).toBe('complete');
    expect(view.getByTestId('word-topic-summary')).toHaveTextContent(
      'Kept 2 words with dictionary data, 0 without data (fetch it later from Word detail), 0 not found in the dictionary.',
    );
  });

  test('a mixed batch keeps found words, keeps dataless candidates and drops not-found', async () => {
    const topic = await createTopicWithWords(0);
    complete.mockResolvedValue({
      text: '["bank", "blurble", "simmer"]',
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });
    lookupMock.mockImplementation(async (word: string) => {
      if (word === 'bank') {
        return {
          outcome: 'found',
          senses: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] }],
          phonetics: ['/bæŋk/'],
        };
      }
      if (word === 'blurble') {
        return { outcome: 'not-found' };
      }
      return { outcome: 'unavailable' };
    });

    const view = await renderScreen(topic.id);
    await openGenerate(view);
    await fireEvent.press(view.getByTestId('word-generate-submit'));

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

  test('a missing provider key surfaces an actionable message and inserts nothing', async () => {
    const topic = await createTopicWithWords(0);
    settings.loadServerlessConfig.mockResolvedValue(null);

    const view = await renderScreen(topic.id);
    await openGenerate(view);
    await fireEvent.press(view.getByTestId('word-generate-submit'));

    await waitFor(() => {
      expect(view.getByTestId('word-topic-generate-error')).toBeTruthy();
    });
    expect(view.getByTestId('word-topic-generate-error').props.children).toContain(
      'Add your provider API key in Settings',
    );
    expect(await listWordsByTopic(db, topic.id)).toEqual([]);
  });
});

describe('WordTopicScreen — collected-words topic (WORD_CAPTURE_V1)', () => {
  test('offers "Generate similar words" and blocks generation on an empty collection', async () => {
    const system = await requireSystemTopic();

    const view = await renderScreen(system.id);
    expect(view.getByTestId('word-topic-title')).toHaveTextContent('Collected words');

    await fireEvent.press(view.getByTestId('word-topic-more'));
    expect(view.getByTestId('word-topic-menu-generate')).toHaveTextContent(
      'Generate similar words',
    );
    await fireEvent.press(view.getByTestId('word-topic-menu-generate'));
    expect(view.getByTestId('word-generate-title')).toHaveTextContent('Generate similar words');
    // Nothing to grow from: the submit stays disabled with the hint visible.
    expect(view.getByTestId('word-generate-empty-error')).toHaveTextContent(
      'Collect or add words first — similar words grow from your collection.',
    );
    expect(view.getByTestId('word-generate-submit').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  test('grows the collection from its own words through the collected prompt', async () => {
    const system = await requireSystemTopic();
    await insertWords(db, system.id, [{ text: 'serendipity', senses_json: [] }]);
    complete.mockResolvedValue({
      text: '["luminous"]',
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderScreen(system.id);
    await openGenerate(view);
    await fireEvent.press(view.getByTestId('word-generate-submit'));

    await waitFor(() => {
      expect(view.queryByTestId('word-topic-summary')).toBeTruthy();
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0];
    const systemPrompt = request.messages.find(
      (m: { role: string }) => m.role === 'system',
    ).content;
    const userPrompt = request.messages.find((m: { role: string }) => m.role === 'user').content;
    expect(systemPrompt).toContain('collected');
    expect(userPrompt).toContain('serendipity');
    expect(userPrompt).toContain('<learner_context>');

    // The generated word lands in the system topic itself.
    const words = await listWordsByTopic(db, system.id);
    expect(words.map(word => word.text).sort()).toEqual(['luminous', 'serendipity']);
  });
});
