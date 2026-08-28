/**
 * Message improvement for one selected user message (TASK-064/089;
 * TASK-AUDIT-014 decomposition of the chat screen).
 *
 * Server mode asks the read-only improvement endpoint through the central
 * authed requester; serverless mode generates locally through the user's
 * own provider key — no backend request either way. The result lands in a
 * bottom sheet that shows the original verbatim, the suggested rewrite and
 * a short explanation; nothing about the stored message changes. Stale
 * responses (session switched, newer request started, or the sheet
 * explicitly dismissed) are dropped instead of reopening stale UI.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import type {ChatMessage, MessageImprovement} from '../api/sessions';
import {improveMessage} from '../api/sessions';
import type {AuthedRequester} from '../auth/authedRequest';
import {toErrorMessage} from '../auth/AuthContext';
import {getLocalDatabase} from '../db/database';
import {getLearningProfile} from '../db/profileStore';
import type {ApplicationMode} from '../mode/types';
import {generateImprovement} from '../serverless/improvement';
import {createProviderClient} from '../serverless/providerRegistry';
import {loadServerlessOpenRouterConfig} from '../serverless/settings';

/** The improvement result currently displayed, tied to its source message. */
export type DisplayedImprovement = MessageImprovement & {messageId: number};

export interface UseMessageImprovementOptions {
  sessionId: number | undefined;
  mode: ApplicationMode;
  authedRequest: AuthedRequester;
  /** Live conversation rows; the selected message content feeds the prompt. */
  messages: ChatMessage[];
}

export function useMessageImprovement(options: UseMessageImprovementOptions) {
  const {sessionId, mode, authedRequest, messages} = options;

  const [improvement, setImprovement] = useState<DisplayedImprovement | null>(null);
  const [improvementLoading, setImprovementLoading] = useState(false);
  const [improvementError, setImprovementError] = useState<string | null>(null);

  // Monotonically increasing request id; responses apply only when both the
  // session and no newer request superseded them. Dismissing the sheet
  // shares the same guard, so closing it can also invalidate an in-flight
  // request.
  const improvementRequestRef = useRef(0);

  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const authedRequestRef = useRef(authedRequest);
  useEffect(() => {
    authedRequestRef.current = authedRequest;
  }, [authedRequest]);

  /**
   * Improve one selected user message. Serverless mode (TASK-089) corrects
   * the message locally with an LLM call using the user's own provider key;
   * server mode (TASK-063) goes through the backend endpoint.
   */
  const startImprovement = useCallback(
    (sid: number, messageId: number) => {
      const requestId = ++improvementRequestRef.current;
      setImprovement(null);
      setImprovementError(null);
      setImprovementLoading(true);
      (async () => {
        try {
          if (mode === 'serverless') {
            const currentSession = sessionIdRef.current;
            const userMessage = messagesRef.current.find(m => m.id === messageId);
            if (currentSession === undefined || !userMessage) {
              return;
            }

            // Load the on-device provider configuration and client.
            const serverlessConfig = await loadServerlessOpenRouterConfig();
            if (!serverlessConfig) {
              return;
            }
            const client = createProviderClient(serverlessConfig);

            // Load the learning profile from local storage.
            const db = await getLocalDatabase();
            const profile = await getLearningProfile(db);

            const result = await generateImprovement(client, {
              level: profile.level,
              originalMessage: userMessage.content,
            });

            if (
              sessionIdRef.current !== currentSession ||
              improvementRequestRef.current !== requestId
            ) {
              return;
            }
            setImprovement({...result, messageId});
          } else {
            // Server mode (TASK-063): ask the backend to improve the message
            // through the central authed requester (TASK-AUDIT-005).
            if (
              sessionIdRef.current !== sid ||
              improvementRequestRef.current !== requestId
            ) {
              return;
            }
            const result = await improveMessage(authedRequestRef.current, sid, messageId);
            if (
              sessionIdRef.current !== sid ||
              improvementRequestRef.current !== requestId
            ) {
              return;
            }
            setImprovement({...result, messageId});
          }
        } catch (err) {
          if (
            sessionIdRef.current === sid &&
            improvementRequestRef.current === requestId
          ) {
            setImprovementError(toErrorMessage(err));
          }
        } finally {
          if (improvementRequestRef.current === requestId) {
            setImprovementLoading(false);
          }
        }
      })();
    },
    [mode],
  );

  /**
   * Sheet dismissal and session switches share one invalidation: any
   * in-flight request is dropped and the sheet's state clears.
   */
  const invalidateImprovement = useCallback(() => {
    improvementRequestRef.current += 1;
    setImprovement(null);
    setImprovementError(null);
    setImprovementLoading(false);
  }, []);

  return {
    improvement,
    improvementLoading,
    improvementError,
    startImprovement,
    invalidateImprovement,
  };
}
