/**
 * Listening-practice session summary: the "Practice ended" screen with the
 * score line, the Practice again / Done actions. Rendered when the learner
 * explicitly ends the reflex loop; the screen owns the counts and restart.
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { SCREEN_TOP_SPACING, Screen, ScreenScrollView } from '../components/ScreenLayout';
import { ScreenTitleBar } from '../components/ScreenTitleBar';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

export interface PracticeSummaryCardProps {
  correctCount: number;
  attemptedCount: number;
  /** Whole-percent accuracy; null when nothing was attempted. */
  accuracy: number | null;
  onRestart: () => void;
  onGoBack: () => void;
}

export function PracticeSummaryCard({
  correctCount,
  attemptedCount,
  accuracy,
  onRestart,
  onGoBack,
}: PracticeSummaryCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Screen style={styles.container} testID="practice-screen">
      <ScreenTitleBar title="Listening practice" onBack={onGoBack} backTestID="practice-back" />
      <ScreenScrollView contentContainerStyle={styles.summaryScroll}>
        <View style={styles.summary} testID="practice-summary">
          <View style={styles.summaryIcon}>
            <Icon name="listening" size={32} color={colors.primary} />
          </View>
          <Text style={styles.summaryEyebrow}>SESSION COMPLETE</Text>
          <Text style={styles.summaryTitle}>Practice ended</Text>
          <Text style={styles.summaryScore} testID="practice-summary-score">
            {correctCount} of {attemptedCount} correct
            {accuracy !== null ? ` · ${accuracy}%` : ''}
          </Text>
          <Text style={styles.summaryHint}>
            Every replay sharpens your ear. Ready for another round?
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onRestart}
            style={({ pressed }) => [
              styles.primaryButton,
              styles.summaryPrimary,
              pressed && styles.primaryButtonPressed,
            ]}
            testID="practice-restart">
            <Icon name="refresh" size={18} color={colors.onPrimary} />
            <Text style={styles.primaryButtonText}>Practice again</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onGoBack}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            testID="practice-summary-done">
            <Text style={styles.secondaryButtonText}>Done</Text>
          </Pressable>
        </View>
      </ScreenScrollView>
    </Screen>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      // Horizontal padding lives on the shared header/scroll containers so
      // the scroll indicator binds to the right screen edge. Same 16px
      // header spacing as the other pushed screens.
      paddingTop: SCREEN_TOP_SPACING,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingBottom: 6,
    },
    summaryScroll: {
      paddingTop: 12,
      paddingBottom: 24,
    },
    summary: {
      alignItems: 'center',
      gap: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 22,
      padding: 24,
    },
    summaryIcon: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.accentSoft,
      marginBottom: 4,
    },
    summaryEyebrow: {
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 1.2,
      color: c.accent,
    },
    summaryTitle: {
      fontSize: 24,
      fontWeight: '700',
      textAlign: 'center',
      color: c.textPrimary,
    },
    summaryScore: {
      fontSize: 15,
      fontWeight: '600',
      textAlign: 'center',
      color: c.textSecondary,
    },
    summaryHint: {
      maxWidth: 260,
      marginTop: 2,
      fontSize: 12,
      lineHeight: 18,
      textAlign: 'center',
      color: c.textMuted,
    },
    summaryPrimary: {
      alignSelf: 'stretch',
      marginTop: 10,
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: c.primary,
      paddingHorizontal: 8,
    },
    primaryButtonPressed: {
      opacity: 0.9,
    },
    primaryButtonText: {
      color: c.onPrimary,
      fontSize: 14,
      fontWeight: '700',
    },
    secondaryButton: {
      alignSelf: 'stretch',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 14,
    },
    secondaryButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    pressed: {
      opacity: 0.72,
    },
  });
}
