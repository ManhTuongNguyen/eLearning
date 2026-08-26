/**
 * CRUD for local conversation sessions (SPEC TASK-081).
 *
 * Low-level store used by the serverless conversation repository (TASK-082);
 * listing is most-recently-updated first to mirror the server API (TASK-031).
 */
import type {EnglishLevel} from '../api/profile';

import type {SqlExecutor} from './driver';
import {nowIso} from './driver';
import type {LocalSession, NewLocalSession} from './types';

const SESSION_COLUMNS =
  'id, title, topic, topic_hint, learning_level, created_at, updated_at';

function mapSession(row: Record<string, unknown>): LocalSession {
  return {
    id: Number(row.id),
    title: String(row.title ?? ''),
    topic: String(row.topic ?? ''),
    topic_hint: String(row.topic_hint ?? ''),
    learning_level: String(row.learning_level ?? 'A1') as EnglishLevel,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

/** Insert a session with sensible defaults; returns the persisted row. */
export async function insertSession(
  db: SqlExecutor,
  input: NewLocalSession = {},
): Promise<LocalSession> {
  const timestamp = nowIso();
  const result = await db.execute(
    `INSERT INTO sessions (title, topic, topic_hint, learning_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.title ?? 'New conversation',
      input.topic ?? '',
      input.topic_hint ?? '',
      input.learning_level ?? 'A1',
      timestamp,
      timestamp,
    ],
  );
  const id = result.insertId;
  if (id === null) {
    throw new Error('insertSession: database did not report an inserted row id');
  }
  return {
    id,
    title: input.title ?? 'New conversation',
    topic: input.topic ?? '',
    topic_hint: input.topic_hint ?? '',
    learning_level: input.learning_level ?? 'A1',
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** Read one session by id; resolves null when it does not exist. */
export async function getSession(
  db: SqlExecutor,
  sessionId: number,
): Promise<LocalSession | null> {
  const result = await db.execute(`${sessionQuery()} WHERE id = ?`, [sessionId]);
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

/** All sessions, most recently updated first. */
export async function listSessions(db: SqlExecutor): Promise<LocalSession[]> {
  const result = await db.execute(
    `${sessionQuery()} ORDER BY updated_at DESC, id DESC`,
  );
  return result.rows.map(mapSession);
}

/** Rename a session and bump its updated_at so ordering follows activity. */
export async function renameSession(
  db: SqlExecutor,
  sessionId: number,
  title: string,
): Promise<void> {
  await db.execute('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', [
    title,
    nowIso(),
    sessionId,
  ]);
}

/** Touch updated_at without changing content (e.g. after chat activity). */
export async function touchSession(
  db: SqlExecutor,
  sessionId: number,
): Promise<void> {
  await db.execute('UPDATE sessions SET updated_at = ? WHERE id = ?', [
    nowIso(),
    sessionId,
  ]);
}

/**
 * Delete a session. Messages and the summary are removed by the
 * ON DELETE CASCADE foreign keys.
 */
export async function deleteSession(
  db: SqlExecutor,
  sessionId: number,
): Promise<boolean> {
  const result = await db.execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
  return result.rowsAffected > 0;
}

function sessionQuery(): string {
  return `SELECT ${SESSION_COLUMNS} FROM sessions`;
}
