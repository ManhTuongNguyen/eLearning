/**
 * Settings screen (TASK-043): hosts account actions for the authenticated
 * user — learning-level entry (SPEC TASK-018), theme selection (SPEC
 * TASK-044) and logout (SPEC TASK-015).
 */
import React, {useMemo} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';

import {useAuth} from '../auth/AuthContext';
import type {SettingsScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';
import type {ThemeMode} from '../theme/ThemeContext';

const THEME_OPTIONS: Array<{value: ThemeMode; label: string; testID: string}> = [
  {value: 'light', label: 'Light', testID: 'settings-theme-light'},
  {value: 'dark', label: 'Dark', testID: 'settings-theme-dark'},
  {value: 'system', label: 'System', testID: 'settings-theme-system'},
];

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.background,
      padding: 24,
      gap: 8,
    },
    title: {
      fontSize: 26,
      fontWeight: '700',
      color: c.textPrimary,
    },
    subtitle: {
      fontSize: 14,
      color: c.textSecondary,
      marginBottom: 16,
    },
    section: {
      alignItems: 'center',
      gap: 8,
      marginBottom: 16,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textSecondary,
    },
    segmentRow: {
      flexDirection: 'row',
      gap: 8,
    },
    segment: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 16,
    },
    segmentSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    segmentText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
    },
    segmentTextSelected: {
      color: c.accent,
    },
    button: {
      backgroundColor: c.danger,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 32,
      alignItems: 'center',
      minWidth: 140,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    buttonText: {
      color: c.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    secondaryButton: {
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 32,
      alignItems: 'center',
      minWidth: 140,
    },
    secondaryButtonText: {
      color: c.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
  });
}

export function SettingsScreen({navigation}: SettingsScreenProps) {
  const {user, logout, busy} = useAuth();
  const {mode, setMode, colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.container} testID="settings-screen">
      <Text style={styles.title}>Settings</Text>
      {user ? (
        <Text style={styles.subtitle}>{user.email}</Text>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Theme</Text>
        <View style={styles.segmentRow}>
          {THEME_OPTIONS.map(option => {
            const isSelected = option.value === mode;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{checked: isSelected}}
                onPress={() => setMode(option.value)}
                style={({pressed}) => [
                  styles.segment,
                  isSelected && styles.segmentSelected,
                  pressed && styles.buttonDisabled,
                ]}
                testID={option.testID}>
                <Text
                  style={[
                    styles.segmentText,
                    isSelected && styles.segmentTextSelected,
                  ]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Pressable
        style={styles.secondaryButton}
        onPress={() => navigation.navigate('Level')}
        testID="settings-open-level">
        <Text style={styles.secondaryButtonText}>Learning level</Text>
      </Pressable>

      <Pressable
        style={[styles.button, busy && styles.buttonDisabled]}
        disabled={busy}
        onPress={() => {
          logout();
        }}
        testID="settings-logout">
        {busy ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>Log out</Text>
        )}
      </Pressable>
    </View>
  );
}
