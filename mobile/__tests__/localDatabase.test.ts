/**
 * Local serverless SQLite database tests (SPEC TASK-081).
 *
 * Runs against the sql.js-backed driver so migrations and CRUD are exercised
 * with real SQL semantics: versioned migration replay, rollback on failure,
 * per-entity CRUD, cascade deletes and constraint enforcement.
 */
import {
  getLocalDatabase,
  openLocalDatabase,
  resetLocalDatabase,
} from '../src/db/database';
import type {SqlDriver} from '../src/db/driver';
import {MIGRATIONS, SCHEMA_VERSION, migrateDatabase} from '../src/db/migrations';
import {
  getMessage,
  insertMessage,
  listMessages,
  updateMessageStatus,
} from '../src/db/messageStore';
import {getLearningProfile, saveLearningProfile} from '../src/db/profileStore';
import {
  deleteSession,
  getSession,
  insertSession,
  listSessions,
  renameSession,
  touchSession,
} from '../src/db/sessionStore';
import {
  deleteSetting,
  getSetting,
  listSettings,
  setSetting,
} from '../src/db/settingsStore';
import {getSummary, saveSummary} from '../src/db/summaryStore';
import {openSqlJsDriver} from '../testing/sqlJsDriver';

async function tableNames(db: SqlDriver): Promise<string[]> {
  const result = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return result.rows.map(row => String(row.name));
}

async function userVersion(db: SqlDriver): Promise<number> {
  const result = await db.execute('PRAGMA user_version');
  return Number(result.rows[0]?.user_version ?? 0);
}

/** Yield so successive mutations get distinct updated_at timestamps. */
function tick(ms = 5): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('migrations (TASK-081)', () => {
  test('a fresh database applies every migration and records the version', async () => {
    const db = await openSqlJsDriver();

    await migrateDatabase(db);

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const tables = await tableNames(db);
    for (const expected of [
      'learning_profile',
      'settings',
      'sessions',
      'messages',
      'summaries',
    ]) {
      expect(tables).toContain(expected);
    }
    await db.close();
  });

  test('re-running migrations is a no-op on an up-to-date database', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);

    await expect(migrateDatabase(db)).resolves.toBeUndefined();
    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    await db.close();
  });

  test('an outdated database only replays pending migrations', async () => {
    const db = await openSqlJsDriver();

    // Simulate a database from an older app release.
    await migrateDatabase(db, MIGRATIONS.slice(0, 1));
    expect(await userVersion(db)).toBe(1);
    await db.execute(
      "INSERT INTO settings (key, value, updated_at) VALUES ('kept', 'yes', 't')",
    );

    await migrateDatabase(db);

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const kept = await db.execute("SELECT value FROM settings WHERE key = 'kept'");
    expect(kept.rows[0]?.value).toBe('yes');
    await db.close();
  });

  test('a failed migration rolls back its statements and leaves the version untouched', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db, MIGRATIONS.slice(0, 1));

    const failing = [
      ...MIGRATIONS.slice(0, 1),
      ['CREATE TABLE temp_ok (id INTEGER)', 'INSERT INTO missing_table VALUES (1)'],
    ];
    await expect(migrateDatabase(db, failing)).rejects.toThrow();

    expect(await userVersion(db)).toBe(1);
    expect(await tableNames(db)).not.toContain('temp_ok');
    await db.close();
  });
});

describe('database initialization (TASK-081)', () => {
  beforeEach(() => {
    resetLocalDatabase();
  });

  test('openLocalDatabase initializes the schema automatically', async () => {
    const db = await openLocalDatabase(() => openSqlJsDriver());

    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    expect(await tableNames(db)).toEqual(
      expect.arrayContaining(['sessions', 'messages', 'summaries']),
    );
    await db.close();
  });

  test('getLocalDatabase caches one connection until reset', async () => {
    const sqliteStorage = jest.requireMock('react-native-sqlite-storage');

    const first = await getLocalDatabase();
    const second = await getLocalDatabase();
    expect(second).toBe(first);
    expect(sqliteStorage.default.openDatabase).toHaveBeenCalledTimes(1);

    resetLocalDatabase();
    await getLocalDatabase();
    expect(sqliteStorage.default.openDatabase).toHaveBeenCalledTimes(2);
  });
});

describe('session store (TASK-081)', () => {
  let db: SqlDriver;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  test('insert applies defaults and getSession reads it back', async () => {
    const created = await insertSession(db, {topic_hint: 'travel'});

    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('New conversation');
    expect(created.topic).toBe('');
    expect(created.topic_hint).toBe('travel');
    expect(created.learning_level).toBe('A1');
    expect(created.created_at).not.toBe('');

    const stored = await getSession(db, created.id);
    expect(stored).toMatchObject({
      id: created.id,
      title: 'New conversation',
      topic_hint: 'travel',
    });
    expect(await getSession(db, 99999)).toBeNull();
  });

  test('explicit attributes are persisted', async () => {
    const created = await insertSession(db, {
      title: 'Airport small talk',
      topic: 'Talking with strangers at an airport',
      learning_level: 'B2',
    });

    expect(await getSession(db, created.id)).toMatchObject({
      title: 'Airport small talk',
      learning_level: 'B2',
    });
  });

  test('listSessions orders by most recent activity', async () => {
    const first = await insertSession(db, {title: 'first'});
    await insertSession(db, {title: 'second'});
    await tick();

    await renameSession(db, first.id, 'first renamed');
    await tick();

    await touchSession(db, first.id);

    const sessions = await listSessions(db);
    expect(sessions.map(session => session.title)).toEqual([
      'first renamed',
      'second',
    ]);
  });

  test('rename updates title but keeps other fields intact', async () => {
    const created = await insertSession(db, {topic_hint: 'movies'});

    await renameSession(db, created.id, 'Movie night');
    const renamed = await getSession(db, created.id);

    expect(renamed).toMatchObject({
      title: 'Movie night',
      topic_hint: 'movies',
    });
  });

  test('delete removes the session and cascades messages and summaries', async () => {
    const created = await insertSession(db);
    await insertMessage(db, {
      session_id: created.id,
      role: 'user',
      content: 'hello',
    });
    await saveSummary(db, {
      session_id: created.id,
      content: 'The user greeted the assistant.',
      message_boundary: 1,
    });

    expect(await deleteSession(db, created.id)).toBe(true);
    expect(await getSession(db, created.id)).toBeNull();

    const orphanMessages = await db.execute('SELECT COUNT(*) AS n FROM messages');
    const orphanSummaries = await db.execute('SELECT COUNT(*) AS n FROM summaries');
    expect(Number(orphanMessages.rows[0]?.n)).toBe(0);
    expect(Number(orphanSummaries.rows[0]?.n)).toBe(0);
    expect(await deleteSession(db, created.id)).toBe(false);
  });
});

describe('message store (TASK-081)', () => {
  let db: SqlDriver;
  let sessionId: number;
  let otherSessionId: number;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
    sessionId = (await insertSession(db)).id;
    otherSessionId = (await insertSession(db)).id;
  });

  afterEach(async () => {
    await db.close();
  });

  test('insert assigns dense per-session sequences in order', async () => {
    const first = await insertMessage(db, {
      session_id: sessionId,
      role: 'assistant',
      content: 'Hi! Ready to practice?',
    });
    const second = await insertMessage(db, {
      session_id: sessionId,
      role: 'user',
      content: 'Yes!',
    });
    const other = await insertMessage(db, {
      session_id: otherSessionId,
      role: 'user',
      content: 'different session',
    });

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(other.sequence).toBe(1);
    expect(first.status).toBe('complete');
  });

  test('pending status can be stored for streaming generations', async () => {
    const pending = await insertMessage(db, {
      session_id: sessionId,
      role: 'assistant',
      content: '',
      status: 'pending',
    });

    expect(pending.status).toBe('pending');
  });

  test('listMessages returns chronological order for one session', async () => {
    await insertMessage(db, {session_id: sessionId, role: 'user', content: 'one'});
    await insertMessage(db, {
      session_id: otherSessionId,
      role: 'user',
      content: 'noise',
    });
    await insertMessage(db, {
      session_id: sessionId,
      role: 'assistant',
      content: 'two',
    });

    const messages = await listMessages(db, sessionId);
    expect(messages.map(message => message.content)).toEqual(['one', 'two']);
    expect(messages.every(message => message.session_id === sessionId)).toBe(true);
  });

  test('updateMessageStatus transitions streaming states safely', async () => {
    const pending = await insertMessage(db, {
      session_id: sessionId,
      role: 'assistant',
      content: '',
      status: 'pending',
    });

    await updateMessageStatus(db, pending.id, 'failed');
    expect((await getMessage(db, pending.id))?.status).toBe('failed');

    await updateMessageStatus(db, pending.id, 'complete', 'Here is your answer.');
    const completed = await getMessage(db, pending.id);
    expect(completed).toMatchObject({status: 'complete', content: 'Here is your answer.'});
  });

  test('getMessage returns null for unknown ids', async () => {
    expect(await getMessage(db, 123456)).toBeNull();
  });

  test('duplicate sequences within a session are rejected', async () => {
    await insertMessage(db, {session_id: sessionId, role: 'user', content: 'one'});
    await expect(
      db.execute(
        `INSERT INTO messages (session_id, role, status, content, sequence, created_at)
         VALUES (?, 'user', 'complete', 'dup', 1, 't')`,
        [sessionId],
      ),
    ).rejects.toThrow();
  });
});

describe('summary store (TASK-081)', () => {
  let db: SqlDriver;
  let sessionId: number;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
    sessionId = (await insertSession(db)).id;
  });

  afterEach(async () => {
    await db.close();
  });

  test('getSummary resolves null before any summary exists', async () => {
    expect(await getSummary(db, sessionId)).toBeNull();
  });

  test('saveSummary inserts once then overwrites the same row', async () => {
    const inserted = await saveSummary(db, {
      session_id: sessionId,
      content: 'First part of the talk.',
      message_boundary: 20,
    });
    expect(inserted).toMatchObject({
      session_id: sessionId,
      content: 'First part of the talk.',
      message_boundary: 20,
    });

    await tick();
    const updated = await saveSummary(db, {
      session_id: sessionId,
      content: 'First part plus archived messages.',
      message_boundary: 40,
    });

    expect(updated.id).toBe(inserted.id);
    expect(updated.content).toContain('archived');
    expect(updated.message_boundary).toBe(40);
    expect(updated.updated_at >= inserted.created_at).toBe(true);

    const count = await db.execute('SELECT COUNT(*) AS n FROM summaries');
    expect(Number(count.rows[0]?.n)).toBe(1);
  });
});

describe('profile store (TASK-081)', () => {
  let db: SqlDriver;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  test('a fresh database reports the default level', async () => {
    const profile = await getLearningProfile(db);
    expect(profile.level).toBe('A1');
    expect(profile.updated_at).toBe('');
  });

  test('saving persists and overwrites the single profile row', async () => {
    await saveLearningProfile(db, 'B2');
    expect((await getLearningProfile(db)).level).toBe('B2');

    await tick();
    await saveLearningProfile(db, 'AUTO');
    const profile = await getLearningProfile(db);
    expect(profile.level).toBe('AUTO');

    const rows = await db.execute('SELECT COUNT(*) AS n FROM learning_profile');
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  test('invalid levels are rejected by the schema', async () => {
    await expect(saveLearningProfile(db, 'Z9' as never)).rejects.toThrow();
    expect((await getLearningProfile(db)).level).toBe('A1');
  });
});

describe('settings store (TASK-081)', () => {
  let db: SqlDriver;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  test('set/get round-trip and overwrite values', async () => {
    expect(await getSetting(db, 'model.primary')).toBeNull();

    await setSetting(db, 'model.primary', 'openai/gpt-4o-mini');
    expect(await getSetting(db, 'model.primary')).toBe('openai/gpt-4o-mini');

    await setSetting(db, 'model.primary', 'anthropic/claude-haiku');
    expect(await getSetting(db, 'model.primary')).toBe('anthropic/claude-haiku');
  });

  test('delete removes only the targeted key', async () => {
    await setSetting(db, 'model.primary', 'a');
    await setSetting(db, 'model.fallback.1', 'b');

    await deleteSetting(db, 'model.primary');

    expect(await getSetting(db, 'model.primary')).toBeNull();
    expect(await listSettings(db)).toEqual({'model.fallback.1': 'b'});
    await expect(deleteSetting(db, 'model.primary')).resolves.toBeUndefined();
  });

  test('listSettings returns all entries', async () => {
    await setSetting(db, 'model.primary', 'a');
    await setSetting(db, 'model.fallback.1', 'b');

    expect(await listSettings(db)).toEqual({
      'model.fallback.1': 'b',
      'model.primary': 'a',
    });
  });
});

describe('transactions (TASK-081)', () => {
  let db: SqlDriver;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  test('committed work persists', async () => {
    const outcome = await db.transaction(async tx => {
      await tx.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 't')",
      );
      return 'done';
    });

    expect(outcome).toBe('done');
    expect(await getSetting(db, 'k')).toBe('v');
  });

  test('thrown errors roll back every statement in the transaction', async () => {
    await expect(
      db.transaction(async tx => {
        await tx.execute(
          "INSERT INTO settings (key, value, updated_at) VALUES ('a', '1', 't')",
        );
        await tx.execute(
          "INSERT INTO settings (key, value, updated_at) VALUES ('b', '2', 't')",
        );
        throw new Error('abort work');
      }),
    ).rejects.toThrow('abort work');

    expect(await getSetting(db, 'a')).toBeNull();
    expect(await getSetting(db, 'b')).toBeNull();
  });
});
