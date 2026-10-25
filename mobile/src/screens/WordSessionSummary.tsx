/**
 * Word practice session summary: the "All caught up" / "Session complete"
 * state with the reviewed count, per-grade chips, the next-due line and the
 * Review again / Back actions. Presentational — the screen owns the session
 * state and the review-again reset.
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { GradeCounts } from '../components/GradeButtons';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

export interface WordSessionSummaryProps {
  /** Reviews completed this sitting; 0 shows the caught-up variant. */
  reviewedCount: number;
  gradeCounts: GradeCounts;
  /** Pre-formatted next-due line; null shows the "no words yet" copy. */
  nextDueLabel: string | null;
  /** True when more cards are due now; shows Review again. */
  hasRemainingDue: boolean;
  onReviewAgain: () => void;
  onBack: () => void;
}

export function WordSessionSummary({
  reviewedCount,
  gradeCounts,
  nextDueLabel,
  hasRemainingDue,
  onReviewAgain,
  onBack,
}: WordSessionSummaryProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.centered} testID="word-practice-summary">
      <Text style={styles.stateTitle}>
        {reviewedCount === 0 ? 'All caught up' : 'Session complete'}
      </Text>
      {reviewedCount > 0 ? (
        <>
          <Text style={styles.stateText} testID="word-practice-summary-count">
            {`${reviewedCount} word${reviewedCount === 1 ? '' : 's'} reviewed.`}
          </Text>
          <View style={styles.summaryRow}>
            {(['again', 'hard', 'good', 'easy'] as const).map(grade => (
              <View key={grade} style={styles.summaryItem}>
                <Text style={styles.summaryCount} testID={`word-practice-summary-${grade}`}>
                  {gradeCounts[grade]}
                </Text>
                <Text style={styles.summaryLabel}>{grade}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
      {nextDueLabel ? (
        <Text style={styles.stateText} testID="word-practice-next-due">
          {nextDueLabel}
        </Text>
      ) : (
        <Text style={styles.stateText}>No words to practice yet.</Text>
      )}
      {hasRemainingDue ? (
        <Pressable
          accessibilityRole="button"
          testID="word-practice-review-again"
          onPress={onReviewAgain}
          style={({ pressed }) => [
            styles.button,
            styles.primaryButton,
            pressed && styles.pressedFade,
          ]}>
          <Text style={styles.primaryButtonText}>Review again</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        testID="word-practice-back-to-topic"
        onPress={onBack}
        style={({ pressed }) => [styles.button, pressed && styles.pressedFade]}>
        <Text style={styles.buttonText}>Back to topic</Text>
      </Pressable>
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: 16,
    },
    stateTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
      textAlign: 'center',
    },
    stateText: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
      paddingHorizontal: 24,
    },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 16,
      flexWrap: 'wrap',
    },
    summaryItem: {
      alignItems: 'center',
    },
    summaryCount: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    summaryLabel: {
      fontSize: 12,
      color: c.textMuted,
    },
    button: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 10,
    },
    primaryButton: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    buttonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    primaryButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.onPrimary,
    },
    pressedFade: {
      opacity: 0.9,
    },
  });
}
