/**
 * Anki-style study-day arithmetic (SENTENCE_LIVE_V1 §2.2, TASK-SENT-015).
 *
 * Anki does not treat midnight as the start of a new day: by default the next
 * day begins at **4 a.m. local time**, so a learner who reviews at 1 a.m. is
 * still in the previous study day and does not "lose" a day of interval.
 * FSRS is trained on those day-grained gaps, so the elapsed time fed to the
 * scheduler must use the same boundary.
 *
 * Everything here works in the device's local timezone. The day number is the
 * local calendar date serialised through UTC, which makes arithmetic exact
 * across daylight-saving shifts (23 h and 25 h days) while still rolling over
 * at the learner's local 4 a.m.
 */

/** First hour of a new study day, in the device's local time (Anki default). */
export const DEFAULT_ROLLOVER_HOUR = 4;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function shiftedLocalDate(now: Date, rolloverHour: number): Date {
  return new Date(now.getTime() - rolloverHour * MS_PER_HOUR);
}

/**
 * The exact instant the current study day started (local `rolloverHour` today,
 * or yesterday when the learner is still up before the rollover).
 */
export function startOfStudyDay(now: Date, rolloverHour = DEFAULT_ROLLOVER_HOUR): Date {
  const shifted = shiftedLocalDate(now, rolloverHour);
  return new Date(
    shifted.getFullYear(),
    shifted.getMonth(),
    shifted.getDate(),
    rolloverHour,
    0,
    0,
    0,
  );
}

/**
 * Integer serial of the study day that contains `now`. Two instants belong to
 * the same study day exactly when their serials are equal.
 */
export function studyDayNumber(now: Date, rolloverHour = DEFAULT_ROLLOVER_HOUR): number {
  const start = startOfStudyDay(now, rolloverHour);
  return Math.round(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()) / MS_PER_DAY);
}

/**
 * Whole study days between two instants, never negative. This is the `t` that
 * FSRS receives for a review, and the `elapsed_days` Anki writes to the review
 * log.
 */
export function studyDaysBetween(
  earlier: Date,
  later: Date,
  rolloverHour = DEFAULT_ROLLOVER_HOUR,
): number {
  const difference = studyDayNumber(later, rolloverHour) - studyDayNumber(earlier, rolloverHour);
  return Math.max(0, difference);
}

/**
 * The instant a review card becomes due: `days` study days after the current
 * one, at the rollover hour. FSRS returns an interval in whole days, and
 * Anki makes the card available when that day starts rather than at the
 * o'clock time of the original review.
 */
export function startOfStudyDayAfter(
  now: Date,
  days: number,
  rolloverHour = DEFAULT_ROLLOVER_HOUR,
): Date {
  const start = startOfStudyDay(now, rolloverHour);
  return new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + Math.max(0, Math.round(days)),
    rolloverHour,
    0,
    0,
    0,
  );
}

/** True when both instants belong to the same local study day. */
export function isSameStudyDay(
  first: Date,
  second: Date,
  rolloverHour = DEFAULT_ROLLOVER_HOUR,
): boolean {
  return studyDayNumber(first, rolloverHour) === studyDayNumber(second, rolloverHour);
}
