/**
 * Streaming UX primitives (SPEC TASK-050/103).
 *
 * Three concerns of a smooth chat stream, kept as pure units so the state
 * transitions are exhaustively testable without rendering:
 *
 * - DeltaBuffer coalesces bursts of SSE delta events into at most one state
 *   commit per flush tick. Token streams can emit many deltas per second;
 *   committing each one schedules a React render per token and long bubbles
 *   visibly stutter. With the buffer, render frequency is bounded by the
 *   tick interval regardless of arrival frequency.
 * - isNearBottom decides whether the conversation list is close enough to
 *   the bottom to justify auto-scrolling. The screen scrolls on content
 *   growth only while this holds, so an intentional scroll upward stops the
 *   follow behavior instead of fighting the user.
 * - The FlatList virtualization bounds below (TASK-103) keep long
 *   conversations usable: only a bounded slice of messages is ever mounted
 *   and rendered per batch, independent of total history length.
 */

/** How often buffered deltas are committed to component state (ms). */
export const STREAM_FLUSH_INTERVAL_MS = 50;

/**
 * TASK-103: rows rendered before the first scroll. Enough to cover the
 * visible viewport of recent history on first open, small enough that
 * opening a long conversation does not lay out its entire history.
 */
export const CHAT_LIST_INITIAL_NUM_TO_RENDER = 12;

/**
 * TASK-103: rows mounted per incremental batch as the user scrolls back
 * through history. One batch per frame keeps catch-up scrolling smooth.
 */
export const CHAT_LIST_MAX_TO_RENDER_PER_BATCH = 12;

/**
 * TASK-103: render window measured in viewport heights around the visible
 * area. The default (21) keeps roughly ten screens of content alive for a
 * chat, far more than can be visible; bounding it to 7 keeps memory and
 * reconciliation work flat while scrolling without ever revealing blank
 * space at normal scroll speeds.
 */
export const CHAT_LIST_WINDOW_SIZE = 7;

/**
 * Distance (in px) from the bottom edge within which the user still counts
 * as "reading the latest message" and auto-scroll stays active.
 */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 120;

/** Scroll geometry extracted from a NativeScrollEvent. */
export interface ScrollGeometry {
  /** contentOffset.y */
  offsetY: number;
  /** contentSize.height */
  contentHeight: number;
  /** layoutMeasurement.height */
  viewportHeight: number;
}

/**
 * Whether the viewport bottom sits within `thresholdPx` of the content end.
 * Content shorter than the viewport is always "at the bottom" because
 * everything is already visible. The threshold comparison is inclusive so
 * resting exactly at the boundary keeps following.
 */
export function isNearBottom(g: ScrollGeometry, thresholdPx: number): boolean {
  if (g.contentHeight <= g.viewportHeight) {
    return true;
  }
  return g.contentHeight - (g.offsetY + g.viewportHeight) <= thresholdPx;
}

/**
 * Accumulates streamed text and hands it to `onFlush` in consolidated
 * chunks. The first push after an idle period schedules exactly one timer;
 * later pushes during the same window join that pending chunk instead of
 * scheduling more work. Consumers either let the tick fire, call flushNow()
 * to apply immediately (e.g. before measuring layout), or discard() when the
 * turn ends so no buffered text can land after cleanup.
 */
export class DeltaBuffer {
  private chunk = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onFlush: (text: string) => void,
    private readonly intervalMs: number,
  ) {}

  /** True while a deferred flush is pending. */
  get scheduled(): boolean {
    return this.timer !== null;
  }

  /** Text accumulated but not yet flushed. */
  get buffered(): string {
    return this.chunk;
  }

  /** Add one delta; schedules the single flush tick if idle. */
  push(text: string): void {
    if (!text) {
      return;
    }
    this.chunk += text;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushNow();
      }, this.intervalMs);
    }
  }

  /** Apply everything accumulated right now, cancelling the pending tick. */
  flushNow(): void {
    this.cancelTimer();
    if (!this.chunk) {
      return;
    }
    const text = this.chunk;
    this.chunk = '';
    this.onFlush(text);
  }

  /** Drop buffered text and cancel the tick without flushing. */
  discard(): void {
    this.cancelTimer();
    this.chunk = '';
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
