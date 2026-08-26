/**
 * Row/entity types for the local serverless database (SPEC TASK-081).
 *
 * Shapes mirror the backend serializers (snake_case fields) so the same UI
 * models work against either storage backend (ROADMAP §15 data isolation:
 * local rows are separate data, but structurally compatible).
 */
import type {EnglishLevel} from '../api/profile';

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
export interface LocalMessage {
  id: number;
  session_id: number;
  role: LocalMessageRole;
  status: LocalMessageStatus;
  content: string;
  sequence: number;
  created_at: string;
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
