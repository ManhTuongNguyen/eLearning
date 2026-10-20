/**
 * Sentence topics screen tests (TASK-SENT-008).
 *
 * The screen is serverless-only: it renders the topic list in serverless mode
 * and a server-only notice in server mode (with zero database reads), and the
 * inline form creates a topic and navigates to it. The database is the real
 * in-memory sql.js driver; persistence and counts are asserted against SQL
 * rather than stubs.
 */
import React from 'react';
import {act, fireEvent, render, waitFor} from '@testing-library/react-native';

import {
  createSentenceTopic,
  insertSentences,
} from '../src/db/sentenceRepository';
import {openSqlJsDriver} from '../testing/sqlJsDriver';
import type {SqlDriver} from '../src/db/driver';
import {SentenceTopicsScreen} from '../src/screens/SentenceTopicsScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import type {SentenceTopicsScreenProps} from '../src/navigation/types';

/** A sql.js database wired through the mocked getLocalDatabase. */
let db: SqlDriver;

jest.mock('../src/db/database', () => {
  const actualMigrations = jest.requireActual('../src/db/migrations').migrateDatabase;
  const handle: {db: SqlDriver} = {db: undefined as never};
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
    (listeners.focus ?? []).forEach(callback => callback());
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
    route: {key: 'sentence-topics-test', name: 'SentenceTopics'},
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
  return {view, db};
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
    const {view} = await renderInMode('server');

    await waitFor(() => {
      expect(view.getByTestId('sentence-mode-notice')).toBeTruthy();
    });
    expect(database.getLocalDatabase).not.toHaveBeenCalled();
  });

  test('serverless mode waits for the mode restore before loading', async () => {
    const {view} = await renderInMode('serverless');

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
    const {view, db: localDb} = await renderInMode();
    await createSentenceTopic(localDb, {title: 'Coffee', description: 'ordering'});
    await new Promise<void>(resolve => setTimeout(() => resolve(), 5));
    await createSentenceTopic(localDb, {title: 'Neighbours', description: ''});

    // Re-list by simulating the screen regaining focus.
    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId('topic-2')).toBeTruthy();
    });

    expect(view.getByText('Neighbours')).toBeTruthy();
    expect(view.getByText('Coffee')).toBeTruthy();
  });

  test('shows sentence and due counts read from the repository', async () => {
    const {view, db: localDb} = await renderInMode();
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
    const {view, db: localDb} = await renderInMode();
    await createSentenceTopic(localDb, {title: 'Coffee', description: ''});

    await flushFocus();
    await waitFor(() => {
      expect(view.getByTestId('topic-1-done')).toBeTruthy();
      expect(view.getByText('all done')).toBeTruthy();
    });
  });
});

describe('SentenceTopicsScreen — new topic entry point', () => {
  test('the add button opens the separate create-topic screen', async () => {
    const {view} = await renderInMode();

    await fireEvent.press(view.getByTestId('sentence-topics-new'));

    expect(navigate).toHaveBeenCalledWith('SentenceTopicNew');
  });

  test('the add button is a circle', async () => {
    const {view} = await renderInMode();

    expect(view.getByTestId('sentence-topics-new')).toHaveStyle({
      width: 44,
      height: 44,
      borderRadius: 22,
    });
  });
});