/**
 * Main conversation screen (SPEC TASK-048/049/050): chronological message
 * list, composer with send button, loading/error states and keyboard
 * handling.
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
 * pill offers the way back down.
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
import {streamChatTurn} from '../api/chatStream';
import type {ChatMessage} from '../api/sessions';
import {listMessages} from '../api/sessions';
import {toErrorMessage, useAuth} from '../auth/AuthContext';
import type {ChatScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';
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
  });
}

export function ChatScreen({route, navigation}: ChatScreenProps) {
  const sessionId = route.params?.sessionId;
  const {getAccessToken} = useAuth();
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [loading, setLoading] = useState(sessionId !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

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
        // history work (Phase 8 pagination UI).
        const page = await listMessages(token, sessionId);
        if (!cancelled) {
          setMessages([...page.results].sort(bySequence));
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
   * the server (a committed user row / failed assistant row reappears; the
   * retry control itself is TASK-054). Buffered-but-unflushed deltas die
   * here — they must never land after the rows are gone.
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
        const handleEvent = (event: ChatStreamEvent): void => {
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
        };
        streamHandleRef.current = streamChatTurn({
          token,
          sessionId: sid,
          text,
          onEvent: handleEvent,
          onError: err => {
            failTurn(toErrorMessage(err));
          },
        });
      })();
    },
    [appendDelta, completeTurn, failTurn],
  );

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || sessionId === undefined || streaming) {
      return;
    }
    setDraft('');
    setStreamError(null);

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
      const waiting =
        item.status === 'pending' && item.role === 'assistant' && item.content === '';
      return (
        <View style={[styles.row, isUser && styles.rowUser]}>
          <View
            style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}
            testID={`chat-message-${item.id}`}>
            {waiting ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Text style={[styles.content, isUser ? styles.contentUser : styles.contentAssistant]}>
                {item.content}
              </Text>
            )}
          </View>
        </View>
      );
    },
    [styles, colors.textMuted],
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
        </>
      )}
    </KeyboardAvoidingView>
  );
}
