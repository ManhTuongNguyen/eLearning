/**
 * Local speaking-practice history repository (Serverless Mode Audit TASK-101/102)
 * and the local persistence layer for SpeakingHistoryScreen + SpeakingPracticeScreen.
 *
 * Persisted in local SQLite database and provides CRUD for speaking-practice
 * history entries: create, read all, read one, delete one. No backend API calls.
 */

import type { EnglishLevel } from '../api/profile';
import type { SqlDriver } from './driver';
import { nowIso } from './driver';
import type { LocalPracticeHistoryRecord } from './types';

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

export async function deleteSpeakingPracticeRecord(db: SqlDriver, id: number): Promise<void> {
  await db.execute(`DELETE FROM speaking_practice_history WHERE id = ?`, [id]);
}
