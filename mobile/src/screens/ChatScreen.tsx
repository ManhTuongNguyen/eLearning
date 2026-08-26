/**
 * Main conversation screen (SPEC TASK-048/049/050/052/053/054):
 * chronological message list, composer with send button, loading/error
 * states and keyboard handling.
 *
 * The screen loads an existing conversation through its `sessionId` route
 * param; without one it shows an empty state until a conversation is opened
 * or created (TASK-051). Sending posts the turn to
 * POST /api/v1/sessions/{id}/messages/stream/ and consumes the SSE reply:
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
 * selected inside that message and handed to the vocabulary save flow
 * (the immediate save round-trip arrives with TASK-070). Loading and error
 * states cover both
 * generation round-trips; the suggestion strip clears on send and both it
 * and the improvement sheet clear on session change, while speech selection
 * stays a seam for its upcoming task.
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
import {toErrorMessage, useAuth} from '../auth/AuthContext';
import type {ChatScreenProps} from '../navigation/types';
import {copyText} from '../utils/clipboard';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';
import {ImprovementSheet} from './ImprovementSheet';
import {MessageActionsMenu} from './MessageActionsMenu';
import type {MessageAction} from './MessageActionsMenu';
import {SampleConversationModal} from './SampleConversationModal';
import {TextSelectionSheet} from './TextSelectionSheet';
import {
  DeltaBuffer,
  isNearBottom,
  STICK_TO_BOTTOM_THRESHOLD_PX,
  STREAM_FLUSH_INTERVAL_MS,
} from './streamingUx';

function bySequence(a: ChatMessage, b: ChatMessage): number {
  return a.sequence - b.sequence;
}

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
    messageRetry: {
      alignSelf: 'flex-start',
      marginTop: 6,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingVertical: 5,
      paddingHorizontal: 14,
      backgroundColor: c.surface,
    },
    messageRetryDisabled: {
      opacity: 0.5,
    },
    messageRetryText: {
      color: c.textPrimary,
      fontSize: 13,
      fontWeight: '600',
    },
    failedNote: {
      fontSize: 14,
      lineHeight: 20,
      color: c.textMuted,
    },
    list: {
      flex: 1,
    },
    listContent: {
      paddingVertical: 16,
      paddingHorizontal: 16,
      gap: 10,
    },
    row: {
      flexDirection: 'row',
    },
    rowUser: {
      justifyContent: 'flex-end',
    },
    bubble: {
      maxWidth: '82%',
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    bubbleUser: {
      backgroundColor: c.primary,
      borderBottomRightRadius: 4,
    },
    bubbleAssistant: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderBottomLeftRadius: 4,
    },
    content: {
      fontSize: 15,
      lineHeight: 21,
    },
    contentUser: {
      color: c.onPrimary,
    },
    contentAssistant: {
      color: c.textPrimary,
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
  });
}

export function ChatScreen({route, navigation}: ChatScreenProps) {
  const sessionId = route.params?.sessionId;
  // Sample turns exist only in the session-creation response, so they ride
  // in as a route param (TASK-053); sessions opened any other way have none.
  const sampleTurns = route.params?.sampleTurns;
  const hasSample = sampleTurns !== undefined && sampleTurns.length > 0;
  const {getAccessToken} = useAuth();
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

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

  // Latest-ref seam: the load effect keys on (session, reload) only, so an
  // auth-state transition never refetches the conversation behind the user's
  // back — the next opened session uses the fresh closure.
  const getAccessTokenRef = useRef(getAccessToken);
  useEffect(() => {
    getAccessTokenRef.current = getAccessToken;
  }, [getAccessToken]);

  // In-flight turn tracking: the abort handle plus the synthetic id of the
  // assistant bubble currently receiving deltas.
  const streamHandleRef = useRef<ChatStreamHandle | null>(null);
  const streamingAssistantIdRef = useRef<number | null>(null);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // TASK-061: monotonically increasing request id; responses apply only
  // when both the session and no newer request superseded them. TASK-064
  // shares the pattern (own counter) so dismissing its sheet can also
  // invalidate an in-flight request.
  const suggestionsRequestRef = useRef(0);
  const improvementRequestRef = useRef(0);

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
      const token = await getAccessTokenRef.current();
      if (!token || sessionIdRef.current !== sid) {
        return;
      }
      const page = await listMessages(token, sid);
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
        const token = await getAccessTokenRef.current();
        if (!token) {
          throw new Error('You need to sign in again to open this conversation.');
        }
        // The first page covers recent history; older pages arrive with the
        // history work (Phase 8 pagination UI). The session detail only
        // feeds the topic bar, so its failure resolves to null instead of
        // failing the conversation.
        const [page, detail] = await Promise.all([
          listMessages(token, sessionId),
          getSession(token, sessionId).catch(() => null),
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
  }, [sessionId, reloadKey, resetMessages, endTurn]);

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

  const startTurn = useCallback(
    (sid: number, text: string) => {
      (async () => {
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
    [failTurn, handleTurnEvent],
  );

  const startRetry = useCallback(
    (sid: number, messageId: number) => {
      (async () => {
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
    [failTurn, handleTurnEvent],
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
        let token: string | null = null;
        try {
          token = await getAccessTokenRef.current();
        } catch {
          token = null;
        }
        if (
          !token ||
          sessionIdRef.current !== sid ||
          suggestionsRequestRef.current !== requestId
        ) {
          return;
        }
        const result = await getMessageSuggestions(token, sid, messageId);
        if (
          sessionIdRef.current !== sid ||
          suggestionsRequestRef.current !== requestId
        ) {
          return;
        }
        setSuggestions({...result, messageId});
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
  }, []);

  /**
   * TASK-064: improve one selected user message through the read-only
   * improvement endpoint. The result lands in a bottom sheet that shows
   * the original verbatim, the suggested rewrite and a short explanation;
   * nothing about the stored message changes. Stale responses (session
   * switched, newer request started, or the sheet explicitly dismissed)
   * are dropped instead of reopening stale UI.
   */
  const startImprovement = useCallback((sid: number, messageId: number) => {
    const requestId = ++improvementRequestRef.current;
    setImprovement(null);
    setImprovementError(null);
    setImprovementLoading(true);
    (async () => {
      try {
        let token: string | null = null;
        try {
          token = await getAccessTokenRef.current();
        } catch {
          token = null;
        }
        if (
          !token ||
          sessionIdRef.current !== sid ||
          improvementRequestRef.current !== requestId
        ) {
          return;
        }
        const result = await improveMessage(token, sid, messageId);
        if (
          sessionIdRef.current !== sid ||
          improvementRequestRef.current !== requestId
        ) {
          return;
        }
        setImprovement({...result, messageId});
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
  }, []);

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
   * TASK-069: the vocabulary save flow's entry point — the selection sheet
   * hands its confirmed expression here and closes. The immediate save
   * round-trip (popup, API call, toast) is layered onto this seam by its
   * upcoming task, which will consume `_selectedText`.
   */
  const saveVocabularySelection = useCallback((_selectedText: string) => {
    setSelectionMessage(null);
  }, []);

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
   * TASK-060 menu selection. Copy runs through the clipboard seam, Suggest
   * replies generates three candidate messages (TASK-061) that the user can
   * tap into the composer, Improve my English (TASK-064) opens the
   * improvement sheet for that message and Select text (TASK-069) opens the
   * vocabulary selection surface over its content; speech (TASK-078) remains
   * a deliberate seam for its upcoming task, exactly like the TASK-048
   * composer send preceded its wire call. Every selection dismisses the
   * menu.
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
      }
    },
    [menuMessage, sessionId, startImprovement, startSuggestions],
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
    ({item}: {item: ChatMessage}) => {
      const isUser = item.role === 'user';
      const failed = !isUser && item.status === 'failed';
      const waiting =
        item.status === 'pending' && item.role === 'assistant' && item.content === '';
      // Only rows with real text offer the long-press menu (TASK-060):
      // pending spinners and failed rows carry nothing actionable, and the
      // backend rejects them as suggestion targets anyway.
      const menuEligible = item.status === 'complete' && item.content.trim().length > 0;
      return (
        <View style={[styles.row, isUser && styles.rowUser]}>
          <View>
            <Pressable
              style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}
              testID={`chat-message-${item.id}`}
              onLongPress={
                menuEligible
                  ? () => {
                      setMenuMessage(item);
                    }
                  : undefined
              }>
              {waiting ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : failed ? (
                <Text style={[styles.content, styles.failedNote]}>
                  The response failed to generate.
                </Text>
              ) : (
                <Text style={[styles.content, isUser ? styles.contentUser : styles.contentAssistant]}>
                  {item.content}
                </Text>
              )}
            </Pressable>
            {failed ? (
              <Pressable
                style={[styles.messageRetry, streaming && styles.messageRetryDisabled]}
                disabled={streaming}
                onPress={() => {
                  handleRetry(item);
                }}
                accessibilityRole="button"
                accessibilityLabel="Retry failed response"
                accessibilityState={{disabled: streaming}}
                testID={`chat-retry-${item.id}`}>
                <Text style={styles.messageRetryText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      );
    },
    [styles, colors.textMuted, streaming, handleRetry],
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
        </>
      )}
    </KeyboardAvoidingView>
  );
}
