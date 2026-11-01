/**
 * Local speaking-practice history repository (Serverless Mode Audit TASK-101/102)
 * and the local persistence layer for SpeakingHistoryScreen + SpeakingPracticeScreen.
 *
 * Persisted in local SQLite database and provides CRUD for speaking-practice
 * history entries: create, read all, read one, update one, delete one. No
 * backend API calls.
 */

import type { EnglishLevel } from '../api/profile';
import type { SqlDriver } from './driver';
import { nowIso } from './driver';
import type { LocalPracticeHistoryRecord } from './types';

/**
 * Average read-aloud pace used to size a user-written practice text. Matches
 * the serverless generation budget (`WORDS_PER_MINUTE` in
 * `serverless/speakingPractice`).
 */
export const SPEAKING_WORDS_PER_MINUTE = 140;

/**
 * Estimated session length for a user-written text. Custom topics carry no
 * AI-sized minute budget, so the history row derives one from the word count
 * (never below one minute).
 */
export function estimateSpeakingMinutes(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / SPEAKING_WORDS_PER_MINUTE));
}

export interface CreateSpeakingPracticeRecordParams {
  userId: number;
  title: string;
  description: string;
  rawPrompt: string;
  englishLevel: EnglishLevel;
  text: string;
  minutes: number;
  wordCount: number;
}

export async function createSpeakingPracticeRecord(
  db: SqlDriver,
  params: CreateSpeakingPracticeRecordParams,
): Promise<LocalPracticeHistoryRecord> {
  const timestamp = nowIso();
  // Plain INSERT + insertId (mirrors sessionStore): RETURNING needs SQLite
  // 3.35+, which older Android WebView-bundled builds lack.
  const result = await db.execute(
    `INSERT INTO speaking_practice_history
       (user_id, title, description, raw_prompt, english_level, text, minutes, word_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.userId,
      params.title,
      params.description,
      params.rawPrompt,
      params.englishLevel,
      params.text,
      params.minutes,
      params.wordCount,
      timestamp,
      timestamp,
    ],
  );
  const id = result.insertId;
  if (id === null || id === undefined) {
    throw new Error('Failed to create speaking practice record');
  }
  return {
    id,
    user_id: params.userId,
    title: params.title,
    description: params.description,
    raw_prompt: params.rawPrompt,
    english_level: params.englishLevel,
    text: params.text,
    minutes: params.minutes,
    word_count: params.wordCount,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function getSpeakingPracticeRecordById(
  db: SqlDriver,
  id: number,
): Promise<LocalPracticeHistoryRecord | null> {
  const result = await db.execute(
    `SELECT id, user_id, title, description, raw_prompt, english_level, text, minutes, word_count, created_at, updated_at
     FROM speaking_practice_history
     WHERE id = ?`,
    [id],
  );
  return (result.rows[0] ?? null) as unknown as LocalPracticeHistoryRecord | null;
}

export async function listSpeakingPracticeRecords(
  db: SqlDriver,
  userId: number,
): Promise<LocalPracticeHistoryRecord[]> {
  const result = await db.execute(
    `SELECT id, user_id, title, description, raw_prompt, english_level, text, minutes, word_count, created_at, updated_at
     FROM speaking_practice_history
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows as unknown as LocalPracticeHistoryRecord[];
}

export interface UpdateSpeakingPracticeRecordParams {
  title?: string;
  text?: string;
  minutes?: number;
  wordCount?: number;
}

/**
 * Update a history entry's editable fields (title and practice content) plus
 * the derived word count/duration. Returns the refreshed record, or null when
 * the id no longer exists.
 */
export async function updateSpeakingPracticeRecord(
  db: SqlDriver,
  id: number,
  patch: UpdateSpeakingPracticeRecordParams,
): Promise<LocalPracticeHistoryRecord | null> {
  const assignments: string[] = [];
  const params: (string | number)[] = [];
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) {
      throw new Error('updateSpeakingPracticeRecord: a title is required');
    }
    assignments.push('title = ?');
    params.push(title);
  }
  if (patch.text !== undefined) {
    const text = patch.text.trim();
    if (!text) {
      throw new Error('updateSpeakingPracticeRecord: practice content is required');
    }
    assignments.push('text = ?');
    params.push(text);
  }
  if (patch.minutes !== undefined) {
    assignments.push('minutes = ?');
    params.push(Math.max(0, Math.round(patch.minutes)));
  }
  if (patch.wordCount !== undefined) {
    assignments.push('word_count = ?');
    params.push(Math.max(0, Math.round(patch.wordCount)));
  }
  if (assignments.length === 0) {
    return getSpeakingPracticeRecordById(db, id);
  }
  assignments.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);
  await db.execute(
    `UPDATE speaking_practice_history SET ${assignments.join(', ')} WHERE id = ?`,
    params,
  );
  return getSpeakingPracticeRecordById(db, id);
}

export async function deleteSpeakingPracticeRecord(db: SqlDriver, id: number): Promise<void> {
  await db.execute(`DELETE FROM speaking_practice_history WHERE id = ?`, [id]);
}
