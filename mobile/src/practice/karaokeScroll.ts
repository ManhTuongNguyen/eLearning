/**
 * Pure helpers for the karaoke-style speaking-practice display (speed-
 * controlled auto-scroll and the session timer). Kept free of React and
 * React Native so the scroll behavior is unit-testable without a device.
 */

/** Outcome of one scroll tick. */
export interface ScrollStep {
  /** The offset to show for this tick, clamped to [0, maxOffset]. */
  offset: number;
  /** True once the text end has been reached. */
  done: boolean;
}

/**
 * Advance the auto-scroll by one tick: the offset grows with the requested
 * speed for the elapsed time and clamps to the scrollable range. Reaching
 * the end marks the practice text as done — the caller then finishes the
 * session. Zero speed and a zero dt never move (and never complete).
 */
export function stepOffset(
  offset: number,
  speedPxPerSecond: number,
  dtMs: number,
  maxOffset: number,
): ScrollStep {
  if (maxOffset <= 0) {
    // The text fits the viewport without scrolling; there is nothing to
    // read past, so the practice can only end through the End control.
    return {offset: Math.min(offset, Math.max(0, maxOffset)), done: false};
  }
  const next = Math.min(
    Math.max(0, offset) + (Math.max(0, speedPxPerSecond) * Math.max(0, dtMs)) / 1000,
    maxOffset,
  );
  return {offset: next, done: next >= maxOffset};
}

/** Milliseconds needed to scroll `maxOffset` at the given speed (min 1 tick). */
export function scrollDurationMs(maxOffset: number, speedPxPerSecond: number): number {
  if (maxOffset <= 0 || speedPxPerSecond <= 0) {
    return 0;
  }
  return Math.ceil((maxOffset / speedPxPerSecond) * 1000);
}

/** Format an elapsed duration as "MM:SS" for the session timer. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/** Count the readable words of a practice text (whitespace-split). */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
