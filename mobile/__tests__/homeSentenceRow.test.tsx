/**
 * Home "Real-life sentences" row (TASK-SENT-014).
 *
 * The row is the serverless-only entry point to the sentence bank. It shows
 * the number of sentences due today, hides the badge at zero, refreshes when
 * Home regains focus after practice, and never touches the local database in
 * server mode.
 */
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {act, fireEvent, render, waitFor} from '@testing-library/react-native';

import type {SqlDriver} from '../src/db/driver';
import {migrateDatabase} from '../src/db/migrations';
import {
  countDueSentences,
  createSentenceTopic,
  insertSentences,
} from '../src/db/sentenceRepository';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import type {HomeScreenProps} from '../src/navigation/types';
import {HomeScreen} from '../src/screens/HomeScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';
import {openSqlJsDriver} from '../testing/sqlJsDriver';

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
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

const navigate = jest.fn();
let listeners: Record<string, (() => void)[]> = {};

function flushFocus(): Promise<void> {
  return act(async () => {
    (listeners.focus ?? []).forEach(callback => callback());
  });
}

function homeProps(): HomeScreenProps {
  return {
    navigation: {
      navigate,
      addListener: (event: string, callback: () => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(callback);
        return () => {
          listeners[event] = listeners[event].filter(cb => cb !== callback);
        };
      },
    },
    route: {key: 'home-test', name: 'Home'},
  } as unknown as HomeScreenProps;
}

async function seedDatabase(): Promise<SqlDriver> {
  db = await openSqlJsDriver();
  await migrateDatabase(db);
  database.__setDriver(db);
  return db;
}

async function renderHome(
  mode: 'server' | 'serverless',
  props: HomeScreenProps = homeProps(),
) {
  await saveApplicationMode(mode);
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <HomeScreen {...props} />
      </ThemeProvider>
    </ModeProvider>,
  );
  // Let ModeProvider restore the persisted mode before asserting row gating.
  await waitFor(() => {
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('app.applicationMode');
  });
  await act(async () => {});
  return {view, props};
}

async function seedSentences(
  localDb: SqlDriver,
  options: {text: string; dueAt?: string; suspended?: boolean}[],
): Promise<void> {
  const topic = await createSentenceTopic(localDb, {title: 'Coffee'});
  await insertSentences(
    localDb,
    topic.id,
    options.map(option => ({
      text: option.text,
      meaning: 'A short everyday meaning.',
      situation: 'A real-life situation.',
    })),
  );
  for (const option of options) {
    if (option.dueAt) {
      await localDb.execute('UPDATE sentences SET due_at = ? WHERE text = ?', [
        option.dueAt,
        option.text,
      ]);
    }
    if (option.suspended) {
      await localDb.execute("UPDATE sentences SET status = 'suspended' WHERE text = ?", [
        option.text,
      ]);
    }
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  navigate.mockReset();
  listeners = {};
  asyncStorage.__resetAsyncStorageStore();
});

afterEach(() => {
  db?.close?.();
});

describe('Home Real-life sentences row', () => {
  test('is present in serverless mode and pushes SentenceTopics', async () => {
    await seedDatabase();
    const {view, props} = await renderHome('serverless');

    const row = await view.findByTestId('home-open-sentences');
    expect(view.getByText('Real-life sentences')).toBeTruthy();
    expect(view.getByTestId('icon-sentences', {includeHiddenElements: true})).toBeTruthy();

    await fireEvent.press(row);
    expect((props.navigation as unknown as {navigate: jest.Mock}).navigate).toHaveBeenLastCalledWith(
      'SentenceTopics',
    );
    expect(navigate).toHaveBeenLastCalledWith('SentenceTopics');
  });

  test('shows a due-today badge equal to countDueSentences', async () => {
    const localDb = await seedDatabase();
    await seedSentences(localDb, [
      {text: 'Could I get a flat white, please?'},
      {text: 'Is this seat taken?'},
      {text: 'Thanks, have a nice day.'},
    ]);
    // Only the first sentence should count: one is suspended and one is due
    // in the future.
    await localDb.execute("UPDATE sentences SET status = 'suspended' WHERE text = ?", [
      'Is this seat taken?',
    ]);
    await localDb.execute('UPDATE sentences SET due_at = ? WHERE text = ?', [
      '2999-01-01T00:00:00.000Z',
      'Thanks, have a nice day.',
    ]);

    const expected = await countDueSentences(localDb);
    expect(expected).toBe(1);

    const {view} = await renderHome('serverless');
    const badge = await view.findByTestId('home-open-sentences-badge');
    expect(badge).toHaveTextContent(String(expected));
  });

  test('hides the badge at zero and removes it when a refreshed count is zero', async () => {
    const localDb = await seedDatabase();
    await seedSentences(localDb, [{text: 'Could I get a flat white, please?'}]);

    const {view} = await renderHome('serverless');
    expect(await view.findByTestId('home-open-sentences-badge')).toHaveTextContent('1');

    await localDb.execute('DELETE FROM sentences');
    await flushFocus();

    await waitFor(() => {
      expect(view.queryByTestId('home-open-sentences-badge')).toBeNull();
    });
  });

  test('is absent in server mode and reads no local data', async () => {
    await seedDatabase();
    const {view} = await renderHome('server');

    expect(view.queryByTestId('home-open-sentences')).toBeNull();
    expect(database.getLocalDatabase).not.toHaveBeenCalled();
  });
});
