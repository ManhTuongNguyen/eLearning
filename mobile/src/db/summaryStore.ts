/**
 * Rolling conversation summary storage (SPEC TASK-081, ROADMAP §5).
 *
 * One summary row per local session; `message_boundary` records how many
 * messages are already folded into the content so compaction never
 * re-summarizes the same range.
 */
import type {SqlExecutor} from './driver';
import {nowIso} from './driver';
import type {LocalSummary} from './types';

const SUMMARY_COLUMNS =
  'id, session_id, content, message_boundary, created_at, updated_at';

function mapSummary(row: Record<string, unknown>): LocalSummary {
  return {
    id: Number(row.id),
    session_id: Number(row.session_id),
    content: String(row.content ?? ''),
    message_boundary: Number(row.message_boundary ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

/**
 * Insert or overwrite the single summary of a session and return the stored
 * row. The UNIQUE(session_id) constraint makes this idempotent per session.
 */
export async function saveSummary(
  db: SqlExecutor,
  input: {
    session_id: number;
    content: string;
    message_boundary: number;
  },
): Promise<LocalSummary> {
  const timestamp = nowIso();
  await db.execute(
    `INSERT INTO summaries (session_id, content, message_boundary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       content = excluded.content,
       message_boundary = excluded.message_boundary,
       updated_at = excluded.updated_at`,
    [input.session_id, input.content, input.message_boundary, timestamp, timestamp],
  );
  const stored = await getSummary(db, input.session_id);
  if (!stored) {
    throw new Error('saveSummary: stored summary could not be read back');
  }
  return stored;
}

/** Read the summary of a session; resolves null when none was saved yet. */
export async function getSummary(
  db: SqlExecutor,
  sessionId: number,
): Promise<LocalSummary | null> {
  const result = await db.execute(
    `SELECT ${SUMMARY_COLUMNS} FROM summaries WHERE session_id = ?`,
    [sessionId],
  );
  return result.rows[0] ? mapSummary(result.rows[0]) : null;
}
