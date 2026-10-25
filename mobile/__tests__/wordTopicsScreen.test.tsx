/**
 * Word topics screen tests (WORD_BANK_V1 TASK-WB-008).
 *
 * The screen is serverless-only: it renders the topic list in serverless mode
 * and a server-only notice in server mode (with zero database reads). The form
 * modal creates and edits topics; the delete modal cascades words and review
 * history. The database is the real in-memory sql.js driver; persistence is
 * asserted against SQL rather than stubs.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import {
  createWordTopic,
  getWordTopicById,
  insertWords,
  listWordsByTopic,
  listWordTopics,
} from '../src/db/wordRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { WordTopicsScreenProps } from '../src/navigation/types';
import { WordTopicsScreen } from '../src/screens/WordTopicsScreen';
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
function screenProps(): WordTopicsScreenProps {
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
    route: { key: 'word-topics-test', name: 'WordTopics' },
  } as unknown as WordTopicsScreenProps;
}

async function renderInMode(mode: 'server' | 'serverless' = 'serverless') {
  db = await openSqlJsDriver();
  database.__setDriver(db);
  await saveApplicationMode(mode);
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <WordTopicsScreen {...screenProps()} />
      </ThemeProvider>
    </ModeProvider>,
  );
  if (mode === 'serverless') {
    await waitFor(() => {
      expect(view.queryByTestId('word-loading')).toBeFalsy();
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

describe('WordTopicsScreen — mode gating', () => {
  test('server mode shows the notice and reads no database', async () => {
    const { view } = await renderInMode('server');

    await waitFor(() => {
      expect(view.getByTestId('word-mode-notice')).toBeTruthy();
    });
    expect(database.getLocalDatabase).not.toHaveBeenCalled();
  });

  test('serverless mode waits for the mode restore before loading', async () => {
    const { view } = await renderInMode('serverless');

    await waitFor(() => {
      expect(database.getLocalDatabase).toHaveBeenCalled();
    });
    // The seeded collected-words topic is always present on a fresh database.
    await waitFor(() => {
      expect(view.getByTestId('word-topic-1')).toBeTruthy();
      expect(view.getByText('Collected words')).toBeTruthy();
    });
  });
});

describe('WordTopicsScreen — topic list', () => {
  test('pins the collected-words topic first, then user topics newest first', async () => {
    const { view, db: localDb } = await renderInMode();
    await createWordTopic(localDb, { title: 'Cooking', description: 'kitchen verbs' });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 5));
    await createWordTopic(localDb, { title: 'Travel', description: '' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId('word-topic-3')).toBeTruthy();
    });

    expect(view.getByText('Travel')).toBeTruthy();
    expect(view.getByText('Cooking')).toBeTruthy();
    expect(view.getByText('Collected words')).toBeTruthy();
    // Pinned-first ordering is covered by the repository tests.
  });

  test('shows word and due counts read from the repository', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createWordTopic(localDb, { title: 'Cooking', description: '' });
    await insertWords(localDb, topic.id, [
      { text: 'bank', data_status: 'missing' }, // missing words are never due
      { text: 'simmer' },
    ]);

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`word-topic-${topic.id}-due`)).toBeTruthy();
      expect(view.getByText('1 due')).toBeTruthy();
      expect(view.getByText('2 words')).toBeTruthy();
    });
  });

  test('shows an "all done" badge when nothing is due', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createWordTopic(localDb, { title: 'Cooking', description: '' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`word-topic-${topic.id}-done`)).toBeTruthy();
      // The seeded system topic carries the same ghost badge.
      expect(view.getByTestId('word-topic-1-done')).toBeTruthy();
    });
  });

  test('the system topic menu offers only practice settings', async () => {
    const { view, db: localDb } = await renderInMode();
    const topics = await listWordTopics(localDb);
    const system = topics.find(topic => topic.is_system);
    if (!system) {
      throw new Error('expected the seeded system topic');
    }

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`word-topic-${system.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`word-topic-menu-${system.id}`));
    expect(view.getByTestId('word-topic-row-menu-practice-settings')).toBeTruthy();
    expect(view.queryByTestId('word-topic-row-menu-edit')).toBeFalsy();
    expect(view.queryByTestId('word-topic-row-menu-delete')).toBeFalsy();
  });
});

describe('WordTopicsScreen — create and edit topic', () => {
  test('the form fields scroll inside the modal so Save stays reachable', async () => {
    const { view } = await renderInMode();

    await fireEvent.press(view.getByTestId('word-topics-new'));
    expect(view.getByTestId('word-topic-form-modal')).toBeTruthy();
    expect(view.getByTestId('word-topic-form-scroll').props.nestedScrollEnabled).toBe(true);
    // Save and Cancel live outside the scroll view.
    expect(view.getByTestId('word-topic-form-save')).toBeTruthy();
    expect(view.getByTestId('word-topic-form-cancel')).toBeTruthy();
  });

  test('a blank title cannot be submitted', async () => {
    const { view } = await renderInMode();

    await fireEvent.press(view.getByTestId('word-topics-new'));
    expect(view.getByTestId('word-topic-form-modal')).toBeTruthy();

    const save = view.getByTestId('word-topic-form-save');
    expect(save.props.accessibilityState).toMatchObject({ disabled: true });

    await fireEvent.changeText(view.getByTestId('word-topic-form-title-input'), '   ');
    expect(view.getByTestId('word-topic-form-save').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect((await listWordTopics(db)).filter(topic => !topic.is_system)).toEqual([]);
  });

  test('creating a topic persists it and navigates to the new topic screen', async () => {
    const { view, db: localDb } = await renderInMode();

    await fireEvent.press(view.getByTestId('word-topics-new'));
    await fireEvent.changeText(view.getByTestId('word-topic-form-title-input'), 'Cooking');
    await fireEvent.changeText(
      view.getByTestId('word-topic-form-description'),
      "I'm a chef, I often read cooking blogs",
    );
    await fireEvent.changeText(
      view.getByTestId('word-topic-form-extra-prompt'),
      'focus on kitchen verbs',
    );
    await fireEvent.press(view.getByTestId('word-topic-form-save'));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('WordTopic', { topicId: expect.any(Number) });
    });
    const topics = await listWordTopics(localDb);
    expect(topics).toHaveLength(2); // the seeded system topic plus "Cooking"
    expect(topics.find(topic => topic.title === 'Cooking')).toMatchObject({
      title: 'Cooking',
      description: "I'm a chef, I often read cooking blogs",
      extra_prompt: 'focus on kitchen verbs',
      is_system: false,
    });
  });

  test('editing a topic persists the new description and additional prompt', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createWordTopic(localDb, { title: 'Cooking', description: 'chefs' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`word-topic-${topic.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`word-topic-menu-${topic.id}`));
    await fireEvent.press(view.getByTestId('word-topic-row-menu-edit'));
    expect(view.getByTestId('word-topic-form-title')).toHaveTextContent('Edit topic');
    await fireEvent.changeText(view.getByTestId('word-topic-form-description'), 'blog reading');
    await fireEvent.changeText(view.getByTestId('word-topic-form-extra-prompt'), 'focus on verbs');
    await fireEvent.press(view.getByTestId('word-topic-form-save'));

    await waitFor(() => {
      expect(view.queryByTestId('word-topic-form-modal')).toBeFalsy();
    });
    const updated = await listWordTopics(localDb);
    expect(updated.find(topic => topic.title === 'Cooking')).toMatchObject({
      title: 'Cooking',
      description: 'blog reading',
      extra_prompt: 'focus on verbs',
    });
  });
});

describe('WordTopicsScreen — delete topic', () => {
  test('opens the confirmation modal, then cascades after confirmation', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createWordTopic(localDb, { title: 'Cooking', description: 'kitchen' });
    await insertWords(localDb, topic.id, [{ text: 'bank' }]);

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`word-topic-${topic.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`word-topic-menu-${topic.id}`));
    await fireEvent.press(view.getByTestId('word-topic-row-menu-delete'));

    expect(view.getByTestId('word-topic-delete-modal')).toBeTruthy();
    expect(view.getByTestId('word-topic-delete-title')).toHaveTextContent('Delete topic?');
    expect(view.getByText(/"Cooking" and its words and practice history/)).toBeTruthy();

    // Nothing is removed until the learner confirms.
    expect((await listWordTopics(localDb)).filter(topic => !topic.is_system)).toHaveLength(1);

    await fireEvent.press(view.getByTestId('word-topic-delete-confirm'));

    await waitFor(() => {
      expect(view.queryByTestId('word-topic-delete-modal')).toBeFalsy();
      expect(view.queryByTestId(`word-topic-${topic.id}`)).toBeFalsy();
    });
    // Only the seeded system topic survives the delete.
    expect((await listWordTopics(localDb)).map(row => row.title)).toEqual(['Collected words']);
    expect(await listWordsByTopic(localDb, topic.id)).toEqual([]);
  });

  test('cancelling the modal keeps the topic', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createWordTopic(localDb, { title: 'Cooking' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`word-topic-${topic.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`word-topic-menu-${topic.id}`));
    await fireEvent.press(view.getByTestId('word-topic-row-menu-delete'));
    expect(view.getByTestId('word-topic-delete-modal')).toBeTruthy();

    await fireEvent.press(view.getByTestId('word-topic-delete-cancel'));

    await waitFor(() => {
      expect(view.queryByTestId('word-topic-delete-modal')).toBeFalsy();
    });
    // The user topic survives alongside the seeded system topic.
    expect(await listWordTopics(localDb)).toHaveLength(2);
  });
});

describe('WordTopicsScreen — practice settings', () => {
  test('row menu opens the modal and saves the drafted limits', async () => {
    const { view, db: localDb } = await renderInMode();
    const topic = await createWordTopic(localDb, { title: 'Cooking', description: 'chefs' });

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId(`word-topic-${topic.id}`)).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId(`word-topic-menu-${topic.id}`));
    expect(view.getByTestId('word-topic-row-menu-practice-settings')).toHaveTextContent(
      /10m ahead · 20\/session/,
    );

    await fireEvent.press(view.getByTestId('word-topic-row-menu-practice-settings'));

    expect(view.getByTestId('practice-settings-modal')).toBeTruthy();
    expect(view.getByTestId('practice-settings-value-learnAhead')).toHaveTextContent('10 min');

    const sessionCards = view.getByTestId('practice-settings-slider-sessionCards');
    const maxReviews = view.getByTestId('practice-settings-slider-maxReviews');
    expect(sessionCards.props.minimumValue).toBe(5);
    expect(sessionCards.props.maximumValue).toBe(50);
    expect(maxReviews.props.maximumValue).toBe(200);
    expect(maxReviews.props.step).toBe(5);

    await act(async () => {
      sessionCards.props.onValueChange(40);
      maxReviews.props.onValueChange(100);
    });
    expect(view.getByTestId('practice-settings-value-sessionCards')).toHaveTextContent('40');
    expect(view.getByTestId('practice-settings-value-maxReviews')).toHaveTextContent('100');

    await fireEvent.press(view.getByTestId('practice-settings-save'));

    await waitFor(() => {
      expect(view.queryByTestId('practice-settings-modal')).toBeFalsy();
    });
    expect(await getWordTopicById(localDb, topic.id)).toMatchObject({
      learn_ahead_minutes: 10,
      new_cards_per_day: 20,
      max_reviews_per_day: 100,
      max_session_cards: 40,
    });
  });
});
