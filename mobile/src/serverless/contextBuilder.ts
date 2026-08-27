/**
 * Application-service layer for building LLM conversation context (SPEC TASK-087).
 *
 * Pure TypeScript port of backend/conversations/context.py: assembles the
 * context for one chat turn exactly as ROADMAP section 5 prescribes:
 *
 *     system instructions + learning profile + topic + summary +
 *     recent messages + current user message
 *
 * The result is a CompletionRequest whose first message is the system prompt
 * (identity, learning level, topic and — when the session has one — the
 * rolling summary) followed by the recent history turns verbatim and the
 * current user message last.
 *
 * Design rules mirror backend context.py:
 * 1. Deterministic — identical inputs produce identical requests
 * 2. Bounded by construction — consumes only the history window handed in
 * 3. Pure — no database access and no provider calls
 */

import type {EnglishLevel} from '../api/profile';
import type {LocalMessage} from '../db/types';
import type {CompletionMessage, CompletionRequest} from './types';

const HISTORY_ROLES = new Set(['user', 'assistant']);

const IDENTITY_SECTION =
  'You are an AI English tutor chatting with a learner who practises ' +
  'conversational English with you.\n' +
  'Keep your replies natural, friendly and appropriate for the learner\'s ' +
  'level, and gently model correct English.';

const LEVEL_LINES: Record<EnglishLevel, string> = {
  A1: 'The learner\'s English level is A1 (CEFR); keep vocabulary, grammar and explanations at that level.',
  A2: 'The learner\'s English level is A2 (CEFR); keep vocabulary, grammar and explanations at that level.',
  B1: 'The learner\'s English level is B1 (CEFR); keep vocabulary, grammar and explanations at that level.',
  B2: 'The learner\'s English level is B2 (CEFR); keep vocabulary, grammar and explanations at that level.',
  C1: 'The learner\'s English level is C1 (CEFR); keep vocabulary, grammar and explanations at that level.',
  C2: 'The learner\'s English level is C2 (CEFR); keep vocabulary, grammar and explanations at that level.',
  AUTO: 'The learner\'s English level is unknown; infer an appropriate level from how they write and adjust your language accordingly.',
};

const TOPIC_TITLE_LINE = 'Conversation topic: "{title}".';
const TOPIC_SCENARIO_LINE = 'Topic scenario: {description}';

const SUMMARY_HEADER = 'Summary of the earlier conversation:';

/** Topic structure matching backend GeneratedTopic and API responses. */
export interface GeneratedTopic {
  title: string;
  description: string;
}

/** Context builder input parameters (all required except summary/recent_messages). */
export interface ContextInput {
  level: EnglishLevel;
  topic: GeneratedTopic;
  summary?: string;
  recentMessages?: readonly LocalMessage[];
  currentMessage: string;
}

/**
 * Build the LLM context CompletionRequest for one turn of a conversation.
 *
 * `recentMessages` are the turns the caller wants the model to see (already
 * windowed); they are included verbatim between the system prompt and the
 * current user message. `summary` is the rolling summary text; blank/missing
 * means "no summary yet" and omits the section entirely.
 */
export function buildContext(input: ContextInput): CompletionRequest {
  const {level, topic, currentMessage} = input;
  const summary = input.summary ?? '';
  const recentMessages = input.recentMessages ?? [];

  if (!LEVEL_LINES[level]) {
    const allowed = Object.keys(LEVEL_LINES).join(', ');
    throw new Error(
      `Unknown learning level "${level}"; expected one of: ${allowed}.`,
    );
  }

  const stripped = currentMessage.trim();
  if (!stripped) {
    throw new Error('currentMessage must not be empty.');
  }

  const systemPrompt = buildSystemPrompt(level, topic, summary);
  const messages: CompletionMessage[] = [
    {role: 'system', content: systemPrompt},
    ...historyTurns(recentMessages),
    {role: 'user', content: stripped},
  ];

  return {messages};
}

function buildSystemPrompt(
  level: EnglishLevel,
  topic: GeneratedTopic,
  summary: string,
): string {
  const blocks: string[] = [
    IDENTITY_SECTION,
    LEVEL_LINES[level],
    [
      TOPIC_TITLE_LINE.replace('{title}', topic.title),
      TOPIC_SCENARIO_LINE.replace('{description}', topic.description),
    ].join('\n'),
  ];

  if (summary.trim()) {
    blocks.push([SUMMARY_HEADER, summary].join('\n'));
  }

  return blocks.join('\n\n');
}

function historyTurns(
  recentMessages: readonly LocalMessage[],
): CompletionMessage[] {
  const turns: CompletionMessage[] = [];
  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    if (!HISTORY_ROLES.has(msg.role)) {
      const allowed = Array.from(HISTORY_ROLES)
        .sort()
        .join(', ');
      throw new Error(
        `History turn ${i} has invalid role "${msg.role}"; expected one of: ${allowed}.`,
      );
    }
    // Only include complete messages with content
    if (msg.status === 'complete' && msg.content.trim()) {
      turns.push({role: msg.role, content: msg.content});
    }
  }
  return turns;
}
