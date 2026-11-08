/**
 * Sentence edit screen tests (MANUAL_SENTENCES).
 *
 * The screen reads and writes the real repository on the in-memory sql.js
 * driver: the stored lists render into per-entry text boxes, the "+" adds a
 * row, saving content-only edits keeps the FSRS schedule, changing the text of
 * a card that has progress asks for confirmation first and resets the schedule
 * on confirm, a duplicate text surfaces inline, and Cancel keeps the row.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
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
import type { SentenceEditScreenProps } from '../src/navigation/types';
import { SentenceEditScreen } from '../src/screens/SentenceEditScreen';
import { ThemeProvider } from '../src/theme/ThemeContext';
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

const database = jest.mocked(require('../src/db/database'));

const goBack = jest.fn();

function screenProps(sentenceId: number): SentenceEditScreenProps {
  return {
    navigation: {
      navigate: jest.fn(),
      goBack,
      popToTop: jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    },
    route: { key: 'sentence-edit-test', name: 'SentenceEdit', params: { sentenceId } },
  } as unknown as SentenceEditScreenProps;
}

async function renderEdit(sentenceId: number) {
  await saveApplicationMode('serverless');
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <SentenceEditScreen {...screenProps(sentenceId)} />
      </ThemeProvider>
    </ModeProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('sentence-edit-loading')).toBeFalsy();
  });
  return view;
}

async function insertSentenceWithContent() {
  const topic = await createSentenceTopic(db, { title: 'Ordering coffee' });
  const [sentence] = await insertSentences(db, topic.id, [
    {
      text: 'Could I get a flat white?',
      meanings: ['Order coffee politely.'],
      situations: ['At a café counter.'],
      alternatives: ['Can I have a flat white?'],
      registers: ['polite'],
      grammar_notes: ['Polite request.'],
    },
  ]);
  return { topic, sentence };
}

beforeEach(async () => {
  jest.clearAllMocks();
  goBack.mockReset();
  db = await openSqlJsDriver();
  await migrateDatabase(db);
  database.__setDriver(db);
});

afterEach(async () => {
  db?.close?.();
});

describe('SentenceEditScreen — rendering', () => {
  test('loads the stored text and lists into editable boxes', async () => {
    const { sentence } = await insertSentenceWithContent();
    const view = await renderEdit(sentence.id);

    expect(view.getByTestId('sentence-edit-text').props.value).toBe('Could I get a flat white?');
    expect(view.getByTestId('sentence-edit-meanings-input-0').props.value).toBe(
      'Order coffee politely.',
    );
    expect(view.getByTestId('sentence-edit-situations-input-0').props.value).toBe(
      'At a café counter.',
    );
    expect(view.getByTestId('sentence-edit-alternatives-input-0').props.value).toBe(
      'Can I have a flat white?',
    );
    expect(view.getByTestId('sentence-edit-registers-input-0').props.value).toBe('polite');
    expect(view.getByTestId('sentence-edit-grammar-input-0').props.value).toBe('Polite request.');
  });

  test('adds and removes list entries with the "+" and remove controls', async () => {
    const { sentence } = await insertSentenceWithContent();
    const view = await renderEdit(sentence.id);

    await fireEvent.press(view.getByTestId('sentence-edit-meanings-add'));
    expect(view.getByTestId('sentence-edit-meanings-input-1')).toBeTruthy();

    await fireEvent.changeText(
      view.getByTestId('sentence-edit-meanings-input-1'),
      'A common café order.',
    );
    await fireEvent.press(view.getByTestId('sentence-edit-save'));

    await waitFor(() => {
      expect(goBack).toHaveBeenCalled();
    });
    const updated = await getSentenceById(db, sentence.id);
    expect(updated?.meanings).toEqual(['Order coffee politely.', 'A common café order.']);
    // The schedule is untouched by a content-only edit.
    expect(updated).toMatchObject({ state: 'new', reps: 0 });

    // Removing the second row leaves only the first box.
    await fireEvent.press(view.getByTestId('sentence-edit-meanings-remove-1'));
    expect(view.queryByTestId('sentence-edit-meanings-input-1')).toBeFalsy();
  });
});

describe('SentenceEditScreen — text change reset', () => {
  test('a text change on a card with progress asks first, then resets the schedule', async () => {
    const { sentence } = await insertSentenceWithContent();
    await applyReviewState(db, sentence.id, {
      state: 'review',
      reps: 4,
      lapses: 1,
      stability: 5.5,
      difficulty: 5,
      elapsed_days: 2,
      scheduled_days: 6,
      learning_steps: 0,
      due_at: '2026-11-01T00:00:00.000Z',
      last_grade: 'good',
      last_reviewed_at: '2026-10-26T00:00:00.000Z',
    });

    const view = await renderEdit(sentence.id);
    await fireEvent.changeText(view.getByTestId('sentence-edit-text'), 'Good to meet you.');
    expect(view.getByTestId('sentence-edit-reset-hint')).toBeTruthy();

    await fireEvent.press(view.getByTestId('sentence-edit-save'));
    // Nothing is written until the reset is confirmed.
    expect(view.getByTestId('sentence-edit-reset-confirm-modal')).toBeTruthy();
    expect((await getSentenceById(db, sentence.id))?.text).toBe('Could I get a flat white?');

    await fireEvent.press(view.getByTestId('sentence-edit-reset-confirm-confirm'));
    await waitFor(() => {
      expect(goBack).toHaveBeenCalled();
    });
    expect(await getSentenceById(db, sentence.id)).toMatchObject({
      text: 'Good to meet you.',
      state: 'new',
      reps: 0,
      lapses: 0,
      stability: 0,
    });
  });

  test('cancelling the reset keeps the original sentence', async () => {
    const { sentence } = await insertSentenceWithContent();
    await applyReviewState(db, sentence.id, {
      state: 'review',
      reps: 4,
      lapses: 0,
      stability: 5.5,
      difficulty: 5,
      elapsed_days: 2,
      scheduled_days: 6,
      learning_steps: 0,
      due_at: '2026-11-01T00:00:00.000Z',
      last_grade: 'good',
      last_reviewed_at: '2026-10-26T00:00:00.000Z',
    });

    const view = await renderEdit(sentence.id);
    await fireEvent.changeText(view.getByTestId('sentence-edit-text'), 'Good to meet you.');
    await fireEvent.press(view.getByTestId('sentence-edit-save'));
    await fireEvent.press(view.getByTestId('sentence-edit-reset-confirm-cancel'));

    await waitFor(() => {
      expect(view.queryByTestId('sentence-edit-reset-confirm-modal')).toBeFalsy();
    });
    expect(goBack).not.toHaveBeenCalled();
    expect((await getSentenceById(db, sentence.id))?.text).toBe('Could I get a flat white?');
  });

  test('a punctuation-only edit of a reviewed card does not warn and keeps the schedule', async () => {
    const { sentence } = await insertSentenceWithContent();
    await applyReviewState(db, sentence.id, {
      state: 'review',
      reps: 2,
      lapses: 0,
      stability: 3,
      difficulty: 5,
      elapsed_days: 1,
      scheduled_days: 3,
      learning_steps: 0,
      due_at: '2026-11-01T00:00:00.000Z',
      last_grade: 'good',
      last_reviewed_at: '2026-10-30T00:00:00.000Z',
    });

    const view = await renderEdit(sentence.id);
    await fireEvent.changeText(
      view.getByTestId('sentence-edit-text'),
      'Could I get a flat white!!',
    );
    expect(view.queryByTestId('sentence-edit-reset-hint')).toBeFalsy();

    await fireEvent.press(view.getByTestId('sentence-edit-save'));
    await waitFor(() => {
      expect(goBack).toHaveBeenCalled();
    });
    expect(await getSentenceById(db, sentence.id)).toMatchObject({
      text: 'Could I get a flat white!!',
      state: 'review',
      reps: 2,
    });
  });

  test('a duplicate text surfaces an inline error and writes nothing', async () => {
    const topic = await createSentenceTopic(db, { title: 'Ordering coffee' });
    await insertSentences(db, topic.id, [{ text: 'Nice to meet you.', meaning: 'A greeting.' }]);
    const [sentence] = await insertSentences(db, topic.id, [
      { text: 'Could I get a flat white?', meaning: 'Order coffee.' },
    ]);

    const view = await renderEdit(sentence.id);
    await fireEvent.changeText(view.getByTestId('sentence-edit-text'), 'Nice to meet you.');
    await fireEvent.press(view.getByTestId('sentence-edit-save'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-edit-save-error')).toHaveTextContent(
        'This sentence already exists in this topic.',
      );
    });
    expect(goBack).not.toHaveBeenCalled();
    expect((await getSentenceById(db, sentence.id))?.text).toBe('Could I get a flat white?');
  });

  test('a blank sentence is refused before any write', async () => {
    const { sentence } = await insertSentenceWithContent();
    const view = await renderEdit(sentence.id);

    await fireEvent.changeText(view.getByTestId('sentence-edit-text'), '   ');
    await fireEvent.press(view.getByTestId('sentence-edit-save'));

    expect(view.getByTestId('sentence-edit-save-error')).toHaveTextContent(
      'A sentence needs its text.',
    );
    expect(goBack).not.toHaveBeenCalled();
    expect((await getSentenceById(db, sentence.id))?.text).toBe('Could I get a flat white?');
  });
});
