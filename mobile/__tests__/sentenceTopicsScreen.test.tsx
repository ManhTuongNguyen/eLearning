/**
 * Sentence topics screen tests (TASK-SENT-008).
 *
 * The screen is serverless-only: it renders the topic list in serverless mode
 * and a server-only notice in server mode (with zero database reads), and the
 * inline form creates a topic and navigates to it. The database is the real
 * in-memory sql.js driver; persistence and counts are asserted against SQL
 * rather than stubs.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import {
  createSentenceTopic,
  getSentenceTopicById,
  insertSentences,
  listSentencesByTopic,
  listSentenceTopics,
} from '../src/db/sentenceRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { SentenceTopicsScreenProps } from '../src/navigation/types';
import { SentenceTopicsScreen } from '../src/screens/SentenceTopicsScreen';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

/** A sql.js database wired through the mocked getLocalDatabase. */
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

const navigate = jest.fn();
let listeners: Record<string, (() => void)[]> = {};
function flushFocus(): Promise<void> {
  return act(async () => {
    (listeners.focus ?? []).forEach(callback => {
      callback();
    });
  });
}
function screenProps(): SentenceTopicsScreenProps {
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
    route: { key: 'sentence-topics-test', name: 'SentenceTopics' },
  } as unknown as SentenceTopicsScreenProps;
}

async function renderInMode(mode: 'server' | 'serverless' = 'serverless') {
  db = await openSqlJsDriver();
  database.__setDriver(db);
  await saveApplicationMode(mode);
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <SentenceTopicsScreen {...screenProps()} />
      </ThemeProvider>
    </ModeProvider>,
  );
  if (mode === 'serverless') {
    // Let the first load finish (and migrate the database) before callers
    // write directly against the driver.
    await waitFor(() => {
      expect(view.queryByTestId('sentence-loading')).toBeFalsy();
    });
  }
  return { view, db };
}

beforeEach(() => {
  jest.clearAllMocks();
  navigate.mockReset();
  listeners = {};
});

afterEach(() => {
  db?.close?.();
});

describe('SentenceTopicsScreen — mode gating', () => {
  test('server mode shows the notice and reads no database', async () => {
    const { view } = await renderInMode('server');

    await waitFor(() => {
      expect(view.getByTestId('sentence-mode-notice')).toBeTruthy();
    });
    expect(database.getLocalDatabase).not.toHaveBeenCalled();
  });

  test('serverless mode waits for the mode restore before loading', async () => {
    const { view } = await renderInMode('serverless');

    await waitFor(() => {
      expect(database.getLocalDatabase).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(view.getByTestId('sentence-empty')).toBeTruthy();
    });
  });
});

describe('SentenceTopicsScreen — topic list', () => {
  test('lists topics newest first with sentence and due counts', async () => {
    const { view, db: localDb } = await renderInMode();
    await createSentenceTopic(localDb, { title: 'Coffee', description: 'ordering' });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 5));
    await createSentenceTopic(localDb, { title: 'Neighbours', description: '' });

    // Re-list by simulating the screen regaining focus.
    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId('topic-2')).toBeTruthy();
    });

    expect(view.getByText('Neighbours')).toBeTruthy();
    expect(view.getByText('Coffee')).toBeTruthy();
  });

  test('shows sentence and due counts read from the repository', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createSentenceTopic(localDb, {
      title: 'Coffee',
      description: '',
    });
    await insertSentences(localDb, topic.id, [
      {
        text: 'Could I get a flat white, please?',
        meaning: 'Ask for a coffee politely.',
        situation: 'Ordering at a café.',
      },
    ]);

    // Re-list by simulating the screen regaining focus.
    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`topic-${topic.id}-due`)).toBeTruthy();
      expect(view.getByText('1 due')).toBeTruthy();
      expect(view.getByText('1 sentence')).toBeTruthy();
    });
  });

  test('shows an "all done" badge when nothing is due', async () => {
    const { view, db: localDb } = await renderInMode();
    await createSentenceTopic(localDb, { title: 'Coffee', description: '' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId('topic-1-done')).toBeTruthy();
      expect(view.getByText('all done')).toBeTruthy();
    });
  });
});

describe('SentenceTopicsScreen — delete topic', () => {
  test('opens the in-app modal, then deletes after confirmation', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createSentenceTopic(localDb, {
      title: 'Coffee',
      description: 'ordering',
    });
    await insertSentences(localDb, topic.id, [
      {
        text: 'Could I get a flat white, please?',
        meaning: 'Ask for a coffee politely.',
        situation: 'Ordering at a café.',
      },
    ]);

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`topic-${topic.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`topic-menu-${topic.id}`));
    await fireEvent.press(view.getByTestId('sentence-topic-row-menu-delete'));

    // The themed dialog replaces the native Android alert.
    expect(view.getByTestId('delete-topic-modal')).toBeTruthy();
    expect(view.getByTestId('delete-topic-title')).toHaveTextContent('Delete topic?');
    expect(view.getByText(/"Coffee" and its sentence and practice history/)).toBeTruthy();

    // Nothing is removed until the learner confirms.
    expect(view.getByTestId(`topic-${topic.id}`)).toBeTruthy();
    expect(await listSentenceTopics(localDb)).toHaveLength(1);

    await fireEvent.press(view.getByTestId('delete-topic-confirm'));

    await waitFor(() => {
      expect(view.queryByTestId('delete-topic-modal')).toBeFalsy();
      expect(view.queryByTestId(`topic-${topic.id}`)).toBeFalsy();
    });
    expect(await listSentenceTopics(localDb)).toEqual([]);
    expect(await listSentencesByTopic(localDb, topic.id)).toEqual([]);
  });

  test('keeps the modal open with an error when deletion fails', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createSentenceTopic(localDb, { title: 'Coffee' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`topic-${topic.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`topic-menu-${topic.id}`));
    await fireEvent.press(view.getByTestId('sentence-topic-row-menu-delete'));
    database.getLocalDatabase.mockRejectedValueOnce(new Error('disk full'));
    await fireEvent.press(view.getByTestId('delete-topic-confirm'));

    await waitFor(() => {
      expect(view.getByTestId('delete-topic-error')).toHaveTextContent('disk full');
    });
    expect(view.getByTestId('delete-topic-modal')).toBeTruthy();
    expect(view.getByTestId(`topic-${topic.id}`)).toBeTruthy();
    expect(await listSentenceTopics(localDb)).toHaveLength(1);
  });

  test('cancelling the modal keeps the topic', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createSentenceTopic(localDb, { title: 'Coffee' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`topic-${topic.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`topic-menu-${topic.id}`));
    await fireEvent.press(view.getByTestId('sentence-topic-row-menu-delete'));
    expect(view.getByTestId('delete-topic-modal')).toBeTruthy();

    await fireEvent.press(view.getByTestId('delete-topic-cancel'));

    await waitFor(() => {
      expect(view.queryByTestId('delete-topic-modal')).toBeFalsy();
    });
    expect(view.getByTestId(`topic-${topic.id}`)).toBeTruthy();
    expect(await listSentenceTopics(localDb)).toHaveLength(1);
  });
});

describe('SentenceTopicsScreen — practice settings', () => {
  test('row menu opens the modal with current values and saves new ones', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createSentenceTopic(localDb, { title: 'Coffee' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`topic-${topic.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`topic-menu-${topic.id}`));
    // The menu shows the current learn-ahead window and session cap.
    expect(view.getByTestId('sentence-topic-row-menu-practice-settings')).toHaveTextContent(
      /10m ahead · 20\/session/,
    );

    await fireEvent.press(view.getByTestId('sentence-topic-row-menu-practice-settings'));

    expect(view.getByTestId('practice-settings-modal')).toBeTruthy();
    expect(view.getByTestId('practice-settings-topic')).toHaveTextContent('Coffee');
    expect(view.getByTestId('practice-settings-value-learnAhead')).toHaveTextContent('10 min');
    expect(view.getByTestId('practice-settings-value-newPerDay')).toHaveTextContent('20');
    expect(view.getByTestId('practice-settings-value-maxReviews')).toHaveTextContent('200');
    expect(view.getByTestId('practice-settings-value-sessionCards')).toHaveTextContent('20');

    const learnAhead = view.getByTestId('practice-settings-slider-learnAhead');
    expect(learnAhead.props.minimumValue).toBe(0);
    expect(learnAhead.props.maximumValue).toBe(50);
    expect(learnAhead.props.step).toBe(1);

    const newPerDay = view.getByTestId('practice-settings-slider-newPerDay');
    await act(async () => {
      learnAhead.props.onValueChange(25);
      newPerDay.props.onValueChange(5);
    });
    expect(view.getByTestId('practice-settings-value-learnAhead')).toHaveTextContent('25 min');
    expect(view.getByTestId('practice-settings-value-newPerDay')).toHaveTextContent('5');

    await fireEvent.press(view.getByTestId('practice-settings-save'));

    await waitFor(() => {
      expect(view.queryByTestId('practice-settings-modal')).toBeFalsy();
    });
    const saved = await getSentenceTopicById(localDb, topic.id);
    expect(saved).toMatchObject({
      learn_ahead_minutes: 25,
      new_cards_per_day: 5,
      max_reviews_per_day: 200,
      max_session_cards: 20,
    });
  });

  test('a zero daily limit reads as Off and cancel leaves the stored values alone', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createSentenceTopic(localDb, { title: 'Coffee' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`topic-${topic.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`topic-menu-${topic.id}`));
    await fireEvent.press(view.getByTestId('sentence-topic-row-menu-practice-settings'));

    const newPerDay = view.getByTestId('practice-settings-slider-newPerDay');
    await act(async () => {
      newPerDay.props.onValueChange(0);
    });
    expect(view.getByTestId('practice-settings-value-newPerDay')).toHaveTextContent('Off');

    await fireEvent.press(view.getByTestId('practice-settings-cancel'));

    await waitFor(() => {
      expect(view.queryByTestId('practice-settings-modal')).toBeFalsy();
    });
    expect((await getSentenceTopicById(localDb, topic.id))?.new_cards_per_day).toBe(20);
  });
});

describe('SentenceTopicsScreen — new topic entry point', () => {
  test('the add button opens the separate create-topic screen', async () => {
    const { view } = await renderInMode();

    await fireEvent.press(view.getByTestId('sentence-topics-new'));

    expect(navigate).toHaveBeenCalledWith('SentenceTopicNew');
  });

  test('the add button is a circle', async () => {
    const { view } = await renderInMode();

    expect(view.getByTestId('sentence-topics-new')).toHaveStyle({
      width: 32,
      height: 32,
      borderRadius: 16,
    });
  });
});
