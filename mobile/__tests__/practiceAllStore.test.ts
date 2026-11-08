/**
 * Cross-topic ("all topics") practice settings store tests (migration v12).
 *
 * One row per bank kind holds the Anki-style deck options used when the learner
 * practises every topic together. These tests pin the defaults a fresh install
 * gets, the per-kind round trip and isolation, and the clamping that keeps a
 * corrupted value from breaking a session.
 */
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  DEFAULT_PRACTICE_ALL_SETTINGS,
  getPracticeAllSettings,
  savePracticeAllSettings,
} from '../src/db/practiceAllStore';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

async function freshDb(): Promise<SqlDriver> {
  const db = await openSqlJsDriver();
  await migrateDatabase(db);
  return db;
}

describe('getPracticeAllSettings', () => {
  test('a fresh install returns the app defaults for both banks', async () => {
    const db = await freshDb();

    await expect(getPracticeAllSettings(db, 'word')).resolves.toEqual(
      DEFAULT_PRACTICE_ALL_SETTINGS,
    );
    await expect(getPracticeAllSettings(db, 'sentence')).resolves.toEqual(
      DEFAULT_PRACTICE_ALL_SETTINGS,
    );
    // Reads never create a row; the first save does.
    const count = await db.execute('SELECT COUNT(*) AS total FROM practice_all_settings');
    expect(Number(count.rows[0]?.total)).toBe(0);

    await db.close();
  });
});

describe('savePracticeAllSettings', () => {
  test('round-trips one bank and leaves the other at its defaults', async () => {
    const db = await freshDb();

    const saved = await savePracticeAllSettings(db, 'word', {
      learn_ahead_minutes: 25,
      new_cards_per_day: 5,
      max_reviews_per_day: 120,
      max_session_cards: 40,
    });

    expect(saved).toEqual({
      learn_ahead_minutes: 25,
      new_cards_per_day: 5,
      max_reviews_per_day: 120,
      max_session_cards: 40,
    });

    await expect(getPracticeAllSettings(db, 'word')).resolves.toEqual(saved);
    await expect(getPracticeAllSettings(db, 'sentence')).resolves.toEqual(
      DEFAULT_PRACTICE_ALL_SETTINGS,
    );

    await db.close();
  });

  test('keeps one row per kind (a second save replaces the first)', async () => {
    const db = await freshDb();

    await savePracticeAllSettings(db, 'sentence', {
      learn_ahead_minutes: 10,
      new_cards_per_day: 20,
      max_reviews_per_day: 200,
      max_session_cards: 20,
    });
    await savePracticeAllSettings(db, 'sentence', {
      learn_ahead_minutes: 15,
      new_cards_per_day: 30,
      max_reviews_per_day: 150,
      max_session_cards: 35,
    });

    const count = await db.execute('SELECT COUNT(*) AS total FROM practice_all_settings');
    expect(Number(count.rows[0]?.total)).toBe(1);
    await expect(getPracticeAllSettings(db, 'sentence')).resolves.toMatchObject({
      learn_ahead_minutes: 15,
      new_cards_per_day: 30,
      max_reviews_per_day: 150,
      max_session_cards: 35,
    });

    await db.close();
  });

  test('clamps invalid values into the shared bounds instead of persisting them', async () => {
    const db = await freshDb();

    const saved = await savePracticeAllSettings(db, 'word', {
      learn_ahead_minutes: 999,
      new_cards_per_day: 999,
      max_reviews_per_day: 999,
      max_session_cards: 1,
    });

    expect(saved).toEqual({
      learn_ahead_minutes: 50,
      new_cards_per_day: 50,
      max_reviews_per_day: 200,
      max_session_cards: 5,
    });
    // The reloaded row is clamped too, so a hand-edited value cannot leak.
    await expect(getPracticeAllSettings(db, 'word')).resolves.toEqual(saved);

    await db.close();
  });
});
