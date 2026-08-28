/**
 * Conversation source service tests (TASK-AUDIT-014): the single owner of
 * the mode-branched conversation reads used by the chat screen.
 *
 * Server mode runs the real endpoint bindings against a routing requester
 * double; serverless mode runs against the sql.js-backed on-device database
 * so real store semantics (ordering, detail lookup, unknown ids) are
 * exercised.
 */
import type {AuthedRequester} from '../src/auth/authedRequest';
import type {ChatMessage, Paginated, Session} from '../src/api/sessions';
import {getLocalDatabase, resetLocalDatabase} from '../src/db/database';
import * as nativeDriver from '../src/db/nativeDriver';
import {insertMessage} from '../src/db/messageStore';
import {insertSession} from '../src/db/sessionStore';
import {
  bySequence,
  listFirstSessionPage,
  loadConversation,
} from '../src/services/conversationSource';

jest.mock('../src/db/nativeDriver', () => {
  const {openSqlJsDriver} = require('../testing/sqlJsDriver');
  let mockDbPromise: Promise<unknown> | null = null;
  return {
    LOCAL_DB_NAME: 'elearning-serverless.db',
    openNativeDriver: () => {
      if (mockDbPromise === null) {
        mockDbPromise = openSqlJsDriver();
      }
      return mockDbPromise;
    },
    __resetLocalDriver: () => {
      mockDbPromise = null;
    },
  };
});

const mockedNativeDriver = nativeDriver as typeof nativeDriver & {
  __resetLocalDriver: () => void;
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 9,
    title: 'Traveling',
    topic: 'Talking about favorite destinations.',
    topic_hint: '',
    learning_level: 'B1',
    created_at: '2026-08-26T10:00:00Z',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 101,
    role: 'assistant',
    status: 'complete',
    content: 'Hello! Ready to practice?',
    sequence: 1,
    created_at: '2026-08-26T10:00:00Z',
    ...overrides,
  };
}

function pageOf(results: ChatMessage[]): Paginated<ChatMessage> {
  return {count: results.length, next: null, previous: null, results};
}

/**
 * Route the binding paths to canned responses, like the backend would; a
 * stored Error instance fails that path's request.
 */
function makeRequester(handlers: Record<string, unknown>): AuthedRequester {
  const request = jest.fn(async <T,>(path: string): Promise<T> => {
    const base = path.replace(/\?.*$/, '');
    const handler = handlers[base];
    if (handler === undefined) {
      throw new Error(`unexpected request path: ${path}`);
    }
    if (handler instanceof Error) {
      throw handler;
    }
    return handler as T;
  });
  return request as unknown as AuthedRequester;
}

/** Yield so successive inserts get distinct recency stamps. */
function tick(ms = 5): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** One freshly migrated in-memory database per test. */
async function freshLocalDatabase() {
  mockedNativeDriver.__resetLocalDriver();
  resetLocalDatabase();
  return getLocalDatabase();
}

describe('bySequence', () => {
  test('orders conversation rows chronologically', () => {
    const rows = [
      makeMessage({id: 3, sequence: 3}),
      makeMessage({id: 1, sequence: 1}),
      makeMessage({id: 2, sequence: 2}),
    ];
    expect([...rows].sort(bySequence).map(row => row.id)).toEqual([1, 2, 3]);
  });
});

describe('listFirstSessionPage (server mode)', () => {
  test('passes the page-one request through the authed requester', async () => {
    const request = makeRequester({
      '/api/v1/sessions/': {
        count: 2,
        next: null,
        previous: null,
        results: [makeSession({id: 9}), makeSession({id: 7})],
      },
    });

    const page = await listFirstSessionPage('server', request);

    expect(request).toHaveBeenCalledWith('/api/v1/sessions/?page=1');
    expect(page.results[0]?.id).toBe(9);
  });
});

describe('listFirstSessionPage (serverless mode)', () => {
  test('reads the on-device sessions most recently active first', async () => {
    await freshLocalDatabase();
    const first = await insertSession(await getLocalDatabase(), {title: 'Older'});
    await tick();
    await insertSession(await getLocalDatabase(), {title: 'Newer'});

    expect(first.id).toBe(1);

    const page = await listFirstSessionPage('serverless', makeRequester({}));

    expect(page.results.map(row => row.title)).toEqual(['Newer', 'Older']);
  });
});

describe('loadConversation (server mode)', () => {
  test('returns the sorted messages plus the session detail', async () => {
    const request = makeRequester({
      '/api/v1/sessions/9/messages/': pageOf([
        makeMessage({id: 12, sequence: 2}),
        makeMessage({id: 11, sequence: 1}),
      ]),
      '/api/v1/sessions/9/': makeSession({id: 9}),
    });

    const snapshot = await loadConversation('server', 9, request);

    expect(snapshot.messages.map(row => row.id)).toEqual([11, 12]);
    expect(snapshot.session?.title).toBe('Traveling');
  });

  test('a failed detail lookup keeps the conversation and drops the session', async () => {
    const request = makeRequester({
      '/api/v1/sessions/9/messages/': pageOf([makeMessage({id: 11, sequence: 1})]),
      '/api/v1/sessions/9/': new Error('detail lookup failed'),
    });

    const snapshot = await loadConversation('server', 9, request);

    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.session).toBeNull();
  });
});

describe('loadConversation (serverless mode)', () => {
  test('reads the local messages sorted plus the local session detail', async () => {
    const db = await freshLocalDatabase();
    const session = await insertSession(db, {title: 'Weekend plans'});
    await insertMessage(db, {
      session_id: session.id,
      role: 'assistant',
      content: 'Hello!',
    });
    await insertMessage(db, {
      session_id: session.id,
      role: 'user',
      content: 'Hi!',
    });

    const snapshot = await loadConversation('serverless', session.id, makeRequester({}));

    expect(snapshot.messages.map(row => row.content)).toEqual(['Hello!', 'Hi!']);
    expect(snapshot.session?.title).toBe('Weekend plans');
  });

  test('an unknown session resolves to an empty snapshot instead of failing', async () => {
    await freshLocalDatabase();

    const snapshot = await loadConversation('serverless', 404, makeRequester({}));

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.session).toBeNull();
  });
});
