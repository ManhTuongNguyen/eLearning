/**
 * Recent-message window selection for serverless conversation context (SPEC TASK-087).
 *
 * Pure TypeScript port of backend/conversations/window.py: given the full
 * prior history of a session in chronological order, selectRecentMessages
 * returns only the most recent N turns — still in chronological order —
 * ready to pass as recent_messages to the context builder.
 *
 * The current user message is deliberately NOT part of the window. It is
 * passed to the builder separately as currentMessage, so it always appears
 * last and can never be crowded out or duplicated by older turns.
 *
 * Design rules mirror backend: pure (no database access, no provider calls),
 * deterministic, and bounded by construction.
 */

import {RECENT_MESSAGE_WINDOW} from './contextConfig';
import type {LocalMessage} from '../db/types';

/**
 * Return the most recent `limit` messages in chronological order.
 *
 * `messages` is the full prior history of a session in chronological order.
 * The returned array contains at most `limit` messages taken from the tail,
 * preserving their original order verbatim.
 *
 * `limit` defaults to the configured RECENT_MESSAGE_WINDOW; explicit values
 * must be positive integers.
 */
export function selectRecentMessages(
  messages: readonly LocalMessage[],
  limit: number = RECENT_MESSAGE_WINDOW,
): readonly LocalMessage[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer (got ${limit}).`);
  }
  return messages.slice(-limit);
}
