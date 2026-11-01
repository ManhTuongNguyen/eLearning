/**
 * Speaking-practice history repository tests: create/list/get/update/delete
 * against real SQL (sql.js), including the edit path used by the history
 * screen's context menu and the word-count→duration estimate for custom
 * topics.
 */
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  createSpeakingPracticeRecord,
  deleteSpeakingPracticeRecord,
  estimateSpeakingMinutes,
  getSpeakingPracticeRecordById,
  listSpeakingPracticeRecords,
  updateSpeakingPracticeRecord,
} from '../src/db/speakingPracticeRepository';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

async function freshDb(): Promise<SqlDriver> {
  const db = await openSqlJsDriver();
  await migrateDatabase(db);
  return db;
}

function newRecord() {
  return {
    userId: 0,
    title: 'Morning routine',
    description: '',
    rawPrompt: '',
    englishLevel: 'AUTO' as const,
    text: 'I wake up early.\n\nThen I drink coffee.',
    minutes: 1,
    wordCount: 8,
  };
}

describe('estimateSpeakingMinutes', () => {
  it('derives a duration from the read-aloud pace with a one-minute floor', () => {
    expect(estimateSpeakingMinutes(0)).toBe(1);
    expect(estimateSpeakingMinutes(70)).toBe(1);
    expect(estimateSpeakingMinutes(140)).toBe(1);
    expect(estimateSpeakingMinutes(141)).toBe(2);
    expect(estimateSpeakingMinutes(280)).toBe(2);
    expect(estimateSpeakingMinutes(700)).toBe(5);
  });
});

describe('speakingPracticeRepository', () => {
  it('creates and lists a history entry', async () => {
    const db = await freshDb();
    const created = await createSpeakingPracticeRecord(db, newRecord());

    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('Morning routine');
    expect(created.english_level).toBe('AUTO');

    const list = await listSpeakingPracticeRecords(db, 0);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe(newRecord().text);
  });

  it('updates the editable title and content plus the derived counts', async () => {
    const db = await freshDb();
    const created = await createSpeakingPracticeRecord(db, newRecord());

    const updated = await updateSpeakingPracticeRecord(db, created.id, {
      title: 'Evening routine',
      text: 'I go to bed late now.',
      minutes: 2,
      wordCount: 6,
    });

    expect(updated).not.toBeNull();
    expect(updated?.title).toBe('Evening routine');
    expect(updated?.text).toBe('I go to bed late now.');
    expect(updated?.minutes).toBe(2);
    expect(updated?.word_count).toBe(6);
    // The immutable prompt/level metadata is left untouched.
    expect(updated?.english_level).toBe('AUTO');

    const fetched = await getSpeakingPracticeRecordById(db, created.id);
    expect(fetched?.title).toBe('Evening routine');
  });

  it('rejects a blank title or content on update', async () => {
    const db = await freshDb();
    const created = await createSpeakingPracticeRecord(db, newRecord());

    await expect(updateSpeakingPracticeRecord(db, created.id, { title: '   ' })).rejects.toThrow(
      'a title is required',
    );
    await expect(updateSpeakingPracticeRecord(db, created.id, { text: '   ' })).rejects.toThrow(
      'practice content is required',
    );
  });

  it('returns null when updating an entry that no longer exists', async () => {
    const db = await freshDb();

    await expect(updateSpeakingPracticeRecord(db, 999, { title: 'Gone' })).resolves.toBeNull();
  });

  it('deletes an entry', async () => {
    const db = await freshDb();
    const created = await createSpeakingPracticeRecord(db, newRecord());

    await deleteSpeakingPracticeRecord(db, created.id);

    expect(await getSpeakingPracticeRecordById(db, created.id)).toBeNull();
    expect(await listSpeakingPracticeRecords(db, 0)).toHaveLength(0);
  });
});
