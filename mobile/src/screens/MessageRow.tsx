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
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChatMessage, ImprovementSeverity } from '../api/sessions';
import type { ThemeColors } from '../theme/colors';
import { createCodeStyle, MarkdownText } from './MarkdownText';

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
    // Corner status mark: a small circle hanging off the bubble's top-right
    // edge. The 44px hitSlop keeps it tappable while the visible mark stays
    // small; the whole bubble is also tappable when a check exists.
    grammarBadge: {
      position: 'absolute',
      top: -8,
      right: -8,
      width: 16,
      height: 16,
      borderRadius: 8,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surface,
    },
    grammarBadgeMinor: {
      borderColor: c.warning,
    },
    grammarBadgeCritical: {
      borderColor: c.errorText,
    },
    grammarBadgeNone: {
      borderColor: c.success,
    },
    grammarBadgeText: {
      fontSize: 10,
      fontWeight: '800',
      lineHeight: 12,
      includeFontPadding: false,
    },
    grammarBadgeTextMinor: {
      color: c.warning,
    },
    grammarBadgeTextNone: {
      color: c.success,
    },
    grammarBadgeTextCritical: {
      color: c.errorText,
    },
    bubbleWithBadge: {
      // Room so the first line of text doesn't run under the corner mark.
      paddingTop: 12,
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
  /**
   * Grammar severity of this user message from the auto-check
   * ("minor" → warning badge, "critical" → error badge); null when the
   * message was correct or never checked. Pressing the badge opens the
   * cached improvement — never a second API call.
   */
  grammarSeverity: ImprovementSeverity | null;
  /** Opens the cached improvement for this row's grammar badge. */
  onGrammarBadgePress: (message: ChatMessage) => void;
}

/** Visible glyph per status; the shape differs so color is not the only cue. */
const GRAMMAR_BADGE_GLYPHS: Record<'none' | 'minor' | 'critical', string> = {
  none: '✓',
  minor: '!',
  critical: '✕',
};

/** Screen-reader labels: the words the icon itself no longer shows. */
const GRAMMAR_BADGE_A11Y: Record<'none' | 'minor' | 'critical', string> = {
  none: 'Looks good, open feedback',
  minor: 'Minor grammar issues found, open suggestion',
  critical: 'Serious grammar issues found, open suggestion',
};

function MessageRowImpl({
  item,
  styles,
  streaming,
  speaking,
  spinnerColor,
  onMessageLongPress,
  onRetry,
  onStopSpeech,
  grammarSeverity,
  onGrammarBadgePress,
}: MessageRowProps) {
  const isUser = item.role === 'user';
  const failed = !isUser && item.status === 'failed';
  const waiting = item.status === 'pending' && item.role === 'assistant' && item.content === '';
  // Only rows with real text offer the long-press menu (TASK-060):
  // pending spinners and failed rows carry nothing actionable, and the
  // backend rejects them as suggestion targets anyway.
  const menuEligible = item.status === 'complete' && item.content.trim().length > 0;
  const hasGrammarBadge = isUser && grammarSeverity !== null;
  const badgeTone =
    grammarSeverity === 'critical' ? 'critical' : grammarSeverity === 'minor' ? 'minor' : 'none';
  // A checked user message opens its feedback on a tap anywhere in the bubble
  // (long-press still opens the actions menu, so the gestures don't clash).
  const bubbleTappable = hasGrammarBadge;
  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      <View style={styles.bubbleWrapper}>
        <Pressable
          style={[
            styles.bubble,
            isUser ? styles.bubbleUser : styles.bubbleAssistant,
            hasGrammarBadge && styles.bubbleWithBadge,
          ]}
          testID={`chat-message-${item.id}`}
          onPress={
            bubbleTappable
              ? () => {
                  onGrammarBadgePress(item);
                }
              : undefined
          }
          accessibilityHint={bubbleTappable ? 'Opens the improvement suggestion' : undefined}
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
        {hasGrammarBadge ? (
          <Pressable
            style={[
              styles.grammarBadge,
              badgeTone === 'critical'
                ? styles.grammarBadgeCritical
                : badgeTone === 'minor'
                  ? styles.grammarBadgeMinor
                  : styles.grammarBadgeNone,
            ]}
            onPress={() => {
              onGrammarBadgePress(item);
            }}
            hitSlop={14}
            testID={`chat-grammar-badge-${item.id}`}
            accessibilityRole="button"
            accessibilityLabel={GRAMMAR_BADGE_A11Y[badgeTone]}>
            {/* Shape carries the meaning too (check / ! / !), so the status
                reads without relying on color alone. */}
            <Text
              importantForAccessibility="no"
              style={[
                styles.grammarBadgeText,
                badgeTone === 'critical'
                  ? styles.grammarBadgeTextCritical
                  : badgeTone === 'minor'
                    ? styles.grammarBadgeTextMinor
                    : styles.grammarBadgeTextNone,
              ]}>
              {GRAMMAR_BADGE_GLYPHS[badgeTone]}
            </Text>
          </Pressable>
        ) : null}
        {failed ? (
          <Pressable
            style={[styles.messageRetry, streaming && styles.messageRetryDisabled]}
            disabled={streaming}
            onPress={() => {
              onRetry(item);
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry failed response"
            accessibilityState={{ disabled: streaming }}
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
            accessibilityState={{ busy: true }}>
            <Text style={styles.speechStopText}>⏹ Speaking… tap to stop</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export const MessageRow = memo(MessageRowImpl);
