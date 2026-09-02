/**
 * Serverless LLM provider settings editor (SPEC TASK-092,
 * TASK-AUDIT-013): configures the active provider (OpenRouter, Gemini,
 * OpenAI), the user's API key, primary model and ordered
 * fallback models. Keys live only in secure storage via
 * saveServerlessOpenRouterConfig (TASK-088/093) — they are never rendered,
 * logged or sent anywhere except the selected provider's auth header, and
 * each provider gets its own keychain/settings/catalog namespace so
 * switching providers never mixes secrets or model ids. Models come from
 * the locally cached per-provider catalog (TASK-084) or a direct refresh
 * through listProviderModels (TASK-AUDIT-004): discovery hits the public
 * /models endpoint with no credentials for providers that publish one
 * (OpenRouter) and requires the user's key for the others
 * (Gemini, OpenAI). Fallback order is edited in place with move up/down
 * controls.
 *
 * The catalog card is purely cache-driven (TASK-AUDIT-017): mounting,
 * re-rendering and provider switching only read the locally persisted
 * snapshot, loading/empty states stay distinct, and the network is hit
 * exclusively through the explicit Refresh control; snapshots older than
 * the staleness window are labelled but remain usable offline.
 *
 * TASK-IMPROVEMENT-004: the models card opens with a short in-screen guide
 * explaining the primary-vs-fallback relationship, the selected primary
 * row is highlighted and badged as the main/default model, and the
 * fallback chain states its order semantics, so the configuration is
 * understandable without external documentation.
 *
 * The top spacing is a fixed constant (the app shell in App.tsx already
 * pads the whole tree out of the system status bar), replacing the
 * fixed oversized padding, so the header sits at the same spacing as the
 * other pushed screens while devices that draw under the status bar
 * (edge-to-edge Android) still clear it.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {toErrorMessage} from '../auth/AuthContext';
import {SecretInput} from '../components/SecretInput';
import {getLocalDatabase} from '../db/database';
import {useApplicationMode} from '../mode/ModeContext';
import type {OpenRouterSettingsScreenProps} from '../navigation/types';
import {getCachedModelCatalog, isModelCatalogStale, refreshModelCatalog} from '../serverless/modelCatalog';
import {
  listProviderModels,
  PROVIDER_DESCRIPTORS,
  SUPPORTED_PROVIDER_IDS,
} from '../serverless/providerRegistry';
import {
  loadServerlessProvider,
  loadServerlessProviderState,
  saveServerlessOpenRouterConfig,
} from '../serverless/settings';
import type {LLMClientConfig, ModelInfo, ProviderId} from '../serverless/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

/** Upper bound of model rows rendered at once; the filter narrows further. */
const MAX_VISIBLE_MODELS = 50;

/** Spacing between the safe-area top inset and the header row (px). */
const HEADER_TOP_SPACING = 24;

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      // No horizontal padding here (TASK-IMPROVEMENT-001): padding on the
      // ScrollView's parent would inset the scrollable's frame and pull its
      // scroll indicator away from the screen edge. The screen gutter is
      // applied by the header and by the scroll content container instead.
      // The app shell (App.tsx) pads the whole tree out of the system bars
      // on edge-to-edge devices (Android 15+); screens only add their own
      // fixed header spacing on top of that.
      paddingTop: HEADER_TOP_SPACING,
    },
    scroll: {
      paddingBottom: 32,
      gap: 16,
      paddingHorizontal: 24,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 24,
      marginBottom: 4,
    },
    backText: {
      fontSize: 16,
      color: c.accent,
      fontWeight: '600',
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    headerSpacer: {
      width: 48,
    },
    modeNotice: {
      // Outside the ScrollView, so it carries the screen gutter itself now
      // that the container no longer applies horizontal padding.
      marginHorizontal: 24,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.surface,
      padding: 16,
      gap: 8,
    },
    modeNoticeText: {
      fontSize: 14,
      lineHeight: 20,
      color: c.textSecondary,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: c.textMuted,
      marginBottom: -10,
    },
    providerRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    providerChip: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingVertical: 8,
      paddingHorizontal: 14,
      backgroundColor: c.surface,
    },
    providerChipActive: {
      borderColor: c.accent,
      backgroundColor: c.accentSoft,
    },
    providerChipText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textSecondary,
    },
    providerChipTextActive: {
      color: c.accent,
    },
    card: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 16,
      gap: 12,
    },
    input: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: c.textPrimary,
    },
    hint: {
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 18,
    },
    cardHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    cardTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
      flex: 1,
    },
    refreshButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    refreshButtonDisabled: {
      opacity: 0.5,
    },
    refreshText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.accent,
    },
    emptyText: {
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 18,
    },
    // TASK-IMPROVEMENT-004: concise in-screen guide for the primary vs
    // fallback model relationship.
    guide: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.background,
      padding: 12,
      gap: 8,
    },
    guideIntro: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textSecondary,
    },
    guideHeading: {
      fontSize: 13,
      fontWeight: '700',
      color: c.textPrimary,
    },
    guideHeadingAccent: {
      color: c.accent,
    },
    guideBody: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textSecondary,
    },
    guideTip: {
      fontSize: 12,
      lineHeight: 17,
      color: c.textMuted,
    },
    catalogMeta: {
      fontSize: 12,
      color: c.textMuted,
    },
    columnHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingBottom: 2,
    },
    columnHeaderPrimary: {
      flex: 1,
      fontSize: 12,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: c.textMuted,
    },
    columnHeaderFallback: {
      width: 92,
      fontSize: 12,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: c.textMuted,
      textAlign: 'center',
    },
    modelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    // TASK-IMPROVEMENT-004: the selected primary row carries an accent wash
    // so the main/default model stands out from fallback candidates.
    modelRowSelected: {
      backgroundColor: c.accentSoft,
    },
    primaryButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 10,
      paddingRight: 6,
    },
    radioOuter: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 2,
      borderColor: c.borderStrong,
    },
    radioOuterSelected: {
      borderColor: c.accent,
      backgroundColor: c.accent,
    },
    modelTexts: {
      flex: 1,
      gap: 1,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    modelName: {
      fontSize: 14,
      fontWeight: '500',
      color: c.textPrimary,
      // Long names truncate instead of pushing the primary badge away.
      flexShrink: 1,
    },
    modelNameSelected: {
      color: c.accent,
    },
    primaryBadge: {
      borderWidth: 1,
      borderColor: c.accent,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
      backgroundColor: c.surface,
    },
    primaryBadgeText: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: c.accent,
    },
    modelId: {
      fontSize: 11,
      color: c.textMuted,
    },
    fallbackToggle: {
      width: 92,
      alignItems: 'center',
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
    },
    fallbackToggleSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    fallbackToggleDisabled: {
      opacity: 0.35,
    },
    fallbackToggleText: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textSecondary,
    },
    fallbackToggleTextSelected: {
      color: c.accent,
    },
    chainList: {
      gap: 8,
    },
    chainListBordered: {
      // TASK-IMPROVEMENT-004: the ordered chain is visually separated from
      // the discovery list so it reads as a summary of secondary models.
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      padding: 10,
      backgroundColor: c.background,
    },
    chainHeader: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textSecondary,
    },
    chainIntro: {
      fontSize: 12,
      lineHeight: 17,
      color: c.textMuted,
    },
    chainRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 10,
      backgroundColor: c.background,
    },
    tooltipOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
    },
    tooltipBubble: {
      width: '100%',
      maxWidth: 480,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      padding: 16,
      gap: 6,
    },
    tooltipText: {
      fontSize: 15,
      fontWeight: '600',
      lineHeight: 21,
      color: c.textPrimary,
    },
    tooltipSub: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textSecondary,
    },
    tooltipHint: {
      fontSize: 12,
      color: c.textMuted,
    },
    chainOrder: {
      width: 20,
      fontSize: 13,
      fontWeight: '700',
      color: c.accent,
    },
    chainId: {
      flex: 1,
      fontSize: 13,
      fontWeight: '500',
      color: c.textPrimary,
    },
    chainControl: {
      width: 34,
      height: 30,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 7,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    chainControlDisabled: {
      opacity: 0.35,
    },
    chainControlRemove: {
      borderColor: c.danger,
    },
    chainControlText: {
      fontSize: 14,
      fontWeight: '700',
      color: c.textPrimary,
    },
    chainControlRemoveText: {
      color: c.danger,
    },
    error: {
      color: c.errorText,
      fontSize: 14,
      lineHeight: 19,
    },
    saved: {
      color: c.success,
      fontSize: 14,
      fontWeight: '600',
    },
    saveButton: {
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 13,
      alignItems: 'center',
    },
    saveButtonDisabled: {
      opacity: 0.5,
    },
    saveButtonText: {
      color: c.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
  });
}

/** Display label for one catalog entry. */
function modelLabel(model: ModelInfo): string {
  return model.name || model.id;
}

export function OpenRouterSettingsScreen({navigation}: OpenRouterSettingsScreenProps) {
  const {colors} = useTheme();
  // TASK-AUDIT-016: this editor configures the serverless provider stack,
  // so it is only operable in serverless mode; server-mode mounts see a
  // notice instead of serverless-only configuration controls.
  const {status: modeStatus, mode} = useApplicationMode();
  const styles = useMemo(
    () => createStyles(colors),
    [colors],
  );

  const [loading, setLoading] = useState(true);
  /** Provider currently being edited (defaults to the historic choice). */
  const [provider, setProvider] = useState<ProviderId>('openrouter');
  /** Switching while the target provider's stored state loads. */
  const [switching, setSwitching] = useState(false);
  /** Key already stored on-device for `provider`; null when none saved yet. Never rendered. */
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [primaryModel, setPrimaryModel] = useState<string | null>(null);
  const [fallbackModels, setFallbackModels] = useState<string[]>([]);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsUpdatedAt, setModelsUpdatedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Long-press tooltip content: the full untruncated model label + id. */
  const [modelTooltip, setModelTooltip] = useState<{
    label: string;
    id: string;
  } | null>(null);

  const descriptor = PROVIDER_DESCRIPTORS[provider];

  // Load the persisted provider plus its stored state and cached catalog;
  // all local reads, so nothing here touches the network or leaks the key.
  // Nothing loads until the persisted mode has been restored, and a server
  // mode application never reads serverless configuration at all
  // (TASK-AUDIT-016).
  useEffect(() => {
    let cancelled = false;
    if (modeStatus !== 'ready') {
      return;
    }
    if (mode !== 'serverless') {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const db = await getLocalDatabase();
        const activeProvider = await loadServerlessProvider();
        const [state, catalog] = await Promise.all([
          loadServerlessProviderState(activeProvider),
          getCachedModelCatalog(db, activeProvider),
        ]);
        if (!cancelled) {
          setProvider(activeProvider);
          setStoredKey(state.apiKey);
          setPrimaryModel(state.primaryModel);
          setFallbackModels([...state.fallbackModels]);
          setModels(catalog?.models ?? null);
          setModelsUpdatedAt(catalog?.fetchedAt ?? null);
        }
      } catch (err) {
        console.error('[provider-models] initial load failed:', err);
        if (!cancelled) {
          setError(toErrorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modeStatus, mode]);

  /**
   * Resolve the key that applies right now: a freshly typed draft wins,
   * otherwise the stored key keeps working without being redisplayed.
   */
  const resolveApiKey = useCallback((): string | null => {
    const draft = apiKeyDraft.trim();
    if (draft) {
      return draft;
    }
    return storedKey;
  }, [apiKeyDraft, storedKey]);

  /**
   * Edit another provider: load its stored key/models and cached catalog.
   * The persisted active provider only changes when the edited
   * configuration is saved.
   */
  const switchProvider = useCallback(
    async (id: ProviderId) => {
      if (id === provider || switching) {
        return;
      }
      setError(null);
      setSaved(false);
      setRefreshing(false);
      setFilter('');
      setSwitching(true);
      try {
        const db = await getLocalDatabase();
        const [state, catalog] = await Promise.all([
          loadServerlessProviderState(id),
          getCachedModelCatalog(db, id),
        ]);
        setProvider(id);
        setStoredKey(state.apiKey);
        setApiKeyDraft('');
        setPrimaryModel(state.primaryModel);
        setFallbackModels([...state.fallbackModels]);
        setModels(catalog?.models ?? null);
        setModelsUpdatedAt(catalog?.fetchedAt ?? null);
      } catch (err) {
        setError(toErrorMessage(err));
      } finally {
        setSwitching(false);
      }
    },
    [provider, switching],
  );

  const handleRefreshModels = useCallback(async () => {
    if (refreshing) {
      return;
    }
    setError(null);
    setSaved(false);
    setRefreshing(true);
    try {
      const db = await getLocalDatabase();
      const currentDescriptor = PROVIDER_DESCRIPTORS[provider];
      let discoveryKey: string | undefined;
      if (currentDescriptor.modelDiscoveryRequiresAuth) {
        const key = resolveApiKey();
        if (!key) {
          throw new Error(
            `Enter your ${currentDescriptor.label} API key to download the model catalog.`,
          );
        }
        discoveryKey = key;
      }
      // Discovery is keyless for providers with a public catalog
      // (TASK-AUDIT-004): no credentials are needed or sent. Providers
      // whose discovery endpoint is authenticated require the key.
      const snapshot = await refreshModelCatalog(
        db,
        () => listProviderModels(provider, {apiKey: discoveryKey}),
        provider,
      );
      setModels(snapshot.models);
      setModelsUpdatedAt(snapshot.fetchedAt);
    } catch (err) {
      // A failed refresh keeps whatever catalog was cached before.
      // Surface the raw cause for on-device diagnosis (adb logcat / DevTools).
      console.error('[provider-models] refresh failed:', err);
      setError(toErrorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, provider, resolveApiKey]);

  const choosePrimary = useCallback((id: string) => {
    setError(null);
    setSaved(false);
    setPrimaryModel(id);
    // The client builds its attempt chain as primary + unique non-primary
    // models, so promoting an entry removes it from the fallback queue.
    setFallbackModels(current => current.filter(model => model !== id));
  }, []);

  const toggleFallback = useCallback((id: string) => {
    setError(null);
    setSaved(false);
    setFallbackModels(current => {
      if (current.includes(id)) {
        return current.filter(model => model !== id);
      }
      return [...current, id];
    });
  }, []);

  const moveFallback = useCallback((index: number, direction: -1 | 1) => {
    setSaved(false);
    setFallbackModels(current => {
      const target = index + direction;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      const moved = next[index];
      next[index] = next[target];
      next[target] = moved;
      return next;
    });
  }, []);

  const removeFallback = useCallback((index: number) => {
    setSaved(false);
    setFallbackModels(current => current.filter((_, position) => position !== index));
  }, []);

  const handleSave = useCallback(async () => {
    if (saving) {
      return;
    }
    setError(null);
    setSaved(false);
    const label = PROVIDER_DESCRIPTORS[provider].label;
    const article = /^[AEIOU]/.test(label) ? 'An' : 'A';
    const apiKey = resolveApiKey();
    if (!apiKey) {
      setError(`${article} ${label} API key is required.`);
      return;
    }
    if (!primaryModel) {
      setError('Select a primary model before saving.');
      return;
    }
    setSaving(true);
    try {
      const config: LLMClientConfig = {provider, apiKey, primaryModel, fallbackModels};
      await saveServerlessOpenRouterConfig(config);
      // The typed key has been persisted; forget it from component state so
      // it cannot linger longer than necessary.
      setStoredKey(apiKey);
      setApiKeyDraft('');
      setSaved(true);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [saving, resolveApiKey, primaryModel, fallbackModels, provider]);

  /** Filtered + alphabetically stable subset of the discovered catalog. */
  const visibleModels = useMemo<{models: ModelInfo[]; total: number}>(() => {
    if (!models) {
      return {models: [], total: 0};
    }
    const query = filter.trim().toLowerCase();
    const matching = query
      ? models.filter(
          model =>
            model.id.toLowerCase().includes(query) ||
            modelLabel(model).toLowerCase().includes(query),
        )
      : models;
    const sorted = [...matching].sort(
      (a, b) =>
        modelLabel(a).localeCompare(modelLabel(b)) || a.id.localeCompare(b.id),
    );
    return {models: sorted.slice(0, MAX_VISIBLE_MODELS), total: sorted.length};
  }, [models, filter]);

  // TASK-AUDIT-017: the catalog card distinguishes loading (initial mount
  // or provider switch still reading the local cache) from empty (nothing
  // has been downloaded yet). No network is involved in either state.
  const catalogLoading = loading || switching;

  // TASK-AUDIT-017: a snapshot older than the staleness window keeps
  // working (models stay selectable offline) but is labelled so the user
  // knows the catalog may be outdated and can refresh explicitly.
  const modelsStale = useMemo<boolean>(() => {
    if (models === null || modelsUpdatedAt === null) {
      return false;
    }
    return isModelCatalogStale({models, fetchedAt: modelsUpdatedAt});
  }, [models, modelsUpdatedAt]);

  // TASK-AUDIT-016: once the persisted mode is known, a server-mode mount
  // renders the serverless-only notice and never the editor. All hooks run
  // above this return, so the conditional keeps the rules-of-hooks contract.
  if (modeStatus === 'ready' && mode !== 'serverless') {
    return (
      <View style={styles.container} testID="openrouter-settings-screen">
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Go back"
            hitSlop={8}
            onPress={() => navigation.goBack()}
            testID="openrouter-back">
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>AI provider</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.modeNotice} testID="openrouter-mode-notice">
          <Text style={styles.modeNoticeText}>
            Direct AI connections are a serverless feature. Switch the
            application to serverless mode to configure a provider, API key
            and models on this device.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="openrouter-settings-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          hitSlop={8}
          onPress={() => navigation.goBack()}
          testID="openrouter-back">
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>{descriptor.label}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.sectionLabel}>Provider</Text>
        <View style={styles.providerRow}>
          {SUPPORTED_PROVIDER_IDS.map(id => {
            const chipDescriptor = PROVIDER_DESCRIPTORS[id];
            const active = id === provider;
            return (
              <Pressable
                key={id}
                accessibilityRole="button"
                accessibilityState={{selected: active}}
                disabled={switching || loading}
                onPress={() => {
                  switchProvider(id);
                }}
                style={[styles.providerChip, active && styles.providerChipActive]}
                testID={`provider-chip-${id}`}>
                <Text
                  style={[
                    styles.providerChipText,
                    active && styles.providerChipTextActive,
                  ]}>
                  {chipDescriptor.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.sectionLabel}>API key</Text>
        <View style={styles.card}>
          <SecretInput
            onChangeText={value => {
              setApiKeyDraft(value);
              setSaved(false);
              setError(null);
            }}
            placeholder={storedKey ? '••••••••••••  saved' : descriptor.keyPlaceholder}
            value={apiKeyDraft}
            testID="openrouter-api-key-input"
            textContentType="none"
            inputStyle={styles.input}
            showBorder={false}
          />
          <Text style={styles.hint}>
            {storedKey
              ? 'Your key is stored securely on this device. Type a new key to replace it.'
              : descriptor.keyHint}
          </Text>
        </View>

        <Text style={styles.sectionLabel}>Models</Text>
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Discovered from {descriptor.label}</Text>
            <Pressable
              accessibilityRole="button"
              disabled={refreshing || loading}
              onPress={() => {
                handleRefreshModels();
              }}
              style={({pressed}) => [
                styles.refreshButton,
                (refreshing || pressed) && styles.refreshButtonDisabled,
              ]}
              testID="openrouter-models-refresh">
              {refreshing ? (
                <ActivityIndicator size="small" testID="openrouter-models-loading" />
              ) : (
                <Text style={styles.refreshText}>Refresh</Text>
              )}
            </Pressable>
          </View>

          {models === null ? (
            catalogLoading ? (
              <Text style={styles.emptyText} testID="openrouter-models-catalog-loading">
                Loading saved models…
              </Text>
            ) : (
              <Text style={styles.emptyText} testID="openrouter-models-empty">
                No models downloaded yet. Tap Refresh to load the available models from{' '}
                {descriptor.label}.
              </Text>
            )
          ) : (
            <>
              <View style={styles.guide} testID="openrouter-model-guide">
                <Text style={styles.guideIntro}>
                  Models are used in order: the primary model first, then each
                  fallback until one answers.
                </Text>
                <View>
                  <Text style={[styles.guideHeading, styles.guideHeadingAccent]}>
                    Primary model
                  </Text>
                  <Text style={styles.guideBody}>
                    The model you want to use first — your default for
                    conversations.
                  </Text>
                </View>
                <View>
                  <Text style={styles.guideHeading}>Fallback models</Text>
                  <Text style={styles.guideBody}>
                    Alternative models used when the primary model fails or
                    cannot complete the request.
                  </Text>
                </View>
                <Text style={styles.guideTip}>
                  Tip: choose a reliable model as your primary model, then add
                  other compatible models as fallbacks.
                </Text>
              </View>
              {modelsUpdatedAt ? (
                <Text
                  style={styles.catalogMeta}
                  testID={modelsStale ? 'openrouter-models-stale' : undefined}>
                  Cached locally (updated {modelsUpdatedAt}).
                  {modelsStale ? ' May be outdated — tap Refresh to update.' : ''}
                </Text>
              ) : null}
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setFilter}
                placeholder="Filter models…"
                style={styles.input}
                testID="openrouter-model-filter"
                value={filter}
              />
              {visibleModels.total === 0 ? (
                <Text style={styles.emptyText}>No models match your filter.</Text>
              ) : (
                <>
                  <View style={styles.columnHeader}>
                    <Text style={styles.columnHeaderPrimary}>Set primary</Text>
                    <Text style={styles.columnHeaderFallback}>Fallback</Text>
                  </View>
                  {visibleModels.models.map(model => {
                    const isPrimary = model.id === primaryModel;
                    const isFallback =
                      !isPrimary && fallbackModels.includes(model.id);
                    return (
                      <View
                        key={model.id}
                        style={[styles.modelRow, isPrimary && styles.modelRowSelected]}>
                        <Pressable
                          accessibilityRole="radio"
                          accessibilityState={{checked: isPrimary}}
                          onPress={() => choosePrimary(model.id)}
                          onLongPress={() =>
                            setModelTooltip({label: modelLabel(model), id: model.id})
                          }
                          style={styles.primaryButton}
                          testID={`openrouter-model-primary-${model.id}`}>
                          <View
                            style={[
                              styles.radioOuter,
                              isPrimary && styles.radioOuterSelected,
                            ]}
                          />
                          <View style={styles.modelTexts}>
                            <View style={styles.nameRow}>
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.modelName,
                                  isPrimary && styles.modelNameSelected,
                                ]}>
                                {modelLabel(model)}
                              </Text>
                              {isPrimary ? (
                                <View
                                  style={styles.primaryBadge}
                                  testID={`openrouter-model-primary-badge-${model.id}`}>
                                  <Text style={styles.primaryBadgeText}>Primary</Text>
                                </View>
                              ) : null}
                            </View>
                            <Text numberOfLines={1} style={styles.modelId}>
                              {model.id}
                            </Text>
                          </View>
                        </Pressable>
                        <Pressable
                          accessibilityRole="checkbox"
                          accessibilityState={{checked: isFallback}}
                          onPress={() => {
                            if (!isPrimary) {
                              toggleFallback(model.id);
                            }
                          }}
                          style={[
                            styles.fallbackToggle,
                            isFallback && styles.fallbackToggleSelected,
                            isPrimary && styles.fallbackToggleDisabled,
                          ]}
                          testID={`openrouter-model-fallback-${model.id}`}>
                          <Text
                            style={[
                              styles.fallbackToggleText,
                              isFallback && styles.fallbackToggleTextSelected,
                            ]}>
                            {isFallback ? '✓ Added' : '+ Add'}
                          </Text>
                        </Pressable>
                      </View>
                    );
                  })}
                  {visibleModels.total > visibleModels.models.length ? (
                    <Text style={styles.catalogMeta}>
                      Showing {visibleModels.models.length} of{' '}
                      {visibleModels.total} models. Refine the filter to narrow the
                      list.
                    </Text>
                  ) : (
                    <Text style={styles.catalogMeta} testID="openrouter-model-count">
                      {visibleModels.total} model(s) available on {descriptor.label}.
                    </Text>
                  )}
                </>
              )}
            </>
          )}

          {fallbackModels.length > 0 ? (
            <View
              style={[styles.chainList, styles.chainListBordered]}
              testID="openrouter-fallback-chain">
              <Text style={styles.chainHeader}>Fallback order</Text>
              <Text style={styles.chainIntro} testID="openrouter-fallback-order-note">
                These models are tried one after another, in this order, when
                the primary model cannot complete the request.
              </Text>
              {fallbackModels.map((id, index) => (
                <Pressable
                  key={id}
                  onLongPress={() => setModelTooltip({label: id, id: ''})}
                  style={styles.chainRow}
                  testID={`openrouter-fallback-chip-${index}`}>
                  <Text style={styles.chainOrder}>{index + 1}.</Text>
                  <Text numberOfLines={1} style={styles.chainId}>
                    {id}
                  </Text>
                  <Pressable
                    accessibilityLabel={`Move ${id} up`}
                    disabled={index === 0}
                    onPress={() => moveFallback(index, -1)}
                    style={[styles.chainControl, index === 0 && styles.chainControlDisabled]}
                    testID={`openrouter-fallback-up-${index}`}>
                    <Text style={styles.chainControlText}>↑</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Move ${id} down`}
                    disabled={index === fallbackModels.length - 1}
                    onPress={() => moveFallback(index, 1)}
                    style={[
                      styles.chainControl,
                      index === fallbackModels.length - 1 && styles.chainControlDisabled,
                    ]}
                    testID={`openrouter-fallback-down-${index}`}>
                    <Text style={styles.chainControlText}>↓</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Remove ${id} from fallbacks`}
                    onPress={() => removeFallback(index)}
                    style={[styles.chainControl, styles.chainControlRemove]}
                    testID={`openrouter-fallback-remove-${index}`}>
                    <Text style={[styles.chainControlText, styles.chainControlRemoveText]}>
                      ✕
                    </Text>
                  </Pressable>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        {error ? (
          <Text role="alert" style={styles.error} testID="openrouter-form-error">
            {error}
          </Text>
        ) : null}
        {saved ? <Text style={styles.saved}>Saved.</Text> : null}

        <Pressable
          accessibilityRole="button"
          disabled={saving || loading}
          onPress={() => {
            handleSave();
          }}
          style={[styles.saveButton, (saving || loading) && styles.saveButtonDisabled]}
          testID="openrouter-save">
          {saving ? (
            <ActivityIndicator color={colors.onPrimary} testID="openrouter-saving" />
          ) : (
            <Text style={styles.saveButtonText}>Save configuration</Text>
          )}
        </Pressable>
      </ScrollView>

      {modelTooltip ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close model details"
          onPress={() => setModelTooltip(null)}
          style={styles.tooltipOverlay}
          testID="openrouter-model-tooltip">
          <View style={styles.tooltipBubble}>
            <Text style={styles.tooltipText}>{modelTooltip.label}</Text>
            {modelTooltip.id && modelTooltip.id !== modelTooltip.label ? (
              <Text style={styles.tooltipSub}>{modelTooltip.id}</Text>
            ) : null}
            <Text style={styles.tooltipHint}>Tap anywhere to close</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}
