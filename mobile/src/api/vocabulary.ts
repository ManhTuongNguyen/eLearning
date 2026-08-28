/** Vocabulary endpoint bindings (SPEC TASK-066/070/071/072/074/075). */

import {API_BASE_URL} from '../config';
import {ApiError, normalizeApiError} from './client';
import type {AuthedRequester} from '../auth/authedRequest';
import type {Paginated} from './sessions';

/** Enrichment lifecycle of a saved expression (backend VocabularyItem.Status). */
export type VocabularyStatus = 'pending' | 'complete' | 'failed';

/** Read representation of a saved vocabulary item (backend VocabularyItemSerializer). */
export interface VocabularyItem {
  id: number;
  expression: string;
  normalized_expression: string;
  definition: string;
  translation: string;
  pronunciation: string;
  part_of_speech: string;
  example: string;
  status: VocabularyStatus;
  source_message: number | null;
  source_session: number | null;
  created_at: string;
}

/**
 * POST /api/v1/vocabulary/ (TASK-066). Saving is immediate and never waits
 * for enrichment — the server creates the row in `pending` status and
 * enriches it asynchronously via Celery, so this promise resolving only
 * means the expression is stored. A duplicate (same user + trimmed/
 * lowercased expression) returns 200 with the existing row unchanged; a new
 * one returns 201. Both are successes; failures are normalized ApiErrors.
 * Runs through the central authed requester (TASK-AUDIT-005).
 */
export function saveVocabulary(
  request: AuthedRequester,
  expression: string,
  sourceMessageId?: number,
): Promise<VocabularyItem> {
  return request<VocabularyItem>('/api/v1/vocabulary/', {
    method: 'POST',
    body:
      sourceMessageId === undefined
        ? {expression}
        : {expression, source_message_id: sourceMessageId},
  });
}

/**
 * GET /api/v1/vocabulary/ (TASK-071): the caller's saved expressions, newest
 * first, as a DRF paginated envelope. `status` exposes the asynchronous
 * enrichment lifecycle (`pending` → `complete` | `failed`) so the list
 * screen can show progress without refetching. Runs through the central
 * authed requester (TASK-AUDIT-005).
 */
export function listVocabulary(
  request: AuthedRequester,
  page?: number,
): Promise<Paginated<VocabularyItem>> {
  return request<Paginated<VocabularyItem>>(
    `/api/v1/vocabulary/${page === undefined ? '' : `?page=${page}`}`,
  );
}

/** Filename the backend serves the export under (backend vocabulary.views.EXPORT_FILENAME). */
export const VOCABULARY_EXPORT_FILENAME = 'anki-vocabulary.csv';

/**
 * GET /api/v1/vocabulary/export/ (TASK-074): the caller's complete vocabulary
 * as Anki-compatible CSV text. Unlike the JSON bindings this response must
 * not be parsed as JSON, so — unlike the requester-based bindings — it
 * performs its own raw request and returns the payload untouched while
 * keeping the error contract: network failures become ApiError(0) and
 * non-2xx responses are normalized through the shared helper (DRF error
 * bodies are still JSON here).
 */
export async function exportVocabulary(token: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/v1/vocabulary/export/`, {
      method: 'GET',
      headers: {Accept: 'text/csv', Authorization: `Bearer ${token}`},
    });
  } catch {
    throw new ApiError(0, 'Network request failed. Check your connection and try again.');
  }
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    throw normalizeApiError(response.status, payload);
  }
  return text;
}
