/**
 * Settings screen (SPEC TASK-091): single surface for every account and
 * preference control, showing only the options that are relevant to the
 * active application mode (TASK-080).
 *
 * Server mode shows: signed-in account identity, logout (TASK-015), and the
 * server-backed rows — learning level editing (TASK-018) and the saved
 * vocabulary list (TASK-072). Serverless mode (TASK-AUDIT-003) is
 * independent of server accounts: no account identity, no server logout —
 * instead an OpenRouter settings card opens the local AI configuration
 * editor (TASK-092): the key itself is stored in secure storage and is
 * never displayed. Both modes keep the theme selection (TASK-044), the
 * application-mode switcher (TASK-090) and — serverless only — local data
 * clearing (TASK-094).
 *
 * The screen is pushed onto the main stack from Chat, so the header carries
 * the same ‹ Back affordance as the other pushed screens (TASK-AUDIT-006);
 * the Android system back button pops the stack identically.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
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
import {clearAllServerlessData, loadServerlessOpenRouterConfig} from '../serverless/settings';
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
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 24,
      paddingTop: 24,
      paddingBottom: 8,
    },
    backText: {
      fontSize: 16,
      color: c.accent,
      fontWeight: '600',
    },
    headerSpacer: {
      width: 48,
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
    secondaryButton: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.danger,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 32,
      alignItems: 'center',
      alignSelf: 'stretch',
    },
    secondaryButtonText: {
      color: c.danger,
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

  /** While clearing local data, the button is disabled to prevent double-taps. */
  const [clearing, setClearing] = useState(false);

  /**
   * Confirm and clear all serverless local data (TASK-094). Server mode
   * has nothing to clear locally, so the action is only exposed when
   * the local store might have data to remove.
   */
  const confirmClearLocalData = (): void => {
    Alert.alert(
      'Clear local data?',
      'This will remove all serverless conversations, summaries, profile and OpenRouter settings from this device. Your account on the server is not affected.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            setClearing(true);
            try {
              await clearAllServerlessData();
              setOpenRouterStatus({hasApiKey: false, primaryModel: null, fallbackCount: 0});
              Alert.alert('Local data cleared', 'All serverless data has been removed from this device.');
            } catch (error) {
              Alert.alert(
                'Clearing failed',
                error instanceof Error ? error.message : 'Unable to clear local data.',
              );
            } finally {
              setClearing(false);
            }
          },
        },
      ],
    );
  };

  /**
   * Read the OpenRouter configuration card state from on-device storage.
   * The request counter follows the screen's stale-response-guard pattern:
   * only the newest read may apply its result.
   */
  const openRouterStatusRequestRef = useRef(0);
  const loadOpenRouterStatus = useCallback((): void => {
    const requestId = ++openRouterStatusRequestRef.current;
    setOpenRouterStatus('loading');
    loadServerlessOpenRouterConfig()
      .then(config => {
        if (openRouterStatusRequestRef.current === requestId) {
          setOpenRouterStatus({
            hasApiKey: config !== null && config.apiKey.length > 0,
            primaryModel: config?.primaryModel ?? null,
            fallbackCount: config?.fallbackModels?.length ?? 0,
          });
        }
      })
      .catch(() => {
        // A storage failure only degrades the card to "not configured".
        if (openRouterStatusRequestRef.current === requestId) {
          setOpenRouterStatus({hasApiKey: false, primaryModel: null, fallbackCount: 0});
        }
      });
  }, []);

  // Reload when the mode flips to serverless and, on real navigators, every
  // time the screen regains focus — returning from the OpenRouter editor
  // must refresh the card. Bare navigation stubs (tests) skip the listener.
  useEffect(() => {
    if (appMode !== 'serverless') {
      return;
    }
    loadOpenRouterStatus();
    const unsubscribe = navigation.addListener?.('focus', loadOpenRouterStatus);
    return () => {
      unsubscribe?.();
    };
  }, [appMode, navigation, loadOpenRouterStatus]);

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
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          hitSlop={8}
          onPress={() => navigation.goBack()}
          testID="settings-back">
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {appMode === 'server' ? (
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
        ) : null}

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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="OpenRouter settings"
            onPress={() => navigation.navigate('OpenRouterSettings')}
            style={({pressed}) => [styles.openRouterCard, pressed && styles.rowPressed]}
            testID="settings-openrouter-card">
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
          </Pressable>
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

        {/* Local data clearing (TASK-094): only meaningful in serverless mode,
            where the on-device SQLite database actually holds user data. */}
        {appMode === 'serverless' ? (
          <View style={styles.rowGroup} testID="settings-clear-local-section">
            <Text style={styles.sectionLabel}>Local data</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear local data"
              style={[styles.secondaryButton, clearing && styles.buttonDisabled]}
              disabled={clearing}
              onPress={confirmClearLocalData}
              testID="settings-clear-local">
              {clearing ? (
                <ActivityIndicator color={colors.textPrimary} />
              ) : (
                <Text style={styles.secondaryButtonText}>Clear local data</Text>
              )}
            </Pressable>
          </View>
        ) : null}

        {/* Server logout: serverless mode has no server account to end
            (TASK-AUDIT-003), so the control is hidden in that mode. */}
        {appMode === 'server' ? (
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
        ) : null}
      </ScrollView>
    </View>
  );
}
