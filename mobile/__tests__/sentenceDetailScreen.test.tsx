/**
 * Sentence detail screen tests (MANUAL_SENTENCES).
 *
 * The screen reads from the real repository on the in-memory sql.js driver:
 * every stored content list renders, the TTS button speaks through the injected
 * engine, Enrich proposes content that is reviewed old-vs-new before it is
 * written (the schedule is never touched), Edit opens the edit screen, and
 * Delete asks for confirmation before removing the row.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  applyReviewState,
  createSentenceTopic,
  getSentenceById,
  insertSentences,
} from '../src/db/sentenceRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { SentenceDetailScreenProps } from '../src/navigation/types';
import { SentenceDetailScreen } from '../src/screens/SentenceDetailScreen';
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

const CONFIG = {
  provider: 'openrouter' as const,
  apiKey: 'test-key',
  primaryModel: 'test-model',
  fallbackModels: [],
};

const PROPOSAL = {
  meanings: ['Order a coffee politely.', 'A common café order.'],
  situations: ['At a café counter in the morning.'],
  alternatives: ['Can I have a flat white?'],
  registers: ['polite, to a barista'],
  grammarNotes: ['Polite request with "could I".'],
};

const navigate = jest.fn();
const goBack = jest.fn();

function screenProps(sentenceId: number): SentenceDetailScreenProps {
  return {
    navigation: {
      navigate,
      goBack,
      popToTop: jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    },
    route: { key: 'sentence-detail-test', name: 'SentenceDetail', params: { sentenceId } },
  } as unknown as SentenceDetailScreenProps;
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

async function insertSentenceWithContent() {
  const topic = await createSentenceTopic(db, { title: 'Ordering coffee' });
  const [sentence] = await insertSentences(db, topic.id, [
    {
      text: 'Could I get a flat white?',
      meanings: ['Order coffee politely.', 'A common café order.'],
      situations: ['At a café counter in the morning.'],
      alternatives: ['Can I have a flat white?'],
      registers: ['polite, to a barista'],
      grammar_notes: ['Polite request with "could I".'],
    },
  ]);
  return { topic, sentence };
}

async function renderDetail(sentenceId: number, speech?: TextToSpeechEngine) {
  await saveApplicationMode('serverless');
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <SentenceDetailScreen {...screenProps(sentenceId)} speech={speech} />
      </ThemeProvider>
    </ModeProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('sentence-detail-loading')).toBeFalsy();
  });
  return view;
}

let complete: jest.Mock;

beforeEach(async () => {
  jest.clearAllMocks();
  navigate.mockReset();
  goBack.mockReset();
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

describe('SentenceDetailScreen — rendering', () => {
  test('renders the sentence, TTS button and every content section', async () => {
    const { topic, sentence } = await insertSentenceWithContent();
    const { engine, spoken } = makeEngine();

    const view = await renderDetail(sentence.id, engine);

    expect(view.getByTestId('sentence-detail-title')).toHaveTextContent(topic.title);
    expect(view.getByTestId('sentence-detail-text')).toHaveTextContent('Could I get a flat white?');
    for (const [key, values] of Object.entries({
      meanings: ['Order coffee politely.', 'A common café order.'],
      situations: ['At a café counter in the morning.'],
      alternatives: ['Can I have a flat white?'],
      registers: ['polite, to a barista'],
      grammar_notes: ['Polite request with "could I".'],
    })) {
      expect(view.getByTestId(`sentence-detail-${key}`)).toBeTruthy();
      for (const value of values as string[]) {
        expect(view.getAllByText(value).length).toBeGreaterThan(0);
      }
    }

    await act(async () => {
      fireEvent.press(view.getByTestId('sentence-detail-play'));
    });
    expect(spoken).toEqual(['Could I get a flat white?']);
  });

  test('opens the edit screen from Edit', async () => {
    const { sentence } = await insertSentenceWithContent();
    const view = await renderDetail(sentence.id);

    await fireEvent.press(view.getByTestId('sentence-detail-edit'));
    expect(navigate).toHaveBeenCalledWith('SentenceEdit', { sentenceId: sentence.id });
  });
});

describe('SentenceDetailScreen — enrichment', () => {
  test('apply persists the proposal content and leaves the schedule untouched', async () => {
    const { sentence } = await insertSentenceWithContent();
    await applyReviewState(db, sentence.id, {
      state: 'review',
      reps: 3,
      lapses: 0,
      stability: 5.5,
      difficulty: 5,
      elapsed_days: 1,
      scheduled_days: 4,
      learning_steps: 0,
      due_at: '2026-11-01T00:00:00.000Z',
      last_grade: 'good',
      last_reviewed_at: '2026-10-28T00:00:00.000Z',
    });
    complete.mockResolvedValue({
      text: JSON.stringify(PROPOSAL),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderDetail(sentence.id);
    await fireEvent.press(view.getByTestId('sentence-detail-enrich'));

    await waitFor(() => {
      expect(view.queryByTestId('sentence-enrich-modal')).toBeTruthy();
    });
    expect(screen.getByTestId('sentence-enrich-old-0')).toHaveTextContent(/Order coffee politely/);
    expect(screen.getByTestId('sentence-enrich-new-0')).toHaveTextContent(/A common café order/);

    await fireEvent.press(view.getByTestId('sentence-enrich-apply'));
    await waitFor(() => {
      expect(view.queryByTestId('sentence-enrich-modal')).toBeFalsy();
    });

    const updated = await getSentenceById(db, sentence.id);
    expect(updated?.meanings).toEqual(PROPOSAL.meanings);
    expect(updated?.situations).toEqual(PROPOSAL.situations);
    expect(updated?.alternatives).toEqual(PROPOSAL.alternatives);
    expect(updated?.registers).toEqual(PROPOSAL.registers);
    expect(updated?.grammar_notes).toEqual(PROPOSAL.grammarNotes);
    // The schedule and the text are untouched.
    expect(updated).toMatchObject({ state: 'review', reps: 3, stability: 5.5 });
    expect(updated?.text).toBe('Could I get a flat white?');
  });

  test('cancel writes nothing', async () => {
    const { sentence } = await insertSentenceWithContent();
    complete.mockResolvedValue({
      text: JSON.stringify(PROPOSAL),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderDetail(sentence.id);
    await fireEvent.press(view.getByTestId('sentence-detail-enrich'));
    await waitFor(() => {
      expect(view.queryByTestId('sentence-enrich-modal')).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId('sentence-enrich-cancel'));
    await waitFor(() => {
      expect(view.queryByTestId('sentence-enrich-modal')).toBeFalsy();
    });
    expect((await getSentenceById(db, sentence.id))?.meanings).toEqual([
      'Order coffee politely.',
      'A common café order.',
    ]);
  });

  test('invalid AI output surfaces an error and writes nothing', async () => {
    const { sentence } = await insertSentenceWithContent();
    complete.mockResolvedValue({
      text: 'I cannot help with that.',
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderDetail(sentence.id);
    await fireEvent.press(view.getByTestId('sentence-detail-enrich'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-detail-enrich-error')).toBeTruthy();
    });
    expect(view.queryByTestId('sentence-enrich-modal')).toBeFalsy();
    expect((await getSentenceById(db, sentence.id))?.meanings).toEqual([
      'Order coffee politely.',
      'A common café order.',
    ]);
  });
});

describe('SentenceDetailScreen — delete', () => {
  test('confirms, then removes the sentence and navigates back', async () => {
    const { sentence } = await insertSentenceWithContent();
    const view = await renderDetail(sentence.id);

    await fireEvent.press(view.getByTestId('sentence-detail-delete'));
    expect(view.getByTestId('sentence-detail-delete-confirm-modal')).toBeTruthy();
    expect(view.getByTestId('sentence-detail-delete-confirm-title')).toHaveTextContent(
      'Delete sentence?',
    );
    expect(await getSentenceById(db, sentence.id)).not.toBeNull();

    await fireEvent.press(view.getByTestId('sentence-detail-delete-confirm-confirm'));
    await waitFor(() => {
      expect(goBack).toHaveBeenCalled();
    });
    expect(await getSentenceById(db, sentence.id)).toBeNull();
  });

  test('cancelling keeps the sentence', async () => {
    const { sentence } = await insertSentenceWithContent();
    const view = await renderDetail(sentence.id);

    await fireEvent.press(view.getByTestId('sentence-detail-delete'));
    await fireEvent.press(view.getByTestId('sentence-detail-delete-confirm-cancel'));

    await waitFor(() => {
      expect(view.queryByTestId('sentence-detail-delete-confirm-modal')).toBeFalsy();
    });
    expect(goBack).not.toHaveBeenCalled();
    expect(await getSentenceById(db, sentence.id)).not.toBeNull();
  });
});
