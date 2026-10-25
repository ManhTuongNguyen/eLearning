/**
 * Character-level answer diff for word practice: each segment colored by its
 * verdict — correct letters in the success color, missing letters underlined
 * in the danger color, extra typed letters struck through in the warning
 * color — plus the one-line "N missing · N extra" summary. Word-level diffs
 * are meaningless for a single word; the learner needs to see WHICH
 * characters were wrong.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, type TextStyle, View } from 'react-native';
import type { CharDiffKind, CharDiffSegment } from '../srs/answerCheck';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

/** Character-level diff colors: typed-but-wrong struck, missing letters underlined. */
function charSegmentStyle(kind: CharDiffKind, colors: ThemeColors): TextStyle {
  switch (kind) {
    case 'correct':
      return { color: colors.success };
    case 'missing':
      return { color: colors.danger, textDecorationLine: 'underline' };
    case 'extra':
      return { color: colors.warning, textDecorationLine: 'line-through' };
  }
}

/** The one-line result summary for the character diff ("1 missing · 1 extra"). */
export function diffSummary(segments: readonly CharDiffSegment[]): string {
  const counts = { missing: 0, extra: 0 };
  for (const segment of segments) {
    if (segment.kind === 'missing') {
      counts.missing += segment.text.length;
    } else if (segment.kind === 'extra') {
      counts.extra += segment.text.length;
    }
  }
  if (counts.missing === 0 && counts.extra === 0) {
    return 'Exact match.';
  }
  const parts: string[] = [];
  if (counts.missing > 0) {
    parts.push(`${counts.missing} missing`);
  }
  if (counts.extra > 0) {
    parts.push(`${counts.extra} extra`);
  }
  return parts.join(' · ');
}

export interface AnswerDiffProps {
  /** The typed-vs-target character diff; null renders nothing. */
  segments: readonly CharDiffSegment[] | null;
}

export function AnswerDiff({ segments }: AnswerDiffProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (segments === null) {
    return null;
  }

  return (
    <>
      <View style={styles.diffRow} testID="word-practice-diff">
        {segments.map((segment, index) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: diff segments are positional
            key={`${segment.kind}-${index}`}
            accessibilityLabel={`${segment.kind} characters: ${segment.text}`}
            style={[styles.diffToken, charSegmentStyle(segment.kind, colors)]}
            testID={`word-practice-diff-char-${index}`}>
            {segment.text}
          </Text>
        ))}
      </View>
      <Text style={styles.diffSummary} testID="word-practice-diff-summary">
        {diffSummary(segments)}
      </Text>
    </>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    diffRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 10,
      backgroundColor: c.background,
    },
    diffToken: {
      fontSize: 16,
      fontWeight: '600',
    },
    diffSummary: {
      fontSize: 13,
      color: c.textSecondary,
    },
  });
}
