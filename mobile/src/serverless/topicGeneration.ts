/**
 * Serverless topic generation over direct OpenRouter (SPEC TASK-085).
 *
 * Mirrors the backend application service in conversations/topics.py so both
 * modes behave identically: the learning level and an optional user hint are
 * turned into one strict-JSON completion request, the response is parsed into
 * a structured topic (tolerating code fences and surrounding prose), and only
 * after a valid parse is anything persisted. All LLM work precedes the single
 * local write, mirroring the server view — a failed generation never leaves a
 * half-filled session behind.
 *
 * Malformed completions become `OpenRouterResponseError` (the mobile analogue
 * of the backend's `LLMResponseError` attributed to the "topics" provider),
 * while transport/provider failures propagate unchanged from the client.
 */
import type {EnglishLevel} from '../api/profile';
import {LocalConversationRepository} from '../db/conversationRepository';
import type {SqlDriver} from '../db/driver';
import {getLearningProfile} from '../db/profileStore';
import type {LocalSession} from '../db/types';
import {OpenRouterResponseError} from './errors';
import type {CompletionRequest, CompletionResult} from './types';

/** System instruction demanding strict JSON topic output; mirrors topics.py. */
export const TOPIC_SYSTEM_PROMPT =
  'You create conversation topics for an English-learning chat application ' +
  'where a learner practises English with an AI tutor.\n' +
  'Respond with ONLY one JSON object and nothing else, using exactly this shape:\n' +
  '{"title": "<short engaging topic name>", ' +
  '"description": "<two or three sentences describing the scenario and what ' +
  'the learner should practise>"}';

/** Structured result of one topic generation (mirrors GeneratedTopic). */
export interface GeneratedTopic {
  /** Short display name, also used as the session title. */
  title: string;
  /** Scenario detail sufficient for the AI tutor to run the conversation. */
  description: string;
}

/** Narrow seam over the client so tests can inject completions directly. */
export type CompleteFn = (request: CompletionRequest) => Promise<CompletionResult>;

/** Compose the user-turn instruction from level and hint; mirrors _build_user_prompt. */
export function buildTopicUserPrompt(level: EnglishLevel, hint: string): string {
  const parts = [
    'Create a conversation topic for a new English-learning chat session.',
  ];
  if (level === 'AUTO') {
    parts.push(
      "The learner's English level is unknown; infer an appropriate level " +
        'for the topic you choose.',
    );
  } else {
    parts.push(
      `The learner's English level is ${level} (CEFR); keep vocabulary and ` +
        'grammar at that level.',
    );
  }
  if (hint) {
    parts.push(`Topic idea from the learner: "${hint}". Build the topic around this idea.`);
  } else {
    parts.push('The learner gave no preference; choose an engaging everyday topic.');
  }
  return parts.join('\n');
}

/**
 * Decode one completion into a GeneratedTopic. Tolerates JSON wrapped in
 * code fences or surrounding prose (the outermost brace span is retried
 * once), but rejects every other deviation with OpenRouterResponseError.
 */
export function parseTopic(text: string, model: string | null = null): GeneratedTopic {
  const payload = extractJsonObject(text);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new OpenRouterResponseError('Topic response was not a JSON object.', model);
  }
  const record = payload as Record<string, unknown>;
  const title = record.title;
  if (typeof title !== 'string' || !title.trim()) {
    throw new OpenRouterResponseError(
      "Topic response is missing a non-empty 'title' string.",
      model,
    );
  }
  const description = record.description;
  if (typeof description !== 'string' || !description.trim()) {
    throw new OpenRouterResponseError(
      "Topic response is missing a non-empty 'description' string.",
      model,
    );
  }
  return {title: title.trim(), description: description.trim()};
}

/** Run one topic completion through `complete` and return the parsed topic. */
export async function generateTopic(
  complete: CompleteFn,
  level: EnglishLevel,
  hint = '',
): Promise<GeneratedTopic> {
  const trimmedHint = hint.trim();
  const request: CompletionRequest = {
    messages: [
      {role: 'system', content: TOPIC_SYSTEM_PROMPT},
      {role: 'user', content: buildTopicUserPrompt(level, trimmedHint)},
    ],
  };
  const result = await complete(request);
  return parseTopic(result.text, result.model);
}

/**
 * Generate a topic through direct OpenRouter and persist it as a local
 * session: `title` carries the topic name, `topic` the scenario description,
 * the hint is stored verbatim, and the level comes from the on-device
 * learning profile. Resolves the created session row.
 */
export async function createServerlessSession(
  db: SqlDriver,
  complete: CompleteFn,
  hint = '',
): Promise<LocalSession> {
  const trimmedHint = hint.trim();
  const profile = await getLearningProfile(db);
  const topic = await generateTopic(complete, profile.level, trimmedHint);
  const repository = new LocalConversationRepository(async () => db);
  return repository.createSession({
    title: topic.title,
    topic: topic.description,
    topic_hint: trimmedHint,
    learning_level: profile.level,
  });
}

/** Parse text as JSON, falling back to its outermost brace span; mirrors _extract_json_object. */
function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    // Fall through to the brace-span recovery below.
  }
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
