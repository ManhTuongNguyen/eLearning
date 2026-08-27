/**
 * Serverless OpenRouter settings editor (SPEC TASK-092): configures the
 * user's API key, primary model and ordered fallback models. The key lives
 * only in secure storage via saveServerlessOpenRouterConfig (TASK-088/093)
 * — it is never rendered, logged or sent anywhere except OpenRouter's
 * Authorization header. Models come from the locally cached catalog
 * (TASK-084) or a direct refresh through listOpenRouterModels, which works
 * with just a key while no primary model is selected yet. Fallback order is
 * edited in place with move up/down controls.
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
import {getLocalDatabase} from '../db/database';
import type {OpenRouterSettingsScreenProps} from '../navigation/types';
import {getCachedModelCatalog, refreshModelCatalog} from '../serverless/modelCatalog';
import {listOpenRouterModels} from '../serverless/openrouterClient';
import {
  loadServerlessOpenRouterConfig,
  saveServerlessOpenRouterConfig,
} from '../serverless/settings';
import type {ModelInfo, OpenRouterClientConfig} from '../serverless/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

/** Upper bound of model rows rendered at once; the filter narrows further. */
const MAX_VISIBLE_MODELS = 50;

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingHorizontal: 24,
      paddingTop: 60,
    },
    scroll: {
      paddingBottom: 32,
      gap: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
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
    sectionLabel: {
      fontSize: 13,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: c.textMuted,
      marginBottom: -10,
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
    modelName: {
      fontSize: 14,
      fontWeight: '500',
      color: c.textPrimary,
    },
    modelNameSelected: {
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
    chainHeader: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textSecondary,
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
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [loading, setLoading] = useState(true);
  /** Key already stored on-device; null when none saved yet. Never rendered. */
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

  // Load current configuration plus the cached catalog; both are local
  // reads, so nothing here touches the network or leaks the stored key.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await getLocalDatabase();
        const [config, catalog] = await Promise.all([
          loadServerlessOpenRouterConfig(),
          getCachedModelCatalog(db),
        ]);
        if (!cancelled) {
          setStoredKey(config && config.apiKey ? config.apiKey : null);
          setPrimaryModel(config?.primaryModel ?? null);
          setFallbackModels([...(config?.fallbackModels ?? [])]);
          setModels(catalog?.models ?? null);
          setModelsUpdatedAt(catalog?.fetchedAt ?? null);
        }
      } catch (err) {
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
  }, []);

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

  const handleRefreshModels = useCallback(async () => {
    if (refreshing) {
      return;
    }
    setError(null);
    setSaved(false);
    const apiKey = resolveApiKey();
    if (!apiKey) {
      setError('Enter your OpenRouter API key to download the model list.');
      return;
    }
    setRefreshing(true);
    try {
      const db = await getLocalDatabase();
      const snapshot = await refreshModelCatalog(db, () =>
        listOpenRouterModels({apiKey}),
      );
      setModels(snapshot.models);
      setModelsUpdatedAt(snapshot.fetchedAt);
    } catch (err) {
      // A failed refresh keeps whatever catalog was cached before.
      setError(toErrorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, resolveApiKey]);

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
    const apiKey = resolveApiKey();
    if (!apiKey) {
      setError('An OpenRouter API key is required.');
      return;
    }
    if (!primaryModel) {
      setError('Select a primary model before saving.');
      return;
    }
    setSaving(true);
    try {
      const config: OpenRouterClientConfig = {apiKey, primaryModel, fallbackModels};
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
  }, [saving, resolveApiKey, primaryModel, fallbackModels]);

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
        <Text style={styles.title}>OpenRouter</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.sectionLabel}>API key</Text>
        <View style={styles.card}>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={value => {
              setApiKeyDraft(value);
              setSaved(false);
              setError(null);
            }}
            placeholder={storedKey ? '••••••••••••  saved' : 'sk-or-v1-…'}
            secureTextEntry
            style={styles.input}
            testID="openrouter-api-key-input"
            value={apiKeyDraft}
          />
          <Text style={styles.hint}>
            {storedKey
              ? 'Your key is stored securely on this device. Type a new key to replace it.'
              : 'Get a key at openrouter.ai. It is stored securely on this device and sent only to OpenRouter.'}
          </Text>
        </View>

        <Text style={styles.sectionLabel}>Models</Text>
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Discovered from OpenRouter</Text>
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
            <Text style={styles.emptyText} testID="openrouter-models-empty">
              No models downloaded yet. Enter your API key and tap Refresh to load the
              available models from OpenRouter.
            </Text>
          ) : (
            <>
              {modelsUpdatedAt ? (
                <Text style={styles.catalogMeta}>
                  Cached locally{modelsUpdatedAt ? ` (updated ${modelsUpdatedAt})` : ''}.
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
                      <View key={model.id} style={styles.modelRow}>
                        <Pressable
                          accessibilityRole="radio"
                          accessibilityState={{checked: isPrimary}}
                          onPress={() => choosePrimary(model.id)}
                          style={styles.primaryButton}
                          testID={`openrouter-model-primary-${model.id}`}>
                          <View
                            style={[
                              styles.radioOuter,
                              isPrimary && styles.radioOuterSelected,
                            ]}
                          />
                          <View style={styles.modelTexts}>
                            <Text
                              numberOfLines={1}
                              style={[
                                styles.modelName,
                                isPrimary && styles.modelNameSelected,
                              ]}>
                              {modelLabel(model)}
                            </Text>
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
                      {visibleModels.total} model(s) available on OpenRouter.
                    </Text>
                  )}
                </>
              )}
            </>
          )}

          {fallbackModels.length > 0 ? (
            <View style={styles.chainList} testID="openrouter-fallback-chain">
              <Text style={styles.chainHeader}>Fallback order</Text>
              {fallbackModels.map((id, index) => (
                <View
                  key={id}
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
                </View>
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
    </View>
  );
}
