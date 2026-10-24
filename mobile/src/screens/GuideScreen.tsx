/**
 * Guide hub: the entry screen of the in-app guide. Lists one row per guide
 * entry (src/guide/guideContent.ts), grouped like the Home hub so the two
 * screens read as one familiar pattern. Every row — including features that
 * exist in only one application mode — is always listed: a guide's job is to
 * explain, so mode-specific entries carry a visible mode badge instead of
 * being hidden.
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import { Screen, ScreenContent, ScreenHeader, ScreenScrollView } from '../components/ScreenLayout';
import { guideEntries, guideModeBadge, guideSections } from '../guide/guideContent';
import type { GuideEntry } from '../guide/types';
import type { GuideScreenProps } from '../navigation/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
    },
    header: {
      paddingTop: 16,
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 40,
    },
    backText: {
      fontSize: 16,
      color: c.accent,
    },
    headerSpacer: {
      width: 48,
    },
    headerTitle: {
      flex: 1,
      textAlign: 'center',
      fontSize: 17,
      fontWeight: '600',
      color: c.textPrimary,
    },
    subtitle: {
      fontSize: 14,
      lineHeight: 20,
      color: c.textMuted,
      marginTop: 4,
    },
    scroll: {
      paddingTop: 16,
      gap: 18,
    },
    section: {
      gap: 10,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '700',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      color: c.textMuted,
      paddingHorizontal: 2,
    },
    rowGroup: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 60,
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 14,
    },
    rowIcon: {
      width: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowText: {
      flex: 1,
      gap: 4,
    },
    rowTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    rowSummary: {
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 18,
    },
    modeBadge: {
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 3,
      backgroundColor: c.accentSoft,
    },
    modeBadgeText: {
      fontSize: 11,
      fontWeight: '600',
      color: c.accent,
    },
    rowPressed: {
      backgroundColor: c.accentSoft,
      opacity: 0.9,
    },
    rowDivider: {
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
  });
}

function GuideRow({
  entry,
  iconColor,
  onPress,
  isFirst,
  styles,
}: {
  entry: GuideEntry;
  iconColor: string;
  onPress: () => void;
  isFirst: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.title} — ${entry.summary}`}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !isFirst && styles.rowDivider,
        pressed && styles.rowPressed,
      ]}
      testID={`guide-open-${entry.id}`}>
      <View style={styles.rowIcon}>
        <Icon name={entry.icon} color={iconColor} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{entry.title}</Text>
        <Text style={styles.rowSummary}>{entry.summary}</Text>
      </View>
      {entry.mode ? (
        <View style={styles.modeBadge}>
          <Text style={styles.modeBadgeText}>{guideModeBadge(entry.mode)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function GuideScreen({ navigation }: GuideScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Screen style={styles.container} testID="guide-screen">
      <ScreenHeader style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          hitSlop={8}
          onPress={() => navigation.goBack()}
          testID="guide-back">
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>App guide</Text>
        <View style={styles.headerSpacer} />
      </ScreenHeader>
      <ScreenContent>
        <Text style={styles.subtitle}>
          How every feature works, which actions ask the AI, and how to get better results.
        </Text>
      </ScreenContent>
      <ScreenScrollView contentContainerStyle={styles.scroll}>
        {guideSections.map(section => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <View style={styles.rowGroup}>
              {section.ids.map((id, index) => (
                <GuideRow
                  key={id}
                  entry={guideEntries[id]}
                  iconColor={colors.accent}
                  isFirst={index === 0}
                  styles={styles}
                  onPress={() => navigation.navigate('GuideDetail', { guideId: id })}
                />
              ))}
            </View>
          </View>
        ))}
      </ScreenScrollView>
    </Screen>
  );
}
