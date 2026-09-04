/**
 * Serverless topic + sample generation tests (SPEC TASK-085/093). Runs
 * against the sql.js-backed driver with real SQL semantics and the scripted
 * OpenRouter fake: a hint steers the generated topic, an empty hint lets the
 * AI choose, the level (including AUTO) shapes the prompt, ONE combined
 * completion yields both the topic and its example conversation, the pair is
 * persisted/returned only after a valid topic parse, a malformed sample
 * section degrades to a blank example while the topic stands, and malformed
 * or failed completions leave no session behind.
 */
import {openLocalDatabase} from '../src/db/database';
import type {SqlDriver} from '../src/db/driver';
import {LocalConversationRepository} from '../src/db/conversationRepository';
import {saveLearningProfile} from '../src/db/profileStore';
import {openSqlJsDriver} from '../testing/sqlJsDriver';
import {FakeOpenRouterClient} from '../testing/fakeOpenRouter';
import {OpenRouterAvailabilityError, OpenRouterResponseError} from '../src/serverless/errors';
import {
  MIN_SAMPLE_TURNS,
  TOPIC_AND_SAMPLE_SYSTEM_PROMPT,
  buildTopicAndSampleUserPrompt,
  createServerlessSession,
  generateTopicWithSample,
  parseTopicWithSample,
} from '../src/serverless/topicGeneration';

const TOPIC = {
  title: 'Ordering Coffee Abroad',
  description: 'You order drinks at a busy café in London. Practise polite requests.',
};

const VALID_SAMPLE_TURNS = [
  {role: 'assistant', content: 'Good morning! What can I get you today?'},
  {role: 'user', content: 'I would like a latte, please.'},
  {role: 'assistant', content: 'Sure! Would you like it with oat milk?'},
  {role: 'user', content: 'Yes, that would be great.'},
];

/** One combined payload: topic and example dialogue in the same object. */
const VALID_COMBINED_JSON = JSON.stringify({
  topic: TOPIC,
  sample_conversation: {turns: VALID_SAMPLE_TURNS},
});

describe('serverless topic + sample generation (TASK-085/093)', () => {
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

  test('ONE combined completion yields the topic, its example and the persisted session', async () => {
    fake.enqueueComplete({
      text: VALID_COMBINED_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const {session, sampleTurns} = await createServerlessSession(
      db,
      request => fake.complete(request),
      'Traveling',
    );

    expect(session.title).toBe(TOPIC.title);
    expect(session.topic).toBe(TOPIC.description);
    expect(session.topic_hint).toBe('Traveling');
    expect(session.learning_level).toBe('A1');
    expect(sampleTurns).toEqual(VALID_SAMPLE_TURNS);

    // Exactly one provider request: system + user with the combined shape.
    expect(fake.completeRequests).toHaveLength(1);
    const [request] = fake.completeRequests;
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]).toEqual({
      role: 'system',
      content: TOPIC_AND_SAMPLE_SYSTEM_PROMPT,
    });
    expect(request.messages[1].role).toBe('user');
    expect(request.messages[1].content).toContain('The learner\'s English level is A1 (CEFR)');
    expect(request.messages[1].content).toContain('Topic idea from the learner: "Traveling".');

    const stored = await repository.readSession(session.id);
    expect(stored).toEqual(session);
  });

  test('an empty hint lets the AI choose and produces a session with a blank hint', async () => {
    fake.enqueueComplete({
      text: VALID_COMBINED_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const {session} = await createServerlessSession(db, request => fake.complete(request), '');

    expect(session.topic_hint).toBe('');
    expect(session.topic).not.toBe('');
    const [userTurn] = fake.completeRequests[0].messages.slice(1);
    expect(userTurn.content).toContain('gave no preference');
  });

  test('the stored learning level shapes the prompt and the session row', async () => {
    await saveLearningProfile(db, 'B2');
    fake.enqueueComplete({
      text: VALID_COMBINED_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const {session} = await createServerlessSession(db, request => fake.complete(request));

    expect(session.learning_level).toBe('B2');
    const [userTurn] = fake.completeRequests[0].messages.slice(1);
    expect(userTurn.content).toContain("The learner's English level is B2 (CEFR)");
    expect(userTurn.content).toContain('in the topic and the example');
  });

  test('an AUTO level asks the model to infer the difficulty', async () => {
    await saveLearningProfile(db, 'AUTO');
    fake.enqueueComplete({
      text: VALID_COMBINED_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const {session} = await createServerlessSession(db, request => fake.complete(request), 'Jobs');

    expect(session.learning_level).toBe('AUTO');
    const [userTurn] = fake.completeRequests[0].messages.slice(1);
    expect(userTurn.content).toContain('level is unknown; infer an appropriate level');
  });

  test('a malformed sample section degrades to a blank example while the topic stands', async () => {
    const badSamplePayloads = [
      undefined, // sample_conversation missing entirely
      'not an object',
      {turns: 'not a list'},
      {turns: []},
      {turns: [{role: 'assistant', content: 'only one turn'}]},
      {turns: [{role: 'system', content: 'wrong role'}, {role: 'user', content: 'x'}]},
      {turns: [{role: 'assistant'}, {role: 'user', content: 'x'}]},
      {turns: [{role: 'assistant', content: 'a'}, {role: 'user', content: ' '}]},
    ];
    for (const sample of badSamplePayloads) {
      fake.clearScripts();
      fake.enqueueComplete({
        text: JSON.stringify({topic: TOPIC, sample_conversation: sample}),
        model: 'vendor/model-a',
        finishReason: 'stop',
        requestId: null,
      });

      const {session, sampleTurns} = await createServerlessSession(
        db,
        request => fake.complete(request),
      );

      expect(session.title).toBe(TOPIC.title);
      expect(sampleTurns).toEqual([]);
      // The session is still persisted: the example is display-only.
      expect(await repository.readSession(session.id)).toEqual(session);
    }
  });

  test('a malformed topic still aborts creation and persists nothing', async () => {
    fake.enqueueComplete({
      text: JSON.stringify({sample_conversation: {turns: VALID_SAMPLE_TURNS}}),
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
});

describe('parseTopicWithSample', () => {
  test('generateTopicWithSample sends one combined request and returns the pair', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueComplete({
      text: VALID_COMBINED_JSON,
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const {topic, sampleTurns} = await generateTopicWithSample(
      request => fake.complete(request),
      'A2',
      'Food',
    );

    expect(topic).toEqual(TOPIC);
    expect(sampleTurns).toEqual(VALID_SAMPLE_TURNS);
    expect(fake.completeRequests).toHaveLength(1);
    const [request] = fake.completeRequests;
    expect(request.messages[0]).toEqual({
      role: 'system',
      content: TOPIC_AND_SAMPLE_SYSTEM_PROMPT,
    });
    expect(request.messages[1].content).toContain("The learner's English level is A2 (CEFR)");
    expect(request.messages[1].content).toContain('Topic idea from the learner: "Food".');
  });

  test('parsing tolerates fenced and prose-wrapped JSON and ignores extra keys', () => {
    const fenced = `\`\`\`json\n${VALID_COMBINED_JSON}\n\`\`\``;
    expect(parseTopicWithSample(fenced)).toEqual({
      topic: TOPIC,
      sampleTurns: VALID_SAMPLE_TURNS,
    });
    expect(
      parseTopicWithSample(
        `Here you go!\n${JSON.stringify({...JSON.parse(VALID_COMBINED_JSON), notes: 'extra'})}\nEnjoy.`,
      ),
    ).toEqual({topic: TOPIC, sampleTurns: VALID_SAMPLE_TURNS});
  });

  test('padded turn content is stripped', () => {
    const payload = JSON.stringify({
      topic: TOPIC,
      sample_conversation: {
        turns: [
          {role: 'assistant', content: '  Padded tutor line \n'},
          {role: 'user', content: '\t Padded learner line '},
        ],
      },
    });

    expect(parseTopicWithSample(payload).sampleTurns).toEqual([
      {role: 'assistant', content: 'Padded tutor line'},
      {role: 'user', content: 'Padded learner line'},
    ]);
  });

  test('malformed topic shapes are rejected with attributed response errors', () => {
    const badPayloads = [
      'no json at all',
      '"just a string"',
      '{"sample_conversation": {"turns": []}}',
      '{"topic": "not an object", "sample_conversation": {"turns": []}}',
      '{"topic": {"title": "", "description": "x"}}',
      '{"topic": {"title": "Only title"}}',
      '{"topic": {"title": "T", "description": ""}}',
      '{"topic": {"title": 42, "description": "x"}}',
    ];
    for (const payload of badPayloads) {
      expect(() => parseTopicWithSample(payload)).toThrow(OpenRouterResponseError);
    }
    expect(() => parseTopicWithSample('broken', 'vendor/model-a')).toThrow(OpenRouterResponseError);
  });
});

describe('buildTopicAndSampleUserPrompt', () => {
  test('mirrors the backend wording for both hint branches', () => {
    const hinted = buildTopicAndSampleUserPrompt('B1', 'Interview practice');
    expect(hinted.split('\n')).toEqual([
      'Create a conversation topic for a new English-learning chat session, then write an example conversation that demonstrates it.',
      "The learner's English level is B1 (CEFR); keep vocabulary and grammar at that level in the topic and the example.",
      'Topic idea from the learner: "Interview practice". Build the topic around this idea.',
    ]);

    const automatic = buildTopicAndSampleUserPrompt('C1', '');
    expect(automatic.split('\n')).toEqual([
      'Create a conversation topic for a new English-learning chat session, then write an example conversation that demonstrates it.',
      "The learner's English level is C1 (CEFR); keep vocabulary and grammar at that level in the topic and the example.",
      'The learner gave no preference; choose an engaging everyday topic.',
    ]);
  });

  test('MIN_SAMPLE_TURNS matches the backend contract of two', () => {
    expect(MIN_SAMPLE_TURNS).toBe(2);
  });
});
