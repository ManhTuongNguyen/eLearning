/**
 * Memoized chat message row (SPEC TASK-103).
 *
 * The FlatList slot element for one message. Extracted from ChatScreen and
 * wrapped in React.memo so a delta flush — which replaces the messages
 * array on every flush tick — re-renders only the row whose content
 * actually changed (the streaming bubble). Untouched rows keep every prop
 * identity stable (same item object from the state map, stable style and
 * callback props) and bail out of rendering entirely, which keeps long
 * conversations smooth while tokens stream into the latest bubble.
 *
 * Memoization lives here and nowhere else: the props are few, shallowly
 * comparable and change only when the row's visible output can change.
 * Callback props are passed as stable references from ChatScreen; the
 * per-row long-press closure is created inside renderItem today and is the
 * remaining (measured) render amplifier until it is hoisted.
 */
import React, {memo} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';

import type {ChatMessage} from '../api/sessions';
import type {ThemeColors} from '../theme/colors';
import {createCodeStyle, MarkdownText} from './MarkdownText';

/** Row-scoped styles, created once per theme by the owning screen. */
export function createRowStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
    },
    rowUser: {
      justifyContent: 'flex-end',
    },
    bubbleWrapper: {
      maxWidth: '85%',
      flexShrink: 1,
    },
    bubble: {
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
    codeInline: createCodeStyle(c),
    failedNote: {
      fontSize: 14,
      lineHeight: 20,
      color: c.textMuted,
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
    speechStop: {
      alignSelf: 'flex-start',
      marginTop: 6,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingVertical: 5,
      paddingHorizontal: 14,
      backgroundColor: c.surface,
    },
    speechStopText: {
      color: c.accent,
      fontSize: 13,
      fontWeight: '600',
    },
  });
}

export type MessageRowStyles = ReturnType<typeof createRowStyles>;

export interface MessageRowProps {
  /** The message this row displays; identity changes only when it changes. */
  item: ChatMessage;
  styles: MessageRowStyles;
  /** True while any turn is streaming; disables retry controls. */
  streaming: boolean;
  /** True while this row's text is being read aloud. */
  speaking: boolean;
  spinnerColor: string;
  /**
   * Opens the long-press actions menu for this message (TASK-060).
   *
   * Deliberately NOT named `onLongPress`: React Native Testing Library's
   * fireEvent walks up ancestor fibers looking for an event prop, so a
   * component-level prop named after a native event name would be invoked
   * (with no event argument) whenever any descendant bubble was long-pressed
   * even though the row itself opted out. A custom name keeps the row's
   * own eligibility decision authoritative.
   */
  onMessageLongPress: (message: ChatMessage) => void;
  /** Retries this row's failed assistant generation (TASK-054). */
  onRetry: (message: ChatMessage) => void;
  /** Stops read-aloud playback (TASK-078). */
  onStopSpeech: () => void;
}

function MessageRowImpl({
  item,
  styles,
  streaming,
  speaking,
  spinnerColor,
  onMessageLongPress,
  onRetry,
  onStopSpeech,
}: MessageRowProps) {
  const isUser = item.role === 'user';
  const failed = !isUser && item.status === 'failed';
  const waiting = item.status === 'pending' && item.role === 'assistant' && item.content === '';
  // Only rows with real text offer the long-press menu (TASK-060):
  // pending spinners and failed rows carry nothing actionable, and the
  // backend rejects them as suggestion targets anyway.
  const menuEligible = item.status === 'complete' && item.content.trim().length > 0;
  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      <View style={styles.bubbleWrapper}>
        <Pressable
          style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}
          testID={`chat-message-${item.id}`}
          onLongPress={
            menuEligible
              ? () => {
                  onMessageLongPress(item);
                }
              : undefined
          }>
          {waiting ? (
            <ActivityIndicator size="small" color={spinnerColor} />
          ) : failed ? (
            <Text style={[styles.content, styles.failedNote]}>
              The response failed to generate.
            </Text>
          ) : isUser ? (
            // User messages keep raw fidelity: what the user typed is what
            // shows, so stray asterisks are never reinterpreted as markup.
            <Text style={[styles.content, styles.contentUser]}>{item.content}</Text>
          ) : (
            <MarkdownText
              content={item.content}
              style={[styles.content, styles.contentAssistant]}
              codeStyle={styles.codeInline}
            />
          )}
        </Pressable>
        {failed ? (
          <Pressable
            style={[styles.messageRetry, streaming && styles.messageRetryDisabled]}
            disabled={streaming}
            onPress={() => {
              onRetry(item);
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry failed response"
            accessibilityState={{disabled: streaming}}
            testID={`chat-retry-${item.id}`}>
            <Text style={styles.messageRetryText}>Retry</Text>
          </Pressable>
        ) : null}
        {speaking ? (
          <Pressable
            style={styles.speechStop}
            onPress={onStopSpeech}
            testID={`chat-speech-stop-${item.id}`}
            accessibilityRole="button"
            accessibilityLabel="Stop reading aloud"
            accessibilityState={{busy: true}}>
            <Text style={styles.speechStopText}>⏹ Speaking… tap to stop</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export const MessageRow = memo(MessageRowImpl);
