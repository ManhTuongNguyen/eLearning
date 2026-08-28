/**
 * Immediate vocabulary save flow with its transient toast (TASK-069/070;
 * TASK-AUDIT-007 removed the confirmation popup; TASK-AUDIT-014 moved the
 * flow out of the chat screen).
 *
 * The save starts as soon as the selection sheet hands over the confirmed
 * trimmed expression. The endpoint returns as soon as the row is stored —
 * enrichment happens asynchronously server-side and is never awaited — so
 * success flashes a confirmation toast while failure surfaces the
 * normalized error as an alert toast (same auto-dismiss contract). Stale
 * responses (a session switched mid-flight) are dropped.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {saveVocabulary} from '../api/vocabulary';
import type {AuthedRequester} from '../auth/authedRequest';
import {toErrorMessage} from '../auth/AuthContext';
import {getRuntimeApplicationMode} from '../mode/runtime';

/** How long the vocabulary save toast stays visible (TASK-070). */
export const VOCAB_TOAST_DURATION_MS = 2500;

/**
 * TASK-070 toast payload; the kind picks the semantic role (status vs.
 * alert) and the text color (TASK-AUDIT-007 made it carry failure
 * feedback too, since the confirmation popup is gone).
 */
export type VocabToast = {text: string; kind: 'success' | 'error'};

export function useVocabularySave(options: {authedRequest: AuthedRequester}) {
  const {authedRequest} = options;
  const [toast, setToast] = useState<VocabToast | null>(null);
  // Stale-response guard: switching sessions invalidates any in-flight save.
  const vocabSaveRequestRef = useRef(0);
  const authedRequestRef = useRef(authedRequest);
  useEffect(() => {
    authedRequestRef.current = authedRequest;
  }, [authedRequest]);

  /**
   * Save one confirmed selection immediately. Optimistic chat rows carry
   * synthetic negative ids that are not real Message pks, so they are sent
   * without source attribution.
   *
   * Serverless mode has no server session (TASK-AUDIT-003): the save
   * attempt goes through anyway so the runtime gate rejects it with its
   * typed, user-visible error instead of a silent no-op — the gate fires
   * before any transport work, so nothing is ever transmitted. Both modes
   * call through the central authed requester (TASK-AUDIT-005).
   */
  const saveVocabularySelection = useCallback(
    (selectedText: string, messageId: number) => {
      const requestId = ++vocabSaveRequestRef.current;
      (async () => {
        try {
          const serverless = getRuntimeApplicationMode() === 'serverless';
          if (!serverless && vocabSaveRequestRef.current !== requestId) {
            return;
          }
          await saveVocabulary(
            authedRequestRef.current,
            selectedText,
            messageId > 0 ? messageId : undefined,
          );
          if (vocabSaveRequestRef.current !== requestId) {
            return;
          }
          setToast({text: 'Saved to vocabulary', kind: 'success'});
        } catch (err) {
          if (vocabSaveRequestRef.current === requestId) {
            setToast({text: toErrorMessage(err), kind: 'error'});
          }
        }
      })();
    },
    [],
  );

  /** Session switch: invalidate any in-flight save and drop the toast. */
  const invalidateVocabSave = useCallback(() => {
    vocabSaveRequestRef.current += 1;
    setToast(null);
  }, []);

  // TASK-070: the save toast (success or failure) dismisses itself after a
  // fixed delay.
  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timer = setTimeout(() => setToast(null), VOCAB_TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return {toast, saveVocabularySelection, invalidateVocabSave};
}
