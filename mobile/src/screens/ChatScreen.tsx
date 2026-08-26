/**
 * Main conversation screen (SPEC TASK-048): chronological message list,
 * composer with send button, loading/error states and keyboard handling.
 *
 * The screen loads an existing conversation through its `sessionId` route
 * param; without one it shows an empty state until a conversation is opened
 * or created (TASK-051). Sending currently appends the user message locally
 * (optimistic echo) — the streaming round-trip over
 * POST /api/v1/sessions/{id}/messages/stream/ lands with the SSE client in
 * TASK-049, which replaces this seam.
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

import type {ChatMessage} from '../api/sessions';
import {listMessages} from '../api/sessions';
import {toErrorMessage, useAuth} from '../auth/AuthContext';
import type {ChatScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

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

  // Latest-ref seam: the load effect keys on (session, reload) only, so an
  // auth-state transition never refetches the conversation behind the user's
  // back — the next opened session uses the fresh closure.
  const getAccessTokenRef = useRef(getAccessToken);
  useEffect(() => {
    getAccessTokenRef.current = getAccessToken;
  }, [getAccessToken]);

  const resetMessages = useCallback(() => {
    setMessages(prev => (prev.length > 0 ? [] : prev));
  }, []);

  useEffect(() => {
    let cancelled = false;

    setError(null);
    resetMessages();
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

    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadKey, resetMessages]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    setDraft('');
    setMessages(prev => {
      const last = prev.length > 0 ? prev[prev.length - 1] : null;
      const localEcho: ChatMessage = {
        id: -Date.now(),
        role: 'user',
        status: 'complete',
        content: text,
        sequence: last ? last.sequence + 1 : 1,
        created_at: new Date().toISOString(),
      };
      return [...prev, localEcho];
    });
    // TASK-049 will drive the assistant reply from here via the SSE stream.
  }, [draft]);

  const canSend = draft.trim().length > 0;

  const renderMessage = useCallback(
    ({item}: {item: ChatMessage}) => {
      const isUser = item.role === 'user';
      return (
        <View style={[styles.row, isUser && styles.rowUser]}>
          <View
            style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}
            testID={`chat-message-${item.id}`}>
            <Text style={[styles.content, isUser ? styles.contentUser : styles.contentAssistant]}>
              {item.content}
            </Text>
          </View>
        </View>
      );
    },
    [styles],
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'android' ? undefined : 'padding'}
      testID="chat-screen">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Chat</Text>
        <View style={styles.headerActions}>
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
        </View>
      ) : (
        <>
          <FlatList
            style={styles.list}
            contentContainerStyle={styles.listContent}
            data={messages}
            keyExtractor={message => String(message.id)}
            renderItem={renderMessage}
            ListEmptyComponent={
              <Text style={styles.emptyHint} testID="chat-empty">
                Say hello to start the conversation.
              </Text>
            }
            testID="chat-list"
          />
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
