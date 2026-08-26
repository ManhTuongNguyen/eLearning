/**
 * Serverless topic generation tests (SPEC TASK-085). Runs against the
 * sql.js-backed driver with real SQL semantics and the scripted OpenRouter
 * fake: a hint steers the generated topic, an empty hint lets the AI choose,
 * the level (including AUTO) shapes the prompt, the parsed topic is
 * persisted as a local session only after a valid parse, and malformed or
 * failed completions leave no session behind.
 */
import {openLocalDatabase} from '../src/db/database';
import type {SqlDriver} from '../src/db/driver';
import {LocalConversationRepository} from '../src/db/conversationRepository';
import {saveLearningProfile} from '../src/db/profileStore';
import {openSqlJsDriver} from '../testing/sqlJsDriver';
import {FakeOpenRouterClient} from '../testing/fakeOpenRouter';
import {OpenRouterAvailabilityError, OpenRouterResponseError} from '../src/serverless/errors';
import {
  TOPIC_SYSTEM_PROMPT,
  buildTopicUserPrompt,
  createServerlessSession,
  generateTopic,
  parseTopic,
} from '../src/serverless/topicGeneration';

const VALID_TOPIC_JSON = JSON.stringify({
  title: 'Ordering Coffee Abroad',
  description: 'You order drinks at a busy café in London. Practise polite requests.',
});

describe('serverless topic generation (TASK-085)', () => {
  let db: SqlDriver;
  let repository: LocalConversationRepository;
  let fake: FakeOpenRouterClient;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
    repository = new LocalConversationRepository(async () => db);
    fake = new FakeOpenRouterClient();
  });

  afterEach(async () => {
    await db.close();
  });

  test('a hinted topic is generated and persisted locally', async () => {
    fake.enqueueComplete({
      text: VALID_TOPIC_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const session = await createServerlessSession(db, request => fake.complete(request), 'Traveling');

    expect(session.title).toBe('Ordering Coffee Abroad');
    expect(session.topic).toBe(
      'You order drinks at a busy café in London. Practise polite requests.',
    );
    expect(session.topic_hint).toBe('Traveling');
    expect(session.learning_level).toBe('A1');

    expect(fake.completeRequests).toHaveLength(1);
    const [request] = fake.completeRequests;
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]).toEqual({role: 'system', content: TOPIC_SYSTEM_PROMPT});
    expect(request.messages[1].role).toBe('user');
    expect(request.messages[1].content).toContain('The learner\'s English level is A1 (CEFR)');
    expect(request.messages[1].content).toContain('Topic idea from the learner: "Traveling".');

    const stored = await repository.readSession(session.id);
    expect(stored).toEqual(session);
  });

  test('an empty hint generates an automatic topic', async () => {
    fake.enqueueComplete({
      text: VALID_TOPIC_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const session = await createServerlessSession(db, request => fake.complete(request), '');

    expect(session.topic_hint).toBe('');
    expect(session.topic).not.toBe('');
    const [, userTurn] = fake.completeRequests[0].messages;
    expect(userTurn.content).toContain('gave no preference');
  });

  test('the stored learning level shapes the prompt and the session row', async () => {
    await saveLearningProfile(db, 'B2');
    fake.enqueueComplete({
      text: VALID_TOPIC_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const session = await createServerlessSession(db, request => fake.complete(request));

    expect(session.learning_level).toBe('B2');
    const [, userTurn] = fake.completeRequests[0].messages;
    expect(userTurn.content).toContain("The learner's English level is B2 (CEFR)");
  });

  test('an AUTO level asks the model to infer the difficulty', async () => {
    await saveLearningProfile(db, 'AUTO');
    fake.enqueueComplete({
      text: VALID_TOPIC_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const session = await createServerlessSession(db, request => fake.complete(request), 'Jobs');

    expect(session.learning_level).toBe('AUTO');
    const [, userTurn] = fake.completeRequests[0].messages;
    expect(userTurn.content).toContain('level is unknown; infer an appropriate level');
  });

  test('generateTopic returns the parsed topic without persisting anything', async () => {
    fake.enqueueComplete({
      text: VALID_TOPIC_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const topic = await generateTopic(request => fake.complete(request), 'A2', 'Food');

    expect(topic).toEqual({
      title: 'Ordering Coffee Abroad',
      description: 'You order drinks at a busy café in London. Practise polite requests.',
    });
    expect(await repository.listSessions()).toHaveLength(0);
  });

  test('parsing tolerates fenced and prose-wrapped JSON but rejects deviations', () => {
    const fenced = `\`\`\`json\n${VALID_TOPIC_JSON}\n\`\`\``;
    expect(parseTopic(fenced)).toEqual(parseTopic(VALID_TOPIC_JSON));
    expect(parseTopic(`Here you go!\n${VALID_TOPIC_JSON}\nEnjoy.`)).toEqual({
      title: 'Ordering Coffee Abroad',
      description: 'You order drinks at a busy café in London. Practise polite requests.',
    });

    const badPayloads = [
      'no json at all',
      '"just a string"',
      '{"title": "", "description": "x"}',
      '{"title": "Only title"}',
      '{"title": "T", "description": ""}',
      '{"title": 42, "description": "x"}',
    ];
    for (const payload of badPayloads) {
      expect(() => parseTopic(payload)).toThrow(OpenRouterResponseError);
    }
    expect(() => parseTopic('broken', 'vendor/model-a')).toThrow(OpenRouterResponseError);
  });

  test('malformed completions raise OpenRouterResponseError and persist nothing', async () => {
    fake.enqueueComplete({
      text: '{"description": "missing the title"}',
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    await expect(createServerlessSession(db, request => fake.complete(request))).rejects.toBeInstanceOf(
      OpenRouterResponseError,
    );
    expect(await repository.listSessions()).toHaveLength(0);
  });

  test('provider failures propagate and leave no session behind', async () => {
    fake.enqueueComplete(new OpenRouterAvailabilityError('model overloaded'));

    await expect(createServerlessSession(db, request => fake.complete(request), 'Sports')).rejects.toBeInstanceOf(
      OpenRouterAvailabilityError,
    );
    expect(await repository.listSessions()).toHaveLength(0);
  });

  test('buildTopicUserPrompt mirrors the backend wording for both hint branches', () => {
    const hinted = buildTopicUserPrompt('B1', 'Interview practice');
    expect(hinted.split('\n')).toEqual([
      'Create a conversation topic for a new English-learning chat session.',
      "The learner's English level is B1 (CEFR); keep vocabulary and grammar at that level.",
      'Topic idea from the learner: "Interview practice". Build the topic around this idea.',
    ]);

    const automatic = buildTopicUserPrompt('C1', '');
    expect(automatic.split('\n')).toEqual([
      'Create a conversation topic for a new English-learning chat session.',
      "The learner's English level is C1 (CEFR); keep vocabulary and grammar at that level.",
      'The learner gave no preference; choose an engaging everyday topic.',
    ]);
  });
});
