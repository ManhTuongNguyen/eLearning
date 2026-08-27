/**
 * Serverless "Improve my English" correction (SPEC TASK-089).
 *
 * Pure TypeScript port of backend/conversations/improvement.py: improves one
 * learner-written user message on explicit request (ROADMAP §8) — the
 * corrected sentence plus a short level-appropriate explanation of what
 * changed. This service calls OpenRouter directly with the user's own API
 * key (no backend involved, ROADMAP Rule 9).
 *
 * Design mirrors backend improvement.py:
 * 1. Prompt construction — the learner's English level shapes how the
 *    explanation is written; `AUTO` lets the model infer an appropriate
 *    level. The message under correction is quoted verbatim.
 * 2. Structured-output parsing — completions must decode into the
 *    `improved` / `explanation` fields; anything else is a contract
 *    violation. The model is never asked to echo the original text:
 *    `original` is composed from the caller's input so the learner always
 *    sees exactly what they wrote.
 * 3. Failure normalization — transport/provider failures propagate as
 *    OpenRouterError subclasses (callers decide on retries); malformed
 *    completions throw OpenRouterResponseError.
 * 4. Purity — improvements are in-memory display data returned to the
 *    caller; nothing persists and no correction is ever written back over
 *    the stored chat message.
 */

import type {EnglishLevel} from '../api/profile';
import type {OpenRouterClient} from './types';
import {OpenRouterResponseError} from './errors';

const SYSTEM_PROMPT =
  'You correct English messages written by a learner in an English-learning ' +
  'chat application.\n' +
  'Respond with ONLY one JSON object and nothing else, using exactly this shape:\n' +
  '{"improved": "<the corrected message>", "explanation": "<short reason for the changes>"}\n' +
  'Fix grammar, spelling, word choice and natural phrasing while keeping the ' +
  "learner's meaning and tone. If the message is already correct, return it " +
  'unchanged as "improved" and say so briefly. Keep the explanation to one ' +
  'or two short sentences.';

const USER_PROMPT_HEADER =
  'Improve this English message that the learner wrote in an ongoing ' +
  'English-learning chat session.';
const MESSAGE_INSTRUCTION = 'The learner\'s message: "{message}"';

/** Structured result of one improvement request (pure display data). */
export interface Improvement {
  /** The learner's message exactly as supplied, whitespace-trimmed only. */
  original: string;
  /** The corrected version of the message. */
  improved: string;
  /** Short description of the important corrections at the learner's level. */
  explanation: string;
}

/** Input parameters for one improvement request. */
export interface ImprovementInput {
  level: EnglishLevel;
  /** The user-authored text to correct; echoed back trimmed as `original`. */
  originalMessage: string;
}

const LEVELS: readonly EnglishLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'AUTO'];

/**
 * Improve one learner message through direct OpenRouter completion.
 */
export async function generateImprovement(
  client: OpenRouterClient,
  input: ImprovementInput,
): Promise<Improvement> {
  const {level, originalMessage} = input;

  if (!LEVELS.includes(level)) {
    throw new Error(
      `Unknown learning level "${level}"; expected one of: ${LEVELS.join(', ')}.`,
    );
  }

  const message = originalMessage.trim();
  if (!message) {
    throw new Error('originalMessage must be a non-empty string.');
  }

  const request = {
    messages: [
      {role: 'system' as const, content: SYSTEM_PROMPT},
      {role: 'user' as const, content: buildUserPrompt(level, message)},
    ],
  };

  const response = await client.complete(request);
  const {improved, explanation} = parseCorrection(response.text);
  return {original: message, improved, explanation};
}

function buildUserPrompt(level: EnglishLevel, message: string): string {
  const parts: string[] = [USER_PROMPT_HEADER];

  if (level === 'AUTO') {
    parts.push(
      "The learner's English level is unknown; infer an appropriate level " +
        'for the explanation.',
    );
  } else {
    parts.push(
      `The learner's English level is ${level} (CEFR); write the ` +
        'explanation so a learner at that level understands it.',
    );
  }

  parts.push(MESSAGE_INSTRUCTION.replace('{message}', message));

  return parts.join('\n');
}

function parseCorrection(text: string): {improved: string; explanation: string} {
  const payload = extractJsonObject(text);

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new OpenRouterResponseError(
      'Improvement response was not a JSON object.',
      null,
    );
  }

  const record = payload as Record<string, unknown>;
  const fields: Partial<{improved: string; explanation: string}> = {};
  for (const fieldName of ['improved', 'explanation'] as const) {
    const value = record[fieldName];
    if (typeof value !== 'string' || !value.trim()) {
      throw new OpenRouterResponseError(
        `Improvement response is missing a non-empty '${fieldName}' string.`,
        null,
      );
    }
    fields[fieldName] = value.trim();
  }

  return {improved: fields.improved!, explanation: fields.explanation!};
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
