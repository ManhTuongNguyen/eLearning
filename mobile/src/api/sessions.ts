/** Conversation session and message endpoint bindings (SPEC TASK-030..034 APIs). */

import {apiRequest} from './client';
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

export function listSessions(token: string, page?: number): Promise<Paginated<Session>> {
  return apiRequest<Paginated<Session>>(`/api/v1/sessions/${pageQuery(page)}`, {token});
}

export function createSession(token: string, topicHint = ''): Promise<CreatedSession> {
  return apiRequest<CreatedSession>('/api/v1/sessions/', {
    method: 'POST',
    body: topicHint ? {topic_hint: topicHint} : {},
    token,
  });
}

export function getSession(token: string, sessionId: number): Promise<Session> {
  return apiRequest<Session>(`/api/v1/sessions/${sessionId}/`, {token});
}

export function renameSession(
  token: string,
  sessionId: number,
  title: string,
): Promise<Session> {
  return apiRequest<Session>(`/api/v1/sessions/${sessionId}/`, {
    method: 'PATCH',
    body: {title},
    token,
  });
}

/** Server-side invalidation is not applicable; deletion cascades messages. */
export function deleteSession(token: string, sessionId: number): Promise<void> {
  return apiRequest<null>(`/api/v1/sessions/${sessionId}/`, {
    method: 'DELETE',
    token,
  }).then(() => undefined);
}

export function listMessages(
  token: string,
  sessionId: number,
  page?: number,
): Promise<Paginated<ChatMessage>> {
  return apiRequest<Paginated<ChatMessage>>(
    `/api/v1/sessions/${sessionId}/messages/${pageQuery(page)}`,
    {token},
  );
}
