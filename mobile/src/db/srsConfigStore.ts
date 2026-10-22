/**
 * Collection-level FSRS configuration and optimizer export (TASK-SENT-015).
 *
 * This is the local equivalent of Anki's FSRS deck preset: one row
 * (`srs_config.id = 1`) holds the optimized weight vector, the desired
 * retention, the interval cap, fuzz, the learning steps and the study-day
 * rollover hour. The pure scheduler reads the resulting `FsrsConfig`; nothing
 * else in the app needs to know where the weights came from.
 *
 * `listReviewHistoryForOptimization` exposes the Anki-shaped `revlog` rows the
 * FSRS optimizer trains on. Optimizing itself stays out of the app bundle
 * (`@open-spaced-repetition/binding` is a WASM/Node tool); export the rows,
 * train, then `saveSrsConfig({ weights })`.
 */

import {
  clampMaximumInterval,
  clampRetention,
  clampRolloverHour,
  DEFAULT_FSRS_CONFIG,
  DEFAULT_MODEL_VERSION,
  type FsrsConfig,
  parseSteps,
  parseWeights,
  serializeSteps,
  serializeWeights,
} from '../srs/config';
import type { SqlExecutor, SqlRow } from './driver';
import { nowIso } from './driver';
import type { ReviewGrade, SentenceState } from './types';

/** Stored config plus the model version the weights were trained for. */
export interface SrsConfigRecord extends FsrsConfig {
  modelVersion: string;
  updatedAt: string;
}

/** Patch accepted by `saveSrsConfig`; omitted fields keep their stored value. */
export type SrsConfigPatch = Partial<FsrsConfig & { modelVersion: string }>;

const CONFIG_COLUMNS =
  'model_version, weights, desired_retention, maximum_interval, enable_fuzz, ' +
  'enable_short_term, learning_steps, relearning_steps, rollover_hour, updated_at';

function mapConfigRow(row: SqlRow): SrsConfigRecord {
  return {
    modelVersion: String(row.model_version ?? DEFAULT_MODEL_VERSION),
    weights: parseWeights(row.weights === null ? null : String(row.weights)),
    desiredRetention: clampRetention(
      Number(row.desired_retention ?? DEFAULT_FSRS_CONFIG.desiredRetention),
    ),
    maximumInterval: clampMaximumInterval(
      Number(row.maximum_interval ?? DEFAULT_FSRS_CONFIG.maximumInterval),
    ),
    enableFuzz: Number(row.enable_fuzz ?? 1) === 1,
    enableShortTerm: Number(row.enable_short_term ?? 1) === 1,
    learningSteps: parseSteps(
      row.learning_steps === null ? null : String(row.learning_steps),
      DEFAULT_FSRS_CONFIG.learningSteps,
    ),
    relearningSteps: parseSteps(
      row.relearning_steps === null ? null : String(row.relearning_steps),
      DEFAULT_FSRS_CONFIG.relearningSteps,
    ),
    rolloverHour: clampRolloverHour(Number(row.rollover_hour ?? DEFAULT_FSRS_CONFIG.rolloverHour)),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/** Read the collection config, falling back to Anki's defaults. */
export async function getSrsConfig(db: SqlExecutor): Promise<SrsConfigRecord> {
  const result = await db.execute(`SELECT ${CONFIG_COLUMNS} FROM srs_config WHERE id = 1`);
  const row = result.rows[0];
  if (!row) {
    return {
      ...DEFAULT_FSRS_CONFIG,
      modelVersion: DEFAULT_MODEL_VERSION,
      updatedAt: '',
    };
  }
  return mapConfigRow(row);
}

/** Merge a patch into the stored config and persist the whole row. */
export async function saveSrsConfig(
  db: SqlExecutor,
  patch: SrsConfigPatch,
): Promise<SrsConfigRecord> {
  const current = await getSrsConfig(db);
  // Normalise patches through the same parser used on read, so a save→load
  // round trip can never change meaning: invalid steps are dropped, an empty
  // list falls back to Anki's default, and `[]`/`null` weights mean "package
  // defaults".
  const next: SrsConfigRecord = {
    modelVersion: patch.modelVersion?.trim() || current.modelVersion,
    weights:
      patch.weights === undefined ? current.weights : parseWeights(serializeWeights(patch.weights)),
    desiredRetention:
      patch.desiredRetention === undefined
        ? current.desiredRetention
        : clampRetention(patch.desiredRetention),
    maximumInterval:
      patch.maximumInterval === undefined
        ? current.maximumInterval
        : clampMaximumInterval(patch.maximumInterval),
    enableFuzz: patch.enableFuzz ?? current.enableFuzz,
    enableShortTerm: patch.enableShortTerm ?? current.enableShortTerm,
    learningSteps:
      patch.learningSteps === undefined
        ? current.learningSteps
        : parseSteps(serializeSteps(patch.learningSteps), DEFAULT_FSRS_CONFIG.learningSteps),
    relearningSteps:
      patch.relearningSteps === undefined
        ? current.relearningSteps
        : parseSteps(serializeSteps(patch.relearningSteps), DEFAULT_FSRS_CONFIG.relearningSteps),
    rolloverHour:
      patch.rolloverHour === undefined
        ? current.rolloverHour
        : clampRolloverHour(patch.rolloverHour),
    updatedAt: nowIso(),
  };

  // INSERT OR REPLACE keeps the single-row config working on SQLite engines
  // older than 3.24 (same reason as settingsStore).
  await db.execute(
    `INSERT OR REPLACE INTO srs_config
       (id, model_version, weights, desired_retention, maximum_interval,
        enable_fuzz, enable_short_term, learning_steps, relearning_steps,
        rollover_hour, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      next.modelVersion,
      serializeWeights(next.weights),
      next.desiredRetention,
      next.maximumInterval,
      next.enableFuzz ? 1 : 0,
      next.enableShortTerm ? 1 : 0,
      serializeSteps(next.learningSteps),
      serializeSteps(next.relearningSteps),
      next.rolloverHour,
      next.updatedAt,
    ],
  );
  return next;
}

/**
 * One review in the shape the FSRS optimizer expects (Anki's `revlog`).
 * `review_time` is the millisecond timestamp; `rating` is 1–4.
 */
export interface OptimizerReviewRow {
  card_id: number;
  topic_id: number;
  review_time: number;
  rating: number;
  state: SentenceState;
  grade: ReviewGrade;
  elapsed_days: number;
  last_elapsed_days: number;
  scheduled_days: number;
  stability: number;
  difficulty: number;
  review_duration_ms: number;
}

/**
 * Review history for parameter optimization, oldest first. Pre-FSRS rows
 * (rating 0, written by migration v6) are skipped because they carry no memory
 * state. The output can be written to the CSV `@open-spaced-repetition/binding`
 * expects, or replayed through `ts-fsrs`'s `reschedule`.
 */
export async function listReviewHistoryForOptimization(
  db: SqlExecutor,
  options: { topicId?: number; limit?: number } = {},
): Promise<OptimizerReviewRow[]> {
  const filters: string[] = ['rating BETWEEN 1 AND 4'];
  const params: (string | number)[] = [];
  if (options.topicId !== undefined) {
    filters.push('topic_id = ?');
    params.push(options.topicId);
  }
  const limit = options.limit ?? 100_000;
  params.push(limit);
  const result = await db.execute(
    `SELECT sentence_id, topic_id, rating, state, grade, elapsed_days,
            last_elapsed_days, scheduled_days, stability, difficulty,
            review_duration_ms, reviewed_at
       FROM sentence_review_log
      WHERE ${filters.join(' AND ')}
      ORDER BY reviewed_at ASC, id ASC
      LIMIT ?`,
    params,
  );
  return result.rows.flatMap(row => {
    const reviewedAt = Date.parse(String(row.reviewed_at ?? ''));
    if (!Number.isFinite(reviewedAt)) {
      return [];
    }
    return [
      {
        card_id: Number(row.sentence_id),
        topic_id: Number(row.topic_id),
        review_time: reviewedAt,
        rating: Number(row.rating),
        state: String(row.state ?? 'new') as SentenceState,
        grade: String(row.grade) as ReviewGrade,
        elapsed_days: Number(row.elapsed_days ?? 0),
        last_elapsed_days: Number(row.last_elapsed_days ?? 0),
        scheduled_days: Number(row.scheduled_days ?? 0),
        stability: Number(row.stability ?? 0),
        difficulty: Number(row.difficulty ?? 0),
        review_duration_ms: Number(row.review_duration_ms ?? 0),
      },
    ];
  });
}
