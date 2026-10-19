/**
 * Serverless generation of real-life English sentences (SENTENCE_LIVE_V1 §2.7,
 * TASK-SENT-007).
 *
 * The pattern is identical to `serverless/topicGeneration.ts`: one completion
 * through the user's own provider key (resolved by the on-device registry,
 * never the backend), a strict-JSON response, and a pure parser that the
 * screen tests against with a fake `complete` seam.
 *
 * The model is asked for plain, spoken English a native speaker really uses,
 * each sentence with an English-only meaning and a short real-life situation.
 * The existing sentences of the topic are sent along so the model does not
 * repeat them, and the local duplicate filter (TASK-SENT-004) is applied again
 * afterwards as the source of truth. Only zero valid candidates is fatal.
 */
import type {EnglishLevel} from '../api/profile';
import {getLearningProfile} from '../db/profileStore';
import type {SqlDriver} from '../db/driver';
import {OpenRouterResponseError} from './errors';
import type {CompletionRequest, CompletionResult} from './types';

/**
 * A candidate sentence returned by the model: the English sentence, an
 * English paraphrase of its meaning, and the short situation in which a
 * native speaker would actually say it.
 */
export interface SentenceCandidate {
  sentence: string;
  meaning: string;
  situation: string;
}

/** Narrow seam over the client so tests can inject completions directly. */
export type CompleteFn = (request: CompletionRequest) => Promise<CompletionResult>;

/**
 * System instruction demanding the JSON array shape and nothing else. The
 * English-only constraint is repeated up front because this feature exists
 * specifically to avoid translation crutches.
 */
export const SENTENCE_GENERATION_SYSTEM_PROMPT =
  'You write everyday English sentences for an English-learning app. ' +
  'A learner saves, practices and gradually memorises them, so each sentence ' +
  'must be short spoken English a native speaker actually says in real life — ' +
  'no literary or textbook register, no proper nouns needing outside context, ' +
  'no two sentences alike.\n' +
  'Respond with ONLY a JSON array named "sentences" whose elements each have ' +
  'exactly:\n' +
  '"sentence":  the English sentence (5-14 words, natural contractions),\n' +
  '"meaning":   a simple English paraphrase, at most 10 words, never a ' +
  'translation to another language,\n' +
  '"situation": one short English line describing when a native speaker says ' +
  'it.\n' +
  'No markdown, no code fences, no commentary, no numbering.';

/** The wrapped envelope the model is told to emit. */
export interface SentenceGenerationPayload {
  sentences: SentenceCandidate[];
}

/** Inputs needed for one generation against a single topic. */
export interface SentenceGenerationInput {
  /** Title and optional scenario of the topic the sentences belong to. */
  topicTitle: string;
  topicDescription: string;
  /** How many sentences to request; the caller clamps this. */
  count: number;
  /** Existing sentences of the topic, so the model avoids repeating them. */
  existingSentences: string[];
}

/**
 * Compose the user turn from level, topic context, the requested count and
 * the sentences already in the topic. `existingSentences` is capped at 50: a
 * few dozen examples are enough for the model to detect repetition and the
 * call must stay cheap on tokens.
 */
export function buildSentenceGenerationUserPrompt(
  level: EnglishLevel,
  input: SentenceGenerationInput,
): string {
  const parts: string[] = [
    `Write ${input.count} everyday English sentence${input.count === 1 ? '' : 's'} ` +
      'for an English-learning app. Each sentence is spoken English a native ' +
      'speaker actually uses in real life.',
  ];

  if (level === 'AUTO') {
    parts.push("The learner's English level is unknown; infer an appropriate level.");
  } else {
    parts.push(`The learner's English level is ${level} (CEFR). Keep vocabulary and grammar at that level.`);
  }

  const trimmedTitle = input.topicTitle.trim();
  const trimmedDescription = input.topicDescription.trim();
  if (trimmedTitle) {
    parts.push(`Topic: ${trimmedTitle}.`);
  }
  if (trimmedDescription) {
    parts.push(`Situation: ${trimmedDescription}.`);
  } else {
    parts.push('No situation hint was given; choose a common everyday situation.');
  }

  const sample = input.existingSentences.slice(0, 50);
  if (sample.length > 0) {
    parts.push(
      'Sentences already in this topic — do NOT repeat or lightly reword any of them:\n' +
        sample.map(sentence => `- ${sentence}`).join('\n'),
    );
  }

  return (
    parts.join('\n\n') +
    '\n\nEach result needs "sentence", "meaning" and "situation". Do not repeat ' +
    'or paraphrase any existing sentence; vary sentence structure and meaning.'
  );
}

/**
 * Decode the model response into candidates. Tolerates a code-fenced or
 * prose-wrapped array and ignores extra keys; an entry missing its sentence or
 * meaning, or whose text duplicates another entry or an existing sentence, is
 * dropped. Only the complete absence of any valid candidate throws.
 */
export function parseGeneratedSentences(
  text: string,
  existingNormalized: readonly string[] = [],
): SentenceCandidate[] {
  const payload = extractSentencesArray(text);

  const seen = new Set(existingNormalized);
  const result: SentenceCandidate[] = [];
  for (const entry of payload) {
    const record = entry as Record<string, unknown> | null;
    if (
      record == null ||
      typeof record.sentence !== 'string' ||
      typeof record.meaning !== 'string'
    ) {
      continue;
    }
    const sentence = record.sentence.trim();
    const meaning = record.meaning.trim();
    if (!sentence || !meaning) {
      continue;
    }

    // Re-use the storage duplicate key so the model's rewording can never
    // smuggle a duplicate past the filter.
    const normalized = normalizeForParse(sentence);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    const situation =
      typeof record.situation === 'string' ? record.situation.trim() : '';
    result.push({sentence, meaning, situation});
  }

  if (result.length === 0) {
    throw new OpenRouterResponseError(
      'Sentence generation returned no usable sentences.',
      null,
    );
  }
  return result;
}

/**
 * Generate `count` sentences for one topic through a single completion. The
 * existing sentences guard against repetition; the local duplicate filter
 * enforces it.
 */
export async function generateSentences(
  complete: CompleteFn,
  level: EnglishLevel,
  input: SentenceGenerationInput,
): Promise<SentenceCandidate[]> {
  const request: CompletionRequest = {
    messages: [
      {role: 'system', content: SENTENCE_GENERATION_SYSTEM_PROMPT},
      {role: 'user', content: buildSentenceGenerationUserPrompt(level, input)},
    ],
  };
  const result = await complete(request);
  const existingNormalized = input.existingSentences.map(normalizeForParse);
  return parseGeneratedSentences(result.text, existingNormalized);
}

/**
 * Generate sentences for one topic, resolving the learner level from the
 * on-device profile — the single-call variant the screen uses. Requires the
 * topic to be configured (title required, description optional/blank).
 */
export async function generateTopicSentences(
  db: SqlDriver,
  complete: CompleteFn,
  input: {
    topicTitle: string;
    topicDescription: string;
    count: number;
    existingSentences: string[];
  },
): Promise<SentenceCandidate[]> {
  if (!input.topicTitle.trim()) {
    throw new Error('generateTopicSentences: a topic needs a title');
  }
  const profile = await getLearningProfile(db);
  return generateSentences(complete, profile.level, {
    topicTitle: input.topicTitle,
    topicDescription: input.topicDescription,
    count: input.count,
    existingSentences: input.existingSentences,
  });
}

/**
 * Pull the `sentences` array out of a response that may be JSON, a JSON object
 * with a `sentences` key, or prose wrapped around either. Mirrors the
 * brace-span recovery used by topic generation.
 */
function extractSentencesArray(text: string): unknown[] {
  let payload: unknown = parseJsonSafely(text);
  if (!Array.isArray(payload)) {
    const objectPayload = payload as Record<string, unknown> | null;
    const embedded = objectPayload?.sentences;
    if (Array.isArray(embedded)) {
      payload = embedded;
    } else if (payload !== null && typeof payload === 'object') {
      return [];
    }
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  // Fall back to the outermost brace/square brackets and retry.
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const bracketed = parseJsonSafely(text.slice(start, end + 1));
    if (Array.isArray(bracketed)) {
      return bracketed;
    }
    const objectPayload = bracketed as Record<string, unknown> | null;
    const embedded = objectPayload?.sentences;
    if (Array.isArray(embedded)) {
      return embedded;
    }
  }
  return [];
}

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/** A parse-time duplicate key consistent with the one stored on disk. */
function normalizeForParse(text: string): string {
  return (text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
}