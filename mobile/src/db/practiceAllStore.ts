/**
 * Cross-topic ("all topics") practice settings (migration v12).
 *
 * Each bank kind keeps one Anki-style deck preset used when a learner practises
 * every topic together instead of a single topic. The settings mirror the
 * per-topic columns (`learn_ahead_minutes`, `new_cards_per_day`,
 * `max_reviews_per_day`, `max_session_cards`) so the practice screens can build
 * the mixed session with the same option shape.
 *
 * A missing row means the app defaults ({@link DEFAULT_PRACTICE_ALL_SETTINGS});
 * the row is written on the first save. Reads always clamp into the shared
 * bounds, so a corrupted row can never leave the practice screen with a bad
 * limit.
 */

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
import type { SqlExecutor, SqlRow } from './driver';
import { nowIso } from './driver';

/** Which bank the settings belong to. */
export type PracticeAllKind = 'word' | 'sentence';

/** The persisted, clamped practice limits of the cross-topic session. */
export interface PracticeAllSettings {
  learn_ahead_minutes: number;
  new_cards_per_day: number;
  max_reviews_per_day: number;
  max_session_cards: number;
}

/** Defaults used before the learner ever saves the cross-topic settings. */
export const DEFAULT_PRACTICE_ALL_SETTINGS: PracticeAllSettings = {
  learn_ahead_minutes: DEFAULT_LEARN_AHEAD_MINUTES,
  new_cards_per_day: DEFAULT_NEW_CARDS_PER_DAY,
  max_reviews_per_day: DEFAULT_MAX_REVIEWS_PER_DAY,
  max_session_cards: DEFAULT_MAX_SESSION_CARDS,
};

const SETTINGS_COLUMNS =
  'learn_ahead_minutes, new_cards_per_day, max_reviews_per_day, max_session_cards, updated_at';

function mapSettingsRow(row: SqlRow): PracticeAllSettings {
  return {
    learn_ahead_minutes: clampLearnAheadMinutes(
      Number(row.learn_ahead_minutes ?? DEFAULT_LEARN_AHEAD_MINUTES),
    ),
    new_cards_per_day: clampNewCardsPerDay(
      Number(row.new_cards_per_day ?? DEFAULT_NEW_CARDS_PER_DAY),
    ),
    max_reviews_per_day: clampMaxReviewsPerDay(
      Number(row.max_reviews_per_day ?? DEFAULT_MAX_REVIEWS_PER_DAY),
    ),
    max_session_cards: clampMaxSessionCards(
      Number(row.max_session_cards ?? DEFAULT_MAX_SESSION_CARDS),
    ),
  };
}

/** Read the cross-topic settings of one bank, falling back to the defaults. */
export async function getPracticeAllSettings(
  db: SqlExecutor,
  kind: PracticeAllKind,
): Promise<PracticeAllSettings> {
  const result = await db.execute(
    `SELECT ${SETTINGS_COLUMNS} FROM practice_all_settings WHERE kind = ?`,
    [kind],
  );
  const row = result.rows[0];
  return row ? mapSettingsRow(row) : { ...DEFAULT_PRACTICE_ALL_SETTINGS };
}

/**
 * Persist the cross-topic settings of one bank, clamping each value. The row is
 * upserted (`INSERT OR REPLACE` works on SQLite engines older than 3.24, same
 * reason as `srsConfigStore`). Returns the stored, clamped settings.
 */
export async function savePracticeAllSettings(
  db: SqlExecutor,
  kind: PracticeAllKind,
  settings: PracticeAllSettings,
): Promise<PracticeAllSettings> {
  const next: PracticeAllSettings = {
    learn_ahead_minutes: clampLearnAheadMinutes(settings.learn_ahead_minutes),
    new_cards_per_day: clampNewCardsPerDay(settings.new_cards_per_day),
    max_reviews_per_day: clampMaxReviewsPerDay(settings.max_reviews_per_day),
    max_session_cards: clampMaxSessionCards(settings.max_session_cards),
  };
  await db.execute(
    `INSERT OR REPLACE INTO practice_all_settings
       (kind, learn_ahead_minutes, new_cards_per_day, max_reviews_per_day,
        max_session_cards, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      kind,
      next.learn_ahead_minutes,
      next.new_cards_per_day,
      next.max_reviews_per_day,
      next.max_session_cards,
      nowIso(),
    ],
  );
  return next;
}
