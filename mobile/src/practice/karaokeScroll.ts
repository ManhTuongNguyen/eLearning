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
    return { offset: Math.min(offset, Math.max(0, maxOffset)), done: false };
  }
  const next = Math.min(
    Math.max(0, offset) + (Math.max(0, speedPxPerSecond) * Math.max(0, dtMs)) / 1000,
    maxOffset,
  );
  return { offset: next, done: next >= maxOffset };
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

/**
 * Map the TTS playback position onto a scroll offset for the listen-mode
 * teleprompter: the offset grows with the fraction of the text already
 * spoken (character-count proportional), so the scroll follows the
 * engine's actual pace instead of the Settings speed slider. Out-of-range
 * inputs clamp deterministically; an empty text or a non-scrollable view
 * stays at the top. This is the FALLBACK used before paragraph layouts
 * are measured; offsetForSpokenChar() is the layout-accurate mapping.
 */
export function offsetForCharProgress(
  charEnd: number,
  totalChars: number,
  maxOffset: number,
): number {
  if (totalChars <= 0 || maxOffset <= 0) {
    return 0;
  }
  const fraction = Math.min(1, Math.max(0, charEnd / totalChars));
  return fraction * maxOffset;
}

/** Character range of one display paragraph within the full practice text. */
export interface ParagraphCharRange {
  charStart: number;
  charEnd: number;
}

/**
 * Locate each display paragraph inside the full practice text that the
 * engine speaks. The paragraphs are trimmed splits of that text, so a
 * sequential search keeps the ranges aligned with the spoken character
 * offsets; a paragraph that cannot be found (defensive) starts at the
 * previous end so ranges stay ordered and monotonic.
 */
export function paragraphCharRanges(
  fullText: string,
  paragraphs: readonly string[],
): ParagraphCharRange[] {
  const ranges: ParagraphCharRange[] = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const foundAt = fullText.indexOf(paragraph, cursor);
    const charStart = foundAt >= 0 ? foundAt : cursor;
    const charEnd = charStart + paragraph.length;
    ranges.push({ charStart, charEnd });
    cursor = charEnd;
  }
  return ranges;
}

/** A paragraph range plus its measured position inside the scroll content. */
export interface ParagraphSpan extends ParagraphCharRange {
  /** Top edge of the paragraph relative to the scroll content start. */
  y: number;
  /** Rendered height of the paragraph box. */
  height: number;
}

/**
 * Map the TTS playback position onto a scroll offset using the MEASURED
 * paragraph layout: the spoken point is interpolated inside the paragraph
 * currently being spoken and kept at `anchorFraction` of the viewport
 * height, so upcoming words stay visible below it. Because paragraph
 * boxes only stack downwards, the result is monotonic in `charEnd` — the
 * teleprompter never jumps backwards — and short versus long paragraphs
 * scroll at a visually consistent pace, which whole-text
 * character-proportional mapping cannot deliver.
 *
 * `topInset` is the scroll content's leading padding above the first
 * paragraph (the karaoke text area's vertical padding). Out-of-range
 * inputs clamp deterministically; an empty span list or a
 * non-scrollable view stays at the top.
 *
 * Before the first paragraph is reached the spoken point sits at the top
 * of the content box (clamped to the viewport top); once the whole text
 * has been spoken the scroll snaps to the very end, so the user clearly
 * sees that playback is finished instead of having the last word sit at
 * the anchor in the middle of otherwise empty space.
 */
export function offsetForSpokenChar(
  charEnd: number,
  spans: readonly ParagraphSpan[],
  topInset: number,
  viewportHeight: number,
  maxOffset: number,
  anchorFraction: number = 0.35,
): number {
  if (spans.length === 0 || maxOffset <= 0) {
    return 0;
  }
  if (charEnd <= spans[0].charStart) {
    // Before the first spoken character: the text is still above the
    // visible area (the first line sits at the top inset), so keep the
    // viewport pinned at its top.
    return 0;
  }
  if (charEnd >= spans[spans.length - 1].charEnd) {
    // The entire text has been spoken: scroll fully to the bottom so the
    // user can see that playback is finished.
    return maxOffset;
  }
  // The span containing charEnd. Past-the-end progress lands in the last
  // span (guaranteed reachable here because of the boundary check above).
  let span: ParagraphSpan = spans[spans.length - 1];
  for (const candidate of spans) {
    if (charEnd < candidate.charEnd) {
      span = candidate;
      break;
    }
  }
  const spanChars = Math.max(1, span.charEnd - span.charStart);
  const fraction = Math.max(0, (charEnd - span.charStart) / spanChars);
  const absoluteY = topInset + span.y + fraction * span.height;
  const anchor = Math.min(1, Math.max(0, anchorFraction));
  const offset = absoluteY - viewportHeight * anchor;
  return Math.min(Math.max(0, offset), maxOffset);
}
