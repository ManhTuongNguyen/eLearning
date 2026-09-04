/**
 * CRUD for local chat messages (SPEC TASK-081).
 *
 * Sequences are per-session and assigned atomically with the insert so
 * concurrent writes cannot collide on the UNIQUE(session_id, sequence)
 * constraint. Status transitions support streaming (pending) and retryable
 * failures (failed) exactly like the backend message model (TASK-027).
 *
 * Each user message also carries its cached grammar improvement (migration
 * v2): once stored, the check is never regenerated and badges survive app
 * restarts.
 */
import type {SqlDriver, SqlExecutor} from './driver';
import {nowIso} from './driver';
import type {
  ImprovementSeverity,
  LocalMessage,
  LocalMessageRole,
  LocalMessageStatus,
} from './types';
const MESSAGE_COLUMNS =
  'id, session_id, role, status, content, sequence, created_at, improvement_content, improvement_explanation, improvement_severity';

function mapMessage(row: Record<string, unknown>): LocalMessage {
  const content = String(row.content ?? '');
  const improvementSeverities = String(row.improvement_severity ?? '');
  return {
    id: Number(row.id),
    session_id: Number(row.session_id),
    role: String(row.role) as LocalMessageRole,
    status: String(row.status ?? 'complete') as LocalMessageStatus,
    content,
    sequence: Number(row.sequence),
    created_at: String(row.created_at ?? ''),
    improvement:
      improvementSeverities !== ''
        ? {
            // `original` is the row's own content — the cache never stores it.
            original: content,
            improved: String(row.improvement_content ?? ''),
            explanation: String(row.improvement_explanation ?? ''),
            severity: improvementSeverities as ImprovementSeverity,
          }
        : undefined,
  };
}

/**
 * Append a message to a session inside a transaction that also reserves the
 * next sequence number; returns the persisted row.
 */
export async function insertMessage(
  db: SqlDriver,
  input: {
    session_id: number;
    role: LocalMessageRole;
    content: string;
    status?: LocalMessageStatus;
  },
): Promise<LocalMessage> {
  return db.transaction(tx => appendMessage(tx, input));
}

/**
 * Append one message using an existing executor (a transaction or bare
 * connection) without opening its own transaction. Sequence reservation
 * reads MAX(sequence) inside the caller's transaction, so several appends
 * composed by one caller (e.g. a user turn plus its pending assistant slot)
 * receive consecutive numbers and commit or roll back together.
 */
export async function appendMessage(
  executor: SqlExecutor,
  input: {
    session_id: number;
    role: LocalMessageRole;
    content: string;
    status?: LocalMessageStatus;
  },
): Promise<LocalMessage> {
  const timestamp = nowIso();
  const status = input.status ?? 'complete';

  const maxResult = await executor.execute(
    'SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM messages WHERE session_id = ?',
    [input.session_id],
  );
  const sequence = Number(maxResult.rows[0]?.max_sequence ?? 0) + 1;

  const insertResult = await executor.execute(
    `INSERT INTO messages (session_id, role, status, content, sequence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.session_id, input.role, status, input.content, sequence, timestamp],
  );

  const stored = await executor.execute(`${messageQuery()} WHERE id = ?`, [
    insertResult.insertId,
  ]);
  if (!stored.rows[0]) {
    throw new Error('appendMessage: inserted row could not be read back');
  }
  return mapMessage(stored.rows[0]);
}

/** Read one message by id; resolves null when it does not exist. */
export async function getMessage(
  db: SqlExecutor,
  messageId: number,
): Promise<LocalMessage | null> {
  const result = await db.execute(`${messageQuery()} WHERE id = ?`, [messageId]);
  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

/** Messages of one session in deterministic chronological order. */
export async function listMessages(
  db: SqlExecutor,
  sessionId: number,
): Promise<LocalMessage[]> {
  const result = await db.execute(
    `${messageQuery()} WHERE session_id = ? ORDER BY sequence ASC`,
    [sessionId],
  );
  return result.rows.map(mapMessage);
}

/**
 * Update a message's generation status (and content once available). Used by
 * serverless streaming/retry so a failed assistant row is never marked
 * complete prematurely.
 */
export async function updateMessageStatus(
  db: SqlExecutor,
  messageId: number,
  status: LocalMessageStatus,
  content?: string,
): Promise<void> {
  if (content === undefined) {
    await db.execute('UPDATE messages SET status = ? WHERE id = ?', [
      status,
      messageId,
    ]);
    return;
  }
  await db.execute('UPDATE messages SET status = ?, content = ? WHERE id = ?', [
    status,
    content,
    messageId,
  ]);
}

/**
 * Persist one grammar improvement onto a message row (idempotent by
 * contract: callers only save once per message, because reads short-circuit
 * regeneration). `original` is deliberately not stored — the row's own
 * `content` is the original. Unknown ids simply update nothing.
 */
export async function saveMessageImprovement(
  db: SqlExecutor,
  messageId: number,
  improvement: {
    improved: string;
    explanation: string;
    severity: ImprovementSeverity;
  },
): Promise<void> {
  await db.execute(
    `UPDATE messages
     SET improvement_content = ?, improvement_explanation = ?, improvement_severity = ?
     WHERE id = ?`,
    [improvement.improved, improvement.explanation, improvement.severity, messageId],
  );
}

function messageQuery(): string {
  return `SELECT ${MESSAGE_COLUMNS} FROM messages`;
}
