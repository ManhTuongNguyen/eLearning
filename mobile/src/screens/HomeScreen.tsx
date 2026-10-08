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

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: 16,
      paddingHorizontal: 24,
      paddingBottom: 24,
    },
    title: {
      fontSize: 26,
      fontWeight: '700',
      color: c.textPrimary,
      marginBottom: 6,
    },
    subtitle: {
      fontSize: 14,
      color: c.textSecondary,
      marginBottom: 20,
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
      justifyContent: 'space-between',
      paddingVertical: 14,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rowPressed: {
      backgroundColor: c.accentSoft,
    },
    rowTexts: {
      flex: 1,
      paddingRight: 12,
    },
    rowTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    rowDescription: {
      fontSize: 13,
      color: c.textSecondary,
      marginTop: 2,
    },
    chevron: {
      fontSize: 18,
      color: c.textMuted,
    },
  });
}

export function HomeScreen({navigation}: HomeScreenProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const rows: HomeRow[] = useMemo(
    () => [
      {
        title: 'Conversations',
        description: 'Chat with the AI tutor about a topic or your questions.',
        onPress: () => navigation.navigate('Chat'),
        testID: 'home-open-chat',
      },
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
        title: 'History',
        description: 'Revisit your past conversations.',
        onPress: () => navigation.navigate('History'),
        testID: 'home-open-history',
      },
      {
        title: 'Settings',
        description: 'Account, AI provider, level, speech and theme.',
        onPress: () => navigation.navigate('Settings'),
        testID: 'home-open-settings',
      },
    ],
    [navigation],
  );

  return (
    <View style={styles.container} testID="home-screen">
      <Text style={styles.title}>Home</Text>
      <Text style={styles.subtitle}>Where would you like to practice today?</Text>
      <ScrollView bounces={false}>
        <View style={styles.rowGroup}>
          {rows.map(row => (
            <Pressable
              key={row.testID}
              accessibilityRole="button"
              accessibilityLabel={row.title}
              onPress={row.onPress}
              style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
              testID={row.testID}>
              <View style={styles.rowTexts}>
                <Text style={styles.rowTitle}>{row.title}</Text>
                <Text style={styles.rowDescription}>{row.description}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
