/**
 * Suggested-replies generation for one selected message (TASK-061/088;
 * TASK-AUDIT-014 decomposition of the chat screen).
 *
 * Server mode asks the read-only suggestions endpoint through the central
 * authed requester; serverless mode generates locally with the user's own
 * provider key — no backend involved either way. Nothing auto-sends: the
 * replies land as chips above the composer and tapping one merely fills the
 * draft. Stale responses (session switched or a newer request started) are
 * dropped instead of overwriting newer state.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import type {ChatMessage, MessageSuggestions, Session} from '../api/sessions';
import {getMessageSuggestions} from '../api/sessions';
import type {AuthedRequester} from '../auth/authedRequest';
import {toErrorMessage} from '../auth/AuthContext';
import {getLocalDatabase} from '../db/database';
import {getLearningProfile} from '../db/profileStore';
import type {LocalMessage} from '../db/types';
import type {ApplicationMode} from '../mode/types';
import {createProviderClient} from '../serverless/providerRegistry';
import {loadServerlessOpenRouterConfig} from '../serverless/settings';
import {generateSuggestions} from '../serverless/suggestions';

/** The suggestion set currently displayed, tied to its source message. */
export type DisplayedSuggestions = MessageSuggestions & {messageId: number};

export interface UseMessageSuggestionsOptions {
  sessionId: number | undefined;
  mode: ApplicationMode;
  authedRequest: AuthedRequester;
  /** Live conversation rows; the serverless history is derived from them. */
  messages: ChatMessage[];
  /** Current session detail; the serverless topic feeds the prompt. */
  session: Session | null;
}

export function useMessageSuggestions(options: UseMessageSuggestionsOptions) {
  const {sessionId, mode, authedRequest, messages, session} = options;

  const [suggestions, setSuggestions] = useState<DisplayedSuggestions | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);

  // Monotonically increasing request id; responses apply only when both the
  // session and no newer request superseded them.
  const suggestionsRequestRef = useRef(0);

  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const authedRequestRef = useRef(authedRequest);
  useEffect(() => {
    authedRequestRef.current = authedRequest;
  }, [authedRequest]);

  /**
   * Generate three suggested replies for one selected message. Serverless
   * mode (TASK-088) derives the conversation history locally and calls the
   * provider with the user's own key; server mode (TASK-061) goes through
   * the backend endpoint.
   */
  const startSuggestions = useCallback(
    (sid: number, messageId: number) => {
      const requestId = ++suggestionsRequestRef.current;
      setSuggestions(null);
      setSuggestionsError(null);
      setSuggestionsLoading(true);
      (async () => {
        try {
          if (mode === 'serverless') {
            const currentSession = sessionIdRef.current;
            const currentMessages = messagesRef.current;
            const currentSessionObj = sessionRef.current;
            const userMessage = currentMessages.find(m => m.id === messageId);
            const sessionTopic = currentSessionObj?.topic;
            if (currentSession === undefined || !userMessage || !sessionTopic) {
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

            // Convert ChatMessage[] to LocalMessage[] for history.
            const history: readonly LocalMessage[] = currentMessages
              .filter(m => m.sequence < userMessage.sequence)
              .map(m => ({
                id: m.id,
                session_id: currentSession,
                role: m.role,
                status: m.status,
                content: m.content,
                sequence: m.sequence,
                created_at: m.created_at,
              }));

            const result = await generateSuggestions(client, {
              level: profile.level,
              topic: {
                title: sessionTopic,
                description: '',
              },
              selectedMessage: userMessage.content,
              history,
            });

            if (
              sessionIdRef.current !== currentSession ||
              suggestionsRequestRef.current !== requestId
            ) {
              return;
            }
            setSuggestions({messageId, replies: [...result.replies]});
          } else {
            // Server mode (TASK-061): ask the backend to generate
            // suggestions through the central authed requester
            // (TASK-AUDIT-005).
            if (
              sessionIdRef.current !== sid ||
              suggestionsRequestRef.current !== requestId
            ) {
              return;
            }
            const result = await getMessageSuggestions(
              authedRequestRef.current,
              sid,
              messageId,
            );
            if (
              sessionIdRef.current !== sid ||
              suggestionsRequestRef.current !== requestId
            ) {
              return;
            }
            setSuggestions({...result, messageId});
          }
        } catch (err) {
          if (
            sessionIdRef.current === sid &&
            suggestionsRequestRef.current === requestId
          ) {
            setSuggestionsError(toErrorMessage(err));
          }
        } finally {
          if (suggestionsRequestRef.current === requestId) {
            setSuggestionsLoading(false);
          }
        }
      })();
    },
    [mode],
  );

  /** Drop the chips (send, chip tap); a shown set never carries an error. */
  const clearSuggestions = useCallback(() => {
    setSuggestions(null);
    setSuggestionsError(null);
  }, []);

  /** Session switch: invalidate any in-flight request and clear all state. */
  const invalidateSuggestions = useCallback(() => {
    suggestionsRequestRef.current += 1;
    setSuggestions(null);
    setSuggestionsLoading(false);
    setSuggestionsError(null);
  }, []);

  return {
    suggestions,
    suggestionsLoading,
    suggestionsError,
    startSuggestions,
    clearSuggestions,
    invalidateSuggestions,
  };
}
