/**
 * Streaming turn pipeline for the chat conversation
 * (TASK-050/054/086; TASK-AUDIT-014 decomposition of the chat screen).
 *
 * Owns everything a "turn" means at runtime: the optimistic echo pair, the
 * delta-buffered stream into the pending assistant bubble, terminal
 * outcomes (completion swap-in, failure resync), retries of failed rows and
 * the abort lifecycle — for both application modes. Server mode streams
 * through the backend SSE endpoints with an access token; serverless mode
 * drives a local turn through the provider abstraction and the on-device
 * repository. The screen only decides when a turn starts; this hook runs
 * it and keeps the message list consistent.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {Dispatch, SetStateAction} from 'react';

import type {ChatStreamEvent, ChatStreamHandle} from '../api/chatStream';
import {streamChatTurn, streamRetryTurn} from '../api/chatStream';
import type {AuthedRequester} from '../auth/authedRequest';
import {toErrorMessage} from '../auth/AuthContext';
import type {ChatMessage} from '../api/sessions';
import {listMessages} from '../api/sessions';
import {LocalConversationRepository} from '../db/conversationRepository';
import {getLocalDatabase} from '../db/database';
import {listMessages as listLocalMessages} from '../db/messageStore';
import {getRuntimeApplicationMode} from '../mode/runtime';
import type {ApplicationMode} from '../mode/types';
import {
  buildServerlessContext,
  updateSummaryIfNeeded,
} from '../serverless/conversationContext';
import {retryServerlessTurn, streamServerlessTurn} from '../serverless/chatStreaming';
import {createProviderClient} from '../serverless/providerRegistry';
import {loadServerlessOpenRouterConfig} from '../serverless/settings';
import type {LLMClient, ServerlessStreamEvent} from '../serverless/types';
import {bySequence} from '../services/conversationSource';
import {DeltaBuffer, STREAM_FLUSH_INTERVAL_MS} from '../screens/streamingUx';

/**
 * Serverless turns (TASK-086) speak the same application event language as
 * the backend SSE protocol except for the terminal failure shape; map it so
 * one shared turn pipeline serves both modes.
 */
function toChatEvent(event: ServerlessStreamEvent): ChatStreamEvent {
  if (event.type === 'failed') {
    return {type: 'error', message: event.message, retryable: event.retryable};
  }
  return event;
}

/** Shown when a serverless turn starts without a provider configuration. */
const NO_SERVERLESS_CONFIG_MESSAGE =
  'Add your provider API key in Settings to chat without the server.';

/** Inputs the turn pipeline reads from its host screen. */
export interface UseChatTurnsOptions {
  sessionId: number | undefined;
  mode: ApplicationMode;
  /** Raw access token getter for the SSE streams (their transport cannot replay). */
  getAccessToken: () => Promise<string | null>;
  /** Central authed requester for the canonical JSON refresh. */
  authedRequest: AuthedRequester;
  /** Message-list owner; the pipeline applies deltas and turn outcomes to it. */
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

/** What the screen needs to start turns and reflect their state. */
export interface UseChatTurnsResult {
  /** True while a turn (fresh or retry) is in flight. */
  streaming: boolean;
  /** Banner text of the last failed turn; null when none is showing. */
  streamError: string | null;
  /** Clear the turn-error banner (session switches, fresh attempts). */
  clearStreamError(): void;
  /** Abort any in-flight turn; safe to call when nothing is running. */
  endTurn(): void;
  /** Optimistic echo + pending bubble, then stream the replacement attempt. */
  sendUserTurn(sessionId: number, text: string): void;
  /** Re-arm one failed assistant row locally and stream its replacement. */
  retryFailedTurn(sessionId: number, message: ChatMessage): void;
}

export function useChatTurns(options: UseChatTurnsOptions): UseChatTurnsResult {
  const {sessionId, mode, getAccessToken, authedRequest, setMessages} = options;

  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Latest-ref seams: the turn callbacks key on (session, request identity)
  // only, so an auth-state transition never restarts a turn behind the
  // user's back — the next turn uses the fresh closure.
  const getAccessTokenRef = useRef(getAccessToken);
  useEffect(() => {
    getAccessTokenRef.current = getAccessToken;
  }, [getAccessToken]);
  // TASK-AUDIT-005: JSON endpoint calls go through the central authed
  // requester (401 → one shared refresh → one retry); only the SSE turn
  // streams keep the raw access token.
  const authedRequestRef = useRef(authedRequest);
  useEffect(() => {
    authedRequestRef.current = authedRequest;
  }, [authedRequest]);

  /**
   * Single owner of the raw token hand-off to the SSE transport
   * (TASK-AUDIT-015): streams cannot be buffered and replayed, so they
   * deliberately receive the current access token instead of the refresh
   * wrapper — shared by fresh turns and retries alike.
   */
  const resolveStreamToken = useCallback(async (): Promise<string | null> => {
    try {
      return await getAccessTokenRef.current();
    } catch {
      return null;
    }
  }, []);

  // In-flight turn tracking: the abort handle plus the synthetic id of the
  // assistant bubble currently receiving deltas.
  const streamHandleRef = useRef<ChatStreamHandle | null>(null);
  const streamingAssistantIdRef = useRef<number | null>(null);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // TASK-050: delta commits run through a DeltaBuffer so token bursts cause
  // at most one message-list update per tick instead of one per SSE event.
  // The flush closure reads the live target id from the ref, so a tick that
  // lands after turn cleanup finds nothing to update.
  const deltaBuffer = useMemo(
    () =>
      new DeltaBuffer(chunk => {
        const targetId = streamingAssistantIdRef.current;
        if (targetId === null) {
          return;
        }
        setMessages(prev =>
          prev.map(message =>
            message.id === targetId
              ? {...message, content: message.content + chunk}
              : message,
          ),
        );
      }, STREAM_FLUSH_INTERVAL_MS),
    [setMessages],
  );

  /** Cancel any in-flight turn; safe to call when nothing is running. */
  const endTurn = useCallback(() => {
    streamHandleRef.current?.abort();
    streamHandleRef.current = null;
    streamingAssistantIdRef.current = null;
    deltaBuffer.discard();
    setStreaming(false);
  }, [deltaBuffer]);

  const clearStreamError = useCallback(() => {
    setStreamError(null);
  }, []);

  /**
   * Silent canonical refresh after a turn settles: replaces optimistic rows
   * (synthetic negative ids) with the persisted ones. Never flips the
   * loading spinner; failures keep whatever is already rendered.
   */
  const refreshMessages = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid === undefined) {
      return;
    }
    try {
      if (getRuntimeApplicationMode() === 'serverless') {
        // Serverless rows persist locally before the terminal event reaches
        // the consumer, so the canonical reload reads the local database.
        const db = await getLocalDatabase();
        const rows = await listLocalMessages(db, sid);
        if (sessionIdRef.current !== sid) {
          return;
        }
        setMessages([...rows].sort(bySequence));
        return;
      }
      if (sessionIdRef.current !== sid) {
        return;
      }
      const page = await listMessages(authedRequestRef.current, sid);
      if (sessionIdRef.current !== sid) {
        return;
      }
      setMessages([...page.results].sort(bySequence));
    } catch {
      // Best-effort sync; turn-level errors already have a visible banner.
    }
  }, [setMessages]);

  /**
   * Queue one streamed chunk for the assistant bubble of this turn. The
   * text is committed on the next flush tick (or earlier via flushNow), so
   * arrival frequency never dictates render frequency.
   */
  const appendDelta = useCallback(
    (delta: string) => {
      if (streamingAssistantIdRef.current === null) {
        return;
      }
      deltaBuffer.push(delta);
    },
    [deltaBuffer],
  );

  /**
   * Turn failed: drop optimistic rows, surface the reason and re-sync with
   * the server (a committed user row / failed assistant row reappears; for
   * TASK-054 retries every row is persisted, so nothing is dropped and the
   * resync restores the still-failed row). Buffered-but-unflushed deltas
   * die here — they must never land after the rows are gone.
   */
  const failTurn = useCallback(
    (message: string) => {
      streamHandleRef.current = null;
      streamingAssistantIdRef.current = null;
      deltaBuffer.discard();
      setStreaming(false);
      setStreamError(message);
      setMessages(prev => (prev.some(m => m.id < 0) ? prev.filter(m => m.id > 0) : prev));
      refreshMessages();
    },
    [deltaBuffer, refreshMessages, setMessages],
  );

  const completeTurn = useCallback(
    (text: string) => {
      // The completed frame carries the authoritative full text, so any
      // still-buffered deltas are superseded rather than appended.
      deltaBuffer.discard();
      const targetId = streamingAssistantIdRef.current;
      setMessages(prev =>
        targetId === null
          ? prev
          : prev.map(message =>
              message.id === targetId
                ? {...message, status: 'complete', content: text}
                : message,
            ),
      );
      streamHandleRef.current = null;
      streamingAssistantIdRef.current = null;
      setStreaming(false);
      // Swap the optimistic echo pair for the persisted rows (real ids).
      refreshMessages();
    },
    [deltaBuffer, refreshMessages, setMessages],
  );

  /** One shared SSE event pipeline for fresh turns and retries alike. */
  const handleTurnEvent = useCallback(
    (event: ChatStreamEvent): void => {
      switch (event.type) {
        case 'start':
          break;
        case 'delta':
          appendDelta(event.text);
          break;
        case 'completed':
          completeTurn(event.text);
          break;
        case 'error':
          failTurn(event.message);
          break;
      }
    },
    [appendDelta, completeTurn, failTurn],
  );

  /**
   * Serverless turn driver (TASK-086): resolves the provider client from
   * the on-device configuration, runs one local turn through the shared
   * event pipeline and keeps the abort handle for screen-level cleanup.
   * Between the configuration read and the handle assignment the optimistic
   * turn may already have ended (navigation, a fast terminal event), so a
   * stale handle is never stored; terminal events are persisted before
   * delivery, which keeps the post-completion canonical reload exact.
   */
  const startServerlessTurn = useCallback(
    (
      sid: number,
      startTurnFn: (
        client: LLMClient,
        repository: LocalConversationRepository,
      ) => Promise<ChatStreamHandle>,
    ) => {
      (async () => {
        const config = await loadServerlessOpenRouterConfig();
        if (!config) {
          failTurn(NO_SERVERLESS_CONFIG_MESSAGE);
          return;
        }
        if (sessionIdRef.current !== sid || streamingAssistantIdRef.current === null) {
          return;
        }
        const client = createProviderClient(config);
        const repository = new LocalConversationRepository(getLocalDatabase);
        try {
          const handle = await startTurnFn(client, repository);
          if (streamingAssistantIdRef.current !== null) {
            streamHandleRef.current = handle;
          }
        } catch (err) {
          failTurn(toErrorMessage(err));
        }
      })();
    },
    [failTurn],
  );

  /** Shared serverless event pipeline: terminal outcomes drive turn state. */
  const serverlessOnEvent = useCallback(
    (client: LLMClient, repository: LocalConversationRepository, sid: number) =>
      (event: ServerlessStreamEvent): void => {
        if (event.type === 'completed') {
          // Post-turn summary maintenance (TASK-087) never blocks the
          // user-facing stream and never fails the turn.
          updateSummaryIfNeeded(repository, client, sid).catch(() => undefined);
        }
        handleTurnEvent(toChatEvent(event));
      },
    [handleTurnEvent],
  );

  const startTurn = useCallback(
    (sid: number, text: string) => {
      (async () => {
        if (mode === 'serverless') {
          startServerlessTurn(sid, (client, repository) =>
            streamServerlessTurn({
              sessionId: sid,
              text,
              openDb: getLocalDatabase,
              stream: streamOptions => client.streamCompletion(streamOptions),
              buildRequest: buildServerlessContext,
              onEvent: serverlessOnEvent(client, repository, sid),
            }),
          );
          return;
        }
        const token = await resolveStreamToken();
        if (sessionIdRef.current !== sid) {
          return;
        }
        if (!token) {
          failTurn('You need to sign in again to send messages.');
          return;
        }
        streamHandleRef.current = streamChatTurn({
          token,
          sessionId: sid,
          text,
          onEvent: handleTurnEvent,
          onError: err => {
            failTurn(toErrorMessage(err));
          },
        });
      })();
    },
    [failTurn, handleTurnEvent, mode, resolveStreamToken, serverlessOnEvent, startServerlessTurn],
  );

  const startRetry = useCallback(
    (sid: number, messageId: number) => {
      (async () => {
        if (mode === 'serverless') {
          startServerlessTurn(sid, (client, repository) =>
            retryServerlessTurn({
              sessionId: sid,
              messageId,
              openDb: getLocalDatabase,
              stream: streamOptions => client.streamCompletion(streamOptions),
              buildRequest: buildServerlessContext,
              onEvent: serverlessOnEvent(client, repository, sid),
            }),
          );
          return;
        }
        const token = await resolveStreamToken();
        if (sessionIdRef.current !== sid) {
          return;
        }
        if (!token) {
          failTurn('You need to sign in again to send messages.');
          return;
        }
        streamHandleRef.current = streamRetryTurn({
          token,
          sessionId: sid,
          messageId,
          onEvent: handleTurnEvent,
          onError: err => {
            failTurn(toErrorMessage(err));
          },
        });
      })();
    },
    [failTurn, handleTurnEvent, mode, resolveStreamToken, serverlessOnEvent, startServerlessTurn],
  );

  /**
   * Fresh turn entry: optimistic local echo + pending assistant bubble with
   * stable synthetic ids (sequences continue chronologically past the last
   * row), then the mode-branched stream. The screen guards the draft and
   * clears per-turn transient state before calling.
   */
  const sendUserTurn = useCallback(
    (sid: number, text: string) => {
      setStreamError(null);
      const echoId = -Date.now();
      const replyId = echoId - 1;
      streamingAssistantIdRef.current = replyId;
      setMessages(prev => {
        const last = prev.length > 0 ? prev[prev.length - 1] : null;
        const baseSequence = last ? last.sequence + 1 : 1;
        const now = new Date().toISOString();
        const userEcho: ChatMessage = {
          id: echoId,
          role: 'user',
          status: 'complete',
          content: text,
          sequence: baseSequence,
          created_at: now,
        };
        const placeholder: ChatMessage = {
          id: replyId,
          role: 'assistant',
          status: 'pending',
          content: '',
          sequence: baseSequence + 1,
          created_at: now,
        };
        return [...prev, userEcho, placeholder];
      });
      setStreaming(true);
      startTurn(sid, text);
    },
    [setMessages, startTurn],
  );

  /**
   * Retry one failed assistant row (TASK-054): the backend re-arms that
   * exact row in place, so locally it becomes the streaming target — same
   * pending spinner, same buffered deltas — and completion flips it to
   * complete. A failure keeps the row failed after resync, leaving the
   * control available for another attempt.
   */
  const retryFailedTurn = useCallback(
    (sid: number, message: ChatMessage) => {
      setStreamError(null);
      streamingAssistantIdRef.current = message.id;
      setMessages(prev =>
        prev.map(row =>
          row.id === message.id ? {...row, status: 'pending', content: ''} : row,
        ),
      );
      setStreaming(true);
      startRetry(sid, message.id);
    },
    [setMessages, startRetry],
  );

  return {
    streaming,
    streamError,
    clearStreamError,
    endTurn,
    sendUserTurn,
    retryFailedTurn,
  };
}
