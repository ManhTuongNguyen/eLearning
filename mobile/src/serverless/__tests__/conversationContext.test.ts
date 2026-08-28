/**
 * Serverless conversation context and local summary tests (SPEC TASK-111).
 *
 * Runs the TASK-087 context seam end to end against a real in-memory SQLite
 * database (sql.js) and the scripted OpenRouter fake:
 * - buildServerlessContext assembles system + profile + topic + rolling
 *   summary + recent prior window + current message from local rows, never
 *   duplicating the current user message and never leaking pending rows
 * - updateSummaryIfNeeded fires exactly at the threshold, folds only the
 *   archived increment (with the previous summary) into the rolling summary,
 *   skips the provider when there is nothing to summarize and ignores
 *   unknown sessions
 */
import {openLocalDatabase} from '../../../src/db/database';
import type {SqlDriver} from '../../../src/db/driver';
import {LocalConversationRepository} from '../../../src/db/conversationRepository';
import {updateMessageStatus} from '../../../src/db/messageStore';
import {getSummary} from '../../../src/db/summaryStore';
import {openSqlJsDriver} from '../../../testing/sqlJsDriver';
import {FakeOpenRouterClient} from '../../../testing/fakeOpenRouter';
import {buildServerlessContext, updateSummaryIfNeeded} from '../conversationContext';

let mockDb: SqlDriver;

jest.mock('../../../src/db/database', () => {
  const actual = jest.requireActual('../../../src/db/database');
  return {
    ...actual,
    // Both functions resolve the shared database implicitly; route it to the
    // per-test sql.js instance created in beforeEach.
    getLocalDatabase: () => Promise.resolve(mockDb),
    resetLocalDatabase: () => {},
  };
});

const SUMMARIZED_TEXT = 'Folded messages 1-40.';

async function addAlternatingTurns(
  repository: LocalConversationRepository,
  sessionId: number,
  count: number,
  firstIndex = 1,
): Promise<void> {
  for (let i = firstIndex; i < firstIndex + count; i++) {
    await repository.addMessage({
      session_id: sessionId,
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `message-${i}`,
    });
  }
}

describe('serverless conversation context (TASK-111)', () => {
  let repository: LocalConversationRepository;
  let fake: FakeOpenRouterClient;

  beforeEach(async () => {
    mockDb = await openLocalDatabase(() => openSqlJsDriver());
    repository = new LocalConversationRepository(async () => mockDb);
    fake = new FakeOpenRouterClient();
  });

  afterEach(async () => {
    await mockDb.close();
  });

  describe('buildServerlessContext', () => {
    test('assembles system prompt, prior window and current message from local rows', async () => {
      const session = await repository.createSession({
        title: 'Traveling',
        topic: 'Traveling: airports, flights and hotel check-ins',
        learning_level: 'B1',
      });
      await addAlternatingTurns(repository, session.id, 25);
      await repository.saveSummary({
        session_id: session.id,
        content: 'Learner greeted and asked about flights.',
        message_boundary: 5,
      });
      const userMessage = await repository.addMessage({
        session_id: session.id,
        role: 'user',
        content: 'What about trains?',
      });
      const assistantMessage = await repository.addMessage({
        session_id: session.id,
        role: 'assistant',
        content: '',
        status: 'pending',
      });

      const request = await buildServerlessContext({session, userMessage, assistantMessage});

      expect(request.messages).toHaveLength(22);
      const [system, ...rest] = request.messages;
      expect(system.role).toBe('system');
      expect(system.content).toContain('The learner\'s English level is B1 (CEFR)');
      expect(system.content).toContain('Conversation topic: "Traveling".');
      expect(system.content).toContain(
        'Topic scenario: Traveling: airports, flights and hotel check-ins',
      );
      expect(system.content).toContain('Summary of the earlier conversation:');
      expect(system.content).toContain('Learner greeted and asked about flights.');

      // History is the last 20 PRIOR messages in chronological order.
      expect(rest[0]).toEqual({role: 'assistant', content: 'message-6'});
      expect(rest[19]).toEqual({role: 'user', content: 'message-25'});
      // The current user message appears exactly once, last; the pending
      // assistant slot never leaks into the request.
      expect(rest[20]).toEqual({role: 'user', content: 'What about trains?'});
      expect(rest.slice(0, 20).filter(turn => turn.content === 'What about trains?')).toEqual([]);
      expect(request.messages.filter(turn => turn.role === 'assistant').map(turn => turn.content))
        .not.toContain('');
    });

    test('omits the summary section while no summary is stored', async () => {
      const session = await repository.createSession({topic: 'Small talk: weather', learning_level: 'A1'});
      const prior = await repository.addMessage({
        session_id: session.id,
        role: 'assistant',
        content: 'Hello! How are you today?',
      });
      const userMessage = await repository.addMessage({
        session_id: session.id,
        role: 'user',
        content: 'I am fine, thanks!',
      });

      const request = await buildServerlessContext({
        session,
        userMessage,
        assistantMessage: {...prior, id: prior.id + 1, role: 'assistant', status: 'pending', content: ''},
      });

      expect(request.messages[0].role).toBe('system');
      expect(request.messages[0].content).not.toContain('Summary of the earlier conversation:');
      expect(request.messages[request.messages.length - 1]).toEqual({
        role: 'user',
        content: 'I am fine, thanks!',
      });
    });

    test('falls back to the full topic string when it has no title prefix', async () => {
      const session = await repository.createSession({topic: 'Just chatting', learning_level: 'A2'});
      const userMessage = await repository.addMessage({
        session_id: session.id,
        role: 'user',
        content: 'Hi there',
      });

      const request = await buildServerlessContext({
        session,
        userMessage,
        assistantMessage: {...userMessage, id: userMessage.id + 1, role: 'assistant', status: 'pending', content: ''},
      });

      expect(request.messages[0].content).toContain('Conversation topic: "Just chatting".');
      expect(request.messages[0].content).toContain('Topic scenario: Just chatting');
    });
  });

  describe('updateSummaryIfNeeded', () => {
    test('resolves false below the threshold without calling the provider', async () => {
      const session = await repository.createSession();
      await addAlternatingTurns(repository, session.id, 59);

      await expect(updateSummaryIfNeeded(repository, fake, session.id)).resolves.toBe(false);

      expect(fake.completeRequests).toHaveLength(0);
      expect(await getSummary(mockDb, session.id)).toBeNull();
    });

    test('generates and persists the rolling summary at the threshold', async () => {
      const session = await repository.createSession();
      await addAlternatingTurns(repository, session.id, 60);
      fake.enqueueComplete({
        text: SUMMARIZED_TEXT,
        model: 'vendor/model-a',
        finishReason: 'stop',
        requestId: null,
      });

      await expect(updateSummaryIfNeeded(repository, fake, session.id)).resolves.toBe(true);

      expect(fake.completeRequests).toHaveLength(1);
      const [, prompt] = fake.completeRequests[0].messages;
      expect(prompt.content).toContain('user: message-1');
      expect(prompt.content).toContain('assistant: message-40');
      expect(prompt.content).not.toContain('message-41');

      const summary = await getSummary(mockDb, session.id);
      expect(summary?.content).toBe(SUMMARIZED_TEXT);
      expect(summary?.message_boundary).toBe(40);
    });

    test('filters failed and incomplete rows out of the archived increment', async () => {
      const session = await repository.createSession();
      await addAlternatingTurns(repository, session.id, 60);
      const fifth = (await repository.listMessages(session.id))[4];
      await updateMessageStatus(mockDb, fifth.id, 'failed', 'failed-partial-output');
      fake.enqueueComplete({
        text: SUMMARIZED_TEXT,
        model: 'vendor/model-a',
        finishReason: 'stop',
        requestId: null,
      });

      await expect(updateSummaryIfNeeded(repository, fake, session.id)).resolves.toBe(true);

      const [, prompt] = fake.completeRequests[0].messages;
      expect(prompt.content).not.toContain('failed-partial-output');
      expect(prompt.content).toContain('assistant: message-6');
      expect(await getSummary(mockDb, session.id)).toMatchObject({
        content: SUMMARIZED_TEXT,
        message_boundary: 40,
      });
    });

    test('advances the boundary without a provider call when nothing is summarizable', async () => {
      const session = await repository.createSession();
      for (let i = 1; i <= 60; i++) {
        await repository.addMessage({
          session_id: session.id,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: '',
          status: 'pending',
        });
      }

      await expect(updateSummaryIfNeeded(repository, fake, session.id)).resolves.toBe(true);

      expect(fake.completeRequests).toHaveLength(0);
      expect(await getSummary(mockDb, session.id)).toMatchObject({
        content: '',
        message_boundary: 40,
      });
    });

    test('passes the previous summary and only the new increment on later compactions', async () => {
      const session = await repository.createSession();
      await addAlternatingTurns(repository, session.id, 60);
      fake.enqueueComplete({
        text: SUMMARIZED_TEXT,
        model: 'vendor/model-a',
        finishReason: 'stop',
        requestId: null,
      });
      await updateSummaryIfNeeded(repository, fake, session.id);

      await addAlternatingTurns(repository, session.id, 60, 61);
      const updatedText = 'Folded messages 1-100.';
      fake.enqueueComplete({
        text: updatedText,
        model: 'vendor/model-a',
        finishReason: 'stop',
        requestId: null,
      });

      await expect(updateSummaryIfNeeded(repository, fake, session.id)).resolves.toBe(true);

      const [, prompt] = fake.completeRequests[1].messages;
      expect(prompt.content).toContain('Summary of the conversation so far:');
      expect(prompt.content).toContain(SUMMARIZED_TEXT);
      expect(prompt.content).toContain('user: message-41');
      expect(prompt.content).toContain('assistant: message-100');
      expect(prompt.content).not.toContain('message-40\n');
      expect(await getSummary(mockDb, session.id)).toMatchObject({
        content: updatedText,
        message_boundary: 100,
      });
    });

    test('resolves false for an unknown session', async () => {
      await expect(updateSummaryIfNeeded(repository, fake, 999)).resolves.toBe(false);
      expect(fake.completeRequests).toHaveLength(0);
    });
  });
});
