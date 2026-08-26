/** Vocabulary endpoint bindings (SPEC TASK-066/070). */

import {apiRequest} from './client';

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
 */
export function saveVocabulary(
  token: string,
  expression: string,
  sourceMessageId?: number,
): Promise<VocabularyItem> {
  return apiRequest<VocabularyItem>('/api/v1/vocabulary/', {
    method: 'POST',
    body:
      sourceMessageId === undefined
        ? {expression}
        : {expression, source_message_id: sourceMessageId},
    token,
  });
}
