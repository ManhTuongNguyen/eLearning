/**
 * Serverless speaking-practice text generation.
 *
 * The karaoke screen turns a learner input (a topic, a list of questions or
 * an already-written passage) plus a session length in minutes into a plain
 * reading-aloud text through ONE completion against the user's own provider
 * (same registry seam as topic generation — ROADMAP Rule 9: nothing touches
 * the backend). The response is plain prose, deliberately not JSON: the
 * display layer splits it into paragraphs itself, so a malformed response
 * costs only a degraded experience, and only the empty case is fatal.
 */
import type {EnglishLevel} from '../api/profile';
import {getLearningProfile} from '../db/profileStore';
import type {SqlDriver} from '../db/driver';
import {OpenRouterResponseError} from './errors';
import type {CompletionRequest, CompletionResult} from './types';

/**
 * System instruction demanding the practice text itself and nothing else.
 * Plain prose, no furniture: the text is read aloud while it scrolls, so
 * titles, markdown and stage directions would all end up spoken.
 */
export const SPEAKING_PRACTICE_SYSTEM_PROMPT =
  'You write reading-aloud practice material for an English-learning app. ' +
  'The learner reads the text aloud while it slowly scrolls on the screen. ' +
  'Respond with ONLY the practice text itself: plain prose, no title, no ' +
  'markdown, no numbering, no stage directions, no explanations. Separate ' +
  'paragraphs with one blank line.';

/** Words per minute of comfortable read-aloud speech (prompt sizing basis). */
export const WORDS_PER_MINUTE = 130;

/** Inputs for one speaking-text generation. */
export interface SpeakingPracticeInput {
  /** Topic idea, question list or the learner's own passage; may be blank. */
  material: string;
  /** Target session length in minutes; drives the generated word budget. */
  minutes: number;
}

/** A generated practice text split into centered display paragraphs. */
export interface SpeakingPracticeText {
  /** The full generated text, trimmed. */
  text: string;
  /** Paragraphs split on blank lines, in order, ready for display. */
  paragraphs: string[];
}

/** Narrow seam over the client so tests can inject completions directly. */
export type CompleteFn = (request: CompletionRequest) => Promise<CompletionResult>;

/**
 * Compose the user-turn instruction from level, material and minutes. The
 * word budget scales linearly with the requested minutes; the material is
 * used either as the subject of the text (topic/questions) or, when it
 * already reads like a passage, as the practice text itself after a light
 * grammar smoothing.
 */
export function buildSpeakingPracticeUserPrompt(
  level: EnglishLevel,
  material: string,
  minutes: number,
): string {
  const parts = [
    `Write a text the learner will read aloud to fill about ${minutes} ` +
      `minutes of speaking. A comfortable reading-aloud pace is about ` +
      `${WORDS_PER_MINUTE} words per minute, so aim for roughly ` +
      `${minutes * WORDS_PER_MINUTE} words. Use a warm, everyday register.`,
  ];
  if (level === 'AUTO') {
    parts.push(
      "The learner's English level is unknown; infer an appropriate level " +
        'for the text you write.',
    );
  } else {
    parts.push(
      `The learner's English level is ${level} (CEFR); keep vocabulary and ` +
        'grammar at that level.',
    );
  }
  const trimmedMaterial = material.trim();
  if (trimmedMaterial) {
    parts.push(
      `The learner's input is:\n"${trimmedMaterial}"\nIf it is a topic or a ` +
        'list of questions, write the practice text about it; if it is ' +
        'already a passage, lightly smooth the grammar and use it as the ' +
        'practice text.',
    );
  } else {
    parts.push('The learner gave no preference; choose an engaging everyday topic.');
  }
  return parts.join('\n');
}

/**
 * Decode one completion into the practice text. Tolerates the response
 * wrapped in code fences or surrounding whitespace; only a completely empty
 * result is fatal (OpenRouterResponseError), because any non-empty prose is
 * readable practice material.
 */
export function parseGeneratedSpeechText(text: string, model: string | null = null): string {
  const unwrapped = text
    .replace(/^\s*```[^\n]*\n/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  if (!unwrapped) {
    throw new OpenRouterResponseError(
      'Speaking practice response was empty.',
      model,
    );
  }
  return unwrapped;
}

/** Split a generated text into display paragraphs on blank lines. */
export function splitPracticeParagraphs(text: string): string[] {
  const paragraphs = text
    .split(/\n[ \t]*\n/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph.length > 0);
  return paragraphs.length > 0 ? paragraphs : [text.trim()];
}

/**
 * Run the single completion through `complete` and return the parsed text
 * plus its display paragraphs.
 */
export async function generateSpeakingText(
  complete: CompleteFn,
  input: SpeakingPracticeInput,
  level: EnglishLevel,
): Promise<SpeakingPracticeText> {
  const request: CompletionRequest = {
    messages: [
      {role: 'system', content: SPEAKING_PRACTICE_SYSTEM_PROMPT},
      {
        role: 'user',
        content: buildSpeakingPracticeUserPrompt(level, input.material, input.minutes),
      },
    ],
  };
  const result = await complete(request);
  const text = parseGeneratedSpeechText(result.text, result.model);
  return {text, paragraphs: splitPracticeParagraphs(text)};
}

/**
 * Generate the practice text with the level resolved from the on-device
 * learning profile — the one-call variant the screen uses.
 */
export async function generateSpeakingPracticeText(
  db: SqlDriver,
  complete: CompleteFn,
  input: SpeakingPracticeInput,
): Promise<SpeakingPracticeText> {
  const profile = await getLearningProfile(db);
  return generateSpeakingText(complete, input, profile.level);
}
