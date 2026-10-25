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
import {
  clampLearnAheadMinutes,
  clampMaxReviewsPerDay,
  clampMaxSessionCards,
  clampNewCardsPerDay,
  DEFAULT_LEARN_AHEAD_MINUTES,
  DEFAULT_MAX_REVIEWS_PER_DAY,
  DEFAULT_MAX_SESSION_CARDS,
  DEFAULT_NEW_CARDS_PER_DAY,
} from '../srs/session';
import type { SqlDriver, SqlExecutor, SqlRow } from './driver';
import { nowIso } from './driver';
import type {
  NewSentence,
  NewSentenceTopic,
  ReviewCardMode,
  ReviewGrade,
  SentenceRecord,
  SentenceReviewLogInput,
  SentenceReviewLogRecord,
  SentenceReviewState,
  SentenceTopicRecord,
  SentenceTopicSummary,
} from './types';

const TOPIC_COLUMNS =
  'id, title, description, generation_prompt, english_level, learn_ahead_minutes, ' +
  'new_cards_per_day, max_reviews_per_day, max_session_cards, created_at, updated_at';
const SENTENCE_COLUMNS =
  'id, topic_id, text, normalized_text, meaning, situation, state, suspended, reps, lapses, ' +
  'stability, difficulty, elapsed_days, scheduled_days, learning_steps, due_at, last_grade, ' +
  'last_reviewed_at, created_at, updated_at';
const REVIEW_LOG_COLUMNS =
  'id, sentence_id, topic_id, grade, rating, state, mode, due_at, stability, difficulty, ' +
  'elapsed_days, last_elapsed_days, scheduled_days, learning_steps, review_duration_ms, ' +
  'reviewed_at';

/**
 * Start of the current study day in the stored `toISOString()` format: the most
 * recent rollover instant, derived from `srs_config.rollover_hour`. The single
 * `?` binds `now`. Used by the daily-quota counts.
 */
const DAY_START_SQL =
  "strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || (SELECT rollover_hour FROM srs_config WHERE id = 1) || ' hours', " +
  "'start of day', '+' || (SELECT rollover_hour FROM srs_config WHERE id = 1) || ' hours')";

/**
 * Per-topic due components for the quota-aware badge, mirroring
 * `buildPracticeSession` with Anki's daily limits: new/review cards due now,
 * learning cards due within the topic's learn-ahead window, and how many
 * new/review cards the review log already consumed today. The five `?`
 * placeholders all bind `now`. Aliases `s`/`l` (sentences/log) and the topic
 * alias `t` must be in scope.
 */
const DUE_COMPONENT_SELECT = `
  (SELECT COUNT(*) FROM sentences s
     WHERE s.topic_id = t.id AND s.suspended = 0 AND s.state = 'new' AND s.due_at <= ?) AS new_due,
  (SELECT COUNT(*) FROM sentences s
     WHERE s.topic_id = t.id AND s.suspended = 0 AND s.state IN ('learning', 'relearning')
       AND s.due_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || t.learn_ahead_minutes || ' minutes')) AS learn_due,
  (SELECT COUNT(*) FROM sentences s
     WHERE s.topic_id = t.id AND s.suspended = 0 AND s.state = 'review' AND s.due_at <= ?) AS review_due,
  (SELECT COUNT(*) FROM sentence_review_log l
     WHERE l.topic_id = t.id AND l.state = 'new' AND l.reviewed_at >= ${DAY_START_SQL}) AS new_done_today,
  (SELECT COUNT(*) FROM sentence_review_log l
     WHERE l.topic_id = t.id AND l.state = 'review' AND l.reviewed_at >= ${DAY_START_SQL}) AS review_done_today`;

/**
 * Fold the components into the badge number: each daily-capped category keeps
 * only its remaining allowance, learning cards are never capped. The row must
 * carry the topic's limit columns too.
 */
function dueCountFromComponents(row: SqlRow): number {
  const newRemaining = Math.max(
    0,
    Number(row.new_cards_per_day ?? DEFAULT_NEW_CARDS_PER_DAY) - Number(row.new_done_today ?? 0),
  );
  const reviewRemaining = Math.max(
    0,
    Number(row.max_reviews_per_day ?? DEFAULT_MAX_REVIEWS_PER_DAY) -
      Number(row.review_done_today ?? 0),
  );
  return (
    Math.min(Number(row.new_due ?? 0), newRemaining) +
    Number(row.learn_due ?? 0) +
    Math.min(Number(row.review_due ?? 0), reviewRemaining)
  );
}

function mapTopicRow(row: SqlRow): SentenceTopicRecord {
  return {
    id: Number(row.id),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    generation_prompt: String(row.generation_prompt ?? ''),
    english_level: String(row.english_level ?? 'AUTO') as SentenceTopicRecord['english_level'],
    learn_ahead_minutes: Number(row.learn_ahead_minutes ?? DEFAULT_LEARN_AHEAD_MINUTES),
    new_cards_per_day: Number(row.new_cards_per_day ?? DEFAULT_NEW_CARDS_PER_DAY),
    max_reviews_per_day: Number(row.max_reviews_per_day ?? DEFAULT_MAX_REVIEWS_PER_DAY),
    max_session_cards: Number(row.max_session_cards ?? DEFAULT_MAX_SESSION_CARDS),
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
    state: String(row.state ?? 'new') as SentenceRecord['state'],
    suspended: Number(row.suspended ?? 0) === 1,
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
    stability: Number(row.stability ?? 0),
    difficulty: Number(row.difficulty ?? 0),
    elapsed_days: Number(row.elapsed_days ?? 0),
    scheduled_days: Number(row.scheduled_days ?? 0),
    learning_steps: Number(row.learning_steps ?? 0),
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
    rating: Number(row.rating ?? 0),
    state: String(row.state ?? 'new') as SentenceReviewLogRecord['state'],
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
  const learnAheadMinutes = clampLearnAheadMinutes(
    input.learn_ahead_minutes ?? DEFAULT_LEARN_AHEAD_MINUTES,
  );
  const newCardsPerDay = clampNewCardsPerDay(input.new_cards_per_day ?? DEFAULT_NEW_CARDS_PER_DAY);
  const maxReviewsPerDay = clampMaxReviewsPerDay(
    input.max_reviews_per_day ?? DEFAULT_MAX_REVIEWS_PER_DAY,
  );
  const maxSessionCards = clampMaxSessionCards(
    input.max_session_cards ?? DEFAULT_MAX_SESSION_CARDS,
  );
  const result = await db.execute(
    `INSERT INTO sentence_topics
       (title, description, generation_prompt, english_level, learn_ahead_minutes,
        new_cards_per_day, max_reviews_per_day, max_session_cards, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title,
      description,
      generationPrompt,
      englishLevel,
      learnAheadMinutes,
      newCardsPerDay,
      maxReviewsPerDay,
      maxSessionCards,
      timestamp,
      timestamp,
    ],
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
    learn_ahead_minutes: learnAheadMinutes,
    new_cards_per_day: newCardsPerDay,
    max_reviews_per_day: maxReviewsPerDay,
    max_session_cards: maxSessionCards,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/**
 * List topics newest first, each with its sentence count and the number of
 * sentences practice would still show at `now`: new/review cards capped by
 * what the topic's daily limits have left (counted from the review log since
 * the rollover), learning-step cards never capped.
 */
export async function listSentenceTopics(
  db: SqlExecutor,
  now: string = nowIso(),
): Promise<SentenceTopicSummary[]> {
  const result = await db.execute(
    `SELECT t.id, t.title, t.description, t.generation_prompt, t.english_level,
            t.learn_ahead_minutes, t.new_cards_per_day, t.max_reviews_per_day,
            t.max_session_cards, t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM sentences s WHERE s.topic_id = t.id) AS sentence_count,
            ${DUE_COMPONENT_SELECT}
       FROM sentence_topics t
      ORDER BY t.created_at DESC, t.id DESC`,
    [now, now, now, now, now],
  );
  return result.rows.map(row => ({
    ...mapTopicRow(row),
    sentence_count: Number(row.sentence_count ?? 0),
    due_count: dueCountFromComponents(row),
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

/** Update the title, description, prompts and/or practice limits of a topic. */
export async function updateSentenceTopic(
  db: SqlExecutor,
  id: number,
  patch: {
    title?: string;
    description?: string;
    generation_prompt?: string;
    learn_ahead_minutes?: number;
    new_cards_per_day?: number;
    max_reviews_per_day?: number;
    max_session_cards?: number;
  },
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
  if (patch.learn_ahead_minutes !== undefined) {
    assignments.push('learn_ahead_minutes = ?');
    params.push(clampLearnAheadMinutes(patch.learn_ahead_minutes));
  }
  if (patch.new_cards_per_day !== undefined) {
    assignments.push('new_cards_per_day = ?');
    params.push(clampNewCardsPerDay(patch.new_cards_per_day));
  }
  if (patch.max_reviews_per_day !== undefined) {
    assignments.push('max_reviews_per_day = ?');
    params.push(clampMaxReviewsPerDay(patch.max_reviews_per_day));
  }
  if (patch.max_session_cards !== undefined) {
    assignments.push('max_session_cards = ?');
    params.push(clampMaxSessionCards(patch.max_session_cards));
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
         (topic_id, text, normalized_text, meaning, situation, state, suspended,
          reps, lapses, stability, difficulty, elapsed_days, scheduled_days,
          learning_steps, due_at, last_grade, last_reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'new', 0, 0, 0, 0, 0, 0, 0, 0, ?, '', '', ?, ?)`,
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

/** Sentences practice would show at `now` across every topic, oldest due first. */
export async function listDueSentences(
  db: SqlExecutor,
  now: string = nowIso(),
  limit = 20,
): Promise<SentenceRecord[]> {
  const result = await db.execute(
    `SELECT ${SENTENCE_COLUMNS} FROM sentences
      WHERE suspended = 0 AND due_at <= ?
      ORDER BY due_at ASC, id ASC
      LIMIT ?`,
    [now, limit],
  );
  return result.rows.map(mapSentenceRow);
}

/**
 * Sentences practice would still show at `now` across every topic, honouring
 * each topic's learn-ahead window and daily limits (Home's due badge).
 */
export async function countDueSentences(db: SqlExecutor, now: string = nowIso()): Promise<number> {
  const result = await db.execute(
    `SELECT t.new_cards_per_day, t.max_reviews_per_day, ${DUE_COMPONENT_SELECT}
       FROM sentence_topics t`,
    [now, now, now, now, now],
  );
  return result.rows.reduce((total, row) => total + dueCountFromComponents(row), 0);
}

/** The per-topic version of {@link countDueSentences}. */
export async function countDueSentencesForTopic(
  db: SqlExecutor,
  topicId: number,
  now: string = nowIso(),
): Promise<number> {
  const result = await db.execute(
    `SELECT t.new_cards_per_day, t.max_reviews_per_day, ${DUE_COMPONENT_SELECT}
       FROM sentence_topics t
      WHERE t.id = ?`,
    [now, now, now, now, now, topicId],
  );
  return result.rows[0] ? dueCountFromComponents(result.rows[0]) : 0;
}

/**
 * How many `new` cards this topic already introduced since the study day
 * started — review-log rows whose pre-review state is `new` (a new card
 * regraded within its learning steps logs `learning`, so it counts once).
 * `dayStartIso` is `startOfStudyDay(now, rolloverHour).toISOString()`.
 */
export async function countNewSentencesIntroducedToday(
  db: SqlExecutor,
  topicId: number,
  dayStartIso: string,
): Promise<number> {
  const result = await db.execute(
    `SELECT COUNT(*) AS total FROM sentence_review_log
      WHERE topic_id = ? AND state = 'new' AND reviewed_at >= ?`,
    [topicId, dayStartIso],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * How many `review` cards this topic already answered since the study day
 * started — review-log rows whose pre-review state is `review` (a lapsed
 * card's intraday relearning steps log `relearning` and do not burn quota).
 */
export async function countSentenceReviewsToday(
  db: SqlExecutor,
  topicId: number,
  dayStartIso: string,
): Promise<number> {
  const result = await db.execute(
    `SELECT COUNT(*) AS total FROM sentence_review_log
      WHERE topic_id = ? AND state = 'review' AND reviewed_at >= ?`,
    [topicId, dayStartIso],
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
      sentenceId,
    ],
  );
}

/** Append one review event to the log (Anki's `revlog` row). */
export async function logSentenceReview(
  executor: SqlExecutor,
  input: {
    sentence_id: number;
    topic_id: number;
    grade: ReviewGrade;
    mode: ReviewCardMode;
    log?: SentenceReviewLogInput;
    review_duration_ms?: number;
    reviewed_at?: string;
  },
): Promise<SentenceReviewLogRecord> {
  const log = input.log;
  const reviewedAt = log?.reviewed_at ?? input.reviewed_at ?? nowIso();
  const result = await executor.execute(
    `INSERT INTO sentence_review_log
       (sentence_id, topic_id, grade, rating, state, mode, due_at, stability,
        difficulty, elapsed_days, last_elapsed_days, scheduled_days,
        learning_steps, review_duration_ms, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.sentence_id,
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
    throw new Error('logSentenceReview: database did not report an inserted row id');
  }
  return {
    id,
    sentence_id: input.sentence_id,
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
export async function recordSentenceReview(
  db: SqlDriver,
  input: {
    sentence_id: number;
    topic_id: number;
    grade: ReviewGrade;
    mode: ReviewCardMode;
    state: SentenceReviewState;
    log?: SentenceReviewLogInput;
    review_duration_ms?: number;
  },
): Promise<void> {
  await db.transaction(async tx => {
    await applyReviewState(tx, input.sentence_id, input.state);
    await logSentenceReview(tx, {
      sentence_id: input.sentence_id,
      topic_id: input.topic_id,
      grade: input.grade,
      mode: input.mode,
      log: input.log,
      review_duration_ms: input.review_duration_ms,
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
