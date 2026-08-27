/**
 * Serverless conversation context assembly and summary management (SPEC TASK-087).
 *
 * Orchestrates the complete rolling-context strategy for serverless mode:
 * builds LLM requests from system prompt + profile + topic + summary + recent
 * messages + current message, and applies the same summary-trigger logic as
 * the backend so local conversations follow identical compaction cadences.
 *
 * The exported `buildServerlessContext` function is the TurnRequestBuilder
 * seam expected by chatStreaming.ts: it assembles one turn's CompletionRequest
 * from a PreparedTurn (which already contains the committed session, user
 * message, and pending assistant slot). The builder is pure — it reads
 * existing session state but never writes; summarization happens separately.
 *
 * `updateSummaryIfNeeded` checks whether the threshold is crossed and, when
 * it is, generates the updated summary through the client and persists it
 * atomically via the repository. This function is meant to be called AFTER
 * a completed turn, never blocking the user-facing chat request.
 */

import type {LocalConversationRepository} from '../db/conversationRepository';
import type {LocalMessage} from '../db/types';
import {getSummary} from '../db/summaryStore';
import {getLocalDatabase} from '../db/database';
import type {PreparedTurn} from './chatStreaming';
import {buildContext} from './contextBuilder';
import type {CompletionRequest, OpenRouterClient} from './types';
import {selectRecentMessages} from './windowSelector';
import {archiveRange} from './summaryTrigger';
import {generateSummary} from './summarizer';

/**
 * Build the LLM context for one serverless chat turn (the TurnRequestBuilder
 * seam consumed by streamServerlessTurn and retryServerlessTurn).
 *
 * Reads the session's existing summary (if any), selects the recent message
 * window, and assembles the full context exactly as the backend does. Pure
 * operation — no writes, no provider calls, only deterministic assembly.
 */
export async function buildServerlessContext(
  turn: PreparedTurn,
): Promise<CompletionRequest> {
  const db = await getLocalDatabase();
  const summary = await getSummary(db, turn.session.id);
  const allMessages = await db.execute(
    'SELECT id, session_id, role, status, content, sequence, created_at ' +
      'FROM messages WHERE session_id = ? ORDER BY sequence ASC',
    [turn.session.id],
  );

  const messages: LocalMessage[] = allMessages.rows.map(row => ({
    id: Number(row.id),
    session_id: Number(row.session_id),
    role: String(row.role) as 'user' | 'assistant',
    status: String(row.status) as 'pending' | 'complete' | 'failed',
    content: String(row.content ?? ''),
    sequence: Number(row.sequence),
    created_at: String(row.created_at ?? ''),
  }));

  // Select only the recent window (excludes the current user message which
  // is already in turn.userMessage and passed separately to buildContext)
  const recentMessages = selectRecentMessages(messages);

  return buildContext({
    level: turn.session.learning_level,
    topic: {
      title: extractTopicTitle(turn.session.topic),
      description: turn.session.topic,
    },
    summary: summary?.content,
    recentMessages,
    currentMessage: turn.userMessage.content,
  });
}

/**
 * Check whether the session has crossed the summary threshold and, if so,
 * generate and persist the updated rolling summary. Returns true when the
 * summary boundary advanced, false when the threshold is not yet crossed.
 *
 * This is a post-turn maintenance operation: it runs AFTER a completed chat
 * turn and must not block the user-facing request. Failures are logged but
 * do not prevent the conversation from continuing — the next turn will retry
 * the same range.
 */
export async function updateSummaryIfNeeded(
  repository: LocalConversationRepository,
  client: OpenRouterClient,
  sessionId: number,
): Promise<boolean> {
  const db = await getLocalDatabase();
  const session = await repository.readSession(sessionId);
  if (!session) {
    return false;
  }

  const messages = await repository.listMessages(sessionId);
  const existingSummary = await getSummary(db, sessionId);
  const boundary = existingSummary?.message_boundary ?? 0;

  const range = archiveRange(messages.length, boundary);
  if (!range) {
    return false;
  }

  // Select only complete, non-blank messages in the archive range
  const archived = messages
    .filter(
      msg =>
        msg.sequence >= range.start &&
        msg.sequence <= range.end &&
        msg.status === 'complete' &&
        msg.content.trim(),
    );

  if (!archived.length) {
    // No content to summarize; advance boundary without LLM call
    await repository.saveSummary({
      session_id: sessionId,
      content: existingSummary?.content ?? '',
      message_boundary: range.end,
    });
    return true;
  }

  const updatedSummary = await generateSummary(client, {
    previousSummary: existingSummary?.content,
    archivedMessages: archived,
  });

  await repository.saveSummary({
    session_id: sessionId,
    content: updatedSummary,
    message_boundary: range.end,
  });

  return true;
}

/**
 * Extract the topic title from the full topic string. Topics are stored as
 * "{title}: {description}" in local sessions (matching backend topic format).
 * Falls back to the full topic string if no colon separator is found.
 */
function extractTopicTitle(topic: string): string {
  const colonIndex = topic.indexOf(':');
  if (colonIndex === -1) {
    return topic;
  }
  return topic.slice(0, colonIndex).trim();
}
