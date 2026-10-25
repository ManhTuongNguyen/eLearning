/**
 * Word capture pipeline tests (WORD_CAPTURE_V1 TASK-WC-003).
 *
 * Runs against real SQL (sql.js) with injected lookup/queue seams: the
 * single-word rule, the keep-everything dictionary policy (the deliberate
 * difference from generation), batch and topic dedupe, the batch cap, and
 * removal semantics — processed raws leave the queue only after the insert
 * committed.
 */
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import type { WordSense } from '../src/db/types';
import { getSystemWordTopic, listWordsByTopic } from '../src/db/wordRepository';
import type { DictionaryLookupResult } from '../src/serverless/dictionaryApi';
import {
  MAX_CAPTURE_BATCH,
  MAX_CAPTURED_WORD_LENGTH,
  processCapturedWords,
  validateCapturedWord,
} from '../src/serverless/wordCapture';
import type { DictionaryLookupFn } from '../src/serverless/wordGeneration';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

const SENSES: WordSense[] = [
  { partOfSpeech: 'noun', definitions: [{ definition: 'A fortunate discovery.' }] },
];

const FOUND: DictionaryLookupResult = {
  outcome: 'found',
  senses: SENSES,
  phonetics: ['/sərənˈdɪpəti/'],
};
const NOT_FOUND: DictionaryLookupResult = { outcome: 'not-found' };
const UNAVAILABLE: DictionaryLookupResult = { outcome: 'unavailable' };

/** A queue seam recording removals; lookup returns per-word configured outcomes. */
function makeSeams(
  queue: string[],
  outcomes: Record<string, DictionaryLookupResult> = {},
  fallback: DictionaryLookupResult = FOUND,
): {
  lookup: DictionaryLookupFn;
  getPending: () => Promise<string[]>;
  remove: (words: readonly string[]) => Promise<void>;
  removed: string[][];
} {
  const removed: string[][] = [];
  return {
    lookup: jest.fn(async (word: string) => outcomes[word] ?? fallback),
    getPending: async () => [...queue],
    remove: async (words: readonly string[]) => {
      removed.push([...words]);
      for (const word of words) {
        const index = queue.indexOf(word);
        if (index !== -1) {
          queue.splice(index, 1);
        }
      }
    },
    removed,
  };
}

async function freshDb(): Promise<SqlDriver> {
  const db = await openSqlJsDriver();
  await migrateDatabase(db);
  return db;
}

describe('validateCapturedWord (TASK-WC-003)', () => {
  test('canonicalizes to the normalized form: lowercase, punctuation-stripped', () => {
    expect(validateCapturedWord('  Serendipity ')).toEqual({
      valid: true,
      normalized: 'serendipity',
    });
    expect(validateCapturedWord('Everything')).toEqual({ valid: true, normalized: 'everything' });
    expect(validateCapturedWord('"bank,"')).toEqual({ valid: true, normalized: 'bank' });
    expect(validateCapturedWord("don't")).toEqual({ valid: true, normalized: "don't" });
    expect(validateCapturedWord('mother-in-law')).toEqual({
      valid: true,
      normalized: 'mother-in-law',
    });
  });

  test('rejects multi-word selections, empties, overlong and punctuation-only raws', () => {
    expect(validateCapturedWord('a phrase').valid).toBe(false);
    expect(validateCapturedWord('one\ttwo').valid).toBe(false);
    expect(validateCapturedWord('   ').valid).toBe(false);
    expect(validateCapturedWord('x'.repeat(MAX_CAPTURED_WORD_LENGTH + 1)).valid).toBe(false);
    expect(validateCapturedWord('—…!!').valid).toBe(false);
  });
});

describe('processCapturedWords (TASK-WC-003)', () => {
  test('an empty queue is a no-op that touches nothing', async () => {
    const db = await freshDb();
    const seams = makeSeams([]);
    expect(await processCapturedWords(db, seams)).toMatchObject({ captured: 0, added: 0 });
    expect(seams.removed).toEqual([]);
    await db.close();
  });

  test('keeps found words complete and not-found/unavailable words dataless', async () => {
    const db = await freshDb();
    const seams = makeSeams(['serendipity', 'notaword', 'offline'], {
      serendipity: FOUND,
      notaword: NOT_FOUND,
      offline: UNAVAILABLE,
    });

    const result = await processCapturedWords(db, seams);
    expect(result).toEqual({
      captured: 3,
      valid: 3,
      added: 3,
      withData: 1,
      withoutData: 2,
      duplicates: 0,
      rejected: 0,
    });

    const topic = await getSystemWordTopic(db);
    if (!topic) {
      throw new Error('expected the seeded system topic');
    }
    const words = await listWordsByTopic(db, topic.id);
    expect(words.map(word => word.text)).toEqual(['offline', 'notaword', 'serendipity']);
    expect(words.find(word => word.text === 'serendipity')).toMatchObject({
      data_status: 'complete',
      phonetics_json: ['/sərənˈdɪpəti/'],
    });
    for (const word of words.filter(item => item.text !== 'serendipity')) {
      expect(word.data_status).toBe('missing');
      expect(word.senses_json).toEqual([]);
    }
    // The processed raws left the queue.
    expect(seams.removed).toEqual([['serendipity', 'notaword', 'offline']]);

    await db.close();
  });

  test('stores the canonical form: sentence case and punctuation never reach the bank', async () => {
    const db = await freshDb();
    const seams = makeSeams(['Everything', '“bank,”']);
    const lookedUp: string[] = [];
    seams.lookup = jest.fn(async (word: string) => {
      lookedUp.push(word);
      return FOUND;
    });

    const result = await processCapturedWords(db, seams);
    expect(result).toMatchObject({ added: 2, withData: 2 });
    // The dictionary was asked for the normalized spellings, not the raws.
    expect(lookedUp).toEqual(['everything', 'bank']);

    const topic = await getSystemWordTopic(db);
    if (!topic) {
      throw new Error('expected the seeded system topic');
    }
    const words = await listWordsByTopic(db, topic.id);
    expect(words.map(word => word.text).sort()).toEqual(['bank', 'everything']);
    for (const word of words) {
      expect(word.data_status).toBe('complete');
    }

    await db.close();
  });

  test('consumes rejected raws and skips duplicates within the batch and topic', async () => {
    const db = await freshDb();
    const seams = makeSeams(['Serendipity!', 'serendipity', 'two words', '—']);

    const result = await processCapturedWords(db, seams);
    expect(result).toEqual({
      captured: 4,
      valid: 1,
      added: 1,
      withData: 1,
      withoutData: 0,
      duplicates: 0,
      rejected: 3,
    });
    // Every raw was consumed, including the rejects, so nothing loops.
    expect(seams.removed).toEqual([['Serendipity!', 'serendipity', 'two words', '—']]);

    // A later capture of the same word is a duplicate against the topic.
    const second = await processCapturedWords(db, makeSeams(['SERENDIPITY']));
    expect(second).toMatchObject({ captured: 1, added: 0, duplicates: 1 });

    await db.close();
  });

  test('a word may exist in another topic; dedupe applies to the system topic only', async () => {
    const db = await freshDb();
    const system = await getSystemWordTopic(db);
    if (!system) {
      throw new Error('expected the seeded system topic');
    }
    await db.execute(
      `INSERT INTO word_topics (title, is_system, created_at, updated_at)
       VALUES ('Cooking', 0, '2026-10-25T08:00:00.000Z', '2026-10-25T08:00:00.000Z')`,
    );
    const cooking = await db.execute("SELECT id FROM word_topics WHERE title = 'Cooking'");
    const cookingId = Number(cooking.rows[0]?.id);
    await db.execute(
      `INSERT INTO words (topic_id, text, normalized_text, due_at, created_at, updated_at)
       VALUES (?, 'bank', 'bank', '2026-10-25T08:00:00.000Z', '2026-10-25T08:00:00.000Z',
               '2026-10-25T08:00:00.000Z')`,
      [cookingId],
    );

    const result = await processCapturedWords(db, makeSeams(['bank']));
    expect(result).toMatchObject({ added: 1, duplicates: 0 });
    expect(await listWordsByTopic(db, system.id)).toHaveLength(1);

    await db.close();
  });

  test(`processes at most ${MAX_CAPTURE_BATCH} raws per run and leaves the rest queued`, async () => {
    const db = await freshDb();
    const queue = Array.from({ length: MAX_CAPTURE_BATCH + 3 }, (_, index) => `word${index}`);
    const seams = makeSeams(queue);

    const result = await processCapturedWords(db, seams);
    expect(result.captured).toBe(MAX_CAPTURE_BATCH);
    expect(result.added).toBe(MAX_CAPTURE_BATCH);
    expect(queue).toEqual([
      `word${MAX_CAPTURE_BATCH}`,
      `word${MAX_CAPTURE_BATCH + 1}`,
      `word${MAX_CAPTURE_BATCH + 2}`,
    ]);

    await db.close();
  });

  test('leaves the queue intact when the insert fails', async () => {
    const db = await freshDb();
    const seams = makeSeams(['serendipity']);
    const originalExecute = db.execute.bind(db);
    // Sabotage inserts so the persist step throws after the lookups ran.
    (db as { execute: unknown }).execute = async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('INSERT INTO words')) {
        throw new Error('disk full');
      }
      return originalExecute(sql, params as []);
    };

    await expect(processCapturedWords(db, seams)).rejects.toThrow('disk full');
    expect(seams.removed).toEqual([]);

    await db.close();
  });
});
