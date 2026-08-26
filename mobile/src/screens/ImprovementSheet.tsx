/**
 * Improvement result sheet (SPEC TASK-064, ROADMAP §8): presents the outcome
 * of "Improve my English" for one user message — the untouched original, the
 * suggested rewrite and a short explanation of what changed. The sheet is a
 * bottom card over a dismissible backdrop, mirroring MessageActionsMenu: it
 * closes through the Close control, a backdrop tap or the Android back
 * button, and its content is an accessibility modal with every control
 * labeled. The three round-trip states are mutually exclusive: a spinner
 * while the request runs, a role="alert" error banner on failure and the
 * result body (with a Copy action for the improved text through the
 * clipboard seam) once the provider answers.
 */
import React, {useCallback, useMemo} from 'react';
import {ActivityIndicator, Modal, Pressable, StyleSheet, Text, View} from 'react-native';

import type {MessageImprovement} from '../api/sessions';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';
import {copyText} from '../utils/clipboard';

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
    loadingBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 24,
      justifyContent: 'center',
    },
    loadingText: {
      fontSize: 14,
      color: c.textSecondary,
    },
    errorText: {
      color: c.errorText,
      fontSize: 14,
      lineHeight: 20,
      paddingVertical: 16,
    },
    sectionLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textMuted,
      marginTop: 14,
      marginBottom: 4,
      textTransform: 'uppercase',
    },
    originalText: {
      fontSize: 15,
      lineHeight: 21,
      color: c.textSecondary,
    },
    improvedCard: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 12,
      backgroundColor: c.background,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    improvedText: {
      fontSize: 15,
      lineHeight: 21,
      color: c.textPrimary,
      fontWeight: '500',
    },
    explanationText: {
      fontSize: 13,
      lineHeight: 19,
      color: c.textSecondary,
    },
    copyButton: {
      marginTop: 16,
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: 'center',
    },
    copyButtonText: {
      color: c.onPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
  });
}

interface ImprovementSheetProps {
  /** Whether the overlay is presented; closed sheets render nothing. */
  visible: boolean;
  /** True while the improvement request is in flight. */
  loading: boolean;
  /** Normalized failure message; shown instead of any result body. */
  error: string | null;
  /** Successful improvement payload for one selected message. */
  result: MessageImprovement | null;
  /** Dismissal callback (Close button, backdrop tap and Android back). */
  onClose: () => void;
}

export function ImprovementSheet({
  visible,
  loading,
  error,
  result,
  onClose,
}: ImprovementSheetProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const copyImproved = useCallback(() => {
    if (result !== null) {
      copyText(result.improved);
    }
  }, [result]);

  if (!visible) {
    return null;
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      testID="chat-improvement-modal"
      transparent
      visible>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        testID="chat-improvement-backdrop">
        <Pressable style={styles.sheet} testID="chat-improvement">
          <View accessibilityViewIsModal testID="chat-improvement-content">
            <View style={styles.header}>
              <Text style={styles.title}>Improved English</Text>
              <Pressable
                onPress={onClose}
                testID="chat-improvement-close"
                accessibilityRole="button"
                accessibilityLabel="Close improvement result">
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
            {loading ? (
              <View style={styles.loadingBox} testID="chat-improvement-loading">
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.loadingText}>Checking your English…</Text>
              </View>
            ) : error !== null ? (
              <Text role="alert" style={styles.errorText} testID="chat-improvement-error">
                {error}
              </Text>
            ) : result !== null ? (
              <>
                <Text style={styles.sectionLabel}>Your message</Text>
                <View testID="chat-improvement-original">
                  <Text style={styles.originalText}>{result.original}</Text>
                </View>
                <Text style={styles.sectionLabel}>Suggested improvement</Text>
                <View style={styles.improvedCard} testID="chat-improvement-improved">
                  <Text style={styles.improvedText}>{result.improved}</Text>
                </View>
                <Text style={styles.sectionLabel}>What changed</Text>
                <View testID="chat-improvement-explanation">
                  <Text style={styles.explanationText}>{result.explanation}</Text>
                </View>
                <Pressable
                  style={styles.copyButton}
                  onPress={copyImproved}
                  testID="chat-improvement-copy"
                  accessibilityRole="button"
                  accessibilityLabel="Copy improved text">
                  <Text style={styles.copyButtonText}>Copy improved text</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
