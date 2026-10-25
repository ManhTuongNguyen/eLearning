/**
 * Serverless AI-provider status card for the Settings screen: provider name,
 * a Ready / Not set up badge and the key/model status lines, opening the AI
 * provider settings when tapped. `ProviderStatus` is the discriminated
 * union the screen loads asynchronously ('loading' until the key store and
 * model selection resolve).
 */
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { PROVIDER_DESCRIPTORS } from '../serverless/providerRegistry';
import type { ProviderId } from '../serverless/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

/** Configuration snapshot of the serverless AI provider card. */
export type ProviderStatus =
  | 'loading'
  | {
      hasApiKey: boolean;
      provider: ProviderId;
      primaryModel: string | null;
      fallbackCount: number;
    };

export interface AIProviderStatusCardProps {
  status: ProviderStatus;
  onOpen: () => void;
}

export function AIProviderStatusCard({ status, onOpen }: AIProviderStatusCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="AI provider settings"
      onPress={onOpen}
      style={({ pressed }) => [styles.aiProviderCard, pressed && styles.rowPressed]}
      testID="settings-ai-provider-card">
      <View style={styles.aiProviderCardHeader}>
        <Text style={styles.aiProviderCardTitle} testID="settings-ai-provider-title">
          {status === 'loading' ? 'AI provider' : PROVIDER_DESCRIPTORS[status.provider].label}
        </Text>
        {status === 'loading' ? (
          <ActivityIndicator size="small" testID="settings-ai-provider-loading" />
        ) : status.hasApiKey ? (
          <View style={styles.badge} testID="settings-ai-provider-badge">
            <Text style={styles.badgeText}>Ready</Text>
          </View>
        ) : (
          <View style={[styles.badge, styles.badgePending]} testID="settings-ai-provider-badge">
            <Text style={[styles.badgeText, styles.badgeTextPending]}>Not set up</Text>
          </View>
        )}
      </View>
      <StatusLine
        label="API key"
        value={
          status === 'loading' ? '…' : status.hasApiKey ? 'Saved on this device' : 'Not configured'
        }
        testID="settings-ai-provider-key-status"
      />
      <StatusLine
        label="Primary model"
        value={status === 'loading' ? '…' : (status.primaryModel ?? 'Not selected')}
        testID="settings-ai-provider-primary-status"
      />
      <StatusLine
        label="Fallback models"
        value={
          status === 'loading'
            ? '…'
            : status.fallbackCount > 0
              ? `${status.fallbackCount} selected`
              : 'None'
        }
        testID="settings-ai-provider-fallback-status"
      />
    </Pressable>
  );
}

/** One status line of the serverless AI provider card. */
function StatusLine({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const { colors } = useTheme();
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

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    aiProviderCard: {
      alignSelf: 'stretch',
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 14,
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 10,
    },
    aiProviderCardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    aiProviderCardTitle: {
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
    rowPressed: {
      opacity: 0.8,
    },
  });
}
