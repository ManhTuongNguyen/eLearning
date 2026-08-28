/**
 * Main conversation screen (SPEC TASK-048/049/050/052/053/054):
 * chronological message list, composer with send button, loading/error
 * states and keyboard handling.
 *
 * The screen loads an existing conversation through its `sessionId` route
 * param; without one — the post-login and post-restore landing state — it
 * derives its state from the authoritative history (TASK-AUDIT-008): the
 * most recent conversation replaces the param-less route in place, a
 * confirmed-empty history shows the empty state (TASK-051), and a failed
 * history lookup surfaces an error with retry instead of a false "empty"
 * claim. The lookup re-runs whenever the route regains focus, so a check
 * that settled while the user was elsewhere never leaves a stale state
 * behind. In server mode messages and session detail come
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
 *
 * Responsibilities (TASK-AUDIT-014): the screen coordinates navigation,
 * layout, presentation and interaction wiring only. The turn-streaming
 * pipeline lives in `useChatTurns`, suggestion/improvement generation in
 * their hooks, the vocabulary save flow in `useVocabularySave`, the
 * scroll-follow behavior in `useFollowBottom` and the mode-branched
 * conversation reads in `services/conversationSource`.
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

import type {ChatMessage, Session} from '../api/sessions';
import {toErrorMessage, useAuth} from '../auth/AuthContext';
import {
  useMessageImprovement,
} from '../hooks/useMessageImprovement';
import {
  useMessageSuggestions,
} from '../hooks/useMessageSuggestions';
import {
  useVocabularySave,
  VOCAB_TOAST_DURATION_MS,
} from '../hooks/useVocabularySave';
import {useChatTurns} from '../hooks/useChatTurns';
import {useFollowBottom} from '../hooks/useFollowBottom';
import type {ChatScreenProps} from '../navigation/types';
import {useApplicationMode} from '../mode/ModeContext';
import {listFirstSessionPage, loadConversation} from '../services/conversationSource';
import {
  CHAT_LIST_INITIAL_NUM_TO_RENDER,
  CHAT_LIST_MAX_TO_RENDER_PER_BATCH,
  CHAT_LIST_WINDOW_SIZE,
} from './streamingUx';
import {ImprovementSheet} from './ImprovementSheet';
import {MessageActionsMenu} from './MessageActionsMenu';
import type {MessageAction} from './MessageActionsMenu';
import {MessageRow, createRowStyles} from './MessageRow';
import {SampleConversationModal} from './SampleConversationModal';
import {TextSelectionSheet} from './TextSelectionSheet';
import {copyText} from '../utils/clipboard';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';
import {useSpeechPlayback} from '../tts/useSpeechPlayback';

export {VOCAB_TOAST_DURATION_MS};

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

  // The first frame is always the spinner (TASK-AUDIT-008): without a
  // session the screen must check the authoritative history before it may
  // claim any state, and with one it loads the conversation.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [topicExpanded, setTopicExpanded] = useState(false);
  const [exampleVisible, setExampleVisible] = useState(false);
  const [draft, setDraft] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  // TASK-AUDIT-008: bumped when the no-session route regains focus so the
  // authoritative history lookup re-runs (see the focus listener below).
  const [restoreKey, setRestoreKey] = useState(0);
  // TASK-060: the message whose long-press menu is open; null when closed.
  const [menuMessage, setMenuMessage] = useState<ChatMessage | null>(null);
  // TASK-069: the message whose content is being combed for vocabulary in
  // the text-selection sheet; null while no sheet is open.
  const [selectionMessage, setSelectionMessage] = useState<ChatMessage | null>(null);

  // TASK-078: single-playback speech controller; speakingMessageId drives
  // the visible playback state on the bubble currently being read aloud.
  const {speakingId: speakingMessageId, speak, stop: stopSpeech} = useSpeechPlayback();

  // TASK-050: scroll-follow behavior (stick to the tail, detach on scroll
  // up, jump-to-latest pill).
  const {
    listRef,
    detachedFromBottom,
    handleContentSizeChange,
    handleScroll,
    jumpToLatest,
    resetFollow,
  } = useFollowBottom<ChatMessage>();

  // Turn pipeline (TASK-050/054/086): optimistic rows, buffered deltas,
  // terminal outcomes and aborts for both modes.
  const {
    streaming,
    streamError,
    clearStreamError,
    endTurn,
    sendUserTurn,
    retryFailedTurn,
  } = useChatTurns({sessionId, mode, getAccessToken, authedRequest, setMessages});

  // TASK-061/088: suggested replies for one selected message.
  const {
    suggestions,
    suggestionsLoading,
    suggestionsError,
    startSuggestions,
    clearSuggestions,
    invalidateSuggestions,
  } = useMessageSuggestions({sessionId, mode, authedRequest, messages, session});

  // TASK-064/089: improvement sheet for one selected user message.
  const {
    improvement,
    improvementLoading,
    improvementError,
    startImprovement,
    invalidateImprovement,
  } = useMessageImprovement({sessionId, mode, authedRequest, messages});

  // TASK-069/070: immediate vocabulary save + self-dismissing toast.
  const {toast, saveVocabularySelection, invalidateVocabSave} = useVocabularySave({
    authedRequest,
  });

  // Latest-ref seam: the load effect keys on (session, reload) only, so an
  // auth-state transition never refetches the conversation behind the user's
  // back — the next opened session uses the fresh closure.
  const authedRequestRef = useRef(authedRequest);
  useEffect(() => {
    authedRequestRef.current = authedRequest;
  }, [authedRequest]);

  const resetMessages = useCallback(() => {
    setMessages(prev => (prev.length > 0 ? [] : prev));
  }, []);

  useEffect(() => {
    let cancelled = false;

    setError(null);
    clearStreamError();
    resetMessages();
    setSession(null);
    setTopicExpanded(false);
    setExampleVisible(false);
    setMenuMessage(null);
    invalidateSuggestions();
    invalidateImprovement();
    setSelectionMessage(null);
    invalidateVocabSave();
    stopSpeech();
    resetFollow();
    endTurn();
    if (sessionId === undefined) {
      // TASK-AUDIT-008: this route is also the post-login and post-restore
      // landing screen, so its state is derived from the authoritative
      // history instead of claiming "No conversation yet" unconditionally.
      // The most recent conversation replaces the param-less route in place
      // (replace, not push — the empty landing has no back story); only a
      // confirmed-empty history renders the empty state, and a failed
      // lookup surfaces the error with retry. A fixed delay would only
      // mask races; the authoritative answer is the point.
      const run = ++restoreRunRef.current;
      restoreInFlightRef.current = true;
      setLoading(true);
      (async () => {
        try {
          const firstPage = await listFirstSessionPage(mode, authedRequestRef.current);
          if (cancelled) {
            return;
          }
          const mostRecent = firstPage.results[0]?.id;
          if (mostRecent === undefined) {
            setLoading(false);
            return;
          }
          if (restoreFocusedRef.current) {
            navigation.replace('Chat', {sessionId: mostRecent});
            return;
          }
          // The user navigated elsewhere before the lookup settled: the
          // route stays in its loading state and the focus listener below
          // re-runs the check when it becomes visible again.
        } catch (err) {
          if (!cancelled) {
            setError(toErrorMessage(err));
            setLoading(false);
          }
        } finally {
          if (restoreRunRef.current === run) {
            restoreInFlightRef.current = false;
          }
        }
      })();
      return;
    }

    setLoading(true);
    (async () => {
      try {
        // Mode-branched reads live behind the conversation source, so the
        // screen neither branches on storage nor duplicates the request
        // shape (the first page covers recent history; older pages arrive
        // with the history work — Phase 8 pagination UI).
        const snapshot = await loadConversation(mode, sessionId, authedRequestRef.current);
        if (!cancelled) {
          setMessages(snapshot.messages);
          setSession(snapshot.session);
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
  }, [
    sessionId,
    reloadKey,
    restoreKey,
    mode,
    navigation,
    resetMessages,
    clearStreamError,
    invalidateSuggestions,
    invalidateImprovement,
    invalidateVocabSave,
    resetFollow,
    endTurn,
    stopSpeech,
  ]);

  // TASK-AUDIT-008: fresh focus state for the no-session restore check —
  // the navigation prop captured by the load effect's closure would answer
  // `isFocused()` with the mount-time state, so focus/blur events keep a
  // ref in sync and the async lookup reads the CURRENT visibility. When the
  // screen regains focus while no check is running, the check re-runs: a
  // lookup that settled while the user was elsewhere must not leave a stale
  // state beneath the active screen, and conversations created while this
  // screen sat in the stack are picked up on return. The mount-time check
  // (already in flight) is not restarted.
  // The landing route starts focused; the listener effect below replaces
  // this initial value with the precise mount state before any lookup (an
  // async continuation) can read it. Bare navigation stubs (tests) have no
  // isFocused — the focused default keeps the restore path inert for them.
  const restoreFocusedRef = useRef(true);
  const restoreInFlightRef = useRef(false);
  const restoreRunRef = useRef(0);
  useEffect(() => {
    if (sessionId !== undefined) {
      return;
    }
    restoreFocusedRef.current = navigation.isFocused?.() ?? true;
    const focusUnsubscribe = navigation.addListener?.('focus', () => {
      restoreFocusedRef.current = true;
      if (restoreInFlightRef.current) {
        return;
      }
      setRestoreKey(key => key + 1);
    });
    const blurUnsubscribe = navigation.addListener?.('blur', () => {
      restoreFocusedRef.current = false;
    });
    return () => {
      focusUnsubscribe?.();
      blurUnsubscribe?.();
    };
  }, [navigation, sessionId]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || sessionId === undefined || streaming) {
      return;
    }
    setDraft('');
    // Stale suggestion chips would offer replies to a conversation that has
    // moved on; sending dismisses them along with any leftover error state.
    clearSuggestions();
    sendUserTurn(sessionId, text);
  }, [draft, sessionId, streaming, clearSuggestions, sendUserTurn]);

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

  /** Retry one failed assistant row through the shared turn pipeline. */
  const handleRetry = useCallback(
    (message: ChatMessage) => {
      if (sessionId === undefined || streaming) {
        return;
      }
      retryFailedTurn(sessionId, message);
    },
    [sessionId, streaming, retryFailedTurn],
  );

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

  /** TASK-069: dismissing the selection sheet never captures anything. */
  const closeTextSelection = useCallback(() => {
    setSelectionMessage(null);
  }, []);

  /**
   * TASK-069/070: the vocabulary save flow's entry point — the selection
   * sheet hands its confirmed trimmed expression here and closes, and the
   * save starts immediately (the toast flow lives in `useVocabularySave`).
   */
  const handleSaveSelection = useCallback(
    (selectedText: string) => {
      if (selectionMessage === null) {
        return;
      }
      setSelectionMessage(null);
      saveVocabularySelection(selectedText, selectionMessage.id);
    },
    [selectionMessage, saveVocabularySelection],
  );

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
            Start a new conversation to practice English.
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
                    clearSuggestions();
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
            onClose={invalidateImprovement}
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
            onSave={handleSaveSelection}
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
