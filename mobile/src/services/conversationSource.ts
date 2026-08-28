/**
 * Mode-branched conversation data access for the chat experience
 * (TASK-AUDIT-014 decomposition of the chat screen).
 *
 * One owner for the question "where does conversation content come from"
 * (TASK-090): server mode talks to the backend through the central authed
 * requester (TASK-AUDIT-005); serverless mode reads the on-device SQLite
 * stores with no backend traffic (Rule 9). Consumers receive mode-agnostic
 * snapshots, so navigation and presentation code never branches on storage
 * details and the server/serverless reads are not duplicated per screen.
 */

import type {AuthedRequester} from '../auth/authedRequest';
import type {ChatMessage, Paginated, Session} from '../api/sessions';
import {getSession, listMessages, listSessions} from '../api/sessions';
import {getLocalDatabase} from '../db/database';
import {listMessages as listLocalMessages} from '../db/messageStore';
import {
  getSession as getLocalSession,
  listSessions as listLocalSessions,
} from '../db/sessionStore';
import type {ApplicationMode} from '../mode/types';

/** Chronological order for conversation rows. */
export function bySequence(a: ChatMessage, b: ChatMessage): number {
  return a.sequence - b.sequence;
}

/**
 * The authoritative history's first page — conversations ordered
 * most-recently-updated first (the backend page-one contract; local rows
 * carry the same ordering). The active mode's call dispatches synchronously
 * and its promise is returned unwrapped, so a consumer awaiting it resumes
 * exactly one microtask hop after the fetch settles: the no-session restore
 * flow (TASK-AUDIT-008) keys its focus/race handling on that boundary.
 */
export function listFirstSessionPage(
  mode: ApplicationMode,
  request: AuthedRequester,
): Promise<Paginated<Session>> {
  if (mode === 'serverless') {
    // Local rows are already ordered most-recently-active first and are
    // delivered in one shot — no pagination.
    return getLocalDatabase()
      .then(db => listLocalSessions(db))
      .then(rows => ({
        count: rows.length,
        next: null,
        previous: null,
        results: rows,
      }));
  }
  return listSessions(request, 1);
}

/** Conversation content plus the session detail that feeds the topic bar. */
export interface ConversationSnapshot {
  messages: ChatMessage[];
  /**
   * null when the detail lookup fails or the row does not exist — it only
   * feeds the topic bar, so its absence never fails the conversation.
   */
  session: Session | null;
}

/** Load one conversation in full from the store of the active mode. */
export async function loadConversation(
  mode: ApplicationMode,
  sessionId: number,
  request: AuthedRequester,
): Promise<ConversationSnapshot> {
  if (mode === 'serverless') {
    const db = await getLocalDatabase();
    const [rows, localSession] = await Promise.all([
      listLocalMessages(db, sessionId),
      getLocalSession(db, sessionId).catch(() => null),
    ]);
    return {messages: [...rows].sort(bySequence), session: localSession};
  }
  const [page, detail] = await Promise.all([
    listMessages(request, sessionId),
    getSession(request, sessionId).catch(() => null),
  ]);
  return {messages: [...page.results].sort(bySequence), session: detail};
}
