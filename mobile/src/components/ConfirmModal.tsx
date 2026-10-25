/**
 * Shared confirmation dialog: dimmed backdrop, one surface card with a
 * title, an explanatory message, an optional inline error and a Cancel /
 * destructive-confirm footer with a busy spinner.
 *
 * Replaces the per-screen delete dialogs (word, word topic, sentence topic,
 * word detail), which were pixel-identical apart from their copy. The
 * `testID` becomes the prefix: `<testID>-modal`, `-title`, `-message`,
 * `-error`, `-cancel` and `-confirm`.
 */
import { useMemo } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { createModalStyles } from './modalChrome';

export interface ConfirmModalProps {
  /** Whether the dialog is presented. */
  visible: boolean;
  /** Bold heading, e.g. "Delete topic?". */
  title: string;
  /** Explanatory body text below the title. */
  message: string;
  /** True while the confirmed action runs; both buttons disable, confirm spins. */
  busy?: boolean;
  /** Failure message; the dialog stays open so the learner can retry. */
  error?: string | null;
  /** Confirm button label; every current use is destructive, default "Delete". */
  confirmLabel?: string;
  /** Cancel button label, default "Cancel". */
  cancelLabel?: string;
  /** Dismiss without acting (Cancel or Android back). */
  onCancel: () => void;
  /** Run the confirmed action (never rejects; owns its error state). */
  onConfirm: () => void;
  /** Prefix for the element testIDs; see the module doc. */
  testID: string;
}

export function ConfirmModal({
  visible,
  title,
  message,
  busy = false,
  error = null,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onCancel,
  onConfirm,
  testID,
}: ConfirmModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createConfirmStyles(colors), [colors]);

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      testID={`${testID}-modal`}
      transparent
      visible={visible}>
      <View style={styles.backdrop}>
        <View style={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} testID={`${testID}-title`}>
            {title}
          </Text>
          <Text style={styles.message} testID={`${testID}-message`}>
            {message}
          </Text>

          {error ? (
            <Text role="alert" style={styles.modalError} testID={`${testID}-error`}>
              {error}
            </Text>
          ) : null}

          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              testID={`${testID}-cancel`}
              onPress={onCancel}
              disabled={busy}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalCancelButton,
                busy && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              <Text style={styles.modalCancelText}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy, busy }}
              testID={`${testID}-confirm`}
              onPress={() => {
                // The caller owns its error handling, so this never rejects.
                onConfirm();
              }}
              disabled={busy}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalDangerButton,
                busy && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              {busy ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.modalPrimaryText}>{confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createConfirmStyles(c: ThemeColors) {
  const modal = createModalStyles(c);
  return StyleSheet.create({
    ...modal,
    message: {
      fontSize: 14,
      lineHeight: 20,
      color: c.textSecondary,
    },
  });
}
