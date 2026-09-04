/** Conversation session and message endpoint bindings (SPEC TASK-030..034 APIs). */

import type {AuthedRequester} from '../auth/authedRequest';
import type {EnglishLevel} from './profile';

/** Read representation of a conversation session (backend SessionSerializer). */
export interface Session {
  id: number;
  title: string;
  topic: string;
  topic_hint: string;
  learning_level: EnglishLevel;
  created_at: string;
}

export type MessageRole = 'user' | 'assistant';

export type MessageStatus = 'pending' | 'complete' | 'failed';

/** Read representation of a chat message (backend MessageSerializer). */
export interface ChatMessage {
  id: number;
  role: MessageRole;
  status: MessageStatus;
  content: string;
  sequence: number;
  created_at: string;
  /**
   * Cached grammar improvement for user messages; present once the message
   * has been checked (server mode persists it on the backend, serverless in
   * local SQLite). Restores badges and suggestions without new API calls.
   */
  improvement?: MessageImprovement;
}

/** One turn of the generated example conversation (backend SampleTurn). */
export interface SampleTurn {
  role: MessageRole;
  content: string;
}

/** Generated sample conversation carried by the creation response. */
export interface SampleConversation {
  turns: SampleTurn[];
}

/**
 * POST /api/v1/sessions/ response: the session fields plus the freshly
 * generated sample conversation (ROADMAP §7). The sample exists only in this
 * response — no GET endpoint exposes it — so consumers must capture it here.
 */
export interface CreatedSession extends Session {
  sample_conversation?: SampleConversation;
}

/** DRF page-number pagination envelope. */
export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

function pageQuery(page?: number): string {
  return page === undefined ? '' : `?page=${page}`;
}

/**
 * Authenticated session/message endpoints (TASK-AUDIT-005): instead of a raw
 * access token these bindings take the central `AuthedRequester`, so an
 * expired token is detected, refreshed, and the original request retried
 * once — transparently and in one place.
 */

export function listSessions(
  request: AuthedRequester,
  page?: number,
): Promise<Paginated<Session>> {
  return request<Paginated<Session>>(`/api/v1/sessions/${pageQuery(page)}`);
}

export function createSession(
  request: AuthedRequester,
  topicHint = '',
): Promise<CreatedSession> {
  return request<CreatedSession>('/api/v1/sessions/', {
    method: 'POST',
    body: topicHint ? {topic_hint: topicHint} : {},
  });
}

export function getSession(request: AuthedRequester, sessionId: number): Promise<Session> {
  return request<Session>(`/api/v1/sessions/${sessionId}/`);
}

export function renameSession(
  request: AuthedRequester,
  sessionId: number,
  title: string,
): Promise<Session> {
  return request<Session>(`/api/v1/sessions/${sessionId}/`, {
    method: 'PATCH',
    body: {title},
  });
}

/** Server-side invalidation is not applicable; deletion cascades messages. */
export function deleteSession(request: AuthedRequester, sessionId: number): Promise<void> {
  return request<null>(`/api/v1/sessions/${sessionId}/`, {
    method: 'DELETE',
  }).then(() => undefined);
}

export function listMessages(
  request: AuthedRequester,
  sessionId: number,
  page?: number,
): Promise<Paginated<ChatMessage>> {
  return request<Paginated<ChatMessage>>(
    `/api/v1/sessions/${sessionId}/messages/${pageQuery(page)}`,
  );
}

/** Three candidate replies for one selected message (TASK-059 contract). */
export interface MessageSuggestions {
  replies: string[];
}

/**
 * POST /api/v1/sessions/{sid}/messages/{mid}/suggestions/ (TASK-061).
 * Read-only generation: nothing persists server-side. Invalid targets
 * (non-complete or blank messages) are 409; provider failures 503/502 —
 * all normalized by the requester's error contract.
 */
export function getMessageSuggestions(
  request: AuthedRequester,
  sessionId: number,
  messageId: number,
): Promise<MessageSuggestions> {
  return request<MessageSuggestions>(
    `/api/v1/sessions/${sessionId}/messages/${messageId}/suggestions/`,
    {method: 'POST', body: {}},
  );
}

/** How wrong the original message was (backend Improvement.severity). */
export type ImprovementSeverity = 'none' | 'minor' | 'critical';

/** Grammar/wording improvement for one user message (TASK-063 contract). */
export interface MessageImprovement {
  original: string;
  improved: string;
  explanation: string;
  /**
   * Classification of the original message: `none` when it was already
   * correct, `minor` for small slips (warning badge) and `critical` for
   * meaning-breaking mistakes (error badge). Returned by the same request
   * that produces the correction, so the client can badge the message and
   * show the improvement without a second API call.
   */
  severity: ImprovementSeverity;
}

/**
 * POST /api/v1/sessions/{sid}/messages/{mid}/improve/ (TASK-063). Read-only
 * generation: the stored message is never modified server-side and `original`
 * is composed from the persisted row. Invalid targets (assistant rows or
 * blank messages) are 409; foreign/nonexistent ids are 404; provider
 * failures 503/502 — all normalized by the requester's error contract.
 */
export function improveMessage(
  request: AuthedRequester,
  sessionId: number,
  messageId: number,
): Promise<MessageImprovement> {
  return request<MessageImprovement>(
    `/api/v1/sessions/${sessionId}/messages/${messageId}/improve/`,
    {method: 'POST', body: {}},
  );
}
