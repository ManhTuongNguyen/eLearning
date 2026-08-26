/**
 * Serverless chat streaming tests (SPEC TASK-086). Runs against the
 * sql.js-backed driver with real SQL semantics and the scripted OpenRouter
 * fake: user messages are stored locally together with their pending
 * assistant slot inside one transaction, streamed text settles that exact
 * row before the terminal event reaches consumers, failed outcomes stay
 * retryable without corrupting the conversation, retries re-arm the failed
 * row in place, and abandoned turns leave nothing but a pending slot.
 */
import {openLocalDatabase} from '../src/db/database';
import {LocalConversationRepository} from '../src/db/conversationRepository';
import type {SqlDriver, SqlExecutor} from '../src/db/driver';
import type {LocalSession} from '../src/db/types';
import {openSqlJsDriver} from '../testing/sqlJsDriver';
import {FakeOpenRouterClient} from '../testing/fakeOpenRouter';
import {
  retryServerlessTurn,
  ServerlessTurnError,
  streamServerlessTurn,
  type PreparedTurn,
  type ServerlessTurnOptions,
  type StreamFn,
  type TurnRequestBuilder,
} from '../src/serverless/chatStreaming';
import type {ServerlessStreamEvent, CompletionRequest} from '../src/serverless/types';

/** Let the async terminal-event persistence (and delivery) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('serverless chat streaming (TASK-086)', () => {
  let db: SqlDriver;
  let repository: LocalConversationRepository;
  let fake: FakeOpenRouterClient;
  let builtTurns: PreparedTurn[];
  let builtRequests: CompletionRequest[];
  let events: Array<Record<string, unknown>>;
  let sessionId: number;

  const buildRequest: TurnRequestBuilder = turn => {
    builtTurns.push(turn);
    const request: CompletionRequest = {
      messages: [{role: 'user', content: turn.userMessage.content}],
    };
    builtRequests.push(request);
    return request;
  };

  const streamFn: StreamFn = options => fake.streamCompletion(options);

  interface OptionOverrides {
    openDb?: () => Promise<SqlDriver>;
    buildRequest?: TurnRequestBuilder;
    sessionId?: number;
    onEvent?: (event: ServerlessStreamEvent) => void;
  }

  function turnOptions(
    text: string,
    overrides: OptionOverrides = {},
  ): ServerlessTurnOptions & {text: string} {
    return {
      openDb: async () => db,
      stream: streamFn,
      buildRequest,
      sessionId,
      onEvent: event => {
        events.push(event as Record<string, unknown>);
      },
      ...overrides,
      text,
    };
  }

  function retryOptions(
    messageId: number,
    overrides: OptionOverrides = {},
  ): ServerlessTurnOptions & {messageId: number} {
    return {
      openDb: async () => db,
      stream: streamFn,
      buildRequest,
      sessionId,
      onEvent: event => {
        events.push(event as Record<string, unknown>);
      },
      ...overrides,
      messageId,
    };
  }

  /** Seed a session with one historical message and an ancient recency stamp. */
  async function seedSession(withHistory = true): Promise<LocalSession> {
    const session = await repository.createSession({
      title: 'Ordering Coffee',
      topic: 'Practise polite requests.',
    });
    sessionId = session.id;
    if (withHistory) {
      await repository.addMessage({session_id: session.id, role: 'user', content: 'Warm-up'});
    }
    await db.execute('UPDATE sessions SET updated_at = ?', ['2000-01-01T00:00:00.000Z']);
    return session;
  }

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
    repository = new LocalConversationRepository(async () => db);
    fake = new FakeOpenRouterClient();
    builtTurns = [];
    builtRequests = [];
    events = [];
    sessionId = 0;
  });

  afterEach(async () => {
    await db.close();
  });

  test('a sent message is stored locally, streams locally and persists on completion', async () => {
    await seedSession();
    fake.enqueueStream({type: 'success', model: 'vendor/model-a', deltas: ['Hello', ' there']});

    const handle = await streamServerlessTurn(turnOptions('Hi tutor'));
    expect(typeof handle.abort).toBe('function');
    await settle();

    const messages = await repository.listMessages(sessionId);
    expect(messages.map(m => [m.role, m.status, m.sequence])).toEqual([
      ['user', 'complete', 1],
      ['user', 'complete', 2],
      ['assistant', 'complete', 3],
    ]);
    expect(messages[1].content).toBe('Hi tutor');
    expect(messages[2].content).toBe('Hello there');

    expect(events.map(e => e.type)).toEqual(['start', 'delta', 'delta', 'completed']);
    expect(events[3]).toMatchObject({text: 'Hello there', model: 'vendor/model-a'});

    // The builder saw both persisted rows; the request carries the prompt.
    expect(builtTurns).toHaveLength(1);
    const [turn] = builtTurns;
    expect(turn.userMessage.content).toBe('Hi tutor');
    expect(turn.assistantMessage.id).toBe(messages[2].id);
    expect(builtRequests[0].messages).toEqual([{role: 'user', content: 'Hi tutor'}]);

    // Conversation activity refreshes the history recency stamp.
    const stored = await repository.readSession(sessionId);
    expect(stored?.updated_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  test('blank or non-string text is rejected before anything is written', async () => {
    await seedSession(false);
    for (const bad of ['', '   ']) {
      builtTurns = [];
      builtRequests = [];
      await expect(
        streamServerlessTurn(turnOptions(bad)),
      ).rejects.toBeInstanceOf(ServerlessTurnError);
      expect(builtTurns).toHaveLength(0);
    }
    expect(await repository.listMessages(sessionId)).toHaveLength(0);
  });

  test('an unknown session rejects without writing rows', async () => {
    sessionId = 424242;
    await expect(
      streamServerlessTurn(turnOptions('Hello?', {sessionId: 424242})),
    ).rejects.toBeInstanceOf(ServerlessTurnError);
    expect(builtTurns).toHaveLength(0);
    expect(await repository.listSessions()).toHaveLength(0);
  });

  test('a failed stream keeps the user message, marks only the status and stays retryable', async () => {
    await seedSession();
    fake.enqueueStream({
      type: 'failure',
      message: 'model overloaded',
      retryable: true,
      partialText: 'Par',
      startModel: 'vendor/model-a',
    });

    await streamServerlessTurn(turnOptions('Correct me'));
    await settle();

    const messages = await repository.listMessages(sessionId);
    expect(messages.map(m => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['user', 'complete'],
      ['assistant', 'failed'],
    ]);
    // Partial output is never persisted as a complete message.
    expect(messages[2].content).toBe('');

    expect(events.map(e => e.type)).toEqual(['start', 'failed']);
    expect(events[1]).toMatchObject({message: 'model overloaded', retryable: true, text: 'Par'});
  });

  test('retry re-arms the failed row in place without duplicating the prompt', async () => {
    await seedSession();
    fake.enqueueStream({
      type: 'failure',
      message: 'first attempt died',
      retryable: true,
    });
    await streamServerlessTurn(turnOptions('Try again please'));
    await settle();

    const failedRow = (await repository.listMessages(sessionId)).find(
      m => m.role === 'assistant',
    );
    expect(failedRow?.status).toBe('failed');

    builtTurns = [];
    events = [];
    fake.enqueueStream({type: 'success', model: 'vendor/model-b', deltas: ['Fixed!']});
    await retryServerlessTurn(retryOptions(failedRow!.id));
    await settle();

    const messages = await repository.listMessages(sessionId);
    // Same primary key, same sequence position, exactly one user prompt.
    expect(messages.map(m => [m.id, m.role, m.status, m.sequence])).toEqual([
      [messages[0].id, 'user', 'complete', 1],
      [messages[1].id, 'user', 'complete', 2],
      [failedRow!.id, 'assistant', 'complete', 3],
    ]);
    expect(messages[2].content).toBe('Fixed!');
    expect(events.map(e => e.type)).toEqual(['start', 'delta', 'completed']);

    // Retry rebuilds the request from the ORIGINAL user message verbatim.
    expect(builtTurns).toHaveLength(1);
    expect(builtTurns[0].userMessage.content).toBe('Try again please');
    expect(builtTurns[0].assistantMessage.id).toBe(failedRow!.id);
  });

  test('retry refuses targets that are not failed assistant rows', async () => {
    await seedSession();
    const userRow = await repository.addMessage({
      session_id: sessionId,
      role: 'user',
      content: 'plain',
    });
    const okAssistant = await repository.addMessage({
      session_id: sessionId,
      role: 'assistant',
      content: 'done',
    });

    for (const messageId of [userRow.id, okAssistant.id, 987654]) {
      builtTurns = [];
      builtRequests = [];
      await expect(
        retryServerlessTurn(retryOptions(messageId)),
      ).rejects.toBeInstanceOf(ServerlessTurnError);
      expect(builtTurns).toHaveLength(0);
    }
    // Nothing changed.
    const messages = await repository.listMessages(sessionId);
    expect(messages).toHaveLength(3);
    expect(messages.every(m => m.status === 'complete')).toBe(true);
  });

  test('an abandoned stream leaves the assistant slot pending and delivers no terminal', async () => {
    await seedSession(false);
    fake.enqueueStream({
      type: 'raw',
      events: [
        {type: 'start', model: 'vendor/model-a'},
        {type: 'delta', text: 'half a thought'},
      ],
    });

    const handle = await streamServerlessTurn(turnOptions('Interrupted'));
    handle.abort();
    await settle();

    const messages = await repository.listMessages(sessionId);
    expect(messages.map(m => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'pending'],
    ]);
    expect(events.map(e => e.type)).toEqual(['start', 'delta']);
  });

  test('abort after the outcome arrived still persists it but never delivers callbacks', async () => {
    await seedSession(false);
    fake.enqueueStream({type: 'success', deltas: ['Too late']});
    const handle = await streamServerlessTurn(turnOptions('Racing'));
    handle.abort();
    await settle();

    // Persistence is not rolled back by a late abort...
    const messages = await repository.listMessages(sessionId);
    expect(messages[1]).toMatchObject({status: 'complete', content: 'Too late'});
    // ...but the consumer observed no terminal delivery after abort().
    expect(events.map(e => e.type)).toEqual(['start', 'delta']);
  });

  test('a failing request builder rolls the whole turn back', async () => {
    await seedSession(false);
    const explodingBuilder: TurnRequestBuilder = () => {
      throw new Error('no context available');
    };
    await expect(
      streamServerlessTurn(turnOptions('Vanishing', {buildRequest: explodingBuilder})),
    ).rejects.toThrow('no context available');

    expect(await repository.listMessages(sessionId)).toHaveLength(0);
    expect(fake.streamRequests).toHaveLength(0);
  });

  test('a failing completion persistence degrades to a retryable failure instead of a lie', async () => {
    await seedSession(false);
    let calls = 0;
    const brokenAfterPrepare = async (): Promise<SqlDriver> => {
      calls += 1;
      if (calls === 1) {
        return db;
      }
      const broken: SqlExecutor = {
        execute: async () => {
          throw new Error('disk full');
        },
      };
      return {...broken, transaction: db.transaction.bind(db), close: db.close.bind(db)} as SqlDriver;
    };

    fake.enqueueStream({type: 'success', deltas: ['Unsavable']});
    await streamServerlessTurn(turnOptions('Save me', {openDb: brokenAfterPrepare}));
    await settle();

    expect(events.map(e => e.type)).toEqual(['start', 'delta', 'failed']);
    expect(events[2]).toMatchObject({
      message: 'The response could not be saved on this device.',
      retryable: true,
      text: 'Unsavable',
    });
    // The row was never marked complete without its commit.
    const messages = await repository.listMessages(sessionId);
    expect(messages[1].status).toBe('pending');
  });
});
