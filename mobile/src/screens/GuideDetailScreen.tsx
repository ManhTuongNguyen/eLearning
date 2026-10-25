/**
 * One guide entry rendered as a full page: intro, numbered usage steps, the
 * per-action AI request card, prompt notes, tips and — when the target takes
 * no parameters — a deep-link button that opens the real screen. All content
 * comes from guideContent.ts; this file only renders it.
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  SCREEN_TOP_SPACING,
  Screen,
  ScreenContent,
  ScreenScrollView,
} from '../components/ScreenLayout';
import { ScreenTitleBar } from '../components/ScreenTitleBar';
import { guideEntries, guideModeBadge } from '../guide/guideContent';
import type { GuideAiUsage, GuideEntry } from '../guide/types';
import type { GuideDetailScreenProps } from '../navigation/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
    },
    header: {
      paddingTop: SCREEN_TOP_SPACING,
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 40,
    },
    scroll: {
      paddingTop: 16,
      gap: 22,
    },
    missingText: {
      fontSize: 14,
      color: c.textMuted,
      marginTop: 4,
    },
    modeNotice: {
      backgroundColor: c.accentSoft,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 2,
    },
    modeNoticeBadge: {
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: c.accent,
    },
    modeNoticeText: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textSecondary,
    },
    intro: {
      fontSize: 15,
      lineHeight: 22,
      color: c.textSecondary,
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
    step: {
      flexDirection: 'row',
      gap: 12,
    },
    stepNumber: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.accentSoft,
    },
    stepNumberText: {
      fontSize: 13,
      fontWeight: '700',
      color: c.accent,
    },
    stepText: {
      flex: 1,
      fontSize: 15,
      lineHeight: 21,
      color: c.textPrimary,
    },
    aiCard: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      padding: 14,
      gap: 12,
    },
    aiIntro: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textMuted,
    },
    aiRow: {
      gap: 4,
    },
    aiRowTop: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    aiAction: {
      flex: 1,
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
    },
    aiChip: {
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 3,
      backgroundColor: c.accentSoft,
    },
    aiChipText: {
      fontSize: 11,
      fontWeight: '600',
      color: c.accent,
    },
    aiNote: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textMuted,
    },
    bullet: {
      flexDirection: 'row',
      gap: 10,
    },
    bulletMarker: {
      width: 12,
      fontSize: 15,
      lineHeight: 21,
      color: c.accent,
    },
    bulletText: {
      flex: 1,
      fontSize: 14,
      lineHeight: 20,
      color: c.textSecondary,
    },
    tryItButton: {
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tryItText: {
      fontSize: 15,
      fontWeight: '700',
      color: c.onPrimary,
    },
  });
}

function ModeNotice({
  entry,
  styles,
}: {
  entry: GuideEntry;
  styles: ReturnType<typeof createStyles>;
}) {
  if (!entry.mode) {
    return null;
  }
  return (
    <View style={styles.modeNotice} testID={`guide-mode-notice-${entry.id}`}>
      <Text style={styles.modeNoticeBadge}>{guideModeBadge(entry.mode)}</Text>
      <Text style={styles.modeNoticeText}>
        {entry.mode === 'serverless'
          ? 'This feature runs on this device with your own API key — add it in Settings first.'
          : 'This feature needs the backend connection of server mode.'}
      </Text>
    </View>
  );
}

function AiUsageRow({
  usage,
  styles,
}: {
  usage: GuideAiUsage;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.aiRow}>
      <View style={styles.aiRowTop}>
        <Text style={styles.aiAction}>{usage.action}</Text>
        <View style={styles.aiChip}>
          <Text style={styles.aiChipText}>{usage.requests}</Text>
        </View>
      </View>
      {usage.note ? <Text style={styles.aiNote}>{usage.note}</Text> : null}
    </View>
  );
}

function Bullets({ items, styles }: { items: string[]; styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.section}>
      {items.map(item => (
        <View key={item} style={styles.bullet}>
          <Text style={styles.bulletMarker}>•</Text>
          <Text style={styles.bulletText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

export function GuideDetailScreen({ route, navigation }: GuideDetailScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const entry = guideEntries[route.params.guideId];

  if (!entry) {
    return (
      <Screen style={styles.container} testID="guide-detail-screen">
        <ScreenTitleBar
          title="App guide"
          onBack={() => navigation.goBack()}
          backTestID="guide-detail-back"
        />
        <ScreenContent>
          <Text style={styles.missingText}>This guide entry does not exist.</Text>
        </ScreenContent>
      </Screen>
    );
  }

  // Bound to a const so the truthiness narrowing survives into the onPress
  // closure (property narrowing on `entry.tryIt` would not).
  const tryIt = entry.tryIt;

  return (
    <Screen style={styles.container} testID="guide-detail-screen">
      <ScreenTitleBar
        title={entry.title}
        onBack={() => navigation.goBack()}
        backTestID="guide-detail-back"
      />
      <ScreenScrollView contentContainerStyle={styles.scroll}>
        <ModeNotice entry={entry} styles={styles} />
        <Text style={styles.intro}>{entry.intro}</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How to use it</Text>
          <View style={styles.section}>
            {entry.steps.map((step, index) => (
              <View key={step} style={styles.step}>
                <View style={styles.stepNumber}>
                  <Text style={styles.stepNumberText}>{index + 1}</Text>
                </View>
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>AI requests</Text>
          <View style={styles.aiCard} testID="guide-ai-card">
            <Text style={styles.aiIntro}>{entry.aiIntro}</Text>
            {entry.aiUsage.map(usage => (
              <AiUsageRow key={usage.action} usage={usage} styles={styles} />
            ))}
          </View>
        </View>

        {entry.promptTips.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Getting better results</Text>
            <Bullets items={entry.promptTips} styles={styles} />
          </View>
        ) : null}

        {entry.tips.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Tips</Text>
            <Bullets items={entry.tips} styles={styles} />
          </View>
        ) : null}

        {tryIt ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tryIt.label}
            onPress={() => navigation.navigate(tryIt.route)}
            style={styles.tryItButton}
            testID={`guide-tryit-${entry.id}`}>
            <Text style={styles.tryItText}>{tryIt.label}</Text>
          </Pressable>
        ) : null}
      </ScreenScrollView>
    </Screen>
  );
}
