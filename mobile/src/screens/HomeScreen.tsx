/**
 * Homepage hub (TASK-HOME-001): the authenticated landing screen that
 * routes to every main destination instead of burying practice behind
 * Settings. Each row pushes its route; the conversations row opens the
 * Chat screen, whose no-session landing restores the most recent
 * conversation (TASK-AUDIT-008) or offers the new-conversation form.
 * The layout follows the Settings row-group pattern so every destination
 * reads as one familiar list.
 */
import React, {useMemo} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import type {HomeScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

interface HomeRow {
  title: string;
  description: string;
  onPress: () => void;
  testID: string;
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
      minHeight: 60,
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 6,
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
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const sections: HomeSection[] = useMemo(
    () => [
      {
        title: 'Continue learning',
        rows: [
          {
            title: 'Conversations',
            description: 'Chat with the AI tutor about a topic or your questions.',
            onPress: () => navigation.navigate('Chat'),
            testID: 'home-open-chat',
          },
          {
            title: 'History',
            description: 'Revisit your past conversations.',
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
            onPress: () => navigation.navigate('Practice'),
            testID: 'home-open-listening',
          },
          {
            title: 'Speaking practice',
            description: 'Read aloud with a karaoke-style scrolling text.',
            onPress: () => navigation.navigate('SpeakingPractice'),
            testID: 'home-open-speaking',
          },
          {
            title: 'Speaking history',
            description: 'Review your completed speaking practice sessions.',
            onPress: () => navigation.navigate('SpeakingHistory'),
            testID: 'home-open-speaking-history',
          },
        ],
      },
      {
        title: 'Account and app',
        rows: [
          {
            title: 'Settings',
            description: 'Account, AI provider, level, speech and theme.',
            onPress: () => navigation.navigate('Settings'),
            testID: 'home-open-settings',
          },
        ],
      },
    ],
    [navigation],
  );

  return (
    <View style={styles.container} testID="home-screen">
      <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.heroCard}>
            <Text style={styles.title}>Home</Text>
            <Text style={styles.subtitle}>What would you like to practice today?</Text>
          </View>
          {sections.map(section => (
            <View key={section.title} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <View style={styles.rowGroup}>
                {section.rows.map((row, index) => (
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
                    <Text style={styles.rowTitle}>{row.title}</Text>
                    <Text style={styles.rowDescription}>{row.description}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
