/**
 * Serverless suggested-reply generation (SPEC TASK-088).
 *
 * Pure TypeScript port of backend/conversations/suggestions.py: generates
 * exactly three candidate replies the learner could send next, based on the
 * selected chat message, the conversation up to that message, the session
 * topic and the learner's English level. This service calls OpenRouter
 * directly with the user's own API key (no backend involved).
 *
 * Design mirrors backend suggestions.py:
 * 1. Prompt construction — topic, level, transcript up to the selected
 *    message, and an instruction to write three distinct replies
 * 2. Structured-output parsing — completions must decode into exactly three
 *    non-blank, mutually distinct replies
 * 3. Failure normalization — transport/provider failures propagate as
 *    OpenRouterError subclasses; malformed completions throw parse errors
 * 4. Purity — suggestions are in-memory display data; nothing persists
 */

import type {EnglishLevel} from '../api/profile';
import type {LocalMessage} from '../db/types';
import type {GeneratedTopic} from './contextBuilder';
import type {OpenRouterClient} from './types';
import {OpenRouterResponseError} from './errors';

export const SUGGESTION_COUNT = 3;

const SYSTEM_PROMPT =
  'You suggest possible next replies for a learner in an English-learning ' +
  'chat where they practise conversational English with an AI tutor.\n' +
  'Respond with ONLY one JSON object and nothing else, using exactly this ' +
  'shape:\n{"replies": ["<first reply>", "<second reply>", "<third reply>"]}\n' +
  'The replies list must contain exactly three items: short natural messages ' +
  'the learner could send next, written at their English level, relevant to ' +
  'the topic and conversation so far, and meaningfully different from each ' +
  'other.';

const SPEAKER_LABELS: Record<string, string> = {
  user: 'Learner',
  assistant: 'Tutor',
};

const TRANSCRIPT_HEADER = 'Conversation so far:';
const EMPTY_TRANSCRIPT_LINE =
  'The conversation has just started; there are no earlier messages.';
const SELECTED_MESSAGE_INSTRUCTION =
  'The learner long-pressed this message: "{selected}"\n' +
  'Write exactly three replies that the learner could send next.';

/** Exactly three candidate replies the learner could send next. */
export interface Suggestions {
  replies: readonly string[];
}

/** Input parameters for suggestion generation. */
export interface SuggestInput {
  level: EnglishLevel;
  topic: GeneratedTopic;
  selectedMessage: string;
  /** Messages BEFORE the selected message, chronological order. */
  history?: readonly LocalMessage[];
}

/**
 * Generate three suggested replies for the selected message.
 *
 * `history` contains only the turns before the selected message, in
 * chronological order; it may be empty when the selected message opens
 * the conversation.
 */
export async function generateSuggestions(
  client: OpenRouterClient,
  input: SuggestInput,
): Promise<Suggestions> {
  const {level, topic, selectedMessage, history = []} = input;

  const stripped = selectedMessage.trim();
  if (!stripped) {
    throw new Error('selectedMessage must be a non-empty string.');
  }

  const userPrompt = buildUserPrompt(level, topic, history, stripped);
  const request = {
    messages: [
      {role: 'system' as const, content: SYSTEM_PROMPT},
      {role: 'user' as const, content: userPrompt},
    ],
  };

  const response = await client.complete(request);
  return parseSuggestions(response.text);
}

function buildUserPrompt(
  level: EnglishLevel,
  topic: GeneratedTopic,
  history: readonly LocalMessage[],
  selectedMessage: string,
): string {
  const parts: string[] = [
    'Suggest possible next replies for the learner in an ongoing ' +
      'English-learning chat session.',
  ];

  if (level === 'AUTO') {
    parts.push(
      "The learner's English level is unknown; keep the replies broadly accessible.",
    );
  } else {
    parts.push(
      `The learner's English level is ${level} (CEFR); keep vocabulary ` +
        'and grammar at that level.',
    );
  }

  parts.push(`Topic title: "${topic.title}".`);
  parts.push(`Topic scenario: ${topic.description}`);
  parts.push(TRANSCRIPT_HEADER);

  // Include only complete messages with content
  const completeHistory = history.filter(
    msg => msg.status === 'complete' && msg.content.trim(),
  );

  if (completeHistory.length > 0) {
    for (const msg of completeHistory) {
      const label = SPEAKER_LABELS[msg.role] ?? msg.role;
      parts.push(`${label}: ${msg.content}`);
    }
  } else {
    parts.push(EMPTY_TRANSCRIPT_LINE);
  }

  parts.push(SELECTED_MESSAGE_INSTRUCTION.replace('{selected}', selectedMessage));

  return parts.join('\n');
}

function parseSuggestions(text: string): Suggestions {
  const payload = extractJsonObject(text);

  if (typeof payload !== 'object' || payload === null) {
    throw new OpenRouterResponseError(
      'Suggestions response was not a JSON object.',
      null,
    );
  }

  const rawReplies = (payload as Record<string, unknown>).replies;
  if (!Array.isArray(rawReplies)) {
    throw new OpenRouterResponseError(
      "Suggestions response is missing a 'replies' list.",
      null,
    );
  }

  if (rawReplies.length !== SUGGESTION_COUNT) {
    throw new OpenRouterResponseError(
      `Suggestions response must contain exactly ${SUGGESTION_COUNT} ` +
        `replies; got ${rawReplies.length}.`,
      null,
    );
  }

  const replies: string[] = [];
  for (let i = 0; i < rawReplies.length; i++) {
    const entry = rawReplies[i];
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new OpenRouterResponseError(
        `Suggestion ${i} is missing a non-empty string.`,
        null,
      );
    }
    replies.push(entry.trim());
  }

  // Check for near-duplicates (case-insensitive)
  const lowered = new Set(replies.map(r => r.toLowerCase()));
  if (lowered.size !== SUGGESTION_COUNT) {
    throw new OpenRouterResponseError(
      'Suggestions must be meaningfully different from each other.',
      null,
    );
  }

  return {replies};
}

function extractJsonObject(text: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(text.trim());
  } catch {
    // Fallback: extract outermost brace span
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
