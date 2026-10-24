/**
 * Word generation service tests (WORD_BANK_V1 TASK-WB-004).
 *
 * The AI call runs through a fake `complete` seam and every dictionary lookup
 * through a fake `lookup` seam — no HTTP anywhere. The persistence side uses
 * real SQL (sql.js) so the pipeline's kept-complete / kept-missing / dropped
 * outcomes are verified against the database the screens read.
 */
import { migrateDatabase } from '../src/db/migrations';
import type { WordTopicRecord } from '../src/db/types';
import { createWordTopic, insertWords, listWordsByTopic } from '../src/db/wordRepository';
import { openSqlJsDriver } from '../testing/sqlJsDriver';
import type { CompletionRequest, CompletionResult } from '../src/serverless/types';
import { OpenRouterResponseError } from '../src/serverless/errors';
import {
  buildWordSystemPrompt,
  buildWordUserPrompt,
  clampWordCount,
  generateTopicWords,
  MAX_WORD_COUNT,
  MIN_WORD_COUNT,
  parseGeneratedWords,
  type CompleteFn,
  type DictionaryLookupFn,
} from '../src/serverless/wordGeneration';
import type { DictionaryLookupResult } from '../src/serverless/dictionaryApi';

function completion(text: string): CompleteFn {
  return async (_request: CompletionRequest): Promise<CompletionResult> => ({
    text,
    model: 'test-model',
    finishReason: 'stop',
    requestId: null,
  });
}

const SENSES = [{ partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] }];

function found(): DictionaryLookupResult {
  return { outcome: 'found', senses: SENSES, phonetics: ['/wɜːd/'] };
}

async function freshTopic(): Promise<{ db: Awaited<ReturnType<typeof openSqlJsDriver>>; topic: WordTopicRecord }> {
  const db = await openSqlJsDriver();
  await migrateDatabase(db);
  const topic = await createWordTopic(db, {
    title: 'Cooking',
    description: "I'm a chef, I often read cooking blogs",
    extra_prompt: 'focus on kitchen verbs',
  });
  return { db, topic };
}

describe('parseGeneratedWords', () => {
  test('accepts a valid JSON array', () => {
    expect(parseGeneratedWords('["bank", "simmer"]')).toEqual(['bank', 'simmer']);
  });

  test('tolerates code fences and surrounding prose', () => {
    expect(parseGeneratedWords('```json\n["bank", "simmer"]\n```')).toEqual(['bank', 'simmer']);
    expect(parseGeneratedWords('Here are your words: ["bank", "simmer"] — enjoy!')).toEqual([
      'bank',
      'simmer',
    ]);
  });

  test('drops non-string and empty entries', () => {
    expect(parseGeneratedWords('["bank", 42, null, "   ", "", "simmer"]')).toEqual([
      'bank',
      'simmer',
    ]);
  });

  test('drops duplicates within the batch and against existing words', () => {
    expect(parseGeneratedWords('["Bank", "BANK", "bank", "whisk"]')).toEqual(['Bank', 'whisk']);
    expect(parseGeneratedWords('["bank", "whisk"]', ['bank'])).toEqual(['whisk']);
    // Normalisation collapses punctuation, casing and padding to the stored
    // key — everything here is filtered out, so nothing usable remains.
    expect(() => parseGeneratedWords('["  bank  "]', ['bank'])).toThrow(OpenRouterResponseError);
  });

  test('only zero valid candidates is fatal', () => {
    expect(() => parseGeneratedWords('["", 42]')).toThrow(OpenRouterResponseError);
    expect(() => parseGeneratedWords('no array here')).toThrow(OpenRouterResponseError);
  });
});

describe('buildWordUserPrompt', () => {
  const topic = {
    title: 'Cooking',
    description: "I'm a chef, I often read cooking blogs",
    extra_prompt: 'focus on kitchen verbs',
  };

  test('contains title, verbatim learner context, count and extra prompt', () => {
    const prompt = buildWordUserPrompt(topic, 10, []);
    expect(prompt).toContain('Choose 10 English words');
    expect(prompt).toContain('Cooking');
    expect(prompt).toContain("I'm a chef, I often read cooking blogs");
    expect(prompt).toContain('focus on kitchen verbs');
  });

  test('contains the existing words with a do-not-repeat instruction', () => {
    const prompt = buildWordUserPrompt(topic, 5, ['bank', 'simmer']);
    expect(prompt).toContain('bank');
    expect(prompt).toContain('simmer');
    expect(prompt).toContain('do NOT repeat');
  });

  test('caps the existing-words list and clamps the count', () => {
    const prompt = buildWordUserPrompt(topic, 99, Array.from({ length: 150 }, (_, i) => `word${i}`));
    expect(prompt).toContain('word99');
    expect(prompt).not.toContain('word100');
    expect(prompt).toContain('Choose 30 English words');
  });

  test('the system prompt asks for words only, never definitions', () => {
    expect(buildWordSystemPrompt()).toContain('JSON array of strings');
    expect(buildWordSystemPrompt()).toContain('base dictionary form');
  });

  test('the count clamps defensively into the 1-30 range', () => {
    expect(clampWordCount(0)).toBe(MIN_WORD_COUNT);
    expect(clampWordCount(31)).toBe(MAX_WORD_COUNT);
    expect(clampWordCount(7.9)).toBe(7);
    expect(clampWordCount(Number.NaN)).toBe(MIN_WORD_COUNT);
  });
});

describe('generateTopicWords pipeline', () => {
  test('inserts found words complete and reports them', async () => {
    const { db, topic } = await freshTopic();
    const complete = completion('["bank", "simmer"]');
    const lookups: string[] = [];
    const lookup: DictionaryLookupFn = async word => {
      lookups.push(word);
      return found();
    };

    const result = await generateTopicWords(db, complete, lookup, {
      topic,
      count: 2,
      existingWords: [],
    });

    expect(lookups).toEqual(['bank', 'simmer']); // sequential
    expect(result).toMatchObject({
      requestedCount: 2,
      keptWithData: 2,
      keptWithoutData: 0,
      notFoundCount: 0,
    });
    expect(result.words).toHaveLength(2);
    expect(result.words[0].data_status).toBe('complete');
    expect(result.words[0].senses_json).toEqual(SENSES);
    expect(result.words[0].phonetics_json).toEqual(['/wɜːd/']);

    const rows = await listWordsByTopic(db, topic.id);
    expect(rows.map(row => row.text)).toEqual(['simmer', 'bank']);

    await db.close();
  });

  test('drops not-found words and keeps unavailable words as missing candidates', async () => {
    const { db, topic } = await freshTopic();
    const complete = completion('["bank", "blurble", "simmer"]');
    const lookup: DictionaryLookupFn = async word => {
      if (word === 'bank') {
        return found();
      }
      if (word === 'blurble') {
        return { outcome: 'not-found' };
      }
      return { outcome: 'unavailable' };
    };

    const result = await generateTopicWords(db, complete, lookup, {
      topic,
      count: 3,
      existingWords: [],
    });

    expect(result.requestedCount).toBe(3);
    expect(result.keptWithData).toBe(1);
    expect(result.keptWithoutData).toBe(1);
    expect(result.notFoundCount).toBe(1);

    const rows = await listWordsByTopic(db, topic.id);
    expect(rows.map(row => row.text).sort()).toEqual(['bank', 'simmer']);
    const missing = rows.find(row => row.text === 'simmer');
    expect(missing?.data_status).toBe('missing');
    expect(missing?.senses_json).toEqual([]);
    expect(missing?.phonetics_json).toEqual([]);
    expect(missing?.data_source).toBe('dictionary');

    await db.close();
  });

  test('a mixed batch reports all three counts and persists only kept rows', async () => {
    const { db, topic } = await freshTopic();
    await insertWords(db, topic.id, [{ text: 'whisk', data_status: 'missing' }]);
    const complete = completion('["whisk", "bank", "blurble", "sear"]');
    const lookup: DictionaryLookupFn = async word => {
      if (word === 'bank' || word === 'sear') {
        return found();
      }
      if (word === 'blurble') {
        return { outcome: 'not-found' };
      }
      return { outcome: 'unavailable' };
    };

    const result = await generateTopicWords(db, complete, lookup, {
      topic,
      count: 4,
      existingWords: ['whisk'],
    });

    // `whisk` is filtered at parse time, `blurble` is dropped by the
    // dictionary, and the remaining three are kept.
    expect(result.keptWithData).toBe(2);
    expect(result.keptWithoutData).toBe(0);
    expect(result.notFoundCount).toBe(1);
    const rows = await listWordsByTopic(db, topic.id);
    expect(rows.map(row => row.text).sort()).toEqual(['bank', 'sear', 'whisk']);

    await db.close();
  });

  test('a response without usable words fails without inserting anything', async () => {
    const { db, topic } = await freshTopic();
    const lookup: DictionaryLookupFn = async () => found();
    await expect(
      generateTopicWords(db, completion('I refuse.'), lookup, {
        topic,
        count: 5,
        existingWords: [],
      }),
    ).rejects.toThrow(OpenRouterResponseError);
    expect(await listWordsByTopic(db, topic.id)).toEqual([]);

    await db.close();
  });
});
