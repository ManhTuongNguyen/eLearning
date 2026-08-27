/**
 * Settings screen (TASK-043): hosts account actions for the authenticated
 * user — learning-level entry (SPEC TASK-018), saved vocabulary (SPEC
 * TASK-072), theme selection (SPEC TASK-044), application-mode switching
 * (SPEC TASK-090) and logout (SPEC TASK-015).
 */
import React, {useMemo} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';

import {useAuth} from '../auth/AuthContext';
import {useApplicationMode} from '../mode/ModeContext';
import type {ApplicationMode} from '../mode/types';
import type {SettingsScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';
import type {ThemeMode} from '../theme/ThemeContext';

const THEME_OPTIONS: Array<{value: ThemeMode; label: string; testID: string}> = [
  {value: 'light', label: 'Light', testID: 'settings-theme-light'},
  {value: 'dark', label: 'Dark', testID: 'settings-theme-dark'},
  {value: 'system', label: 'System', testID: 'settings-theme-system'},
];

const APPLICATION_MODE_OPTIONS: Array<{
  value: ApplicationMode;
  label: string;
  description: string;
  testID: string;
}> = [
  {
    value: 'server',
    label: 'Server mode',
    description: 'Your conversations are stored with your account.',
    testID: 'settings-mode-server',
  },
  {
    value: 'serverless',
    label: 'Serverless mode',
    description:
      'Conversations stay on this device and AI requests go directly to OpenRouter.',
    testID: 'settings-mode-serverless',
  },
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
    modeSection: {
      alignSelf: 'stretch',
      gap: 8,
      marginBottom: 16,
    },
    modeSectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textSecondary,
      textAlign: 'center',
    },
    modeOption: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    modeOptionSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    modeRadioOuter: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: c.borderStrong,
      marginTop: 1,
    },
    modeRadioOuterSelected: {
      borderColor: c.accent,
    },
    modeRadioInner: {
      flex: 1,
      margin: 3,
      borderRadius: 7,
      backgroundColor: c.accent,
    },
    modeTexts: {
      flex: 1,
      gap: 4,
    },
    modeLabel: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    modeLabelSelected: {
      color: c.accent,
    },
    modeDescription: {
      fontSize: 13,
      color: c.textSecondary,
      lineHeight: 18,
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
  // Two independent "mode" concepts live side by side here: the visual theme
  // and the SERVER/SERVERLESS application mode (TASK-090) — aliased apart.
  const {mode: themeMode, setMode: setThemeMode, colors} = useTheme();
  const {mode: appMode, setMode: setApplicationMode} = useApplicationMode();
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
            const isSelected = option.value === themeMode;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{checked: isSelected}}
                onPress={() => setThemeMode(option.value)}
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

      <View style={styles.modeSection} testID="settings-mode-section">
        <Text style={styles.modeSectionTitle}>Application mode</Text>
        {APPLICATION_MODE_OPTIONS.map(option => {
          const isSelected = option.value === appMode;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{checked: isSelected}}
              onPress={() => setApplicationMode(option.value)}
              style={({pressed}) => [
                styles.modeOption,
                isSelected && styles.modeOptionSelected,
                pressed && styles.buttonDisabled,
              ]}
              testID={option.testID}>
              <View
                style={[
                  styles.modeRadioOuter,
                  isSelected && styles.modeRadioOuterSelected,
                ]}>
                {isSelected ? <View style={styles.modeRadioInner} /> : null}
              </View>
              <View style={styles.modeTexts}>
                <Text
                  style={[
                    styles.modeLabel,
                    isSelected && styles.modeLabelSelected,
                  ]}>
                  {option.label}
                </Text>
                <Text style={styles.modeDescription}>{option.description}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        style={styles.secondaryButton}
        onPress={() => navigation.navigate('Level')}
        testID="settings-open-level">
        <Text style={styles.secondaryButtonText}>Learning level</Text>
      </Pressable>

      <Pressable
        style={styles.secondaryButton}
        onPress={() => navigation.navigate('Vocabulary')}
        testID="settings-open-vocabulary">
        <Text style={styles.secondaryButtonText}>Vocabulary</Text>
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
