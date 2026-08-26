/**
 * Vocabulary save confirmation popup (SPEC TASK-070, ROADMAP §9): presented
 * after the text-selection sheet hands over an expression. It shows exactly
 * what will be stored and offers Save and Cancel — Save fires the immediate
 * vocabulary API call (the server returns as soon as the row is written;
 * background enrichment is never awaited here) while Cancel, the Close
 * control, a backdrop tap or the Android back button dismisses without
 * saving. While the request is in flight a spinner replaces the actions;
 * on failure a role="alert" message appears and Save stays available for
 * another attempt. The surface mirrors MessageActionsMenu/ImprovementSheet:
 * a bottom card over a dismissible backdrop whose body is an accessibility
 * modal with labeled controls.
 */
import React, {useMemo} from 'react';
import {ActivityIndicator, Modal, Pressable, StyleSheet, Text, View} from 'react-native';

import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: 16,
      paddingBottom: 20,
      paddingTop: 6,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 4,
    },
    title: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    closeText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.accent,
      paddingVertical: 4,
    },
    hintText: {
      fontSize: 13,
      lineHeight: 19,
      color: c.textSecondary,
      marginBottom: 10,
    },
    expressionBox: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 12,
      backgroundColor: c.background,
      paddingHorizontal: 14,
      paddingVertical: 12,
      minHeight: 46,
      justifyContent: 'center',
    },
    expressionText: {
      fontSize: 15,
      lineHeight: 21,
      color: c.primary,
      fontWeight: '500',
    },
    enrichHint: {
      fontSize: 12,
      lineHeight: 18,
      color: c.textMuted,
      marginTop: 8,
    },
    errorText: {
      color: c.errorText,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 12,
    },
    loadingBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 16,
      justifyContent: 'center',
    },
    loadingText: {
      fontSize: 14,
      color: c.textSecondary,
    },
    actionsRow: {
      flexDirection: 'row',
      gap: 10,
      marginTop: 16,
    },
    cancelButton: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: 'center',
    },
    cancelButtonText: {
      color: c.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    saveButton: {
      flex: 1,
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: 'center',
    },
    saveDisabled: {
      opacity: 0.5,
    },
    saveButtonText: {
      color: c.onPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
  });
}

interface VocabularySaveSheetProps {
  /** Whether the overlay is presented; closed sheets render nothing. */
  visible: boolean;
  /** The confirmed expression about to be saved. */
  expression: string;
  /** True while the save request is in flight. */
  loading: boolean;
  /** Normalized failure message; shown above the action row when set. */
  error: string | null;
  /** Fires the immediate save round-trip for the expression. */
  onSave: () => void;
  /** Dismissal callback (Cancel, Close, backdrop tap and Android back). */
  onClose: () => void;
}

export function VocabularySaveSheet({
  visible,
  expression,
  loading,
  error,
  onSave,
  onClose,
}: VocabularySaveSheetProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (!visible) {
    return null;
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      testID="chat-vocab-modal"
      transparent
      visible>
      <Pressable style={styles.backdrop} onPress={onClose} testID="chat-vocab-backdrop">
        <Pressable style={styles.sheet} testID="chat-vocab">
          <View accessibilityViewIsModal testID="chat-vocab-content">
            <View style={styles.header}>
              <Text style={styles.title}>Save to vocabulary</Text>
              <Pressable
                onPress={onClose}
                testID="chat-vocab-close"
                accessibilityRole="button"
                accessibilityLabel="Close vocabulary save popup">
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
            <Text style={styles.hintText}>Save this expression to your vocabulary?</Text>
            <View style={styles.expressionBox} testID="chat-vocab-expression">
              <Text style={styles.expressionText}>{expression}</Text>
            </View>
            <Text style={styles.enrichHint}>
              The definition and details are added automatically afterwards.
            </Text>
            {error !== null ? (
              <Text role="alert" style={styles.errorText} testID="chat-vocab-error">
                {error}
              </Text>
            ) : null}
            {loading ? (
              <View style={styles.loadingBox} testID="chat-vocab-loading">
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.loadingText}>Saving…</Text>
              </View>
            ) : (
              <View style={styles.actionsRow}>
                <Pressable
                  style={styles.cancelButton}
                  onPress={onClose}
                  testID="chat-vocab-cancel"
                  accessibilityRole="button"
                  accessibilityLabel="Cancel saving the expression">
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={styles.saveButton}
                  onPress={onSave}
                  testID="chat-vocab-save"
                  accessibilityRole="button"
                  accessibilityLabel="Save expression to vocabulary">
                  <Text style={styles.saveButtonText}>Save</Text>
                </Pressable>
              </View>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
