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
 * Spaced-repetition state of one sentence (migration v4, TASK-SENT-003).
 *
 * `new` has never been reviewed; `learning` is the ten-minute relearning step
 * after an `Again`; `review` is the graduated, day-scale schedule; `suspended`
 * is excluded from every session.
 */
export type SentenceStatus = 'new' | 'learning' | 'review' | 'suspended';

/** The three rating buttons of the review session. */
export type ReviewGrade = 'again' | 'good' | 'easy';

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
 * One sentence plus its review schedule. `normalized_text` is the duplicate
 * key (unique per topic) and `due_at` is an ISO timestamp — a freshly
 * generated sentence is due immediately.
 */
export interface SentenceRecord {
  id: number;
  topic_id: number;
  text: string;
  normalized_text: string;
  meaning: string;
  situation: string;
  status: SentenceStatus;
  reps: number;
  lapses: number;
  ease: number;
  interval_days: number;
  due_at: string;
  last_grade: ReviewGrade | '';
  last_reviewed_at: string;
  created_at: string;
  updated_at: string;
}

/** One append-only review event, used for per-sentence statistics. */
export interface SentenceReviewLogRecord {
  id: number;
  sentence_id: number;
  topic_id: number;
  grade: ReviewGrade;
  mode: ReviewCardMode;
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
 */
export interface SentenceReviewState {
  status: SentenceStatus;
  reps: number;
  lapses: number;
  ease: number;
  interval_days: number;
  due_at: string;
  last_grade: ReviewGrade;
  last_reviewed_at: string;
}
