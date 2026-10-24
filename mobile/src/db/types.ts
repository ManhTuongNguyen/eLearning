/**
 * Row/entity types for the local serverless database (SPEC TASK-081).
 *
 * Shapes mirror the backend serializers (snake_case fields) so the same UI
 * models work against either storage backend (ROADMAP §15 data isolation:
 * local rows are separate data, but structurally compatible).
 */
import type { EnglishLevel } from '../api/profile';
import type { ImprovementSeverity } from '../api/sessions';

export type { ImprovementSeverity };

export type LocalMessageRole = 'user' | 'assistant';

export type LocalMessageStatus = 'pending' | 'complete' | 'failed';

/** One conversation session stored on-device for serverless mode. */
export interface LocalSession {
  id: number;
  title: string;
  topic: string;
  topic_hint: string;
  learning_level: EnglishLevel;
  created_at: string;
  updated_at: string;
}

/** Attributes accepted when creating a local session; omitted fields default. */
export interface NewLocalSession {
  title?: string;
  topic?: string;
  topic_hint?: string;
  learning_level?: EnglishLevel;
}

/** One chat message belonging to a local session. */
export interface LocalMessageImprovement {
  /** The learner's original wording (the row's own `content`). */
  original: string;
  improved: string;
  explanation: string;
  severity: ImprovementSeverity;
}

/** One chat message belonging to a local session. */
export interface LocalMessage {
  id: number;
  session_id: number;
  role: LocalMessageRole;
  status: LocalMessageStatus;
  content: string;
  sequence: number;
  created_at: string;
  /**
   * Cached grammar improvement (migration v2); undefined while the message
   * has never been checked. Persisted so badges survive app restarts.
   */
  improvement?: LocalMessageImprovement;
}

/**
 * Rolling conversation summary for one local session (ROADMAP §5). The
 * boundary records how many messages are already folded into `content`.
 */
export interface LocalSummary {
  id: number;
  session_id: number;
  content: string;
  message_boundary: number;
  created_at: string;
  updated_at: string;
}

/** On-device learning profile; a single row exists at any time. */
export interface LocalLearningProfile {
  level: EnglishLevel;
  updated_at: string;
}

/**
 * A speaking practice history entry for a single practice session.
 */
export interface LocalPracticeHistoryRecord {
  id: number;
  user_id: number;
  title: string;
  description: string;
  raw_prompt: string;
  english_level: EnglishLevel;
  text: string;
  minutes: number;
  word_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * FSRS card state of one sentence (migration v6, TASK-SENT-015).
 *
 * Mirrors `ts-fsrs`'s `State`: `new` has never been reviewed, `learning` is a
 * short-term step for a new card, `review` is the day-scale schedule, and
 * `relearning` is the short-term step after a lapse. Suspension is a separate
 * `suspended` flag (as in Anki), not a state.
 */
export type SentenceState = 'new' | 'learning' | 'review' | 'relearning';

/**
 * The four rating buttons of the review session, in Anki order. Each maps to
 * an FSRS `Rating` (1–4) that is also stored in the review log.
 */
export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

/** Which card shape produced a review: listen-and-type or situation recall. */
export type ReviewCardMode = 'dictation' | 'recall';

/** A learner-created topic holding a bank of real-life sentences. */
export interface SentenceTopicRecord {
  id: number;
  title: string;
  description: string;
  /**
   * Optional advanced guidance for sentence generation. It is stored as
   * untrusted learner context and never injected into the prompt as commands.
   */
  generation_prompt: string;
  english_level: EnglishLevel;
  created_at: string;
  updated_at: string;
}

/**
 * One sentence plus its FSRS review schedule. `normalized_text` is the
 * duplicate key (unique per topic) and `due_at` is an ISO timestamp — a freshly
 * generated sentence is due immediately.
 *
 * `stability` (days; FSRS memory strength) and `difficulty` (1–10) are the
 * FSRS memory state; `elapsed_days`/`scheduled_days` and `learning_steps` are
 * the remaining `Card` fields the scheduler replays the next review with.
 */
export interface SentenceRecord {
  id: number;
  topic_id: number;
  text: string;
  normalized_text: string;
  meaning: string;
  situation: string;
  state: SentenceState;
  suspended: boolean;
  reps: number;
  lapses: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  due_at: string;
  last_grade: ReviewGrade | '';
  last_reviewed_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * One append-only review event. The columns mirror Anki's `revlog` row so the
 * history can be fed to the FSRS optimizer:
 *
 * - `rating` is the FSRS value 1–4 (`grade` is its readable name);
 * - `state` is the card state *before* the review;
 * - `elapsed_days` is the gap FSRS saw, `scheduled_days` the interval the
 *   review produced, and `due_at` the next due date;
 * - `stability`/`difficulty` are the memory state after the review.
 */
export interface SentenceReviewLogRecord {
  id: number;
  sentence_id: number;
  topic_id: number;
  grade: ReviewGrade;
  rating: number;
  state: SentenceState;
  mode: ReviewCardMode;
  due_at: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  last_elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  review_duration_ms: number;
  reviewed_at: string;
}

/** Attributes accepted when creating a topic; omitted fields default. */
export interface NewSentenceTopic {
  title: string;
  description?: string;
  /** Optional advanced guidance used only for sentence generation. */
  generation_prompt?: string;
  english_level?: EnglishLevel;
}

/** One generated (or hand-written) sentence before it has an id. */
export interface NewSentence {
  text: string;
  meaning: string;
  situation?: string;
}

/** A topic row plus the counts the topic list shows. */
export interface SentenceTopicSummary extends SentenceTopicRecord {
  /** Sentences in the topic, suspended ones included. */
  sentence_count: number;
  /** Sentences due at the reference time, suspended ones excluded. */
  due_count: number;
}

/**
 * The review-state half of a sentence row: exactly what the scheduler returns
 * and the repository persists. Kept separate from the content columns so a
 * review can never accidentally rewrite the sentence the learner studies.
 * `suspended` is deliberately absent: grading never changes it.
 */
export interface SentenceReviewState {
  state: SentenceState;
  reps: number;
  lapses: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  due_at: string;
  last_grade: ReviewGrade;
  last_reviewed_at: string;
}

/**
 * The review-log half of one graded review. `state` and `elapsed_days` describe
 * the card *before* the grade (Anki's revlog semantics); the rest describe the
 * resulting schedule.
 */
export interface SentenceReviewLogInput {
  grade: ReviewGrade;
  rating: number;
  state: SentenceState;
  due_at: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  last_elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reviewed_at: string;
}

// --- Word bank (WORD_BANK_V1, migration v7) ---------------------------------

/**
 * One dictionary sense group: a part of speech with its definitions. This is
 * the same shape the Free Dictionary API returns (minus metadata the app does
 * not store), so the AI's enrichment proposal can replace the stored JSON
 * wholesale and the change-review modal can diff old vs new structurally.
 */
export interface WordSense {
  partOfSpeech: string;
  definitions: WordSenseDefinition[];
}

/** One definition inside a sense group, with its optional example sentence. */
export interface WordSenseDefinition {
  definition: string;
  example?: string;
}

/**
 * A learner-created vocabulary topic. `description` is free-form learner
 * context (domain, habits, self-described level) passed verbatim to the
 * generation and enrichment prompts; `extra_prompt` is an optional additional
 * AI instruction, `''` when absent.
 */
export interface WordTopicRecord {
  id: number;
  title: string;
  description: string;
  extra_prompt: string;
  created_at: string;
  updated_at: string;
}

/**
 * Where a word's learning data came from: the Free Dictionary API at creation
 * or fetch time, or an approved AI enrichment. Phonetics always come from the
 * dictionary — enrichment never touches them.
 */
export type WordDataSource = 'dictionary' | 'enriched';

/**
 * Whether the word has dictionary data. `'missing'` words (kept after a
 * transient API error) have empty `senses_json`/`phonetics_json` and are
 * excluded from sessions and due counts until a fetch fills them.
 */
export type WordDataStatus = 'complete' | 'missing';

/**
 * One English word plus its FSRS review schedule. `senses_json` and
 * `phonetics_json` are the parsed stored JSON: every dictionary sense (all
 * parts of speech) and the IPA strings. `enriched_at` is the ISO instant of
 * the last approved enrichment, null when the word was never enriched.
 */
export interface WordRecord {
  id: number;
  topic_id: number;
  text: string;
  normalized_text: string;
  senses_json: WordSense[];
  phonetics_json: string[];
  data_source: WordDataSource;
  data_status: WordDataStatus;
  enriched_at: string | null;
  state: SentenceState;
  suspended: boolean;
  reps: number;
  lapses: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  due_at: string;
  last_grade: ReviewGrade | '';
  last_reviewed_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * One append-only word review event. Same Anki `revlog` shape as the sentence
 * log so per-feature history can train the FSRS optimizer.
 */
export interface WordReviewLogRecord {
  id: number;
  word_id: number;
  topic_id: number;
  grade: ReviewGrade;
  rating: number;
  state: SentenceState;
  mode: ReviewCardMode;
  due_at: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  last_elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  review_duration_ms: number;
  reviewed_at: string;
}

/**
 * Parse the stored `senses_json` column into `WordSense[]`. Accepts already
 * parsed values too (the sql.js driver returns strings, but callers may hold
 * parsed data). Every entry is validated: sense groups without a usable part
 * of speech and empty/whitespace definitions are dropped; anything malformed
 * yields `[]` instead of throwing — a corrupted column must never crash the
 * word list or the practice screen.
 */
export function parseWordSenses(raw: unknown): WordSense[] {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const senses: WordSense[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const partOfSpeech = typeof record.partOfSpeech === 'string' ? record.partOfSpeech.trim() : '';
    const rawDefinitions = Array.isArray(record.definitions) ? record.definitions : [];
    const definitions: WordSenseDefinition[] = [];
    for (const rawDefinition of rawDefinitions) {
      if (typeof rawDefinition !== 'object' || rawDefinition === null) {
        continue;
      }
      const definitionRecord = rawDefinition as Record<string, unknown>;
      if (typeof definitionRecord.definition !== 'string') {
        continue;
      }
      const definition = definitionRecord.definition.trim();
      if (!definition) {
        continue;
      }
      const example =
        typeof definitionRecord.example === 'string' && definitionRecord.example.trim()
          ? definitionRecord.example.trim()
          : undefined;
      definitions.push(example === undefined ? { definition } : { definition, example });
    }
    if (partOfSpeech && definitions.length > 0) {
      senses.push({ partOfSpeech, definitions });
    }
  }
  return senses;
}

/**
 * Parse the stored `phonetics_json` column into the IPA strings. Malformed
 * JSON and non-string/empty entries yield safe defaults (`[]`) instead of
 * throwing.
 */
export function parseWordPhonetics(raw: unknown): string[] {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}
