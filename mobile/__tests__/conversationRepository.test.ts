/**
 * Local conversation repository tests (SPEC TASK-082).
 *
 * Runs against the sql.js-backed driver with real SQL semantics so foreign
 * keys, cascades and ordering behave exactly as on device. The repository is
 * constructed with an injected driver factory; the default getLocalDatabase()
 * wiring is covered separately through the mocked native driver.
 */
import {openLocalDatabase, resetLocalDatabase} from '../src/db/database';
import {
  LocalConversationRepository,
  type NewRepositoryMessage,
} from '../src/db/conversationRepository';
import type {SqlDriver} from '../src/db/driver';
import {openSqlJsDriver} from '../testing/sqlJsDriver';

/** Yield so successive mutations get distinct updated_at timestamps. */
function tick(ms = 5): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('LocalConversationRepository (TASK-082)', () => {
  let db: SqlDriver;
  let repo: LocalConversationRepository;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
    repo = new LocalConversationRepository(() => Promise.resolve(db));
  });

  afterEach(async () => {
    await db.close();
  });

  test('createSession applies defaults and readSession reads it back', async () => {
    const created = await repo.createSession({topic_hint: 'travel'});

    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('New conversation');
    expect(created.topic).toBe('');
    expect(created.topic_hint).toBe('travel');
    expect(created.learning_level).toBe('A1');
    expect(created.created_at).not.toBe('');

    expect(await repo.readSession(created.id)).toMatchObject({
      id: created.id,
      title: 'New conversation',
      topic_hint: 'travel',
    });
  });

  test('readSession resolves null for unknown ids', async () => {
    expect(await repo.readSession(424242)).toBeNull();
  });

  test('createSession honors explicit attributes', async () => {
    const created = await repo.createSession({
      title: 'Airport small talk',
      topic: 'Talking with strangers at an airport',
      topic_hint: 'flying',
      learning_level: 'B2',
    });

    expect(await repo.readSession(created.id)).toEqual(created);
  });

  test('addMessage appends per-session sequences in order', async () => {
    const session = await repo.createSession();
    const other = await repo.createSession();

    const first = await repo.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'Hi! Ready to practice?',
    });
    const second = await repo.addMessage({
      session_id: session.id,
      role: 'user',
      content: 'Yes!',
    });
    const otherMessage = await repo.addMessage({
      session_id: other.id,
      role: 'user',
      content: 'different session',
    });

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(otherMessage.sequence).toBe(1);

    const messages = await repo.listMessages(session.id);
    expect(messages.map(message => message.content)).toEqual([
      'Hi! Ready to practice?',
      'Yes!',
    ]);
  });

  test('addMessage stores pending status for streaming generations', async () => {
    const session = await repo.createSession();

    const pending = await repo.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: '',
      status: 'pending',
    });

    const [stored] = await repo.listMessages(session.id);
    expect(stored).toMatchObject({id: pending.id, status: 'pending'});
  });

  test('addMessage keeps the active session first in listings', async () => {
    const older = await repo.createSession({title: 'older'});
    await tick();
    await repo.createSession({title: 'newer'});

    // Creation order puts the newest session on top.
    expect((await repo.listSessions()).map(session => session.title)).toEqual([
      'newer',
      'older',
    ]);

    // Chat activity promotes the older session back to the top.
    await tick();
    await repo.addMessage({
      session_id: older.id,
      role: 'user',
      content: 'hello again',
    });

    expect((await repo.listSessions()).map(session => session.title)).toEqual([
      'older',
      'newer',
    ]);
  });

  test('addMessage rejects messages for unknown sessions', async () => {
    const orphan: NewRepositoryMessage = {
      session_id: 987654,
      role: 'user',
      content: 'nowhere to go',
    };
    await expect(repo.addMessage(orphan)).rejects.toThrow();
  });

  test('renameSession persists the title without touching other fields', async () => {
    const created = await repo.createSession({topic_hint: 'movies'});

    await tick();
    await repo.renameSession(created.id, 'Movie night');

    expect(await repo.readSession(created.id)).toMatchObject({
      title: 'Movie night',
      topic_hint: 'movies',
    });
  });

  test('deleteSession cascades messages and summaries and reports existence', async () => {
    const created = await repo.createSession();
    await repo.addMessage({
      session_id: created.id,
      role: 'user',
      content: 'hello',
    });
    await repo.saveSummary({
      session_id: created.id,
      content: 'The user greeted the assistant.',
      message_boundary: 1,
    });

    expect(await repo.deleteSession(created.id)).toBe(true);
    expect(await repo.readSession(created.id)).toBeNull();

    const orphanMessages = await db.execute('SELECT COUNT(*) AS n FROM messages');
    const orphanSummaries = await db.execute('SELECT COUNT(*) AS n FROM summaries');
    expect(Number(orphanMessages.rows[0]?.n)).toBe(0);
    expect(Number(orphanSummaries.rows[0]?.n)).toBe(0);
    expect(await repo.deleteSession(created.id)).toBe(false);
  });

  test('saveSummary stores the rolling summary with its boundary', async () => {
    const created = await repo.createSession();

    const stored = await repo.saveSummary({
      session_id: created.id,
      content: 'They talked about airports.',
      message_boundary: 20,
    });

    expect(stored).toMatchObject({
      session_id: created.id,
      content: 'They talked about airports.',
      message_boundary: 20,
    });
  });

  test('saveSummary overwrites the single summary row per session', async () => {
    const created = await repo.createSession();

    const inserted = await repo.saveSummary({
      session_id: created.id,
      content: 'First part of the talk.',
      message_boundary: 10,
    });
    await tick();
    const updated = await repo.saveSummary({
      session_id: created.id,
      content: 'First part plus archived messages.',
      message_boundary: 30,
    });

    expect(updated.id).toBe(inserted.id);
    expect(updated.message_boundary).toBe(30);
    expect(updated.content).toContain('archived');

    const count = await db.execute('SELECT COUNT(*) AS n FROM summaries');
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  test('saveSummary rejects summaries for unknown sessions', async () => {
    await expect(
      repo.saveSummary({session_id: 555555, content: 'orphan', message_boundary: 1}),
    ).rejects.toThrow();
  });
});

describe('default database wiring (TASK-082)', () => {
  beforeEach(() => {
    resetLocalDatabase();
  });

  afterEach(() => {
    resetLocalDatabase();
  });

  test('the repository resolves the shared auto-initialized database by default', async () => {
    const sqliteStorage = jest.requireMock('react-native-sqlite-storage');
    const repo = new LocalConversationRepository();

    await expect(repo.readSession(1)).resolves.toBeNull();

    expect(sqliteStorage.default.openDatabase).toHaveBeenCalledTimes(1);
  });
});
