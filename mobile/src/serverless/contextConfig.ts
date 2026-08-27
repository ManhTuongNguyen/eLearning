/**
 * Conversation context configuration for serverless mode (SPEC TASK-087).
 *
 * Mirrors the backend CONTEXT_* settings (settings.py lines 242-251) so both
 * modes apply the same rolling-summary architecture: the recent window keeps
 * the last N messages sent to the model, and summarization triggers only when
 * enough unsummarized messages have accumulated beyond that window.
 *
 * Default values match the backend's configured thresholds exactly.
 */

/**
 * How many recent messages are sent to the model with each chat turn.
 * Older messages leave the window and belong to the rolling summary instead.
 */
export const RECENT_MESSAGE_WINDOW = 20;

/**
 * Rolling summaries refresh only after this many unsummarized messages have
 * accumulated beyond the recent window. Batched — never per message.
 */
export const SUMMARY_TRIGGER_THRESHOLD = 40;

/**
 * Short conversations (fewer than window + threshold messages) never trigger
 * summarization. With defaults: 20 + 40 = 60 messages minimum before first
 * summary.
 */
export const MIN_MESSAGES_FOR_SUMMARY = RECENT_MESSAGE_WINDOW + SUMMARY_TRIGGER_THRESHOLD;
