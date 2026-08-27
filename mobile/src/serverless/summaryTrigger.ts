/**
 * Summary-trigger decision logic for serverless mode (SPEC TASK-087).
 *
 * Pure TypeScript port of backend/conversations/trigger.py: decides WHEN to
 * summarize using the same integer math so local and server conversations
 * follow identical compaction cadences. The rule: with W recent messages in
 * the window and B messages already covered by the rolling summary, the
 * pending count is (total - W) - B; summarization fires only when that count
 * reaches the configured threshold.
 *
 * Consequences (matching backend behavior):
 * - Short conversations never trigger (< window + threshold messages)
 * - After compaction the pending count resets to zero
 * - Each compaction advances the boundary by at least one threshold batch
 *
 * All functions are deterministic, boundary-checked integer operations.
 */

import {RECENT_MESSAGE_WINDOW, SUMMARY_TRIGGER_THRESHOLD} from './contextConfig';

/** Inclusive [start, end] sequence range to summarize, or null when threshold not crossed. */
export interface ArchiveRange {
  start: number;
  end: number;
}

/**
 * Return the sequence range to summarize, or null when threshold not crossed.
 *
 * `totalMessages` is the count of messages in the session; `boundary` is the
 * persisted message_boundary (messages with sequence <= boundary are already
 * covered by the rolling summary). The last `window` messages stay in the
 * recent window; summarization fires only when at least `threshold` further
 * messages have left it since the boundary.
 *
 * Explicit window/threshold must be positive integers; defaults resolve the
 * configured values from contextConfig.
 */
export function archiveRange(
  totalMessages: number,
  boundary: number,
  options?: {window?: number; threshold?: number},
): ArchiveRange | null {
  const window = options?.window ?? RECENT_MESSAGE_WINDOW;
  const threshold = options?.threshold ?? SUMMARY_TRIGGER_THRESHOLD;

  validateCount(totalMessages, 'totalMessages');
  validateCount(boundary, 'boundary');
  validatePositive(window, 'window');
  validatePositive(threshold, 'threshold');

  if (boundary > totalMessages) {
    throw new Error(
      `boundary (${boundary}) cannot exceed totalMessages (${totalMessages}).`,
    );
  }

  const end = totalMessages - window;
  if (end - boundary < threshold) {
    return null;
  }

  return {start: boundary + 1, end};
}

function validateCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer (got ${value}).`);
  }
}

function validatePositive(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer (got ${value}).`);
  }
}
