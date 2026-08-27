/**
 * Rolling conversation summary generation for serverless mode (SPEC TASK-087).
 *
 * Pure TypeScript port of backend/conversations/summarizer.py: as a
 * conversation grows, turns that fall out of the recent message window are
 * folded into a rolling summary instead of being resent to the LLM forever.
 *
 * The service consumes EXACTLY the increment it is handed — the previous
 * summary plus only the messages that just left the active window — and
 * produces the updated summary. It never receives (and never re-processes)
 * the complete conversation.
 *
 * Design rules mirror backend summarizer.py:
 * 1. Provider injection — wraps any OpenRouterClient for testability
 * 2. Input validation — bad inputs throw before any provider request
 * 3. Failure propagation — transport/provider failures propagate unchanged
 * 4. Purity — no database access; callers own persistence
 */

import type {LocalMessage} from '../db/types';
import type {CompletionRequest, OpenRouterClient} from './types';

const HISTORY_ROLES = new Set(['user', 'assistant']);

const SYSTEM_PROMPT =
  'You maintain the rolling summary of an ongoing English-learning chat ' +
  'between a learner and an AI tutor.\n' +
  'Respond with ONLY the updated summary as plain text: no headings, no ' +
  'markdown formatting, no quotation marks around the whole summary and no ' +
  'commentary.\n' +
  'Keep it concise but preserve names, preferences, corrections and any ' +
  'unfinished threads so the tutor can continue the conversation naturally.';

const PREVIOUS_SUMMARY_HEADER = 'Summary of the conversation so far:';
const ARCHIVED_MESSAGES_HEADER =
  'These messages have just left the recent window and must now be folded into the summary:';
const WRITE_INSTRUCTION =
  'Write the updated summary covering everything in the previous summary plus these messages.';

/** Summarizer input: only the increment being folded. */
export interface SummarizerInput {
  previousSummary?: string;
  archivedMessages: readonly LocalMessage[];
}

/**
 * Generate an updated rolling summary through an OpenRouter client.
 *
 * `archivedMessages` are ONLY the turns that just left the active recent
 * window, in chronological order. `previousSummary` is the existing rolling
 * summary; blank/missing means this is the first compaction. The LLM request
 * contains exactly these inputs and nothing else from the conversation.
 */
export async function generateSummary(
  client: OpenRouterClient,
  input: SummarizerInput,
): Promise<string> {
  const previousSummary = (input.previousSummary ?? '').trim();
  const messages = validateArchivedMessages(input.archivedMessages);

  const request: CompletionRequest = {
    messages: [
      {role: 'system', content: SYSTEM_PROMPT},
      {role: 'user', content: buildUserPrompt(previousSummary, messages)},
    ],
  };

  const response = await client.complete(request);
  return parseSummary(response.text);
}

function validateArchivedMessages(
  messages: readonly LocalMessage[],
): readonly LocalMessage[] {
  if (!messages.length) {
    throw new Error(
      'archivedMessages must not be empty; summarization runs only when ' +
        'messages actually leave the recent window.',
    );
  }

  const allowed = Array.from(HISTORY_ROLES)
    .sort()
    .join(', ');
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!HISTORY_ROLES.has(msg.role)) {
      throw new Error(
        `Archived message ${i} has invalid role "${msg.role}"; expected one of: ${allowed}.`,
      );
    }
    if (!msg.content.trim()) {
      throw new Error(`Archived message ${i} content must not be empty.`);
    }
  }

  return messages;
}

function buildUserPrompt(
  previousSummary: string,
  messages: readonly LocalMessage[],
): string {
  const parts: string[] = [];

  if (previousSummary) {
    parts.push(PREVIOUS_SUMMARY_HEADER, previousSummary);
  }

  parts.push(ARCHIVED_MESSAGES_HEADER);
  for (const msg of messages) {
    parts.push(`${msg.role}: ${msg.content}`);
  }

  parts.push(WRITE_INSTRUCTION);
  return parts.join('\n');
}

function parseSummary(text: string): string {
  const stripped = stripCodeFence(text.trim());
  if (!stripped) {
    throw new Error('Summary response was empty.');
  }
  return stripped;
}

/**
 * Remove one surrounding ``` fence (with optional language tag).
 * Tolerates the completion being wrapped in a code fence (a common model
 * habit even when asked for plain text).
 */
function stripCodeFence(text: string): string {
  if (!text.startsWith('```')) {
    return text;
  }

  const withoutOpen = text.slice(3);
  const newlineIndex = withoutOpen.indexOf('\n');
  if (newlineIndex === -1) {
    return withoutOpen;
  }

  let body = withoutOpen.slice(newlineIndex + 1);
  const closingIndex = body.lastIndexOf('```');
  if (closingIndex !== -1 && !body.slice(closingIndex + 3).trim()) {
    body = body.slice(0, closingIndex);
  }

  return body.trimEnd();
}
