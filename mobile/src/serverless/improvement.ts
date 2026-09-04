/**
 * Serverless "Improve my English" correction (SPEC TASK-089).
 *
 * Pure TypeScript port of backend/conversations/improvement.py: improves one
 * learner-written user message on explicit request (ROADMAP §8) — the
 * corrected sentence plus a short level-appropriate explanation of what
 * changed. This service calls the configured provider directly with the
 * user's own API key (no backend involved, ROADMAP Rule 9).
 *
 * With a known level the model must also EXTEND the message: rewrite the
 * correction as a fuller, natural version that guides the learner to say
 * more, pitched one CEFR sub-level above their own (A2 → about B1; C2 caps
 * at C2) — the classic "slightly above their level" stretch. AUTO stays
 * correction-only.
 *
 * Design mirrors backend improvement.py:
 * 1. Prompt construction — the learner's English level shapes how the
 *    explanation is written; `AUTO` lets the model infer an appropriate
 *    level. The message under correction is quoted verbatim.
 * 2. Structured-output parsing — completions must decode into the
 *    `improved` / `explanation` / `severity` fields; anything else is a
 *    contract violation. The model is never asked to echo the original
 *    text: `original` is composed from the caller's input so the learner
 *    always sees exactly what they wrote. `severity` classifies how wrong
 *    the original was — `none` (already correct), `minor` (small slips) or
 *    `critical` (meaning-breaking mistakes) — so the app can badge the
 *    message without a second provider call.
 * 3. Failure normalization — transport/provider failures propagate as
 *    provider error subclasses (callers decide on retries); malformed
 *    completions throw OpenRouterResponseError.
 * 4. Purity — improvements are in-memory display data returned to the
 *    caller; nothing persists and no correction is ever written back over
 *    the stored chat message.
 */

import type {EnglishLevel} from '../api/profile';
import type {ImprovementSeverity} from '../api/sessions';
import type {OpenRouterClient} from './types';
import {OpenRouterResponseError} from './errors';

const SYSTEM_PROMPT =
  'You improve English messages written by a learner in an English-learning ' +
  'chat application.\n' +
  'Respond with ONLY one JSON object and nothing else, using exactly this shape:\n' +
  '{"improved": "<the improved message>", "explanation": "<short reason for the changes>", ' +
  '"severity": "<none|minor|critical>"}\n' +
  'Always fix grammar, spelling, word choice and natural phrasing while ' +
  "keeping the learner's meaning and tone. When the learner's level is " +
  'known, go beyond correcting: extend the message into a fuller, more ' +
  'engaging version that guides the learner to say more — build on their ' +
  'ideas, add a natural follow-up element such as a reason, example, ' +
  'opinion or question, and use richer vocabulary and grammar pitched ' +
  'slightly above their level (roughly one CEFR sub-level up, e.g. an A2 ' +
  'learner receives about B1) so the improvement is a small, reachable ' +
  'stretch rather than a leap. When the learner\'s level is unknown, keep ' +
  'the message at its own level: only correct it. If the message is ' +
  'already correct, still return it as "improved" (extended when the level ' +
  'is known, unchanged otherwise), say so briefly and use severity "none". ' +
  'Rate severity by how much the mistakes hurt understanding: "none" for ' +
  'a correct message, "minor" for small slips a reader easily overlooks (typos, a ' +
  'missing article), "critical" for mistakes that break or materially distort ' +
  'the meaning (wrong verb tense changing when something happened, wrong ' +
  'negation, wrong key vocabulary). Keep the explanation to one or two short ' +
  'sentences.';

const USER_PROMPT_HEADER =
  'Improve this English message that the learner wrote in an ongoing ' +
  'English-learning chat session.';
const MESSAGE_INSTRUCTION = 'The learner\'s message: "{message}"';

/**
 * CEFR ladder used to pitch the extended message one sub-level above the
 * learner's own level (an A2 learner receives about B1); mirrors the backend
 * ladder in conversations/improvement.py.
 */
const CEFR_LADDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

/** One CEFR sub-level above `level`, capped at the top of the scale. */
function targetLevel(level: EnglishLevel): EnglishLevel {
  const index = (CEFR_LADDER as readonly string[]).indexOf(level);
  return CEFR_LADDER[Math.min(index + 1, CEFR_LADDER.length - 1)];
}

const SEVERITY_VALUES: readonly ImprovementSeverity[] = ['none', 'minor', 'critical'];

/** Structured result of one improvement request (pure display data). */
export interface Improvement {
  /** The learner's message exactly as supplied, whitespace-trimmed only. */
  original: string;
  /** The corrected version of the message. */
  improved: string;
  /** Short description of the important corrections at the learner's level. */
  explanation: string;
  /** How wrong the original was: `none` | `minor` | `critical`. */
  severity: ImprovementSeverity;
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
  const {improved, explanation, severity} = parseCorrection(response.text);
  return {original: message, improved, explanation, severity};
}

function buildUserPrompt(level: EnglishLevel, message: string): string {
  const parts: string[] = [USER_PROMPT_HEADER];

  if (level === 'AUTO') {
    parts.push(
      "The learner's English level is unknown; infer an appropriate level " +
        'for the explanation. Correct the message only — do not extend or ' +
        'rewrite it beyond the corrections.',
    );
  } else {
    parts.push(
      `The learner's English level is ${level} (CEFR); write the ` +
        'explanation so a learner at that level understands it.',
    );
    const target = targetLevel(level);
    if (target !== level) {
      parts.push(
        'Extend the message as well: after correcting it, rewrite it ' +
          'as a fuller, natural version that guides the learner to say ' +
          'more — add a relevant detail, reason, example, opinion or ' +
          'follow-up question instead of keeping a simple sentence, ' +
          'while keeping their original point intact.',
      );
      parts.push(
        `Pitch the extended message slightly above the learner's ` +
          `level: write it around ${target} rather than ${level}.`,
      );
    } else {
      parts.push(
        `The learner is already at the top of the CEFR scale (${level}); ` +
          'extend the message in natural, idiomatic English at that level.',
      );
    }
  }

  parts.push(MESSAGE_INSTRUCTION.replace('{message}', message));

  return parts.join('\n');
}

function parseCorrection(text: string): {
  improved: string;
  explanation: string;
  severity: ImprovementSeverity;
} {
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

  const rawSeverity = record.severity;
  // Case-insensitive: models routinely answer "None"/"Minor"/"Critical";
  // only genuinely unknown values stay contract violations.
  const severity = typeof rawSeverity === 'string' ? rawSeverity.trim().toLowerCase() : rawSeverity;
  if (
    typeof severity !== 'string' ||
    !SEVERITY_VALUES.includes(severity as ImprovementSeverity)
  ) {
    throw new OpenRouterResponseError(
      `Improvement response is missing a valid 'severity' (${SEVERITY_VALUES.join('|')}).`,
      null,
    );
  }

  return {
    improved: fields.improved!,
    explanation: fields.explanation!,
    severity: severity as ImprovementSeverity,
  };
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
