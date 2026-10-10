/**
 * Speaking-practice generation tests: the prompt carries the minutes→words
 * budget, the level clause and the material (topic, questions or passage),
 * the parser strips code fences and rejects empty responses, and the
 * paragraphs are split on blank lines for the centered karaoke display.
 */
import {FakeOpenRouterClient} from '../testing/fakeOpenRouter';
import {OpenRouterResponseError} from '../src/serverless/errors';
import {
  WORDS_PER_MINUTE,
  buildSpeakingPracticeUserPrompt,
  generateSpeakingPracticeText,
  generateSpeakingText,
  parseGeneratedSpeechText,
  splitPracticeParagraphs,
} from '../src/serverless/speakingPractice';
import {openLocalDatabase} from '../src/db/database';
import type {SqlDriver} from '../src/db/driver';
import {openSqlJsDriver} from '../testing/sqlJsDriver';

describe('buildSpeakingPracticeUserPrompt', () => {
  it('sizes the word budget to the requested minutes', () => {
    const prompt = buildSpeakingPracticeUserPrompt('B1', 'Travel', 3);
    expect(prompt).toContain(`about ${WORDS_PER_MINUTE} words per minute`);
    expect(prompt).toContain(`roughly ${3 * WORDS_PER_MINUTE} words`);
    expect(prompt).toContain("The learner's English level is B1 (CEFR)");
    expect(prompt).toContain('"Travel"');
  });

  it('instructs the model to smooth an already-written passage', () => {
    const prompt = buildSpeakingPracticeUserPrompt('A2', 'i has went to store yesterday', 2);
    expect(prompt).toContain('already a passage');
    expect(prompt).toContain('lightly smooth the grammar');
  });

  it('lets the model choose when the learner input is blank', () => {
    expect(buildSpeakingPracticeUserPrompt('AUTO', '   ', 5)).toContain(
      'gave no preference; choose an engaging everyday topic',
    );
    expect(buildSpeakingPracticeUserPrompt('AUTO', '   ', 5)).toContain(
      'level is unknown; infer an appropriate level',
    );
  });
});

describe('parseGeneratedSpeechText', () => {
  it('returns plain prose unchanged', () => {
    expect(parseGeneratedSpeechText('Hello world. How are you?')).toBe(
      'Hello world. How are you?',
    );
  });

  it('strips a wrapping code fence', () => {
    expect(parseGeneratedSpeechText('```text\nHello world.\n```')).toBe('Hello world.');
  });

  it('rejects an empty response with a response error', () => {
    expect(() => parseGeneratedSpeechText('   \n  ')).toThrow(OpenRouterResponseError);
    expect(() => parseGeneratedSpeechText('```\n```', 'vendor/m')).toThrow(
      OpenRouterResponseError,
    );
  });
});

describe('splitPracticeParagraphs', () => {
  it('splits on blank lines and drops empty paragraphs', () => {
    expect(
      splitPracticeParagraphs('First paragraph.\n\nSecond paragraph.\n\n\n'),
    ).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('keeps single-line text as one paragraph', () => {
    expect(splitPracticeParagraphs('Only one line.')).toEqual(['Only one line.']);
  });
});

describe('generateSpeakingText', () => {
  it('sends one completion with the system + user turns and returns paragraphs', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueComplete({
      text: 'First paragraph about the beach.\n\nSecond paragraph about the city.',
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    const {text, paragraphs} = await generateSpeakingText(
      request => fake.complete(request),
      {material: 'A day at the beach', minutes: 2},
      'A2',
    );

    expect(text).toContain('First paragraph');
    expect(paragraphs).toEqual([
      'First paragraph about the beach.',
      'Second paragraph about the city.',
    ]);
    expect(fake.completeRequests).toHaveLength(1);
    const [request] = fake.completeRequests;
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[1].content).toContain('roughly 280 words');
    expect(request.messages[1].content).toContain('A day at the beach');
  });

  it('propagates provider failures', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueComplete({
      text: '   ',
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });
    await expect(
      generateSpeakingText(request => fake.complete(request), {material: '', minutes: 1}, 'B1'),
    ).rejects.toBeInstanceOf(OpenRouterResponseError);
  });
});

describe('generateSpeakingPracticeText (db-backed level)', () => {
  let db: SqlDriver;

  beforeEach(async () => {
    db = await openLocalDatabase(() => openSqlJsDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  it('reads the learning level from the on-device profile', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueComplete({
      text: 'Practice text.',
      model: 'vendor/model-a',
      finishReason: 'stop',
      requestId: null,
    });

    await generateSpeakingPracticeText(
      db,
      request => fake.complete(request),
      {material: 'Weekend plans', minutes: 1},
    );

    const [request] = fake.completeRequests;
    expect(request.messages[1].content).toContain(
      "The learner's English level is A1 (CEFR)",
    );
  });
});
