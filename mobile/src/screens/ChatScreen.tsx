/**
 * Main conversation screen (SPEC TASK-048/049/050/052/053/054):
 * chronological message list, composer with send button, loading/error
 * states and keyboard handling.
 *
 * The screen loads an existing conversation through its `sessionId` route
 * param; without one it shows an empty state until a conversation is opened
 * or created (TASK-051). In server mode messages and session detail come
 * from the backend API; in serverless mode (TASK-090) both are read from the
 * on-device SQLite database and no backend request is made (Rule 9). Sending
 * posts the turn to POST /api/v1/sessions/{id}/messages/stream/ (server
 * mode) or streams it directly through OpenRouter via the local turn
 * service (TASK-086) and consumes the reply:
 * deltas land in a DeltaBuffer so token bursts commit at most once per tick
 * (TASK-050 render throttling), completion finalizes it and a silent reload
 * swaps optimistic rows for persisted ones. Error frames and transport
 * failures surface in an inline banner; leaving the screen aborts the
 * stream. Auto-scroll follows content growth only while the user rests near
 * the bottom; an intentional scroll up detaches the follow behavior and a
 * pill offers the way back down. A compact collapsible topic bar (TASK-052)
 * sits under the header once the session detail loads — one line of the
 * session title by default, full topic description on demand; a failed
 * detail fetch only hides the bar, never the conversation. When the route
 * carries sample turns from session creation, a "Show me an example" link
 * (TASK-053) opens the generated sample conversation in a dismissible modal
 * that stays fully separate from the chat history and exposes per-line TTS
 * controls through the speech seam. Failed assistant rows (persisted with
 * status failed) carry an inline Retry control (TASK-054): pressing it
 * re-arms that row locally exactly like the backend does and streams the
 * replacement attempt from POST .../messages/{id}/retry/ into the same
 * bubble through the shared turn pipeline. Long-pressing a message row with
 * real text (TASK-060) opens the contextual actions menu — Copy runs
 * immediately via the clipboard seam, Suggest replies (TASK-061) calls
 * the read-only suggestions endpoint and presents the three replies as
 * chips above the composer (tapping a chip inserts its text into the draft
 * without sending), Improve my English (TASK-064) calls the read-only
 * improvement endpoint and presents the outcome in a bottom sheet —
 * original vs. suggested rewrite plus a short explanation, with a Copy
 * action for the improved text — and Select text (TASK-069) opens a
 * bottom-sheet surface where a word, phrase or multi-word expression can be
 * selected inside that message and saved immediately (TASK-AUDIT-007 removed
 * the TASK-070 confirmation popup as redundant): pressing Save word closes
 * the sheet and fires the vocabulary API call at once (enrichment happens
 * server-side afterwards and is never awaited), success flashes a
 * self-dismissing toast and failure surfaces the normalized error as an
 * alert toast. Loading
 * and error states cover both
 * generation round-trips; the suggestion strip clears on send and the
 * suggestion strip, improvement sheet and vocabulary feedback clear on session
 * change. Read aloud (TASK-078) speaks the chosen message through the
 * speech seam with a single-playback contract — starting another message
 * stops the current one, the speaking bubble shows a visible Stop control,
 * failures only clear the state — and switching sessions silences playback.
 * Rendering performance (TASK-103): rows render through a memoized
 * MessageRow with stable prop identities, so a delta flush re-renders only
 * the streaming bubble while every untouched row bails out, and the FlatList
 * virtualization bounds keep long conversations mounted in a bounded window.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type {NativeScrollEvent, NativeSyntheticEvent} from 'react-native';

import type {ChatStreamEvent, ChatStreamHandle} from '../api/chatStream';
import {streamChatTurn, streamRetryTurn} from '../api/chatStream';
import type {ChatMessage, MessageImprovement, MessageSuggestions, Session} from '../api/sessions';
import {getMessageSuggestions, getSession, improveMessage, listMessages} from '../api/sessions';
import {saveVocabulary} from '../api/vocabulary';
import {toErrorMessage, useAuth} from '../auth/AuthContext';
import type {ChatScreenProps} from '../navigation/types';
import {copyText} from '../utils/clipboard';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';
import {useSpeechPlayback} from '../tts/useSpeechPlayback';
import {useApplicationMode} from '../mode/ModeContext';
import {getRuntimeApplicationMode} from '../mode/runtime';
import {getLocalDatabase} from '../db/database';
import {listMessages as listLocalMessages} from '../db/messageStore';
import {getSession as getLocalSession} from '../db/sessionStore';
import {createOpenRouterClient} from '../serverless/openrouterClient';
import {generateImprovement} from '../serverless/improvement';
import {generateSuggestions} from '../serverless/suggestions';
import {loadServerlessOpenRouterConfig} from '../serverless/settings';
import {
  retryServerlessTurn,
  streamServerlessTurn,
} from '../serverless/chatStreaming';
import {buildServerlessContext, updateSummaryIfNeeded} from '../serverless/conversationContext';
import type {OpenRouterClient, ServerlessStreamEvent} from '../serverless/types';
import {LocalConversationRepository} from '../db/conversationRepository';
import {getLearningProfile} from '../db/profileStore';
import type {LocalMessage} from '../db/types';
import {ImprovementSheet} from './ImprovementSheet';
import {MessageActionsMenu} from './MessageActionsMenu';
import type {MessageAction} from './MessageActionsMenu';
import {MessageRow, createRowStyles} from './MessageRow';
import {SampleConversationModal} from './SampleConversationModal';
import {TextSelectionSheet} from './TextSelectionSheet';
import {
  DeltaBuffer,
  isNearBottom,
  CHAT_LIST_INITIAL_NUM_TO_RENDER,
  CHAT_LIST_MAX_TO_RENDER_PER_BATCH,
  CHAT_LIST_WINDOW_SIZE,
  STICK_TO_BOTTOM_THRESHOLD_PX,
  STREAM_FLUSH_INTERVAL_MS,
} from './streamingUx';

function bySequence(a: ChatMessage, b: ChatMessage): number {
  return a.sequence - b.sequence;
}

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

/** Shown when a serverless turn starts without an OpenRouter configuration. */
const NO_SERVERLESS_CONFIG_MESSAGE =
  'Add your OpenRouter API key in Settings to chat without the server.';

/** How long the vocabulary save toast stays visible (TASK-070). */
export const VOCAB_TOAST_DURATION_MS = 2500;

/**
 * TASK-070 toast payload; the kind picks the semantic role (status vs.
 * alert) and the text color (TASK-AUDIT-007 made it carry failure
 * feedback too, since the confirmation popup is gone).
 */
type VocabToast = {text: string; kind: 'success' | 'error'};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.background,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    headerActions: {
      flexDirection: 'row',
      gap: 16,
    },
    headerLink: {
      fontSize: 15,
      fontWeight: '600',
      color: c.accent,
    },
    topicBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    topicMeta: {
      flex: 1,
    },
    topicTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
    },
    topicDescription: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textSecondary,
      marginTop: 4,
    },
    topicToggleGlyph: {
      fontSize: 14,
      color: c.accent,
    },
    body: {
      flex: 1,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      padding: 24,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: c.textPrimary,
      textAlign: 'center',
    },
    emptyHint: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
    },
    error: {
      color: c.errorText,
      fontSize: 14,
      textAlign: 'center',
    },
    retryButton: {
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 20,
      backgroundColor: c.surface,
    },
    retryText: {
      color: c.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    list: {
      flex: 1,
    },
    listContent: {
      paddingVertical: 16,
      paddingHorizontal: 16,
      gap: 10,
    },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 10,
      padding: 12,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.surface,
    },
    input: {
      flex: 1,
      minHeight: 42,
      maxHeight: 120,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 12,
      backgroundColor: c.background,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 15,
      color: c.textPrimary,
    },
    send: {
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 18,
    },
    sendDisabled: {
      opacity: 0.5,
    },
    sendText: {
      color: c.onPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    streamErrorBanner: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.surface,
    },
    listArea: {
      flex: 1,
    },
    jumpLatest: {
      position: 'absolute',
      right: 16,
      bottom: 12,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 999,
      paddingVertical: 8,
      paddingHorizontal: 14,
    },
    jumpLatestText: {
      color: c.accent,
      fontSize: 13,
      fontWeight: '600',
    },
    exampleBar: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    exampleLink: {
      fontSize: 13,
      fontWeight: '600',
      color: c.accent,
    },
    suggestionsBar: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.surface,
    },
    suggestionsLoading: {
      alignItems: 'center',
    },
    suggestionsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    suggestionChip: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 14,
      backgroundColor: c.background,
      paddingHorizontal: 12,
      paddingVertical: 8,
      maxWidth: '100%',
    },
    suggestionText: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textPrimary,
    },
    toast: {
      position: 'absolute',
      bottom: 96,
      left: 24,
      right: 24,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      alignItems: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.15,
      shadowRadius: 8,
      shadowOffset: {width: 0, height: 2},
      elevation: 6,
    },
    toastText: {
      color: c.success,
      fontSize: 14,
      fontWeight: '600',
      textAlign: 'center',
    },
    toastError: {
      borderColor: c.errorText,
    },
    toastTextError: {
      color: c.errorText,
    },
  });
}

export function ChatScreen({route, navigation}: ChatScreenProps) {
  const sessionId = route.params?.sessionId;
  // Sample turns exist only in the session-creation response, so they ride
  // in as a route param (TASK-053); sessions opened any other way have none.
  const sampleTurns = route.params?.sampleTurns;
  const hasSample = sampleTurns !== undefined && sampleTurns.length > 0;
  const {getAccessToken, authedRequest} = useAuth();
  const {colors} = useTheme();
  const {mode} = useApplicationMode();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Row styles are created once per theme so the memoized MessageRow sees a
  // stable `styles` prop (TASK-103).
  const rowStyles = useMemo(() => createRowStyles(colors), [colors]);

  const [loading, setLoading] = useState(sessionId !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [topicExpanded, setTopicExpanded] = useState(false);
  const [exampleVisible, setExampleVisible] = useState(false);
  const [draft, setDraft] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  // TASK-060: the message whose long-press menu is open; null when closed.
  const [menuMessage, setMenuMessage] = useState<ChatMessage | null>(null);
  // TASK-061: the suggestion set currently displayed (tied to its source
  // message), plus loading/error for the generation round-trip.
  const [suggestions, setSuggestions] = useState<MessageSuggestions & {
    messageId: number;
  } | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  // TASK-064: the improvement result currently displayed (tied to its
  // source message), plus loading/error for the generation round-trip. The
  // sheet is visible exactly while one of these three states is active.
  const [improvement, setImprovement] = useState<MessageImprovement & {
    messageId: number;
  } | null>(null);
  const [improvementLoading, setImprovementLoading] = useState(false);
  const [improvementError, setImprovementError] = useState<string | null>(null);
  // TASK-069: the message whose content is being combed for vocabulary in
  // the text-selection sheet; null while no sheet is open.
  const [selectionMessage, setSelectionMessage] = useState<ChatMessage | null>(null);
  // TASK-070: transient toast after an immediate vocabulary save — a
  // success confirmation or the normalized failure message (TASK-AUDIT-007
  // removed the confirmation popup); auto-dismissed after a fixed delay.
  const [toast, setToast] = useState<VocabToast | null>(null);
  // TASK-078: single-playback speech controller; speakingMessageId drives
  // the visible playback state on the bubble currently being read aloud.
  const {speakingId: speakingMessageId, speak, stop: stopSpeech} = useSpeechPlayback();

  // Latest-ref seam: the load effect keys on (session, reload) only, so an
  // auth-state transition never refetches the conversation behind the user's
  // back — the next opened session uses the fresh closure.
  const getAccessTokenRef = useRef(getAccessToken);
  useEffect(() => {
    getAccessTokenRef.current = getAccessToken;
  }, [getAccessToken]);
  // TASK-AUDIT-005: JSON endpoint calls go through the central authed
  // requester (401 → one shared refresh → one retry); only the SSE turn
  // streams keep the raw access token (their transport cannot replay).
  const authedRequestRef = useRef(authedRequest);
  useEffect(() => {
    authedRequestRef.current = authedRequest;
  }, [authedRequest]);

  // In-flight turn tracking: the abort handle plus the synthetic id of the
  // assistant bubble currently receiving deltas.
  const streamHandleRef = useRef<ChatStreamHandle | null>(null);
  const streamingAssistantIdRef = useRef<number | null>(null);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // TASK-061/088: ref for live messages access inside async callbacks without
  // adding them to useCallback dependencies.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // TASK-088: ref for live session access (needed for topic in serverless mode)
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // TASK-061: monotonically increasing request id; responses apply only
  // when both the session and no newer request superseded them. TASK-064
  // shares the pattern (own counter) so dismissing its sheet can also
  // invalidate an in-flight request.
  const suggestionsRequestRef = useRef(0);
  const improvementRequestRef = useRef(0);
  // TASK-070 shares the same stale-response guard: switching sessions
  // invalidates any in-flight save request.
  const vocabSaveRequestRef = useRef(0);

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
    [],
  );

  // Scroll-follow state: nearBottomRef is read inside callbacks without
  // re-rendering; the detached flag drives the jump-to-latest pill and
  // flips only at the threshold boundary.
  const listRef = useRef<FlatList<ChatMessage> | null>(null);
  const nearBottomRef = useRef(true);
  const [detachedFromBottom, setDetachedFromBottom] = useState(false);

  const resetMessages = useCallback(() => {
    setMessages(prev => (prev.length > 0 ? [] : prev));
  }, []);

  /** Cancel any in-flight turn; safe to call when nothing is running. */
  const endTurn = useCallback(() => {
    streamHandleRef.current?.abort();
    streamHandleRef.current = null;
    streamingAssistantIdRef.current = null;
    deltaBuffer.discard();
    setStreaming(false);
  }, [deltaBuffer]);

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
  }, []);

  useEffect(() => {
    let cancelled = false;

    setError(null);
    setStreamError(null);
    resetMessages();
    setSession(null);
    setTopicExpanded(false);
    setExampleVisible(false);
    setMenuMessage(null);
    suggestionsRequestRef.current += 1;
    setSuggestions(null);
    setSuggestionsLoading(false);
    setSuggestionsError(null);
    improvementRequestRef.current += 1;
    setImprovement(null);
    setImprovementLoading(false);
    setImprovementError(null);
    setSelectionMessage(null);
    vocabSaveRequestRef.current += 1;
    setToast(null);
    stopSpeech();
    nearBottomRef.current = true;
    setDetachedFromBottom(false);
    endTurn();
    if (sessionId === undefined) {
      setLoading(false);
      return;
    }

    setLoading(true);
    (async () => {
      try {
        if (mode === 'serverless') {
          // TASK-090: serverless conversations live in the on-device SQLite
          // database; no backend traffic happens in this mode (Rule 9). The
          // local session detail only feeds the topic bar, so its failure
          // resolves to null instead of failing the conversation.
          const db = await getLocalDatabase();
          const [rows, localSession] = await Promise.all([
            listLocalMessages(db, sessionId),
            getLocalSession(db, sessionId).catch(() => null),
          ]);
          if (!cancelled) {
            setMessages([...rows].sort(bySequence));
            setSession(localSession);
          }
          return;
        }
        const request = authedRequestRef.current;
        // The first page covers recent history; older pages arrive with the
        // history work (Phase 8 pagination UI). The session detail only
        // feeds the topic bar, so its failure resolves to null instead of
        // failing the conversation.
        const [page, detail] = await Promise.all([
          listMessages(request, sessionId),
          getSession(request, sessionId).catch(() => null),
        ]);
        if (!cancelled) {
          setMessages([...page.results].sort(bySequence));
          setSession(detail);
        }
      } catch (err) {
        if (!cancelled) {
          setError(toErrorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    // Leaving the screen or switching sessions also aborts an in-flight
    // stream so no turn outlives its UI.
    return () => {
      cancelled = true;
      endTurn();
    };
  }, [sessionId, reloadKey, mode, resetMessages, endTurn, stopSpeech]);

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
    [deltaBuffer, refreshMessages],
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
    [deltaBuffer, refreshMessages],
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
   * Serverless turn driver (TASK-086): resolves the OpenRouter client from
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
        client: OpenRouterClient,
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
        const client = createOpenRouterClient(config);
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
    (client: OpenRouterClient, repository: LocalConversationRepository, sid: number) =>
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
              stream: options => client.streamCompletion(options),
              buildRequest: buildServerlessContext,
              onEvent: serverlessOnEvent(client, repository, sid),
            }),
          );
          return;
        }
        let token: string | null = null;
        try {
          token = await getAccessTokenRef.current();
        } catch {
          token = null;
        }
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
    [failTurn, handleTurnEvent, mode, serverlessOnEvent, startServerlessTurn],
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
              stream: options => client.streamCompletion(options),
              buildRequest: buildServerlessContext,
              onEvent: serverlessOnEvent(client, repository, sid),
            }),
          );
          return;
        }
        let token: string | null = null;
        try {
          token = await getAccessTokenRef.current();
        } catch {
          token = null;
        }
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
    [failTurn, handleTurnEvent, mode, serverlessOnEvent, startServerlessTurn],
  );

/**
     * TASK-061: generate three suggested replies for one selected message
     * through the read-only suggestions endpoint. Nothing auto-sends — the
     * replies land as chips above the composer and tapping one merely fills
     * the draft. Stale responses (session switched or a newer request
     * started) are dropped instead of overwriting newer state.
     */
    const startSuggestions = useCallback((sid: number, messageId: number) => {
      const requestId = ++suggestionsRequestRef.current;
      setSuggestions(null);
      setSuggestionsError(null);
      setSuggestionsLoading(true);
      (async () => {
        try {
          if (mode === 'serverless') {
            // Serverless mode (TASK-088): generate suggestions locally with an
            // LLM call using the user's own OpenRouter key. No backend involved.
            const currentSession = sessionIdRef.current;
            const currentMessages = messagesRef.current;
            const currentSessionObj = sessionRef.current;
            const userMessage = currentMessages.find(m => m.id === messageId);
            const sessionTopic = currentSessionObj?.topic;
            if (
              currentSession === undefined ||
              !userMessage ||
              !sessionTopic
            ) {
              return;
            }

            // Load serverless OpenRouter configuration and create client
            const serverlessConfig = await loadServerlessOpenRouterConfig();
            if (!serverlessConfig) {
              return;
            }
            const client = createOpenRouterClient(serverlessConfig);

            // Load learning profile from local storage
            const db = await getLocalDatabase();
            const profile = await getLearningProfile(db);

            // Convert ChatMessage[] to LocalMessage[] for history
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
          // Server mode (TASK-061): ask the backend to generate suggestions
          // through the central authed requester (TASK-AUDIT-005).
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
  }, [mode]);

  /**
   * TASK-064/089: improve one selected user message. Server mode asks the
   * read-only improvement endpoint; serverless mode generates locally
   * through the user's own OpenRouter key — no backend request either way.
   * The result lands in a bottom sheet that shows the original verbatim,
   * the suggested rewrite and a short explanation; nothing about the stored
   * message changes. Stale responses (session switched, newer request
   * started, or the sheet explicitly dismissed) are dropped instead of
   * reopening stale UI.
   */
  const startImprovement = useCallback((sid: number, messageId: number) => {
    const requestId = ++improvementRequestRef.current;
    setImprovement(null);
    setImprovementError(null);
    setImprovementLoading(true);
    (async () => {
      try {
        if (mode === 'serverless') {
          // Serverless mode (TASK-089): correct the message locally with an
          // LLM call using the user's own OpenRouter key. No backend involved.
          const currentSession = sessionIdRef.current;
          const userMessage = messagesRef.current.find(m => m.id === messageId);
          if (currentSession === undefined || !userMessage) {
            return;
          }

          // Load serverless OpenRouter configuration and create client
          const serverlessConfig = await loadServerlessOpenRouterConfig();
          if (!serverlessConfig) {
            return;
          }
          const client = createOpenRouterClient(serverlessConfig);

          // Load learning profile from local storage
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
  }, [mode]);

  /** Sheet dismissal also invalidates any in-flight improvement request. */
  const closeImprovement = useCallback(() => {
    improvementRequestRef.current += 1;
    setImprovement(null);
    setImprovementError(null);
    setImprovementLoading(false);
  }, []);

  /** TASK-069: dismissing the selection sheet never captures anything. */
  const closeTextSelection = useCallback(() => {
    setSelectionMessage(null);
  }, []);

  /**
   * TASK-069/070: the vocabulary save flow's entry point — the selection
   * sheet hands its confirmed trimmed expression here and closes, and the
   * save starts immediately (TASK-AUDIT-007 removed the redundant TASK-070
   * confirmation popup).
   *
   * The endpoint returns as soon as the row is stored — enrichment happens
   * asynchronously server-side and is never awaited here — so success
   * flashes the confirmation toast, while failure surfaces the normalized
   * error as an alert toast (same auto-dismiss contract). Stale responses
   * (a session switched mid-flight) are dropped. Optimistic rows carry
   * synthetic negative ids that are not real Message pks, so they are sent
   * without source attribution.
   */
  const saveVocabularySelection = useCallback(
    (selectedText: string) => {
      if (selectionMessage === null) {
        return;
      }
      setSelectionMessage(null);
      const requestId = ++vocabSaveRequestRef.current;
      const messageId = selectionMessage.id;
      (async () => {
        try {
          const serverless = getRuntimeApplicationMode() === 'serverless';
          if (!serverless && vocabSaveRequestRef.current !== requestId) {
            return;
          }
          // Both modes call through the central authed requester
          // (TASK-AUDIT-005). Serverless mode has no server session
          // (TASK-AUDIT-003): the save attempt goes through anyway so the
          // runtime gate rejects it with its typed, user-visible error
          // instead of a silent no-op — the gate fires before any transport
          // work, so nothing is ever transmitted.
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
    [selectionMessage],
  );

  // TASK-070: the save toast (success or failure) dismisses itself after a
  // fixed delay.
  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timer = setTimeout(() => setToast(null), VOCAB_TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * Retry one failed assistant row (TASK-054): the backend re-arms that
   * exact row in place, so locally it becomes the streaming target — same
   * pending spinner, same buffered deltas — and completion flips it to
   * complete. A failure keeps the row failed after resync, leaving the
   * control available for another attempt.
   */
  const handleRetry = useCallback(
    (message: ChatMessage) => {
      if (sessionId === undefined || streaming) {
        return;
      }
      setStreamError(null);
      streamingAssistantIdRef.current = message.id;
      setMessages(prev =>
        prev.map(row =>
          row.id === message.id ? {...row, status: 'pending', content: ''} : row,
        ),
      );
      setStreaming(true);
      startRetry(sessionId, message.id);
    },
    [sessionId, streaming, startRetry],
  );

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || sessionId === undefined || streaming) {
      return;
    }
    setDraft('');
    setStreamError(null);
    // Stale suggestion chips would offer replies to a conversation that has
    // moved on; sending dismisses them along with any leftover error state.
    setSuggestions(null);
    setSuggestionsError(null);

    // Optimistic local echo + pending assistant bubble with stable
    // synthetic ids; sequences continue chronologically past the last row.
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
    startTurn(sessionId, text);
  }, [draft, sessionId, streaming, startTurn]);

  const canSend = draft.trim().length > 0 && !streaming;

  /**
   * TASK-078: speaking the same message again acts as a stop toggle; any
   * other message supersedes current playback through the hook.
   */
  const toggleSpeech = useCallback(
    (messageId: number, content: string) => {
      if (speakingMessageId === messageId) {
        stopSpeech();
        return;
      }
      speak(messageId, content);
    },
    [speakingMessageId, speak, stopSpeech],
  );

  /**
   * TASK-103: stable long-press callback shared by every row so the
   * memoized MessageRow's prop comparison never sees a fresh closure —
   * an inline arrow here would re-render every mounted bubble on each
   * delta flush.
   */
  const handleRowLongPress = useCallback((message: ChatMessage) => {
    setMenuMessage(message);
  }, []);

  /**
   * TASK-060 menu selection. Copy runs through the clipboard seam, Suggest
   * replies generates three candidate messages (TASK-061) that the user can
   * tap into the composer, Improve my English (TASK-064) opens the
   * improvement sheet for that message and Select text (TASK-069) opens the
   * vocabulary selection surface over its content; Read aloud (TASK-078)
   * speaks that message — or stops it when it is already speaking. Every
   * selection dismisses the menu.
   */
  const handleMenuAction = useCallback(
    (action: MessageAction) => {
      const message = menuMessage;
      setMenuMessage(null);
      if (!message || sessionId === undefined) {
        return;
      }
      if (action === 'copy') {
        copyText(message.content);
      } else if (action === 'suggest-replies') {
        startSuggestions(sessionId, message.id);
      } else if (action === 'improve-english') {
        startImprovement(sessionId, message.id);
      } else if (action === 'select-text') {
        setSelectionMessage(message);
      } else if (action === 'speak') {
        toggleSpeech(message.id, message.content);
      }
    },
    [menuMessage, sessionId, startImprovement, startSuggestions, toggleSpeech],
  );

  /** Follow the conversation tail; no-op when the list is not mounted. */
  const stickToBottom = useCallback((animated: boolean) => {
    listRef.current?.scrollToEnd({animated});
  }, []);

  /**
   * Content growth (streamed deltas, optimistic rows) keeps the viewport
   * pinned to the newest message — but only while the user is still reading
   * there. An intentional scroll up has already cleared the sticky flag, so
   * growth never yanks the view.
   */
  const handleContentSizeChange = useCallback(() => {
    if (nearBottomRef.current) {
      stickToBottom(false);
    }
  }, [stickToBottom]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
      const near = isNearBottom(
        {
          offsetY: contentOffset.y,
          contentHeight: contentSize.height,
          viewportHeight: layoutMeasurement.height,
        },
        STICK_TO_BOTTOM_THRESHOLD_PX,
      );
      nearBottomRef.current = near;
      setDetachedFromBottom(!near);
    },
    [],
  );

  const jumpToLatest = useCallback(() => {
    nearBottomRef.current = true;
    setDetachedFromBottom(false);
    stickToBottom(true);
  }, [stickToBottom]);

  const renderMessage = useCallback(
    ({item}: {item: ChatMessage}) => (
      <MessageRow
        item={item}
        styles={rowStyles}
        streaming={streaming}
        speaking={speakingMessageId === item.id}
        spinnerColor={colors.textMuted}
        onMessageLongPress={handleRowLongPress}
        onRetry={handleRetry}
        onStopSpeech={stopSpeech}
      />
    ),
    [
      rowStyles,
      streaming,
      speakingMessageId,
      colors.textMuted,
      handleRowLongPress,
      handleRetry,
      stopSpeech,
    ],
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'android' ? undefined : 'padding'}
      testID="chat-screen">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Chat</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => navigation.navigate('NewConversation')}
            testID="chat-open-new">
            <Text style={styles.headerLink}>New</Text>
          </Pressable>
          <Pressable onPress={() => navigation.navigate('History')} testID="chat-open-history">
            <Text style={styles.headerLink}>History</Text>
          </Pressable>
          <Pressable onPress={() => navigation.navigate('Settings')} testID="chat-open-settings">
            <Text style={styles.headerLink}>Settings</Text>
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator testID="chat-loading" color={colors.primary} />
        </View>
      ) : error !== null ? (
        <View style={styles.centered}>
          <Text role="alert" style={styles.error} testID="form-error">
            {error}
          </Text>
          <Pressable
            style={styles.retryButton}
            onPress={() => {
              setReloadKey(key => key + 1);
            }}
            testID="chat-retry">
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : sessionId === undefined ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle} testID="chat-no-session">
            No conversation yet
          </Text>
          <Text style={styles.emptyHint}>
            Open a past conversation from History or start a new one to practice English.
          </Text>
          <Pressable
            style={styles.retryButton}
            onPress={() => navigation.navigate('NewConversation')}
            testID="chat-start-new"
            accessibilityRole="button"
            accessibilityLabel="Start a new conversation">
            <Text style={styles.retryText}>Start a new conversation</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {session !== null ? (
            <Pressable
              style={styles.topicBar}
              onPress={() => {
                setTopicExpanded(expanded => !expanded);
              }}
              testID="chat-topic"
              accessibilityRole="button"
              accessibilityLabel={
                topicExpanded ? 'Hide topic details' : 'Show topic details'
              }
              accessibilityState={{expanded: topicExpanded}}>
              <View style={styles.topicMeta}>
                <Text
                  numberOfLines={topicExpanded ? undefined : 1}
                  style={styles.topicTitle}
                  testID="chat-topic-title">
                  {session.title}
                </Text>
                {topicExpanded ? (
                  <Text style={styles.topicDescription} testID="chat-topic-text">
                    {session.topic}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.topicToggleGlyph} testID="chat-topic-toggle">
                {topicExpanded ? '▴' : '▾'}
              </Text>
            </Pressable>
          ) : null}
          {hasSample ? (
            <Pressable
              style={styles.exampleBar}
              onPress={() => {
                setExampleVisible(true);
              }}
              testID="chat-show-example"
              accessibilityRole="button"
              accessibilityLabel="Show me an example">
              <Text style={styles.exampleLink}>Show me an example</Text>
            </Pressable>
          ) : null}
          <View style={styles.listArea}>
            <FlatList
              ref={listRef}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              data={messages}
              keyExtractor={message => String(message.id)}
              renderItem={renderMessage}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              onContentSizeChange={handleContentSizeChange}
              // TASK-103 virtualization bounds: mount a bounded slice of a
              // long conversation and grow it in steady batches.
              initialNumToRender={CHAT_LIST_INITIAL_NUM_TO_RENDER}
              maxToRenderPerBatch={CHAT_LIST_MAX_TO_RENDER_PER_BATCH}
              windowSize={CHAT_LIST_WINDOW_SIZE}
              ListEmptyComponent={
                <Text style={styles.emptyHint} testID="chat-empty">
                  Say hello to start the conversation.
                </Text>
              }
              testID="chat-list"
            />
            {detachedFromBottom ? (
              <Pressable
                style={styles.jumpLatest}
                onPress={jumpToLatest}
                testID="chat-jump-latest"
                accessibilityRole="button"
                accessibilityLabel="Jump to latest messages">
                <Text style={styles.jumpLatestText}>Jump to latest</Text>
              </Pressable>
            ) : null}
          </View>
          {streamError !== null ? (
            <View style={styles.streamErrorBanner}>
              <Text role="alert" style={styles.error} testID="chat-stream-error">
                {streamError}
              </Text>
            </View>
          ) : null}
          {suggestionsLoading ? (
            <View style={[styles.suggestionsBar, styles.suggestionsLoading]} testID="chat-suggestions-loading">
              <ActivityIndicator size="small" color={colors.textMuted} />
            </View>
          ) : suggestionsError !== null ? (
            <View style={styles.suggestionsBar}>
              <Text role="alert" style={styles.error} testID="chat-suggestions-error">
                {suggestionsError}
              </Text>
            </View>
          ) : suggestions !== null ? (
            <View style={[styles.suggestionsBar, styles.suggestionsRow]} testID="chat-suggestions">
              {suggestions.replies.map((reply, index) => (
                <Pressable
                  key={`${suggestions.messageId}-${index}`}
                  style={styles.suggestionChip}
                  onPress={() => {
                    // Insertion only — a suggestion is a draft, never an
                    // automatic send (ROADMAP §8).
                    setDraft(reply);
                    setSuggestions(null);
                  }}
                  testID={`chat-suggestion-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Insert suggested reply ${index + 1}`}>
                  <Text numberOfLines={3} style={styles.suggestionText}>
                    {reply}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.composer} testID="chat-composer">
            <TextInput
              style={styles.input}
              placeholder="Type a message"
              placeholderTextColor={colors.textMuted}
              multiline
              value={draft}
              onChangeText={setDraft}
              testID="composer-input"
            />
            <Pressable
              style={[styles.send, !canSend && styles.sendDisabled]}
              disabled={!canSend}
              onPress={handleSend}
              testID="chat-send">
              <Text style={styles.sendText}>Send</Text>
            </Pressable>
          </View>
          <SampleConversationModal
            visible={exampleVisible && hasSample}
            turns={sampleTurns ?? []}
            onClose={() => {
              setExampleVisible(false);
            }}
          />
          <ImprovementSheet
            visible={
              improvementLoading || improvementError !== null || improvement !== null
            }
            loading={improvementLoading}
            error={improvementError}
            result={improvement}
            onClose={closeImprovement}
          />
          <MessageActionsMenu
            visible={menuMessage !== null}
            role={menuMessage?.role ?? 'assistant'}
            onClose={() => {
              setMenuMessage(null);
            }}
            onSelect={handleMenuAction}
          />
          <TextSelectionSheet
            visible={selectionMessage !== null}
            content={selectionMessage?.content ?? ''}
            onClose={closeTextSelection}
            onSave={saveVocabularySelection}
          />
          {toast !== null ? (
            <View
              pointerEvents="none"
              style={[styles.toast, toast.kind === 'error' ? styles.toastError : null]}
              testID="chat-toast">
              <Text
                role={toast.kind === 'error' ? 'alert' : 'status'}
                style={[
                  styles.toastText,
                  toast.kind === 'error' ? styles.toastTextError : null,
                ]}
                testID="chat-toast-text">
                {toast.text}
              </Text>
            </View>
          ) : null}
        </>
      )}
    </KeyboardAvoidingView>
  );
}
