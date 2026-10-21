/**
 * In-app confirmation dialog for deleting a real-life sentence topic.
 *
 * The native Android alert is deliberately avoided so the confirmation matches
 * the app's theme (including dark mode) and can show a deletion error without
 * dismissing itself. The dialog is a centred card over a dimmed backdrop; the
 * destructive action is disabled while the delete is in flight.
 */
import React, {useMemo} from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {SCREEN_GUTTER} from '../components/ScreenLayout';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

export interface DeleteTopicModalProps {
  /** Whether the dialog is presented. */
  visible: boolean;
  /** Title of the topic being deleted. */
  topicTitle: string;
  /** How many sentences will be removed with the topic. */
  sentenceCount: number;
  /** True while the delete request is running. */
  deleting: boolean;
  /** Message shown when the delete failed; the dialog stays open. */
  error: string | null;
  /** Dismiss without deleting (Cancel button or Android back). */
  onCancel: () => void;
  /** Delete the topic (destructive action). */
  onConfirm: () => void;
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: SCREEN_GUTTER,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 16,
      padding: 20,
      gap: 12,
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    message: {
      fontSize: 14,
      lineHeight: 20,
      color: c.textSecondary,
    },
    error: {
      fontSize: 13,
      lineHeight: 18,
      color: c.errorText,
    },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
      marginTop: 4,
    },
    button: {
      minWidth: 88,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    cancelButton: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    deleteButton: {
      backgroundColor: c.danger,
    },
    disabled: {
      opacity: 0.5,
    },
    cancelText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    deleteText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.onPrimary,
    },
  });
}

/** Describe exactly what the cascade removes, avoiding "0 sentences". */
export function describeDeletedTopic(
  sentenceCount: number,
): string {
  if (sentenceCount === 0) {
    return 'its practice history';
  }
  if (sentenceCount === 1) {
    return 'its sentence and practice history';
  }
  return `its ${sentenceCount} sentences and practice history`;
}

export function DeleteTopicModal({
  visible,
  topicTitle,
  sentenceCount,
  deleting,
  error,
  onCancel,
  onConfirm,
}: DeleteTopicModalProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (!visible) {
    return null;
  }

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      testID="delete-topic-modal"
      transparent
      visible
    >
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.title} testID="delete-topic-title">
            Delete topic?
          </Text>
          <Text style={styles.message} testID="delete-topic-message">
            {`"${topicTitle}" and ${describeDeletedTopic(sentenceCount)} will be ` +
              'permanently deleted. This cannot be undone.'}
          </Text>

          {error ? (
            <Text
              role="alert"
              style={styles.error}
              testID="delete-topic-error"
            >
              {error}
            </Text>
          ) : null}

          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{disabled: deleting}}
              testID="delete-topic-cancel"
              onPress={onCancel}
              disabled={deleting}
              style={({pressed}) => [
                styles.button,
                styles.cancelButton,
                deleting && styles.disabled,
                pressed && styles.disabled,
              ]}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{disabled: deleting, busy: deleting}}
              testID="delete-topic-confirm"
              onPress={onConfirm}
              disabled={deleting}
              style={({pressed}) => [
                styles.button,
                styles.deleteButton,
                deleting && styles.disabled,
                pressed && styles.disabled,
              ]}
            >
              {deleting ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.deleteText}>Delete</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
