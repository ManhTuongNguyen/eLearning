/**
 * Homepage hub (TASK-HOME-001): the authenticated landing screen that
 * routes to every main destination instead of burying practice behind
 * Settings. Each row pushes its route; the conversations row opens the
 * Chat screen, whose no-session landing restores the most recent
 * conversation (TASK-AUDIT-008) or offers the new-conversation form.
 * The layout follows the Settings row-group pattern so every destination
 * reads as one familiar list.
 *
 * Every row carries a leading icon (TASK-SENT-002) rendered through the icon
 * seam, so the hub is scannable at a glance. The icon sits in a fixed-width
 * column and the text column keeps `flex: 1`, which is what keeps long
 * descriptions wrapping instead of being squeezed on narrow screens.
 *
 * Real-life sentences (TASK-SENT-014) are on-device only: the row exists in
 * serverless mode and carries a due-today badge read from the local review
 * schedule. Server mode never shows the row or touches the local database.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {Icon} from '../components/Icon';
import type {IconName} from '../components/Icon';
import {getLocalDatabase} from '../db/database';
import {countDueSentences} from '../db/sentenceRepository';
import {useApplicationMode} from '../mode/ModeContext';
import type {HomeScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

interface HomeRow {
  title: string;
  description: string;
  icon: IconName;
  onPress: () => void;
  testID: string;
  /** Rendered only in these modes; omitted means every mode. */
  modes?: ('server' | 'serverless')[];
  /** Trailing count pill; zero (or omitted) hides it. */
  badgeCount?: number;
}

interface HomeSection {
  title: string;
  rows: HomeRow[];
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: 16,
      paddingHorizontal: 20,
      paddingBottom: 16,
    },
    content: {
      paddingBottom: 28,
      gap: 18,
    },
    heroCard: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      paddingVertical: 16,
      paddingHorizontal: 16,
      gap: 6,
    },
    title: {
      fontSize: 26,
      fontWeight: '700',
      color: c.textPrimary,
    },
    subtitle: {
      fontSize: 15,
      lineHeight: 21,
      color: c.textMuted,
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
    rowBadge: {
      minWidth: 26,
      height: 26,
      borderRadius: 13,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.primary,
    },
    rowBadgeText: {
      fontSize: 12,
      fontWeight: '700',
      color: c.onPrimary,
    },
    rowPressed: {
      backgroundColor: c.accentSoft,
      opacity: 0.9,
    },
    rowDivider: {
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    rowTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    rowDescription: {
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 18,
    },
  });
}

export function HomeScreen({navigation}: HomeScreenProps) {
  const {status: modeStatus, mode} = useApplicationMode();
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Real-life sentences are on-device only; the row appears once the
  // persisted mode has been restored and only in serverless mode
  // (TASK-SENT-014), so server-mode users never see a dead destination.
  const serverlessReady = modeStatus === 'ready' && mode === 'serverless';
  const [dueCount, setDueCount] = useState(0);

  const loadDueCount = useCallback(async () => {
    if (!serverlessReady) {
      setDueCount(0);
      return;
    }
    try {
      const db = await getLocalDatabase();
      setDueCount(await countDueSentences(db));
    } catch {
      // The badge is advisory: a local database failure must never take the
      // Home hub down with it.
      setDueCount(0);
    }
  }, [serverlessReady]);

  useEffect(() => {
    loadDueCount();
  }, [loadDueCount]);

  // Refresh after practice or topic edits; the badge is computed when Home
  // regains focus rather than polled.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('focus', () => {
      loadDueCount();
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, loadDueCount]);

  const sections: HomeSection[] = useMemo(
    () => [
      {
        title: 'Continue learning',
        rows: [
          {
            title: 'Conversations',
            description: 'Chat with the AI tutor about a topic or your questions.',
            icon: 'chat',
            onPress: () => navigation.navigate('Chat'),
            testID: 'home-open-chat',
          },
          {
            title: 'History',
            description: 'Revisit your past conversations.',
            icon: 'history',
            onPress: () => navigation.navigate('History'),
            testID: 'home-open-history',
          },
        ],
      },
      {
        title: 'Practice',
        rows: [
          {
            title: 'Listening practice',
            description: 'Train reflexes for numbers and letters you hear.',
            icon: 'listening',
            onPress: () => navigation.navigate('Practice'),
            testID: 'home-open-listening',
          },
          {
            title: 'Speaking practice',
            description: 'Read aloud with a karaoke-style scrolling text.',
            icon: 'speaking',
            onPress: () => navigation.navigate('SpeakingPractice'),
            testID: 'home-open-speaking',
          },
          {
            title: 'Speaking history',
            description: 'Review your completed speaking practice sessions.',
            icon: 'speakingHistory',
            onPress: () => navigation.navigate('SpeakingHistory'),
            testID: 'home-open-speaking-history',
          },
          {
            title: 'Real-life sentences',
            description:
              'Collect everyday English and drill it with spaced repetition.',
            icon: 'sentences',
            onPress: () => navigation.navigate('SentenceTopics'),
            testID: 'home-open-sentences',
            modes: ['serverless'],
            badgeCount: dueCount,
          },
        ],
      },
      {
        title: 'Account and app',
        rows: [
          {
            title: 'Settings',
            description: 'Account, AI provider, level, speech and theme.',
            icon: 'settings',
            onPress: () => navigation.navigate('Settings'),
            testID: 'home-open-settings',
          },
        ],
      },
    ],
    [navigation, dueCount],
  );

  return (
    <View style={styles.container} testID="home-screen">
      <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.heroCard}>
            <Text style={styles.title}>Home</Text>
            <Text style={styles.subtitle}>What would you like to practice today?</Text>
          </View>
          {sections.map(section => {
            const rows = section.rows.filter(row => {
              if (!row.modes) {
                return true;
              }
              return modeStatus === 'ready' && row.modes.includes(mode);
            });
            if (rows.length === 0) {
              return null;
            }
            return (
              <View key={section.title} style={styles.section}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <View style={styles.rowGroup}>
                  {rows.map((row, index) => (
                    <Pressable
                      key={row.testID}
                      accessibilityRole="button"
                      accessibilityLabel={`${row.title} — ${row.description}`}
                      hitSlop={6}
                      onPress={row.onPress}
                      style={({pressed}) => [
                        styles.row,
                        index > 0 && styles.rowDivider,
                        pressed && styles.rowPressed,
                      ]}
                      testID={row.testID}>
                      <View style={styles.rowIcon}>
                        <Icon name={row.icon} color={colors.accent} />
                      </View>
                      <View style={styles.rowText}>
                        <Text style={styles.rowTitle}>{row.title}</Text>
                        <Text style={styles.rowDescription}>{row.description}</Text>
                      </View>
                      {row.badgeCount && row.badgeCount > 0 ? (
                        <View
                          accessibilityLabel={`${row.badgeCount} due today`}
                          style={styles.rowBadge}
                          testID={`${row.testID}-badge`}>
                          <Text style={styles.rowBadgeText}>{row.badgeCount}</Text>
                        </View>
                      ) : null}
                    </Pressable>
                  ))}
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
