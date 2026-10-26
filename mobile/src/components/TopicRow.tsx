/**
 * Shared topic list row: icon, title, two-line description, count + due
 * badges, and the trailing ⋮ menu button. One component serves both the word
 * topics and the sentence topics screens — the rows were structurally
 * identical, differing only in icon, count wording and testIDs.
 *
 * `testID` prefixes the row (`<testID>`) and the due/done badge
 * (`<testID>-due` / `<testID>-done`); `menuTestID` targets the ⋮ button.
 */
import { useMemo } from 'react';
import { type GestureResponderEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { Icon, type IconName } from './Icon';

export interface TopicRowProps {
  title: string;
  /** Second line under the title; omitted when empty. */
  description?: string;
  /** Leading row icon ("words" / "sentences"). */
  icon: IconName;
  /** Pluralized count chip text, e.g. "12 words" / "3 sentences". */
  countLabel: string;
  /** Due-badge number; 0 renders the "all done" ghost chip instead. */
  dueCount: number;
  onPress: () => void;
  /** The ⋮ press; carries the event so the caller can anchor its menu. */
  onMenuPress: (event: GestureResponderEvent) => void;
  testID: string;
  menuTestID: string;
  index: number;
}

export function TopicRow({
  title,
  description,
  icon,
  countLabel,
  dueCount,
  onPress,
  onMenuPress,
  testID,
  menuTestID,
  index,
}: TopicRowProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const dueBadge =
    dueCount > 0 ? (
      <View style={styles.badge} testID={`${testID}-due`}>
        <Text style={[styles.badgeLabel, { color: colors.onPrimary }]}>{dueCount} due</Text>
      </View>
    ) : (
      <View style={styles.badgeGhost} testID={`${testID}-done`}>
        <Text style={[styles.badgeLabel, { color: colors.textMuted }]}>all done</Text>
      </View>
    );

  return (
    <View style={[styles.row, index > 0 && styles.rowGap]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title} — ${countLabel}, ${dueCount} due`}
        testID={testID}
        onPress={onPress}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressedFade]}>
        <View style={styles.rowIcon}>
          <Icon name={icon} color={colors.accent} />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          {description ? (
            <Text style={styles.rowDescription} numberOfLines={2}>
              {description}
            </Text>
          ) : null}
          <View style={styles.rowCounts}>
            <Text style={styles.badgeGhost}>{countLabel}</Text>
            {dueBadge}
          </View>
        </View>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Topic actions for ${title}`}
        testID={menuTestID}
        onPress={onMenuPress}
        style={({ pressed }) => [styles.rowMenuButton, pressed && styles.pressedFade]}>
        <Icon name="more" size={18} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    rowGap: {
      marginTop: 6,
    },
    rowMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowText: {
      flex: 1,
      gap: 4,
    },
    rowTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: c.textPrimary,
    },
    rowDescription: {
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 18,
    },
    rowCounts: {
      flexDirection: 'row',
      gap: 8,
    },
    badge: {
      fontSize: 12,
      fontWeight: '600',
      color: c.onPrimary,
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    badgeGhost: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textMuted,
      backgroundColor: c.surface,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    badgeLabel: {
      fontSize: 12,
      fontWeight: '600',
    },
    rowMenuButton: {
      width: 30,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressedFade: {
      opacity: 0.9,
    },
  });
}
