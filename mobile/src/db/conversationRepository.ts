/**
 * Repository abstraction for local serverless conversations (SPEC TASK-082).
 *
 * Composes the TASK-081 entity stores behind one conversation-facing API so
 * feature code neither writes SQL nor manages connections: every method
 * lazily resolves the shared auto-initialized database, and the driver
 * factory is injectable for tests.
 *
 * Deliberate local-mode difference from the server API: appending a message
 * also refreshes the session's `updated_at`, so history listings ordered
 * most-recently-updated-first follow conversation activity.
 */

import {getLocalDatabase} from './database';
import type {SqlDriver} from './driver';
import * as messageStore from './messageStore';
import * as sessionStore from './sessionStore';
import * as summaryStore from './summaryStore';
import type {
  LocalMessage,
  LocalMessageRole,
  LocalMessageStatus,
  LocalSession,
  LocalSummary,
  NewLocalSession,
} from './types';

/** Attributes accepted when appending one message to a local session. */
export interface NewRepositoryMessage {
  session_id: number;
  role: LocalMessageRole;
  content: string;
  status?: LocalMessageStatus;
}

/** Attributes accepted when persisting one rolling summary. */
export interface NewRepositorySummary {
  session_id: number;
  content: string;
  message_boundary: number;
}

/** Conversation-oriented facade over the local SQLite database. */
export class LocalConversationRepository {
  constructor(
    private readonly openDb: () => Promise<SqlDriver> = getLocalDatabase,
  ) {}

  /** Create a session with sensible defaults; returns the persisted row. */
  async createSession(input: NewLocalSession = {}): Promise<LocalSession> {
    return sessionStore.insertSession(await this.openDb(), input);
  }

  /**
   * Append a message to a session and refresh the session's recency stamp.
   * Unknown sessions fail through the foreign-key constraint.
   */
  async addMessage(input: NewRepositoryMessage): Promise<LocalMessage> {
    const db = await this.openDb();
    const message = await messageStore.insertMessage(db, input);
    await sessionStore.touchSession(db, input.session_id);
    return message;
  }

  /** Read one session by id; resolves null when it does not exist. */
  async readSession(sessionId: number): Promise<LocalSession | null> {
    return sessionStore.getSession(await this.openDb(), sessionId);
  }

  /** Messages of one session in chronological order. */
  async listMessages(sessionId: number): Promise<LocalMessage[]> {
    return messageStore.listMessages(await this.openDb(), sessionId);
  }

  /** All sessions, most recently active first. */
  async listSessions(): Promise<LocalSession[]> {
    return sessionStore.listSessions(await this.openDb());
  }

  /** Rename a session and bump its recency stamp. */
  async renameSession(sessionId: number, title: string): Promise<void> {
    return sessionStore.renameSession(await this.openDb(), sessionId, title);
  }

  /**
   * Delete a session together with its messages and summary (cascade).
   * Resolves false when the session did not exist.
   */
  async deleteSession(sessionId: number): Promise<boolean> {
    return sessionStore.deleteSession(await this.openDb(), sessionId);
  }

  /**
   * Insert or overwrite the single rolling summary of a session and return
   * the stored row. Unknown sessions fail through the foreign-key constraint.
   */
  async saveSummary(input: NewRepositorySummary): Promise<LocalSummary> {
    return summaryStore.saveSummary(await this.openDb(), input);
  }
}
