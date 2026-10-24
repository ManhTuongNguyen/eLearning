/**
 * Home "Word bank" row (WORD_BANK_V1 TASK-WB-015).
 *
 * The row is the serverless-only entry point to the word bank. It shows the
 * number of words due today (complete, non-suspended words only), hides the
 * badge at zero, refreshes when Home regains focus, and never touches the
 * local database in server mode.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import { countDueWords, createWordTopic, insertWords } from '../src/db/wordRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { HomeScreenProps } from '../src/navigation/types';
import { HomeScreen } from '../src/screens/HomeScreen';
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
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

const navigate = jest.fn();
let listeners: Record<string, (() => void)[]> = {};

function flushFocus(): Promise<void> {
  return act(async () => {
    (listeners.focus ?? []).forEach(callback => {
      callback();
    });
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
    route: { key: 'home-test', name: 'Home' },
  } as unknown as HomeScreenProps;
}

async function seedDatabase(): Promise<SqlDriver> {
  db = await openSqlJsDriver();
  await migrateDatabase(db);
  database.__setDriver(db);
  return db;
}

async function renderHome(mode: 'server' | 'serverless', props: HomeScreenProps = homeProps()) {
  await saveApplicationMode(mode);
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <HomeScreen {...props} />
      </ThemeProvider>
    </ModeProvider>,
  );
  await waitFor(() => {
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('app.applicationMode');
  });
  await act(async () => {});
  return { view, props };
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

describe('Home Word bank row', () => {
  test('is present in serverless mode and pushes WordTopics', async () => {
    await seedDatabase();
    const { view, props } = await renderHome('serverless');

    const row = await view.findByTestId('home-open-words');
    expect(view.getByText('Word bank')).toBeTruthy();
    expect(view.getByTestId('icon-words', { includeHiddenElements: true })).toBeTruthy();

    await fireEvent.press(row);
    expect(
      (props.navigation as unknown as { navigate: jest.Mock }).navigate,
    ).toHaveBeenLastCalledWith('WordTopics');
  });

  test('shows a due-today badge equal to countDueWords', async () => {
    const localDb = await seedDatabase();
    const topic = await createWordTopic(localDb, { title: 'Cooking' });
    await insertWords(localDb, topic.id, [
      { text: 'bank' }, // due now
      { text: 'simmer' }, // suspended below
      { text: 'whisk' }, // future-due below
      { text: 'blanch', data_status: 'missing' }, // dataless: never due
    ]);
    await localDb.execute("UPDATE words SET suspended = 1 WHERE text = 'simmer'");
    await localDb.execute(
      "UPDATE words SET due_at = '2999-01-01T00:00:00.000Z' WHERE text = 'whisk'",
    );

    const expected = await countDueWords(localDb);
    expect(expected).toBe(1);

    const { view } = await renderHome('serverless');
    const badge = await view.findByTestId('home-open-words-badge');
    expect(badge).toHaveTextContent(String(expected));
  });

  test('hides the badge at zero and refreshes on focus', async () => {
    const localDb = await seedDatabase();
    const topic = await createWordTopic(localDb, { title: 'Cooking' });
    await insertWords(localDb, topic.id, [{ text: 'bank' }]);

    const { view } = await renderHome('serverless');
    expect(await view.findByTestId('home-open-words-badge')).toHaveTextContent('1');

    await localDb.execute('DELETE FROM words');
    await flushFocus();

    await waitFor(() => {
      expect(view.queryByTestId('home-open-words-badge')).toBeNull();
    });
  });

  test('is absent in server mode and reads no local data', async () => {
    await seedDatabase();
    const { view } = await renderHome('server');

    expect(view.queryByTestId('home-open-words')).toBeNull();
    expect(database.getLocalDatabase).not.toHaveBeenCalled();
  });
});
