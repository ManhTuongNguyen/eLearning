/**
 * Local repository for the real-life sentence bank (TASK-SENT-004).
 *
 * Every SQL statement for topics, sentences, review state and the review log
 * lives here: feature code and screens call these typed functions and never
 * write SQL themselves (the same rule the conversation stores follow). The
 * repository owns row shape only — scheduling decisions arrive as a
 * `SentenceReviewState` produced by the pure scheduler, and duplicate
 * detection goes through `normalizeSentenceText`.
 */

import { normalizeSentenceText } from '../srs/normalize';
import type { SqlDriver, SqlExecutor, SqlRow } from './driver';
import { nowIso } from './driver';
import type {
  NewSentence,
  NewSentenceTopic,
  ReviewCardMode,
  ReviewGrade,
  SentenceRecord,
  SentenceReviewLogRecord,
  SentenceReviewState,
  SentenceTopicRecord,
  SentenceTopicSummary,
} from './types';

const TOPIC_COLUMNS =
  'id, title, description, generation_prompt, english_level, created_at, updated_at';
const SENTENCE_COLUMNS =
  'id, topic_id, text, normalized_text, meaning, situation, status, reps, lapses, ' +
  'ease, interval_days, due_at, last_grade, last_reviewed_at, created_at, updated_at';
const REVIEW_LOG_COLUMNS = 'id, sentence_id, topic_id, grade, mode, reviewed_at';

function mapTopicRow(row: SqlRow): SentenceTopicRecord {
  return {
    id: Number(row.id),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    generation_prompt: String(row.generation_prompt ?? ''),
    english_level: String(row.english_level ?? 'AUTO') as SentenceTopicRecord['english_level'],
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

function mapSentenceRow(row: SqlRow): SentenceRecord {
  return {
    id: Number(row.id),
    topic_id: Number(row.topic_id),
    text: String(row.text ?? ''),
    normalized_text: String(row.normalized_text ?? ''),
    meaning: String(row.meaning ?? ''),
    situation: String(row.situation ?? ''),
    status: String(row.status ?? 'new') as SentenceRecord['status'],
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
    ease: Number(row.ease ?? 2.5),
    interval_days: Number(row.interval_days ?? 0),
    due_at: String(row.due_at ?? ''),
    last_grade: String(row.last_grade ?? '') as SentenceRecord['last_grade'],
    last_reviewed_at: String(row.last_reviewed_at ?? ''),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

function mapReviewLogRow(row: SqlRow): SentenceReviewLogRecord {
  return {
    id: Number(row.id),
    sentence_id: Number(row.sentence_id),
    topic_id: Number(row.topic_id),
    grade: String(row.grade) as ReviewGrade,
    mode: String(row.mode) as ReviewCardMode,
    reviewed_at: String(row.reviewed_at ?? ''),
  };
}

// --- Topics -----------------------------------------------------------------

/** Create a topic; `english_level` defaults to AUTO (infer from the learner). */
export async function createSentenceTopic(
  db: SqlExecutor,
  input: NewSentenceTopic,
): Promise<SentenceTopicRecord> {
  const timestamp = nowIso();
  const title = input.title.trim();
  if (!title) {
    throw new Error('createSentenceTopic: a topic needs a title');
  }
  const description = input.description?.trim() ?? '';
  const generationPrompt = input.generation_prompt?.trim() ?? '';
  const englishLevel = input.english_level ?? 'AUTO';
  const result = await db.execute(
    `INSERT INTO sentence_topics
       (title, description, generation_prompt, english_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [title, description, generationPrompt, englishLevel, timestamp, timestamp],
  );
  const id = result.insertId;
  if (id === null || id === undefined) {
    throw new Error('createSentenceTopic: database did not report an inserted row id');
  }
  return {
    id,
    title,
    description,
    generation_prompt: generationPrompt,
    english_level: englishLevel,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/**
 * List topics newest first, each with its sentence count and the number of
 * sentences due at `now` (suspended sentences never count as due).
 */
export async function listSentenceTopics(
  db: SqlExecutor,
  now: string = nowIso(),
): Promise<SentenceTopicSummary[]> {
  const result = await db.execute(
    `SELECT t.id, t.title, t.description, t.generation_prompt, t.english_level,
            t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM sentences s WHERE s.topic_id = t.id) AS sentence_count,
            (SELECT COUNT(*) FROM sentences s
              WHERE s.topic_id = t.id AND s.status != 'suspended' AND s.due_at <= ?) AS due_count
       FROM sentence_topics t
      ORDER BY t.created_at DESC, t.id DESC`,
    [now],
  );
  return result.rows.map(row => ({
    ...mapTopicRow(row),
    sentence_count: Number(row.sentence_count ?? 0),
    due_count: Number(row.due_count ?? 0),
  }));
}

export async function getSentenceTopicById(
  db: SqlExecutor,
  id: number,
): Promise<SentenceTopicRecord | null> {
  const result = await db.execute(`SELECT ${TOPIC_COLUMNS} FROM sentence_topics WHERE id = ?`, [
    id,
  ]);
  const row = result.rows[0];
  return row ? mapTopicRow(row) : null;
}

/** Update the title, description and/or generation prompt of a topic. */
export async function updateSentenceTopic(
  db: SqlExecutor,
  id: number,
  patch: { title?: string; description?: string; generation_prompt?: string },
): Promise<SentenceTopicRecord | null> {
  const assignments: string[] = [];
  const params: (string | number)[] = [];
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) {
      throw new Error('updateSentenceTopic: a topic needs a title');
    }
    assignments.push('title = ?');
    params.push(title);
  }
  if (patch.description !== undefined) {
    assignments.push('description = ?');
    params.push(patch.description.trim());
  }
  if (patch.generation_prompt !== undefined) {
    assignments.push('generation_prompt = ?');
    params.push(patch.generation_prompt.trim());
  }
  if (assignments.length === 0) {
    return getSentenceTopicById(db, id);
  }
  assignments.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);
  await db.execute(`UPDATE sentence_topics SET ${assignments.join(', ')} WHERE id = ?`, params);
  return getSentenceTopicById(db, id);
}

/** Delete a topic; its sentences and review log cascade away with it. */
export async function deleteSentenceTopic(db: SqlExecutor, id: number): Promise<void> {
  await db.execute('DELETE FROM sentence_topics WHERE id = ?', [id]);
}

/** Count the sentences of one topic (suspended included). */
export async function countSentencesInTopic(db: SqlExecutor, topicId: number): Promise<number> {
  const result = await db.execute('SELECT COUNT(*) AS total FROM sentences WHERE topic_id = ?', [
    topicId,
  ]);
  return Number(result.rows[0]?.total ?? 0);
}

// --- Sentences --------------------------------------------------------------

/**
 * Insert a batch of candidates in ONE transaction, skipping anything that
 * duplicates an existing sentence of the topic (or an earlier candidate in the
 * same batch) after normalisation. Returns the rows actually inserted, so the
 * caller can report how many of the generated sentences were new.
 */
export async function insertSentences(
  db: SqlDriver,
  topicId: number,
  candidates: readonly NewSentence[],
): Promise<SentenceRecord[]> {
  return db.transaction(async tx => insertSentencesWith(tx, topicId, candidates));
}

/**
 * Transaction-free variant for callers that already own a transaction (for
 * example the generation review modal, which persists a selection atomically).
 */
export async function insertSentencesWith(
  tx: SqlExecutor,
  topicId: number,
  candidates: readonly NewSentence[],
): Promise<SentenceRecord[]> {
  const existing = await tx.execute('SELECT normalized_text FROM sentences WHERE topic_id = ?', [
    topicId,
  ]);
  const seen = new Set(existing.rows.map(row => String(row.normalized_text ?? '')));

  const timestamp = nowIso();
  const inserted: SentenceRecord[] = [];
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    const normalized = normalizeSentenceText(text);
    if (!text || !normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const meaning = candidate.meaning.trim();
    const situation = candidate.situation?.trim() ?? '';
    const result = await tx.execute(
      `INSERT INTO sentences
         (topic_id, text, normalized_text, meaning, situation, status, reps, lapses, ease,
          interval_days, due_at, last_grade, last_reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'new', 0, 0, 2.5, 0, ?, '', '', ?, ?)`,
      [topicId, text, normalized, meaning, situation, timestamp, timestamp, timestamp],
    );
    const id = result.insertId;
    if (id === null || id === undefined) {
      throw new Error('insertSentences: database did not report an inserted row id');
    }
    inserted.push({
      id,
      topic_id: topicId,
      text,
      normalized_text: normalized,
      meaning,
      situation,
      status: 'new',
      reps: 0,
      lapses: 0,
      ease: 2.5,
      interval_days: 0,
      due_at: timestamp,
      last_grade: '',
      last_reviewed_at: '',
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  return inserted;
}

/** List a topic's sentences, newest first. */
export async function listSentencesByTopic(
  db: SqlExecutor,
  topicId: number,
): Promise<SentenceRecord[]> {
  const result = await db.execute(
    `SELECT ${SENTENCE_COLUMNS} FROM sentences
      WHERE topic_id = ?
      ORDER BY created_at DESC, id DESC`,
    [topicId],
  );
  return result.rows.map(mapSentenceRow);
}

export async function getSentenceById(db: SqlExecutor, id: number): Promise<SentenceRecord | null> {
  const result = await db.execute(`SELECT ${SENTENCE_COLUMNS} FROM sentences WHERE id = ?`, [id]);
  const row = result.rows[0];
  return row ? mapSentenceRow(row) : null;
}

export async function deleteSentence(db: SqlExecutor, id: number): Promise<void> {
  await db.execute('DELETE FROM sentences WHERE id = ?', [id]);
}

// --- Due queries ------------------------------------------------------------

/** Sentences due at `now` across every topic, oldest due first. */
export async function listDueSentences(
  db: SqlExecutor,
  now: string = nowIso(),
  limit = 20,
): Promise<SentenceRecord[]> {
  const result = await db.execute(
    `SELECT ${SENTENCE_COLUMNS} FROM sentences
      WHERE status != 'suspended' AND due_at <= ?
      ORDER BY due_at ASC, id ASC
      LIMIT ?`,
    [now, limit],
  );
  return result.rows.map(mapSentenceRow);
}

export async function countDueSentences(db: SqlExecutor, now: string = nowIso()): Promise<number> {
  const result = await db.execute(
    "SELECT COUNT(*) AS total FROM sentences WHERE status != 'suspended' AND due_at <= ?",
    [now],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function countDueSentencesForTopic(
  db: SqlExecutor,
  topicId: number,
  now: string = nowIso(),
): Promise<number> {
  const result = await db.execute(
    `SELECT COUNT(*) AS total FROM sentences
      WHERE topic_id = ? AND status != 'suspended' AND due_at <= ?`,
    [topicId, now],
  );
  return Number(result.rows[0]?.total ?? 0);
}

// --- Review state and log ---------------------------------------------------

/** Persist the scheduler's decision for one sentence. */
export async function applyReviewState(
  executor: SqlExecutor,
  sentenceId: number,
  state: SentenceReviewState,
): Promise<void> {
  await executor.execute(
    `UPDATE sentences
        SET status = ?, reps = ?, lapses = ?, ease = ?, interval_days = ?, due_at = ?,
            last_grade = ?, last_reviewed_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      state.status,
      state.reps,
      state.lapses,
      state.ease,
      state.interval_days,
      state.due_at,
      state.last_grade,
      state.last_reviewed_at,
      nowIso(),
      sentenceId,
    ],
  );
}

/** Append one review event to the log. */
export async function logSentenceReview(
  executor: SqlExecutor,
  input: {
    sentence_id: number;
    topic_id: number;
    grade: ReviewGrade;
    mode: ReviewCardMode;
    reviewed_at?: string;
  },
): Promise<SentenceReviewLogRecord> {
  const reviewedAt = input.reviewed_at ?? nowIso();
  const result = await executor.execute(
    `INSERT INTO sentence_review_log (sentence_id, topic_id, grade, mode, reviewed_at)
     VALUES (?, ?, ?, ?, ?)`,
    [input.sentence_id, input.topic_id, input.grade, input.mode, reviewedAt],
  );
  const id = result.insertId;
  if (id === null || id === undefined) {
    throw new Error('logSentenceReview: database did not report an inserted row id');
  }
  return {
    id,
    sentence_id: input.sentence_id,
    topic_id: input.topic_id,
    grade: input.grade,
    mode: input.mode,
    reviewed_at: reviewedAt,
  };
}

/**
 * Record one graded review atomically: the schedule update and its log row
 * commit together, so statistics can never disagree with the schedule.
 */
export async function recordSentenceReview(
  db: SqlDriver,
  input: {
    sentence_id: number;
    topic_id: number;
    grade: ReviewGrade;
    mode: ReviewCardMode;
    state: SentenceReviewState;
  },
): Promise<void> {
  await db.transaction(async tx => {
    await applyReviewState(tx, input.sentence_id, input.state);
    await logSentenceReview(tx, {
      sentence_id: input.sentence_id,
      topic_id: input.topic_id,
      grade: input.grade,
      mode: input.mode,
    });
  });
}

/** Review events of one sentence, newest first. */
export async function listReviewLogForSentence(
  db: SqlExecutor,
  sentenceId: number,
): Promise<SentenceReviewLogRecord[]> {
  const result = await db.execute(
    `SELECT ${REVIEW_LOG_COLUMNS} FROM sentence_review_log
      WHERE sentence_id = ?
      ORDER BY reviewed_at DESC, id DESC`,
    [sentenceId],
  );
  return result.rows.map(mapReviewLogRow);
}
