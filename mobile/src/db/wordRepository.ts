/**
 * Local repository for the word bank (WORD_BANK_V1 TASK-WB-002).
 *
 * Every SQL statement for topics, words, review state and the review log lives
 * here: feature code and screens call these typed functions and never write
 * SQL themselves (the same rule `sentenceRepository.ts` follows). The
 * repository owns row shape only — scheduling decisions arrive as a
 * `SentenceReviewState` produced by the pure scheduler, dictionary facts
 * arrive already parsed, and duplicate detection goes through
 * `normalizeWordText`.
 */

import { normalizeWordText } from '../srs/normalizeWord';
import type { SqlDriver, SqlExecutor, SqlRow } from './driver';
import { nowIso } from './driver';
import type {
  NewWord,
  NewWordTopic,
  ReviewCardMode,
  ReviewGrade,
  SentenceReviewState,
  SentenceState,
  WordDataSource,
  WordDataStatus,
  WordRecord,
  WordReviewLogRecord,
  WordReviewLogInput,
  WordSense,
  WordTopicRecord,
  WordTopicSummary,
} from './types';
import { parseWordPhonetics, parseWordSenses } from './types';

const TOPIC_COLUMNS =
  'id, title, description, extra_prompt, created_at, updated_at';
const WORD_COLUMNS =
  'id, topic_id, text, normalized_text, phonetics_json, senses_json, data_source, data_status, ' +
  'enriched_at, state, suspended, reps, lapses, stability, difficulty, elapsed_days, ' +
  'scheduled_days, learning_steps, due_at, last_grade, last_reviewed_at, created_at, updated_at';
const REVIEW_LOG_COLUMNS =
  'id, word_id, topic_id, grade, rating, state, mode, due_at, stability, difficulty, ' +
  'elapsed_days, last_elapsed_days, scheduled_days, learning_steps, review_duration_ms, ' +
  'reviewed_at';

function mapTopicRow(row: SqlRow): WordTopicRecord {
  return {
    id: Number(row.id),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    extra_prompt: String(row.extra_prompt ?? ''),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

function mapWordRow(row: SqlRow): WordRecord {
  return {
    id: Number(row.id),
    topic_id: Number(row.topic_id),
    text: String(row.text ?? ''),
    normalized_text: String(row.normalized_text ?? ''),
    senses_json: parseWordSenses(row.senses_json),
    phonetics_json: parseWordPhonetics(row.phonetics_json),
    data_source: String(row.data_source ?? 'dictionary') as WordDataSource,
    data_status: String(row.data_status ?? 'missing') as WordDataStatus,
    enriched_at: row.enriched_at === null || row.enriched_at === undefined ? null : String(row.enriched_at),
    state: String(row.state ?? 'new') as SentenceState,
    suspended: Number(row.suspended ?? 0) === 1,
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
    stability: Number(row.stability ?? 0),
    difficulty: Number(row.difficulty ?? 0),
    elapsed_days: Number(row.elapsed_days ?? 0),
    scheduled_days: Number(row.scheduled_days ?? 0),
    learning_steps: Number(row.learning_steps ?? 0),
    due_at: String(row.due_at ?? ''),
    last_grade: String(row.last_grade ?? '') as WordRecord['last_grade'],
    last_reviewed_at: String(row.last_reviewed_at ?? ''),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

function mapReviewLogRow(row: SqlRow): WordReviewLogRecord {
  return {
    id: Number(row.id),
    word_id: Number(row.word_id),
    topic_id: Number(row.topic_id),
    grade: String(row.grade) as ReviewGrade,
    rating: Number(row.rating ?? 0),
    state: String(row.state ?? 'new') as SentenceState,
    mode: String(row.mode) as ReviewCardMode,
    due_at: String(row.due_at ?? ''),
    stability: Number(row.stability ?? 0),
    difficulty: Number(row.difficulty ?? 0),
    elapsed_days: Number(row.elapsed_days ?? 0),
    last_elapsed_days: Number(row.last_elapsed_days ?? 0),
    scheduled_days: Number(row.scheduled_days ?? 0),
    learning_steps: Number(row.learning_steps ?? 0),
    review_duration_ms: Number(row.review_duration_ms ?? 0),
    reviewed_at: String(row.reviewed_at ?? ''),
  };
}

// --- Topics -----------------------------------------------------------------

/** Create a word topic; the description is the learner-context text. */
export async function createWordTopic(
  db: SqlExecutor,
  input: NewWordTopic,
): Promise<WordTopicRecord> {
  const timestamp = nowIso();
  const title = input.title.trim();
  if (!title) {
    throw new Error('createWordTopic: a topic needs a title');
  }
  const description = input.description?.trim() ?? '';
  const extraPrompt = input.extra_prompt?.trim() ?? '';
  const result = await db.execute(
    `INSERT INTO word_topics
       (title, description, extra_prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [title, description, extraPrompt, timestamp, timestamp],
  );
  const id = result.insertId;
  if (id === null || id === undefined) {
    throw new Error('createWordTopic: database did not report an inserted row id');
  }
  return {
    id,
    title,
    description,
    extra_prompt: extraPrompt,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/**
 * List topics newest first, each with its word count and the number of words
 * due at `now`. Suspended words and `data_status='missing'` words (no
 * dictionary data to recall yet) never count as due.
 */
export async function listWordTopics(
  db: SqlExecutor,
  now: string = nowIso(),
): Promise<WordTopicSummary[]> {
  const result = await db.execute(
    `SELECT t.id, t.title, t.description, t.extra_prompt, t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM words w WHERE w.topic_id = t.id) AS word_count,
            (SELECT COUNT(*) FROM words w
              WHERE w.topic_id = t.id AND w.suspended = 0 AND w.data_status = 'complete'
                AND w.due_at <= ?) AS due_count
       FROM word_topics t
      ORDER BY t.created_at DESC, t.id DESC`,
    [now],
  );
  return result.rows.map(row => ({
    ...mapTopicRow(row),
    word_count: Number(row.word_count ?? 0),
    due_count: Number(row.due_count ?? 0),
  }));
}

export async function getWordTopicById(
  db: SqlExecutor,
  id: number,
): Promise<WordTopicRecord | null> {
  const result = await db.execute(`SELECT ${TOPIC_COLUMNS} FROM word_topics WHERE id = ?`, [id]);
  const row = result.rows[0];
  return row ? mapTopicRow(row) : null;
}

/** Update the title, description and/or additional prompt of a topic. */
export async function updateWordTopic(
  db: SqlExecutor,
  id: number,
  patch: { title?: string; description?: string; extra_prompt?: string },
): Promise<WordTopicRecord | null> {
  const assignments: string[] = [];
  const params: (string | number)[] = [];
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) {
      throw new Error('updateWordTopic: a topic needs a title');
    }
    assignments.push('title = ?');
    params.push(title);
  }
  if (patch.description !== undefined) {
    assignments.push('description = ?');
    params.push(patch.description.trim());
  }
  if (patch.extra_prompt !== undefined) {
    assignments.push('extra_prompt = ?');
    params.push(patch.extra_prompt.trim());
  }
  if (assignments.length === 0) {
    return getWordTopicById(db, id);
  }
  assignments.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);
  await db.execute(`UPDATE word_topics SET ${assignments.join(', ')} WHERE id = ?`, params);
  return getWordTopicById(db, id);
}

/** Delete a topic; its words and review log cascade away with it. */
export async function deleteWordTopic(db: SqlExecutor, id: number): Promise<void> {
  await db.execute('DELETE FROM word_topics WHERE id = ?', [id]);
}

// --- Words ------------------------------------------------------------------

/**
 * Insert a batch of candidates in ONE transaction, skipping anything that
 * duplicates an existing word of the topic (or an earlier candidate in the same
 * batch) after normalisation. A fresh word is immediately due (`due_at` = now)
 * so a fresh topic can be practiced at once. Candidates with
 * `data_status='missing'` keep empty senses/phonetics until a dictionary fetch
 * fills them. Returns the rows actually inserted.
 */
export async function insertWords(
  db: SqlDriver,
  topicId: number,
  candidates: readonly NewWord[],
): Promise<WordRecord[]> {
  return db.transaction(async tx => insertWordsWith(tx, topicId, candidates));
}

/**
 * Transaction-free variant for callers that already own a transaction (for
 * example the generation review modal, which persists a selection atomically).
 */
export async function insertWordsWith(
  tx: SqlExecutor,
  topicId: number,
  candidates: readonly NewWord[],
): Promise<WordRecord[]> {
  const existing = await tx.execute('SELECT normalized_text FROM words WHERE topic_id = ?', [
    topicId,
  ]);
  const seen = new Set(existing.rows.map(row => String(row.normalized_text ?? '')));

  const timestamp = nowIso();
  const inserted: WordRecord[] = [];
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    const normalized = normalizeWordText(text);
    if (!text || !normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const senses = candidate.senses_json ?? [];
    const phonetics = candidate.phonetics_json ?? [];
    const dataSource = candidate.data_source ?? 'dictionary';
    const dataStatus = candidate.data_status ?? 'complete';
    const result = await tx.execute(
      `INSERT INTO words
         (topic_id, text, normalized_text, phonetics_json, senses_json, data_source,
          enriched_at, data_status, state, suspended, reps, lapses, stability, difficulty,
          elapsed_days, scheduled_days, learning_steps, due_at, last_grade,
          last_reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'new', 0, 0, 0, 0, 0, 0, 0, 0, ?, '', '', ?, ?)`,
      [
        topicId,
        text,
        normalized,
        JSON.stringify(phonetics),
        JSON.stringify(senses),
        dataSource,
        dataStatus,
        timestamp,
        timestamp,
        timestamp,
      ],
    );
    const id = result.insertId;
    if (id === null || id === undefined) {
      throw new Error('insertWords: database did not report an inserted row id');
    }
    inserted.push({
      id,
      topic_id: topicId,
      text,
      normalized_text: normalized,
      senses_json: senses,
      phonetics_json: phonetics,
      data_source: dataSource,
      data_status: dataStatus,
      enriched_at: null,
      state: 'new',
      suspended: false,
      reps: 0,
      lapses: 0,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      due_at: timestamp,
      last_grade: '',
      last_reviewed_at: '',
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  return inserted;
}

/** List a topic's words, newest first. */
export async function listWordsByTopic(
  db: SqlExecutor,
  topicId: number,
): Promise<WordRecord[]> {
  const result = await db.execute(
    `SELECT ${WORD_COLUMNS} FROM words
      WHERE topic_id = ?
      ORDER BY created_at DESC, id DESC`,
    [topicId],
  );
  return result.rows.map(mapWordRow);
}

export async function getWordById(db: SqlExecutor, id: number): Promise<WordRecord | null> {
  const result = await db.execute(`SELECT ${WORD_COLUMNS} FROM words WHERE id = ?`, [id]);
  const row = result.rows[0];
  return row ? mapWordRow(row) : null;
}

export async function deleteWord(db: SqlExecutor, id: number): Promise<void> {
  await db.execute('DELETE FROM words WHERE id = ?', [id]);
}

/**
 * A word found in another topic by normalised text — the cross-topic duplicate
 * hint the review modal shows ("already in <topic>"). `excludeTopicId` skips
 * the topic being filled; the same word in several topics is allowed.
 */
export interface WordDuplicateHint {
  word: WordRecord;
  topic_title: string;
}

/** Find the first word with this normalised text, newest first. */
export async function getWordByText(
  db: SqlExecutor,
  text: string,
  options: { excludeTopicId?: number } = {},
): Promise<WordDuplicateHint | null> {
  const normalized = normalizeWordText(text);
  if (!normalized) {
    return null;
  }
  const result = await db.execute(
    `SELECT ${WORD_COLUMNS_WITH_PREFIX('w')}, t.title AS topic_title
       FROM words w JOIN word_topics t ON t.id = w.topic_id
      WHERE w.normalized_text = ? AND w.topic_id != ?
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT 1`,
    [normalized, options.excludeTopicId ?? -1],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { word: mapWordRow(row), topic_title: String(row.topic_title ?? '') };
}

/** Column list qualified with a table alias, for joined queries. */
function WORD_COLUMNS_WITH_PREFIX(alias: string): string {
  return WORD_COLUMNS.split(', ')
    .map(column => `${alias}.${column}`)
    .join(', ');
}

/**
 * Store fetched dictionary facts on a dataless word and flip it to complete:
 * the one path that resolves `data_status='missing'`. The FSRS state, the
 * schedule and `data_source` are untouched; the word stays out of practice
 * until this runs. Returns the updated record, or null when the id is unknown.
 */
export async function fillWordDictionaryData(
  db: SqlExecutor,
  wordId: number,
  data: { senses_json: WordSense[]; phonetics_json: string[] },
): Promise<WordRecord | null> {
  await db.execute(
    `UPDATE words
        SET senses_json = ?, phonetics_json = ?, data_status = 'complete', updated_at = ?
      WHERE id = ?`,
    [JSON.stringify(data.senses_json), JSON.stringify(data.phonetics_json), nowIso(), wordId],
  );
  return getWordById(db, wordId);
}

/**
 * Replace a word's senses wholesale with an approved enrichment proposal: one
 * transaction writes the new senses, flips `data_source` to `'enriched'` and
 * stamps `enriched_at`. Phonetics are untouched (the dictionary's IPA survives
 * every enrichment) and so is the FSRS state — no review counter, schedule or
 * `due_at` changes. Returns the updated record, or null when the id is
 * unknown.
 */
export async function applyWordEnrichment(
  db: SqlExecutor,
  wordId: number,
  senses: WordSense[],
  enrichedAt: string,
): Promise<WordRecord | null> {
  await db.execute(
    `UPDATE words
        SET senses_json = ?, data_source = 'enriched', enriched_at = ?, updated_at = ?
      WHERE id = ?`,
    [JSON.stringify(senses), enrichedAt, nowIso(), wordId],
  );
  return getWordById(db, wordId);
}

// --- Due queries ------------------------------------------------------------

/**
 * Words due at `now` across every topic, oldest due first. Suspended words and
 * `data_status='missing'` words are excluded — a word without meanings cannot
 * be recalled.
 */
export async function listDueWords(
  db: SqlExecutor,
  now: string = nowIso(),
  limit = 20,
): Promise<WordRecord[]> {
  const result = await db.execute(
    `SELECT ${WORD_COLUMNS} FROM words
      WHERE suspended = 0 AND data_status = 'complete' AND due_at <= ?
      ORDER BY due_at ASC, id ASC
      LIMIT ?`,
    [now, limit],
  );
  return result.rows.map(mapWordRow);
}

export async function countDueWords(db: SqlExecutor, now: string = nowIso()): Promise<number> {
  const result = await db.execute(
    `SELECT COUNT(*) AS total FROM words
      WHERE suspended = 0 AND data_status = 'complete' AND due_at <= ?`,
    [now],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function countDueWordsForTopic(
  db: SqlExecutor,
  topicId: number,
  now: string = nowIso(),
): Promise<number> {
  const result = await db.execute(
    `SELECT COUNT(*) AS total FROM words
      WHERE topic_id = ? AND suspended = 0 AND data_status = 'complete' AND due_at <= ?`,
    [topicId, now],
  );
  return Number(result.rows[0]?.total ?? 0);
}

// --- Review state and log ---------------------------------------------------

/** Persist the scheduler's decision for one word. */
export async function applyWordReviewState(
  executor: SqlExecutor,
  wordId: number,
  state: SentenceReviewState,
): Promise<void> {
  await executor.execute(
    `UPDATE words
        SET state = ?, reps = ?, lapses = ?, stability = ?, difficulty = ?,
            elapsed_days = ?, scheduled_days = ?, learning_steps = ?, due_at = ?,
            last_grade = ?, last_reviewed_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      state.state,
      state.reps,
      state.lapses,
      state.stability,
      state.difficulty,
      state.elapsed_days,
      state.scheduled_days,
      state.learning_steps,
      state.due_at,
      state.last_grade,
      state.last_reviewed_at,
      nowIso(),
      wordId,
    ],
  );
}

/** Append one review event to the word log (Anki's `revlog` row). */
export async function logWordReview(
  executor: SqlExecutor,
  input: {
    word_id: number;
    topic_id: number;
    grade: ReviewGrade;
    mode: ReviewCardMode;
    log?: WordReviewLogInput;
    review_duration_ms?: number;
    reviewed_at?: string;
  },
): Promise<WordReviewLogRecord> {
  const log = input.log;
  const reviewedAt = log?.reviewed_at ?? input.reviewed_at ?? nowIso();
  const result = await executor.execute(
    `INSERT INTO word_review_log
       (word_id, topic_id, grade, rating, state, mode, due_at, stability,
        difficulty, elapsed_days, last_elapsed_days, scheduled_days,
        learning_steps, review_duration_ms, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.word_id,
      input.topic_id,
      input.grade,
      log?.rating ?? 0,
      log?.state ?? 'new',
      input.mode,
      log?.due_at ?? '',
      log?.stability ?? 0,
      log?.difficulty ?? 0,
      log?.elapsed_days ?? 0,
      log?.last_elapsed_days ?? 0,
      log?.scheduled_days ?? 0,
      log?.learning_steps ?? 0,
      input.review_duration_ms ?? 0,
      reviewedAt,
    ],
  );
  const id = result.insertId;
  if (id === null || id === undefined) {
    throw new Error('logWordReview: database did not report an inserted row id');
  }
  return {
    id,
    word_id: input.word_id,
    topic_id: input.topic_id,
    grade: input.grade,
    rating: log?.rating ?? 0,
    state: log?.state ?? 'new',
    mode: input.mode,
    due_at: log?.due_at ?? '',
    stability: log?.stability ?? 0,
    difficulty: log?.difficulty ?? 0,
    elapsed_days: log?.elapsed_days ?? 0,
    last_elapsed_days: log?.last_elapsed_days ?? 0,
    scheduled_days: log?.scheduled_days ?? 0,
    learning_steps: log?.learning_steps ?? 0,
    review_duration_ms: input.review_duration_ms ?? 0,
    reviewed_at: reviewedAt,
  };
}

/**
 * Record one graded review atomically: the schedule update and its log row
 * commit together, so statistics can never disagree with the schedule.
 */
export async function recordWordReview(
  db: SqlDriver,
  input: {
    word_id: number;
    topic_id: number;
    grade: ReviewGrade;
    mode: ReviewCardMode;
    state: SentenceReviewState;
    log?: WordReviewLogInput;
    review_duration_ms?: number;
  },
): Promise<void> {
  await db.transaction(async tx => {
    await applyWordReviewState(tx, input.word_id, input.state);
    await logWordReview(tx, {
      word_id: input.word_id,
      topic_id: input.topic_id,
      grade: input.grade,
      mode: input.mode,
      log: input.log,
      review_duration_ms: input.review_duration_ms,
    });
  });
}

/** Review events of one word, newest first. */
export async function listWordReviewLog(
  db: SqlExecutor,
  wordId: number,
): Promise<WordReviewLogRecord[]> {
  const result = await db.execute(
    `SELECT ${REVIEW_LOG_COLUMNS} FROM word_review_log
      WHERE word_id = ?
      ORDER BY reviewed_at DESC, id DESC`,
    [wordId],
  );
  return result.rows.map(mapReviewLogRow);
}
