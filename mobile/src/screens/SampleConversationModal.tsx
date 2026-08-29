/**
 * "Show me an example" overlay (SPEC TASK-053, ROADMAP §7): presents the
 * topic's generated sample conversation in a modal. The example is pure
 * presentation data — it never becomes part of the user's actual chat
 * history (a note says so explicitly) — and every turn carries a Play/Stop
 * control wired through the TextToSpeechEngine seam. Playback state is
 * managed by the same useSpeechPlayback hook as chat messages (TASK-079),
 * so example lines behave identically: one line at a time, starting
 * another halts the current one, failures never crash, and closing or
 * unmounting the overlay silences the engine. The overlay is dismissible
 * via its Close control and via the Android back button (Modal
 * onRequestClose), and hides itself entirely when closed so nothing leaks
 * into the conversation tree underneath.
 */
import React, {useCallback, useEffect, useMemo} from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {SampleTurn} from '../api/sessions';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';
import type {TextToSpeechEngine} from '../tts/textToSpeech';
import {getSpeechEngine} from '../tts/textToSpeech';
import {useSpeechPlayback} from '../tts/useSpeechPlayback';
import {createCodeStyle, MarkdownText} from './MarkdownText';

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
      backgroundColor: c.surface,
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    closeText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.accent,
      paddingVertical: 4,
    },
    note: {
      fontSize: 12,
      color: c.textMuted,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    body: {
      flex: 1,
    },
    turns: {
      paddingVertical: 12,
      paddingHorizontal: 16,
      gap: 14,
    },
    row: {
      width: '100%',
    },
    rowUser: {
      alignItems: 'flex-end',
    },
    turnMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      alignSelf: 'stretch',
      marginBottom: 4,
    },
    role: {
      fontSize: 11,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: c.textMuted,
    },
    ttsText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.accent,
      paddingVertical: 2,
    },
    bubble: {
      maxWidth: '88%',
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 9,
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
  });
}

interface SampleConversationModalProps {
  /** Whether the overlay is presented; closed modals render nothing. */
  visible: boolean;
  /** Generated example turns, in playback order. */
  turns: SampleTurn[];
  /** Dismissal callback (Close button and Android back). */
  onClose: () => void;
  /** TTS seam; defaults to the active engine from the registry. */
  speech?: TextToSpeechEngine;
}

export function SampleConversationModal({
  visible,
  turns,
  onClose,
  speech = getSpeechEngine(),
}: SampleConversationModalProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Shared playback state machine (TASK-078): single playback, overlap
  // prevention, stale-settlement guard and failure-safe clearing — exactly
  // the semantics chat messages get.
  const {speakingId, speak, stop} = useSpeechPlayback(speech);

  // Closing the overlay halts playback immediately; a fresh open starts
  // clean. Unmount cleanup is handled inside the hook.
  useEffect(() => {
    if (!visible) {
      stop();
    }
  }, [visible, stop]);

  const handleToggleSpeech = useCallback(
    (index: number) => {
      const turn = turns[index];
      if (!turn) {
        return;
      }
      if (speakingId === index) {
        stop();
        return;
      }
      speak(index, turn.content);
    },
    [turns, speakingId, speak, stop],
  );

  if (!visible) {
    return null;
  }

  return (
    <Modal animationType="slide" onRequestClose={onClose} testID="sample-modal" visible>
      <View style={styles.container} accessibilityViewIsModal>
        <View style={styles.header}>
          <Text style={styles.title} testID="sample-title">
            Example conversation
          </Text>
          <Pressable
            onPress={onClose}
            testID="sample-close"
            accessibilityRole="button"
            accessibilityLabel="Close example conversation">
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        <Text style={styles.note} testID="sample-note">
          Just an example — it never becomes part of your chat history.
        </Text>
        <ScrollView style={styles.body} contentContainerStyle={styles.turns}>
          {turns.map((turn, index) => {
            const isUser = turn.role === 'user';
            const speaking = speakingId === index;
            return (
              <View
                key={`sample-turn-${index}`}
                style={[styles.row, isUser && styles.rowUser]}
                testID={`sample-turn-${index}`}>
                <View style={styles.turnMeta}>
                  <Text style={styles.role}>{isUser ? 'You' : 'AI'}</Text>
                  <Pressable
                    onPress={() => {
                      handleToggleSpeech(index);
                    }}
                    testID={`sample-tts-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={
                      speaking
                        ? `Stop example line ${index + 1}`
                        : `Play example line ${index + 1}`
                    }
                    accessibilityState={{busy: speaking}}>
                    <Text style={styles.ttsText}>{speaking ? '⏹ Stop' : '▶ Play'}</Text>
                  </Pressable>
                </View>
                <View
                  style={[
                    styles.bubble,
                    isUser ? styles.bubbleUser : styles.bubbleAssistant,
                  ]}>
                  {isUser ? (
                    <Text style={[styles.content, styles.contentUser]}>{turn.content}</Text>
                  ) : (
                    <MarkdownText
                      content={turn.content}
                      style={[styles.content, styles.contentAssistant]}
                      codeStyle={styles.codeInline}
                    />
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}
