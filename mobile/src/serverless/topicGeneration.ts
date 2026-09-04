/**
 * Serverless topic + example-conversation generation (SPEC TASK-085/093).
 *
 * Server mode issues two LLM requests per session (topic, then sample —
 * conversations/views.py). Serverless instead runs ONE combined completion
 * against the user's own provider key: the learning level and an optional
 * hint are turned into a single strict-JSON request whose response carries
 * both the topic and a short example dialogue for it. One request keeps the
 * latency and token cost of session creation at half of the two-request
 * shape while still producing everything the server flow shows.
 *
 * The combined prompt is built carefully so both artifacts come back in one
 * parseable object: the topic is validated strictly (a session without a
 * usable topic is worthless, so its failure aborts creation and nothing is
 * persisted), while the sample is display-only and degrades — any malformed
 * or missing `sample_conversation` section is skipped and answered as a
 * blank `{"turns": []}`, mirroring the backend view's guard for unusable
 * sample output. Transport/provider failures always propagate unchanged.
 */
import type {EnglishLevel} from '../api/profile';
import {LocalConversationRepository} from '../db/conversationRepository';
import type {SqlDriver} from '../db/driver';
import {getLearningProfile} from '../db/profileStore';
import type {LocalSession} from '../db/types';
import {OpenRouterResponseError} from './errors';
import type {CompletionRequest, CompletionResult} from './types';

/**
 * System instruction demanding one strict JSON object holding BOTH the
 * topic and its example dialogue. The shape is stated verbatim, the roles
 * and turn count are constrained, and the example is tied to the created
 * topic so one completion yields a coherent pair.
 */
export const TOPIC_AND_SAMPLE_SYSTEM_PROMPT =
  'You create conversation topics and short example conversations for an ' +
  'English-learning chat application where a learner practises English ' +
  'with an AI tutor.\n' +
  'Respond with ONLY one JSON object and nothing else, using exactly this shape:\n' +
  '{"topic": {"title": "<short engaging topic name>", "description": "<two or ' +
  'three sentences describing the scenario and what the learner should ' +
  'practise>"}, "sample_conversation": {"turns": [{"role": "assistant", ' +
  '"content": "<what the tutor says>"}, {"role": "user", "content": "<what ' +
  'the learner replies>"}]}}\n' +
  'In sample_conversation use only the roles "assistant" and "user". Write 4 ' +
  'to 6 turns in total, alternating between them and starting with ' +
  '"assistant". The example conversation must demonstrate the topic you ' +
  'created, using vocabulary and grammar appropriate for it.';

/** Sample turn roles mirror the chat message roles. */
export const SAMPLE_ROLES = ['assistant', 'user'] as const;

/** A sample conversation needs at least this many turns; mirrors MIN_SAMPLE_TURNS. */
export const MIN_SAMPLE_TURNS = 2;

/** Structured result of one topic generation (mirrors backend GeneratedTopic). */
export interface GeneratedTopic {
  /** Short display name, also used as the session title. */
  title: string;
  /** Scenario detail sufficient for the AI tutor to run the conversation. */
  description: string;
}

/** One dialogue line of a generated sample conversation (backend SampleTurn). */
export interface SampleTurn {
  role: (typeof SAMPLE_ROLES)[number];
  content: string;
}

/** A short example dialogue for one generated topic; display data only. */
export interface SampleConversation {
  turns: SampleTurn[];
}

/** Both artifacts of one combined session-creation completion. */
export interface TopicWithSample {
  topic: GeneratedTopic;
  sampleTurns: SampleTurn[];
}

/** Narrow seam over the client so tests can inject completions directly. */
export type CompleteFn = (request: CompletionRequest) => Promise<CompletionResult>;

/**
 * Compose the single user-turn instruction from level and hint. The level
 * clause governs BOTH artifacts (the topic difficulty and the example's
 * vocabulary/grammar), mirroring the backend's two prompts merged into one.
 */
export function buildTopicAndSampleUserPrompt(level: EnglishLevel, hint: string): string {
  const parts = [
    'Create a conversation topic for a new English-learning chat session, ' +
      'then write an example conversation that demonstrates it.',
  ];
  if (level === 'AUTO') {
    parts.push(
      "The learner's English level is unknown; infer an appropriate level " +
        'for the topic you choose.',
    );
  } else {
    parts.push(
      `The learner's English level is ${level} (CEFR); keep vocabulary and ` +
        'grammar at that level in the topic and the example.',
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
 * Decode one combined completion into its topic and example turns. Tolerates
 * JSON wrapped in code fences or surrounding prose and ignores extra keys.
 * The `topic` member is required and validated strictly — deviations throw
 * OpenRouterResponseError and the caller aborts creation. The
 * `sample_conversation` member is display-only: any deviation from the
 * expected shape (missing, not an object, too few turns, bad roles, blank
 * content) is skipped and returned as an empty turn list.
 */
export function parseTopicWithSample(text: string, model: string | null = null): TopicWithSample {
  const payload = extractJsonObject(text);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new OpenRouterResponseError('Topic response was not a JSON object.', model);
  }
  const record = payload as Record<string, unknown>;

  const topicRecord = record.topic;
  if (typeof topicRecord !== 'object' || topicRecord === null || Array.isArray(topicRecord)) {
    throw new OpenRouterResponseError(
      "Topic response is missing a 'topic' object.",
      model,
    );
  }
  const topicFields = topicRecord as Record<string, unknown>;
  const title = topicFields.title;
  if (typeof title !== 'string' || !title.trim()) {
    throw new OpenRouterResponseError(
      "Topic response is missing a non-empty 'title' string.",
      model,
    );
  }
  const description = topicFields.description;
  if (typeof description !== 'string' || !description.trim()) {
    throw new OpenRouterResponseError(
      "Topic response is missing a non-empty 'description' string.",
      model,
    );
  }

  let sampleTurns: SampleTurn[] = [];
  try {
    sampleTurns = parseSampleTurns(record.sample_conversation, model);
  } catch (error) {
    if (!(error instanceof OpenRouterResponseError)) {
      throw error;
    }
    // Display-only degradation: an unusable example never blocks the topic.
    sampleTurns = [];
  }

  return {
    topic: {title: title.trim(), description: description.trim()},
    sampleTurns,
  };
}

/**
 * Validate the `sample_conversation` member into turns. Mirrors the backend
 * `_parse_sample`/`_parse_turn` rules: an object holding a `turns` list of
 * at least MIN_SAMPLE_TURNS entries, each an object with an allowed role and
 * non-empty content. Every deviation throws OpenRouterResponseError.
 */
function parseSampleTurns(value: unknown, model: string | null): SampleTurn[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OpenRouterResponseError(
      "Sample conversation response is missing a 'turns' object.",
      model,
    );
  }
  const rawTurns = (value as Record<string, unknown>).turns;
  if (!Array.isArray(rawTurns)) {
    throw new OpenRouterResponseError(
      "Sample conversation response is missing a 'turns' list.",
      model,
    );
  }
  if (rawTurns.length < MIN_SAMPLE_TURNS) {
    throw new OpenRouterResponseError(
      `Sample conversation needs at least ${MIN_SAMPLE_TURNS} turns.`,
      model,
    );
  }
  return rawTurns.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new OpenRouterResponseError(
        'Sample conversation turns must be JSON objects.',
        model,
      );
    }
    const record = entry as Record<string, unknown>;
    const role = record.role;
    if (typeof role !== 'string' || !(SAMPLE_ROLES as readonly string[]).includes(role)) {
      throw new OpenRouterResponseError(
        `Sample conversation turn ${index} has an invalid role.`,
        model,
      );
    }
    const content = record.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new OpenRouterResponseError(
        `Sample conversation turn ${index} is missing a non-empty content string.`,
        model,
      );
    }
    return {role: role as SampleTurn['role'], content: content.trim()};
  });
}

/**
 * Run the single combined completion through `complete` and return the
 * parsed topic plus example turns.
 */
export async function generateTopicWithSample(
  complete: CompleteFn,
  level: EnglishLevel,
  hint = '',
): Promise<TopicWithSample> {
  const trimmedHint = hint.trim();
  const request: CompletionRequest = {
    messages: [
      {role: 'system', content: TOPIC_AND_SAMPLE_SYSTEM_PROMPT},
      {role: 'user', content: buildTopicAndSampleUserPrompt(level, trimmedHint)},
    ],
  };
  const result = await complete(request);
  return parseTopicWithSample(result.text, result.model);
}

/**
 * Generate the topic and its example dialogue in ONE provider request and
 * persist the session locally: `title` carries the topic name, `topic` the
 * scenario description, the hint is stored verbatim, and the level comes
 * from the on-device learning profile. The single completion finishes before
 * the local write, so a failed generation never leaves a session behind. The
 * sample turns are display-only (they ride to Chat as a route param) and
 * never become chat messages; an unusable example section resolves as an
 * empty turn list while the topic stands. Resolves the created session row
 * and its example turns.
 */
export async function createServerlessSession(
  db: SqlDriver,
  complete: CompleteFn,
  hint = '',
): Promise<{session: LocalSession; sampleTurns: SampleTurn[]}> {
  const trimmedHint = hint.trim();
  const profile = await getLearningProfile(db);
  const {topic, sampleTurns} = await generateTopicWithSample(
    complete,
    profile.level,
    trimmedHint,
  );
  const repository = new LocalConversationRepository(async () => db);
  const session = await repository.createSession({
    title: topic.title,
    topic: topic.description,
    topic_hint: trimmedHint,
    learning_level: profile.level,
  });
  return {session, sampleTurns};
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
