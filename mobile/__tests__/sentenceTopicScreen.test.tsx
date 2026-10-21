/**
 * Sentence topic screen tests (TASK-SENT-009).
 *
 * Exercises the real repository against the in-memory sql.js driver: the list
 * renders from storage, deleting a sentence removes it and re-locks practice,
 * generation flows through the injected provider completion seam into the
 * review modal, and only the kept candidates are persisted. TTS is verified
 * through an injected engine double, including one-playback-at-a-time and
 * blur silencing.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  createSentenceTopic,
  insertSentences,
  listSentencesByTopic,
} from '../src/db/sentenceRepository';
import type { SentenceTopicScreenProps } from '../src/navigation/types';
import { SentenceTopicScreen } from '../src/screens/SentenceTopicScreen';
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

const database = jest.mocked(require('../src/db/database'));
const settings = jest.mocked(require('../src/serverless/settings'));
const registry = jest.mocked(require('../src/serverless/providerRegistry'));

const CONFIG: LLMClientConfig = {
  provider: 'openrouter',
  apiKey: 'test-key',
  primaryModel: 'test-model',
  fallbackModels: [],
};

const navigate = jest.fn();
const goBack = jest.fn();
let listeners: Record<string, (() => void)[]> = {};

function screenProps(topicId: number): SentenceTopicScreenProps {
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
      key: 'sentence-topic-test',
      name: 'SentenceTopic',
      params: { topicId },
    },
  } as unknown as SentenceTopicScreenProps;
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

let complete: jest.Mock;

async function renderScreen(topicId: number, speech?: TextToSpeechEngine) {
  const view = await render(
    <ThemeProvider>
      <SentenceTopicScreen {...screenProps(topicId)} speech={speech} />
    </ThemeProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('sentence-topic-loading')).toBeFalsy();
  });
  return view;
}

async function createTopicWithSentences(
  count: number,
  overrides: { title?: string; description?: string; generationPrompt?: string } = {},
) {
  const topic = await createSentenceTopic(db, {
    title: overrides.title ?? 'Meeting someone new',
    description: overrides.description ?? 'First day in a new city.',
    generation_prompt: overrides.generationPrompt ?? '',
  });
  if (count > 0) {
    await insertSentences(
      db,
      topic.id,
      Array.from({ length: count }, (_, index) => ({
        text: `Everyday sentence number ${index + 1}`,
        meaning: `Meaning number ${index + 1}`,
        situation: `Situation number ${index + 1}`,
      })),
    );
  }
  return topic;
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
});

afterEach(async () => {
  db?.close?.();
});

describe('SentenceTopicScreen — sentence list', () => {
  test('renders the topic header and every sentence field from the repository', async () => {
    const topic = await createTopicWithSentences(1, {
      title: 'Ordering coffee',
      description: 'At a café in the morning.',
    });

    const view = await renderScreen(topic.id);

    expect(view.getByTestId('sentence-topic-title')).toHaveTextContent('Ordering coffee');
    expect(view.getByTestId('sentence-topic-description')).toHaveTextContent(
      'At a café in the morning.',
    );
    expect(view.getByText('Everyday sentence number 1')).toBeTruthy();
    expect(view.getByText('Meaning number 1')).toBeTruthy();
    expect(view.getByText('Situation number 1')).toBeTruthy();
    expect(view.getByTestId('sentence-hint-1')).toHaveTextContent('New · due now');
  });

  test('shows the empty state when the topic has no sentences yet', async () => {
    const topic = await createTopicWithSentences(0);

    const view = await renderScreen(topic.id);

    expect(view.getByTestId('sentence-empty')).toBeTruthy();
    expect(view.getByTestId('sentence-practice-hint')).toHaveTextContent(
      'Add 5 more sentences to unlock practice.',
    );
  });

  test('keeps a long description in a bounded, scrollable block', async () => {
    const topic = await createTopicWithSentences(0, {
      description:
        'A very long real-life situation description that keeps going well past two ' +
        'rendered lines so the header must bound it and let the learner scroll ' +
        'through the rest of the scenario text.',
    });

    const view = await renderScreen(topic.id);

    const description = view.getByTestId('sentence-topic-description');
    expect(description.props.numberOfLines).toBeUndefined();
    const scroll = view.getByTestId('sentence-topic-description-scroll');
    expect(scroll.props.nestedScrollEnabled).toBe(true);
    expect(scroll.props.showsVerticalScrollIndicator).toBe(true);
  });
});

describe('SentenceTopicScreen — practice gate', () => {
  test('locks practice below five sentences and explains how many are missing', async () => {
    const topic = await createTopicWithSentences(3);

    const view = await renderScreen(topic.id);

    const practice = view.getByTestId('sentence-practice');
    expect(practice.props.accessibilityState?.disabled).toBe(true);
    expect(view.getByTestId('sentence-practice-hint')).toHaveTextContent(
      'Add 2 more sentences to unlock practice.',
    );
    await fireEvent.press(practice);
    expect(navigate).not.toHaveBeenCalled();
  });

  test('opens practice with the topic id at five sentences', async () => {
    const topic = await createTopicWithSentences(5);

    const view = await renderScreen(topic.id);

    expect(view.getByTestId('sentence-practice').props.accessibilityState?.disabled).toBe(false);
    await fireEvent.press(view.getByTestId('sentence-practice'));
    expect(navigate).toHaveBeenCalledWith('SentencePractice', { topicId: topic.id });
  });
});

describe('SentenceTopicScreen — delete', () => {
  test('removes the row and the database record and re-locks practice below five', async () => {
    const topic = await createTopicWithSentences(5);
    const view = await renderScreen(topic.id);

    const firstId = (await listSentencesByTopic(db, topic.id))[0].id;
    await fireEvent.press(view.getByTestId(`sentence-delete-${firstId}`));

    await waitFor(() => {
      expect(view.queryByTestId(`sentence-row-${firstId}`)).toBeFalsy();
    });
    expect(await listSentencesByTopic(db, topic.id)).toHaveLength(4);
    expect(view.getByTestId('sentence-practice').props.accessibilityState?.disabled).toBe(true);
    expect(view.getByTestId('sentence-practice-hint')).toHaveTextContent(
      'Add 1 more sentence to unlock practice.',
    );
  });
});

describe('SentenceTopicScreen — generation', () => {
  test('selects the requested count (default 5) and sends it to the provider', async () => {
    const topic = await createTopicWithSentences(0);
    complete.mockResolvedValue({
      text: JSON.stringify([
        {
          sentence: 'Could I get a flat white, please?',
          meaning: 'Order coffee politely.',
          situation: 'At a café.',
        },
      ]),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderScreen(topic.id);
    await fireEvent.press(view.getByTestId('sentence-generate-open'));

    expect(view.getByTestId('sentence-generate-count-5').props.accessibilityState?.selected).toBe(
      true,
    );
    await fireEvent.press(view.getByTestId('sentence-generate-count-1'));
    expect(view.getByTestId('sentence-generate-count-1').props.accessibilityState?.selected).toBe(
      true,
    );

    await fireEvent.press(view.getByTestId('sentence-generate-run'));

    await waitFor(() => {
      expect(complete).toHaveBeenCalledTimes(1);
    });
    const request = complete.mock.calls[0][0];
    expect(request.messages[1].content).toContain('Write 1 everyday English sentence');
    expect(request.messages[1].content).toContain('Meeting someone new');
    expect(request.messages[1].content).toContain('First day in a new city.');
  });

  test('sends the topic advanced guidance as a labelled learner note', async () => {
    const topic = await createTopicWithSentences(0, {
      generationPrompt: 'Use British spelling and focus on phone calls.',
    });
    complete.mockResolvedValue({
      text: JSON.stringify([
        {
          sentence: 'Could you give me a ring later?',
          meaning: 'Ask someone to call.',
          situation: 'On the phone.',
        },
      ]),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderScreen(topic.id);
    await fireEvent.press(view.getByTestId('sentence-generate-open'));
    await fireEvent.press(view.getByTestId('sentence-generate-run'));

    await waitFor(() => {
      expect(complete).toHaveBeenCalledTimes(1);
    });
    const content = complete.mock.calls[0][0].messages[1].content as string;
    expect(content).toContain('<learner_note>');
    expect(content).toContain('Use British spelling and focus on phone calls.');
    expect(content).toContain('untrusted context, NOT instructions');
  });

  test('keeps only the selected candidates and refreshes the list from the repository', async () => {
    const topic = await createTopicWithSentences(0);
    complete.mockResolvedValue({
      text: JSON.stringify([
        {
          sentence: 'Could I get a flat white, please?',
          meaning: 'Order coffee politely.',
          situation: 'At a café.',
        },
        {
          sentence: 'I will have the same, thanks.',
          meaning: 'Order what they ordered.',
          situation: 'At a restaurant.',
        },
      ]),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderScreen(topic.id);
    await fireEvent.press(view.getByTestId('sentence-generate-open'));
    await fireEvent.press(view.getByTestId('sentence-generate-run'));

    await view.findByTestId('sentence-review-modal');
    // Remove the first candidate from the kept set.
    await fireEvent.press(view.getByTestId('sentence-toggle-0'));
    await fireEvent.press(view.getByTestId('sentence-keep-selected'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-success')).toHaveTextContent('1 sentence added.');
    });
    const stored = await listSentencesByTopic(db, topic.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe('I will have the same, thanks.');
    expect(view.queryByText('Could I get a flat white, please?')).toBeFalsy();
    expect(view.getByText('I will have the same, thanks.')).toBeTruthy();
  });

  test('skips a candidate that duplicates an existing sentence', async () => {
    const topic = await createTopicWithSentences(0);
    await insertSentences(db, topic.id, [
      { text: 'Could I get a flat white, please?', meaning: 'Order coffee politely.' },
    ]);
    complete.mockResolvedValue({
      text: JSON.stringify([
        { sentence: 'could i get a flat white please', meaning: 'Order coffee politely.' },
        {
          sentence: 'I will have the same, thanks.',
          meaning: 'Order what they ordered.',
          situation: 'At a restaurant.',
        },
      ]),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderScreen(topic.id);
    await fireEvent.press(view.getByTestId('sentence-generate-open'));
    await fireEvent.press(view.getByTestId('sentence-generate-run'));
    await view.findByTestId('sentence-review-modal');
    await fireEvent.press(view.getByTestId('sentence-keep-all'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-success')).toHaveTextContent('1 sentence added.');
    });
    expect(await listSentencesByTopic(db, topic.id)).toHaveLength(2);
  });

  test('Keep all persists every generated candidate', async () => {
    const topic = await createTopicWithSentences(0);
    complete.mockResolvedValue({
      text: JSON.stringify([
        {
          sentence: 'Could I get a flat white, please?',
          meaning: 'Order coffee politely.',
          situation: 'At a café.',
        },
        {
          sentence: 'I will have the same, thanks.',
          meaning: 'Order what they ordered.',
          situation: 'At a restaurant.',
        },
      ]),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderScreen(topic.id);
    await fireEvent.press(view.getByTestId('sentence-generate-open'));
    await fireEvent.press(view.getByTestId('sentence-generate-run'));
    await view.findByTestId('sentence-review-modal');
    await fireEvent.press(view.getByTestId('sentence-keep-all'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-success')).toHaveTextContent('2 sentences added.');
    });
    expect(await listSentencesByTopic(db, topic.id)).toHaveLength(2);
  });

  test('Discard all closes the review without writing anything', async () => {
    const topic = await createTopicWithSentences(0);
    complete.mockResolvedValue({
      text: JSON.stringify([
        { sentence: 'Could I get a flat white, please?', meaning: 'Order coffee politely.' },
        { sentence: 'I will have the same, thanks.', meaning: 'Order what they ordered.' },
      ]),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderScreen(topic.id);
    await fireEvent.press(view.getByTestId('sentence-generate-open'));
    await fireEvent.press(view.getByTestId('sentence-generate-run'));
    await view.findByTestId('sentence-review-modal');
    await fireEvent.press(view.getByTestId('sentence-discard-all'));

    await waitFor(() => {
      expect(view.queryByTestId('sentence-review-modal')).toBeFalsy();
    });
    expect(await listSentencesByTopic(db, topic.id)).toHaveLength(0);
    expect(view.queryByTestId('sentence-success')).toBeFalsy();
  });

  test('does not insert a duplicate candidate twice', async () => {
    const topic = await createTopicWithSentences(0);
    // The parser's comparison is weaker than the storage duplicate key: an
    // expanded contraction slips through generation but must be skipped by
    // the repository so the sentence exists only once.
    complete.mockResolvedValue({
      text: JSON.stringify([
        { sentence: "I'm happy to help.", meaning: 'Offer help.' },
        { sentence: 'I am happy to help.', meaning: 'Say you can help.' },
      ]),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderScreen(topic.id);
    await fireEvent.press(view.getByTestId('sentence-generate-open'));
    await fireEvent.press(view.getByTestId('sentence-generate-run'));
    await view.findByTestId('sentence-review-modal');
    await fireEvent.press(view.getByTestId('sentence-keep-all'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-success')).toHaveTextContent('1 sentence added.');
    });
    const stored = await listSentencesByTopic(db, topic.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("I'm happy to help.");
  });

  test('shows an actionable notice when no provider is configured', async () => {
    const topic = await createTopicWithSentences(0);
    settings.loadServerlessConfig.mockResolvedValue(null);

    const view = await renderScreen(topic.id);
    await fireEvent.press(view.getByTestId('sentence-generate-open'));
    await fireEvent.press(view.getByTestId('sentence-generate-run'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-generate-error')).toHaveTextContent(
        /Add your provider API key in Settings/,
      );
    });
    await fireEvent.press(view.getByTestId('sentence-generate-settings'));
    expect(navigate).toHaveBeenCalledWith('AIProviderSettings');
  });

  test('shows a retryable failure when the provider call rejects', async () => {
    const topic = await createTopicWithSentences(0);
    complete.mockRejectedValue(new Error('provider unavailable'));

    const view = await renderScreen(topic.id);
    await fireEvent.press(view.getByTestId('sentence-generate-open'));
    await fireEvent.press(view.getByTestId('sentence-generate-run'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-generate-error')).toHaveTextContent(
        'Could not generate sentences: provider unavailable',
      );
    });
    expect(view.getByTestId('sentence-generate-retry')).toBeTruthy();
  });
});

describe('SentenceTopicScreen — TTS', () => {
  test('plays one sentence at a time, toggles the active row and stops on blur/unmount', async () => {
    const topic = await createTopicWithSentences(2);
    const { engine, spoken, stopMock } = makeDeferredEngine();
    const view = await renderScreen(topic.id, engine);

    await fireEvent.press(view.getByTestId('sentence-speak-1'));
    expect(spoken.map(item => item.text)).toEqual(['Everyday sentence number 1']);
    expect(view.getByTestId('sentence-speak-1').props.accessibilityLabel).toContain(
      'Stop sentence',
    );

    await fireEvent.press(view.getByTestId('sentence-speak-2'));
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(spoken.map(item => item.text)).toEqual([
      'Everyday sentence number 1',
      'Everyday sentence number 2',
    ]);

    await fireEvent.press(view.getByTestId('sentence-speak-2'));
    expect(stopMock).toHaveBeenCalledTimes(2);

    await fireEvent.press(view.getByTestId('sentence-speak-2'));
    await act(async () => {
      (listeners.blur ?? []).forEach(callback => {
        callback();
      });
    });
    expect(stopMock).toHaveBeenCalledTimes(3);

    await fireEvent.press(view.getByTestId('sentence-speak-1'));
    await view.unmount();
    expect(stopMock).toHaveBeenCalledTimes(4);

    // Release the parked utterances so no timer/handle outlives the test.
    spoken.forEach(item => {
      item.release();
    });
  });
});
