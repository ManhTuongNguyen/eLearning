/**
 * Study-day boundary tests (TASK-SENT-015).
 *
 * Anki's "next day starts at" default is 4 a.m., so the boundary — not
 * midnight and not a rolling 24-hour window — decides both the `elapsed_days`
 * FSRS sees and the day a review card becomes due. Every instant here is built
 * with local-time constructors, so the assertions hold in any test timezone.
 */
import {
  DEFAULT_ROLLOVER_HOUR,
  isSameStudyDay,
  startOfStudyDay,
  startOfStudyDayAfter,
  studyDayNumber,
  studyDaysBetween,
} from '../src/srs/dayBoundary';

describe('startOfStudyDay', () => {
  test('defaults to 4 a.m. local time', () => {
    expect(DEFAULT_ROLLOVER_HOUR).toBe(4);

    const start = startOfStudyDay(new Date(2026, 9, 19, 9, 30));

    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(9);
    expect(start.getDate()).toBe(19);
    expect(start.getHours()).toBe(4);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
  });

  test('before 4 a.m. the study day is still yesterday', () => {
    const start = startOfStudyDay(new Date(2026, 9, 20, 3, 59));
    expect(start.getDate()).toBe(19);
    expect(start.getHours()).toBe(4);
  });

  test('respects a custom rollover hour', () => {
    const start = startOfStudyDay(new Date(2026, 9, 20, 0, 30), 0);
    expect(start.getDate()).toBe(20);
    expect(start.getHours()).toBe(0);
  });
});

describe('studyDaysBetween', () => {
  test('counts whole study days and never goes negative', () => {
    const morning = new Date(2026, 9, 19, 5, 0);
    const nextMorning = new Date(2026, 9, 21, 5, 0);

    expect(studyDaysBetween(morning, nextMorning)).toBe(2);
    expect(studyDaysBetween(nextMorning, morning)).toBe(0);
  });

  test('a late-night review and an early-morning review share one study day', () => {
    const lateNight = new Date(2026, 9, 19, 23, 30);
    const earlyMorning = new Date(2026, 9, 20, 2, 15);

    expect(isSameStudyDay(lateNight, earlyMorning)).toBe(true);
    expect(studyDaysBetween(lateNight, earlyMorning)).toBe(0);

    const afterRollover = new Date(2026, 9, 20, 4, 15);
    expect(isSameStudyDay(lateNight, afterRollover)).toBe(false);
    expect(studyDaysBetween(lateNight, afterRollover)).toBe(1);
  });

  test('day serials are exact across a month boundary', () => {
    const lastOfMonth = new Date(2026, 9, 31, 12, 0);
    const firstOfNext = new Date(2026, 10, 1, 12, 0);

    expect(studyDayNumber(firstOfNext) - studyDayNumber(lastOfMonth)).toBe(1);
  });
});

describe('startOfStudyDayAfter', () => {
  test('returns the rollover instant N study days later', () => {
    const now = new Date(2026, 9, 19, 9, 0);
    const due = startOfStudyDayAfter(now, 3);

    expect(due.getFullYear()).toBe(2026);
    expect(due.getMonth()).toBe(9);
    expect(due.getDate()).toBe(22);
    expect(due.getHours()).toBe(4);
    expect(studyDaysBetween(now, due)).toBe(3);
  });

  test('crosses into the next month and never goes backwards', () => {
    const now = new Date(2026, 9, 30, 9, 0);

    expect(startOfStudyDayAfter(now, 2).getMonth()).toBe(10);
    expect(startOfStudyDayAfter(now, -5).getTime()).toBe(startOfStudyDayAfter(now, 0).getTime());
  });
});
