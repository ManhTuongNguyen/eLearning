/**
 * Anki's four grade buttons, shared by the word and sentence practice
 * screens: uniform layout, and the pre-suggested grade is highlighted
 * (border + accent background + colored label) instead of an inline check
 * mark that would shift the text inside the button.
 *
 * `testIDPrefix` keeps each screen's existing testIDs: the buttons render
 * `<prefix>-<grade>` and the interval labels `<prefix>-interval-<grade>`.
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ReviewGrade } from '../db/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

/** The four Anki grades in display order. */
export const GRADE_OPTIONS: Array<{ grade: ReviewGrade; label: string }> = [
  { grade: 'again', label: 'Again' },
  { grade: 'hard', label: 'Hard' },
  { grade: 'good', label: 'Good' },
  { grade: 'easy', label: 'Easy' },
];

/** Session summary tallies per grade. */
export type GradeCounts = Record<ReviewGrade, number>;

/** Fresh zeroed tallies for a new session. */
export const EMPTY_GRADE_COUNTS: GradeCounts = { again: 0, hard: 0, good: 0, easy: 0 };

export interface GradeButtonsProps {
  /** The scheduler's suggested grade, highlighted on its button. */
  suggested: ReviewGrade | null;
  /** True while the review persists; every button disables and dims. */
  saving: boolean;
  /** Optional next-interval label per grade, e.g. from `previewSchedule`. */
  intervals?: Partial<Record<ReviewGrade, string>>;
  onGrade: (grade: ReviewGrade) => void;
  /** testID prefix for the buttons and their interval labels. */
  testIDPrefix: string;
}

export function GradeButtons({
  suggested,
  saving,
  intervals,
  onGrade,
  testIDPrefix,
}: GradeButtonsProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.gradeRow}>
      {GRADE_OPTIONS.map(option => {
        const isSuggested = suggested === option.grade;
        const interval = intervals?.[option.grade];
        return (
          <Pressable
            key={option.grade}
            accessibilityRole="button"
            accessibilityLabel={`Grade ${option.label}`}
            accessibilityState={{ disabled: saving, selected: isSuggested }}
            testID={`${testIDPrefix}-${option.grade}`}
            disabled={saving}
            onPress={() => onGrade(option.grade)}
            style={({ pressed }) => [
              styles.gradeButton,
              isSuggested && styles.gradeButtonSuggested,
              saving && styles.buttonDisabled,
              pressed && styles.pressedFade,
            ]}>
            <Text
              style={[
                styles.gradeText,
                { color: isSuggested ? colors.primary : colors.textPrimary },
              ]}>
              {option.label}
            </Text>
            {interval ? (
              <Text
                style={styles.gradeIntervalText}
                testID={`${testIDPrefix}-interval-${option.grade}`}>
                {interval}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    gradeRow: {
      flexDirection: 'row',
      gap: 10,
    },
    gradeButton: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      paddingVertical: 12,
    },
    gradeButtonSuggested: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    gradeText: {
      fontSize: 14,
      fontWeight: '700',
      color: c.textPrimary,
    },
    gradeIntervalText: {
      fontSize: 11,
      fontWeight: '600',
      color: c.textMuted,
      marginTop: 2,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    pressedFade: {
      opacity: 0.7,
    },
  });
}
