/**
 * FSRS schedule info card for the word detail screen (WORD_BANK_V1
 * TASK-WB-012): the stored card state as label/value rows — state, due
 * instant, stability, difficulty, reps, lapses and the last grade.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { WordRecord } from '../db/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

/** The stored FSRS schedule, formatted for the info block. */
export function describeSchedule(
  word: WordRecord,
  now: Date,
): Array<{ label: string; value: string }> {
  const dueDate = new Date(word.due_at);
  const due = Number.isFinite(dueDate.getTime())
    ? `${dueDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ` +
      `${dueDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : word.due_at;
  const rows: Array<{ label: string; value: string }> = [
    { label: 'State', value: word.state },
    { label: 'Due', value: dueDate.getTime() <= now.getTime() ? `${due} (due now)` : due },
    { label: 'Stability', value: `${word.stability}` },
    { label: 'Difficulty', value: `${word.difficulty}` },
    { label: 'Reps', value: `${word.reps}` },
    { label: 'Lapses', value: `${word.lapses}` },
  ];
  if (word.last_grade) {
    const lastDate = new Date(word.last_reviewed_at);
    rows.push({
      label: 'Last grade',
      value:
        `${word.last_grade}` +
        (Number.isFinite(lastDate.getTime())
          ? ` (${lastDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})`
          : ''),
    });
  }
  return rows;
}

export interface WordScheduleCardProps {
  word: WordRecord;
}

export function WordScheduleCard({ word }: WordScheduleCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const rows = useMemo(() => describeSchedule(word, new Date()), [word]);

  return (
    <View style={styles.scheduleCard} testID="word-detail-schedule">
      {rows.map(row => (
        <View key={row.label} style={styles.scheduleRow}>
          <Text style={styles.scheduleLabel}>{row.label}</Text>
          <Text
            style={styles.scheduleValue}
            testID={`word-detail-schedule-${row.label.toLowerCase().replace(' ', '-')}`}>
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    scheduleCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      gap: 6,
    },
    scheduleRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    scheduleLabel: {
      fontSize: 13,
      color: c.textMuted,
    },
    scheduleValue: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textPrimary,
    },
  });
}
