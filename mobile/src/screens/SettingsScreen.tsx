/**
 * Settings screen (SPEC TASK-091): single surface for every account and
 * preference control, showing only the options that are relevant to the
 * active application mode (TASK-080).
 *
 * Always shown: signed-in account identity, application-mode switcher
 * (TASK-090), theme selection (TASK-044) and logout (TASK-015). Server mode
 * adds rows backed by server features — learning level editing (TASK-018)
 * and the saved vocabulary list (TASK-072). Serverless mode replaces them
 * with an OpenRouter settings card reporting whether a local AI
 * configuration exists — the key itself is stored in secure storage and is
 * never displayed (TASK-083/092); local data clearing arrives with its own
 * task (TASK-094), so it is not rendered until it can actually work.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {useAuth} from '../auth/AuthContext';
import {useApplicationMode} from '../mode/ModeContext';
import type {ApplicationMode} from '../mode/types';
import type {SettingsScreenProps} from '../navigation/types';
import {loadServerlessOpenRouterConfig} from '../serverless/settings';
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

/** Row shape shared by both mode-specific sections. */
interface SettingsRow {
  title: string;
  description: string;
  onPress(): void;
  testID: string;
}

/** True when the label's first glyph is unusable as an avatar initial. */
function isRenderableInitial(email: string): boolean {
  return email.length > 0 && /\p{L}|\p{N}/u.test(email[0]);
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
    },
    content: {
      alignItems: 'center',
      gap: 20,
      padding: 24,
      paddingBottom: 40,
    },
    title: {
      fontSize: 26,
      fontWeight: '700',
      color: c.textPrimary,
      alignSelf: 'flex-start',
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: c.textMuted,
      alignSelf: 'stretch',
      textAlign: 'center',
    },
    /* Account identity */
    accountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      alignSelf: 'stretch',
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 14,
      paddingVertical: 12,
      paddingHorizontal: 16,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarInitial: {
      fontSize: 18,
      fontWeight: '700',
      color: c.accent,
      textTransform: 'uppercase',
    },
    accountTexts: {
      flex: 1,
      gap: 2,
    },
    accountHint: {
      fontSize: 13,
      color: c.textMuted,
    },
    accountEmail: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    /* Mode-specific navigation rows */
    rowGroup: {
      alignSelf: 'stretch',
      gap: 10,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    rowPressed: {
      opacity: 0.8,
    },
    rowTexts: {
      flex: 1,
      gap: 2,
    },
    rowTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    rowDescription: {
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 18,
    },
    chevron: {
      fontSize: 18,
      color: c.textMuted,
    },
    /* OpenRouter status card (serverless only) */
    openRouterCard: {
      alignSelf: 'stretch',
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 14,
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 10,
    },
    openRouterHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    openRouterTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
      flex: 1,
    },
    badge: {
      borderRadius: 999,
      paddingVertical: 4,
      paddingHorizontal: 10,
      backgroundColor: c.accentSoft,
    },
    badgePending: {
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    badgeText: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: c.accent,
    },
    badgeTextPending: {
      color: c.textSecondary,
    },
    statusRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 12,
    },
    statusKey: {
      fontSize: 13,
      color: c.textSecondary,
    },
    statusValue: {
      flexShrink: 1,
      textAlign: 'right',
      fontSize: 13,
      fontWeight: '500',
      color: c.textPrimary,
    },
    /* Theme segment control */
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
    /* Mode switcher cards */
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
      alignSelf: 'stretch',
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
      alignSelf: 'stretch',
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    buttonText: {
      color: c.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
  });
}

/** One status line of the serverless OpenRouter card. */
function StatusLine({label, value, testID}: {label: string; value: string; testID?: string}) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusKey}>{label}</Text>
      <Text style={styles.statusValue} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

export function SettingsScreen({navigation}: SettingsScreenProps) {
  const {user, logout, busy} = useAuth();
  // Two independent "mode" concepts live side by side here: the visual theme
  // and the SERVER/SERVERLESS application mode (TASK-080) — aliased apart.
  const {mode: themeMode, setMode: setThemeMode, colors} = useTheme();
  const {mode: appMode, setMode: setApplicationMode} = useApplicationMode();
  const styles = useMemo(() => createStyles(colors), [colors]);

  /** Configuration state for the serverless OpenRouter card. */
  const [openRouterStatus, setOpenRouterStatus] = useState<'loading' | {
    hasApiKey: boolean;
    primaryModel: string | null;
    fallbackCount: number;
  }>('loading');

  useEffect(() => {
    if (appMode !== 'serverless') {
      return;
    }
    let cancelled = false;
    setOpenRouterStatus('loading');
    loadServerlessOpenRouterConfig()
      .then(config => {
        if (!cancelled) {
          setOpenRouterStatus({
            hasApiKey: config !== null && config.apiKey.length > 0,
            primaryModel: config?.primaryModel ?? null,
            fallbackCount: config?.fallbackModels?.length ?? 0,
          });
        }
      })
      .catch(() => {
        // A storage failure only degrades the card to "not configured".
        if (!cancelled) {
          setOpenRouterStatus({hasApiKey: false, primaryModel: null, fallbackCount: 0});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appMode]);

  /** Server-feature rows: hidden entirely while serverless is active. */
  const serverRows: SettingsRow[] = useMemo(() => {
    if (appMode !== 'server') {
      return [];
    }
    return [
      {
        title: 'Learning level',
        description: 'Set the level used to shape topics and corrections.',
        onPress: () => navigation.navigate('Level'),
        testID: 'settings-open-level',
      },
      {
        title: 'Vocabulary',
        description: 'Saved words and phrases with their enrichment.',
        onPress: () => navigation.navigate('Vocabulary'),
        testID: 'settings-open-vocabulary',
      },
    ];
  }, [appMode, navigation]);

  const email = user?.email ?? '';
  const avatarInitial = isRenderableInitial(email) ? email[0] : '?';

  return (
    <View style={styles.container} testID="settings-screen">
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        <View style={styles.accountRow} testID="settings-account-section">
          <View style={styles.avatar}>
            <Text style={styles.avatarInitial}>{avatarInitial}</Text>
          </View>
          <View style={styles.accountTexts}>
            <Text style={styles.accountHint}>Signed in as</Text>
            <Text style={styles.accountEmail} numberOfLines={1} testID="settings-account-email">
              {email || 'Unknown account'}
            </Text>
          </View>
        </View>

        {serverRows.length > 0 ? (
          <View style={styles.rowGroup}>
            <Text style={styles.sectionLabel}>Learning</Text>
            {serverRows.map(row => (
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
        ) : null}

        {appMode === 'serverless' ? (
          <View style={[styles.openRouterCard]} testID="settings-openrouter-card">
            <View style={styles.openRouterHeader}>
              <Text style={styles.openRouterTitle}>OpenRouter</Text>
              {openRouterStatus === 'loading' ? (
                <ActivityIndicator size="small" testID="settings-openrouter-loading" />
              ) : openRouterStatus.hasApiKey ? (
                <View style={styles.badge} testID="settings-openrouter-badge">
                  <Text style={styles.badgeText}>Ready</Text>
                </View>
              ) : (
                <View style={[styles.badge, styles.badgePending]} testID="settings-openrouter-badge">
                  <Text style={[styles.badgeText, styles.badgeTextPending]}>Not set up</Text>
                </View>
              )}
            </View>
            <StatusLine
              label="API key"
              value={
                openRouterStatus === 'loading'
                  ? '…'
                  : openRouterStatus.hasApiKey
                    ? 'Saved on this device'
                    : 'Not configured'
              }
              testID="settings-openrouter-key-status"
            />
            <StatusLine
              label="Primary model"
              value={
                openRouterStatus === 'loading'
                  ? '…'
                  : (openRouterStatus.primaryModel ?? 'Not selected')
              }
              testID="settings-openrouter-primary-status"
            />
            <StatusLine
              label="Fallback models"
              value={
                openRouterStatus === 'loading'
                  ? '…'
                  : openRouterStatus.fallbackCount > 0
                    ? `${openRouterStatus.fallbackCount} selected`
                    : 'None'
              }
              testID="settings-openrouter-fallback-status"
            />
          </View>
        ) : null}

        <View style={styles.rowGroup}>
          <Text style={styles.sectionLabel}>Theme</Text>
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

        {/* Application mode */}
        <View style={styles.rowGroup} testID="settings-mode-section">
          <Text style={styles.sectionLabel}>Application mode</Text>
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
      </ScrollView>
    </View>
  );
}
