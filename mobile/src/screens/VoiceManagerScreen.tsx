/**
 * Voice manager (TASK-TTS-003): one concise surface for choosing the
 * speaking voice. Lists the English voices installed on the device's
 * Android TTS engine, with search, per-voice metadata (locale, quality,
 * latency, network requirement) and audition. Non-English locales are
 * hidden — the app converses in English (TASK-077 probes only English voice
 * data), so other locales would never render intelligible speech.
 *
 * The instant-voices-only switch (latency/quality trade-off) lives HERE,
 * directly above the list it filters, so the setting and its effect are
 * visible in one place.
 *
 * Every selection writes through speechSettings AND applySpeechPreferences
 * so the change is live immediately (no restart, no stale settings screen).
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  applySpeechPreferences,
  getSystemEngineId,
  listSystemEngines,
  listSystemVoices,
  previewSystemVoice,
  selectSystemEngine,
} from '../tts/androidSpeech';
import {loadSpeechPreferences, saveSpeechPreferences} from '../tts/speechSettings';
import type {
  SpeechEngineInfo,
  SpeechPreferences,
  SpeechVoiceInfo,
} from '../tts/types';
import {isEnglishVoice} from '../tts/types';
import type {VoiceManagerScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

/** Sentence spoken by the per-voice audition buttons. */
export const VOICE_SAMPLE_SENTENCE = 'Hello! This is how this voice sounds.';

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      // Same fixed header spacing as the other pushed screens (the app shell
      // in App.tsx already pads the tree out of the system status bar).
      paddingTop: 16,
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
    scroll: {
      paddingBottom: 32,
      gap: 12,
      paddingHorizontal: 24,
    },
    notice: {
      fontSize: 12,
      color: c.textMuted,
      lineHeight: 16,
    },
    searchInput: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      fontSize: 14,
      color: c.textPrimary,
    },
    card: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 14,
      gap: 8,
    },
    cardSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
    },
    cardTexts: {
      flex: 1,
      gap: 2,
    },
    voiceName: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    voiceMeta: {
      fontSize: 12,
      color: c.textMuted,
      lineHeight: 16,
    },
    badge: {
      borderRadius: 999,
      paddingVertical: 3,
      paddingHorizontal: 10,
      backgroundColor: c.accentSoft,
      alignSelf: 'flex-start',
    },
    badgeText: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: c.accent,
    },
    actions: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
    },
    actionButton: {
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 16,
      backgroundColor: c.primary,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    actionButtonSecondary: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    actionButtonDisabled: {
      opacity: 0.5,
    },
    actionButtonText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.onPrimary,
    },
    actionButtonTextSecondary: {
      color: c.textPrimary,
    },
    filterRow: {
      flexDirection: 'row',
      gap: 8,
      flexWrap: 'wrap',
    },
    filterChip: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 999,
      paddingVertical: 6,
      paddingHorizontal: 14,
    },
    filterChipSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    filterChipText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textSecondary,
    },
    filterChipTextSelected: {
      color: c.accent,
    },
    emptyText: {
      fontSize: 13,
      color: c.textMuted,
      textAlign: 'center',
      paddingVertical: 24,
    },
    loadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 16,
    },
    switchRow: {
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
    switchValue: {
      fontSize: 13,
      fontWeight: '700',
      color: c.textPrimary,
    },
  });
}

/** One-line voice summary for the system list rows. */
function voiceMetaLine(voice: SpeechVoiceInfo): string {
  return [
    voice.language || 'unknown locale',
    `quality: ${voice.quality}`,
    `latency: ${voice.latency}`,
    voice.network ? 'needs network' : 'on-device',
  ].join(' · ');
}

export function VoiceManagerScreen({navigation}: VoiceManagerScreenProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [query, setQuery] = useState('');

  /** Speech preferences — mutated only through the shared update seam. */
  const [preferences, setPreferences] = useState<SpeechPreferences | null>(null);
  const prefsRef = useRef<SpeechPreferences | null>(null);
  const updatePreferences = useCallback((patch: Partial<SpeechPreferences>) => {
    const current = prefsRef.current;
    if (!current) {
      return;
    }
    const updated: SpeechPreferences = {...current, ...patch};
    prefsRef.current = updated;
    setPreferences(updated);
    saveSpeechPreferences(updated);
    applySpeechPreferences(updated);
  }, []);

  // System voices state.
  const [voices, setVoices] = useState<SpeechVoiceInfo[]>([]);
  const [engines, setEngines] = useState<SpeechEngineInfo[]>([]);
  const [activeSystemEngineId, setActiveSystemEngineId] = useState<string | null>(null);
  const [systemAvailable, setSystemAvailable] = useState(false);
  const [systemLoading, setSystemLoading] = useState(true);
  const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Stale-response-guarded system voice/engine read. */
  const systemRequestRef = useRef(0);
  const loadSystemVoices = useCallback(() => {
    const requestId = ++systemRequestRef.current;
    setSystemLoading(true);
    Promise.all([listSystemVoices(), listSystemEngines(), getSystemEngineId()])
      .then(([voiceRows, engineRows, engineId]) => {
        if (systemRequestRef.current !== requestId || !mountedRef.current) {
          return;
        }
        setVoices(voiceRows);
        setEngines(engineRows);
        setActiveSystemEngineId(engineId);
        setSystemAvailable(true);
      })
      .catch(() => {
        if (systemRequestRef.current !== requestId || !mountedRef.current) {
          return;
        }
        setSystemAvailable(false);
      })
      .finally(() => {
        if (systemRequestRef.current === requestId && mountedRef.current) {
          setSystemLoading(false);
        }
      });
  }, []);

  // Load on mount; focus reloads preferences and voices (e.g. after toggles
  // elsewhere) so nothing can go stale.
  useEffect(() => {
    const restore = () => {
      loadSpeechPreferences().then(stored => {
        if (mountedRef.current) {
          prefsRef.current = stored;
          setPreferences(stored);
        }
      });
      loadSystemVoices();
    };
    restore();
    const unsubscribe = navigation.addListener?.('focus', restore);
    return () => {
      unsubscribe?.();
    };
  }, [navigation, loadSystemVoices]);

  const selectSystemVoice = useCallback(
    (voice: SpeechVoiceInfo | null) => {
      updatePreferences({systemVoiceId: voice?.id ?? null});
    },
    [updatePreferences],
  );

  /** Auditions a system voice without changing the persisted selection. */
  const previewVoiceRow = useCallback((voice: SpeechVoiceInfo) => {
    setPreviewVoiceId(voice.id);
    previewSystemVoice(voice.id, VOICE_SAMPLE_SENTENCE)
      .catch(() => {
        // Audition failures are non-fatal.
      })
      .finally(() => {
        if (mountedRef.current) {
          setPreviewVoiceId(prev => (prev === voice.id ? null : prev));
        }
      });
  }, []);

  const normalizedQuery = query.trim().toLowerCase();

  // English-only (TASK-077): other locales can never render the app's
  // English speech. The search still applies on top.
  const englishVoices = useMemo(() => voices.filter(isEnglishVoice), [voices]);
  const filteredSystemVoices = useMemo(() => {
    if (!preferences) {
      return [];
    }
    return englishVoices.filter(voice => {
      if (preferences.instantOnly && voice.network) {
        return false;
      }
      if (normalizedQuery && !voice.name.toLowerCase().includes(normalizedQuery)) {
        return false;
      }
      return true;
    });
  }, [englishVoices, preferences, normalizedQuery]);

  if (!preferences) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Go back"
            hitSlop={8}
            onPress={() => navigation.goBack()}
            testID="voice-manager-back">
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Voice manager</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" testID="voice-manager-loading" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="voice-manager-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          hitSlop={8}
          onPress={() => navigation.goBack()}
          testID="voice-manager-back">
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Voice manager</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.notice}>
          English voices installed on this device. Tapping a voice makes it
          the active system voice immediately; Preview auditions it without
          selecting.
        </Text>

        {/* Shared search filter */}
        <TextInput
          accessibilityLabel="Filter voices by name"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Filter by name…"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          testID="voice-manager-search"
          value={query}
        />

        {/* Instant-voices-only switch: sits directly above the list it
            filters so the setting and its effect read as one unit. */}
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{checked: preferences.instantOnly}}
          onPress={() => updatePreferences({instantOnly: !preferences.instantOnly})}
          style={({pressed}) => [styles.switchRow, pressed && styles.rowPressed]}
          testID="tts-instant-only">
          <View style={styles.cardTexts}>
            <Text style={styles.voiceName}>Instant voices only</Text>
            <Text style={styles.voiceMeta}>
              Hide voices that need a network fetch before speaking.
            </Text>
          </View>
          <Text style={styles.switchValue}>
            {preferences.instantOnly ? 'On' : 'Off'}
          </Text>
        </Pressable>

        {systemLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" />
            <Text style={styles.emptyText}>Loading installed voices…</Text>
          </View>
        ) : !systemAvailable ? (
          <Text style={styles.emptyText}>
            System voice options are not available on this device; the
            platform default voice will be used.
          </Text>
        ) : filteredSystemVoices.length === 0 ? (
          <Text style={styles.emptyText}>
            No voices match the current filters.
          </Text>
        ) : (
          <>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{checked: preferences.systemVoiceId === null}}
              onPress={() => selectSystemVoice(null)}
              style={[
                styles.card,
                preferences.systemVoiceId === null && styles.cardSelected,
              ]}
              testID="voice-system-default">
              <Text style={styles.voiceName}>Device default voice</Text>
              <Text style={styles.voiceMeta}>The engine's built-in choice.</Text>
            </Pressable>
            {filteredSystemVoices.map(voice => {
              const isSelected = voice.id === preferences.systemVoiceId;
              return (
                <Pressable
                  key={voice.id}
                  accessibilityRole="radio"
                  accessibilityState={{checked: isSelected}}
                  onPress={() => selectSystemVoice(voice)}
                  style={[styles.card, isSelected && styles.cardSelected]}
                  testID={`voice-system-${voice.id}`}>
                  <View style={styles.cardHeader}>
                    <View style={styles.cardTexts}>
                      <Text style={styles.voiceName}>{voice.name}</Text>
                      <Text style={styles.voiceMeta}>{voiceMetaLine(voice)}</Text>
                    </View>
                    {isSelected ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>Active</Text>
                      </View>
                    ) : null}
                  </View>
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Preview ${voice.name}`}
                      onPress={() => previewVoiceRow(voice)}
                      disabled={previewVoiceId === voice.id}
                      style={({pressed}) => [
                        styles.actionButton,
                        styles.actionButtonSecondary,
                        previewVoiceId === voice.id && styles.actionButtonDisabled,
                        pressed && styles.actionButtonDisabled,
                      ]}
                      testID={`voice-system-preview-${voice.id}`}>
                      {previewVoiceId === voice.id ? (
                        <ActivityIndicator size="small" />
                      ) : null}
                      <Text
                        style={[
                          styles.actionButtonText,
                          styles.actionButtonTextSecondary,
                        ]}>
                        {previewVoiceId === voice.id ? 'Playing…' : 'Preview'}
                      </Text>
                    </Pressable>
                  </View>
                </Pressable>
              );
            })}
          </>
        )}

        {/* Engine picker (when the device has more than one TTS engine) */}
        {engines.length > 1 ? (
          <>
            <Text style={styles.notice}>TTS engine</Text>
            <View style={styles.filterRow}>
              {engines.map(engine => {
                const isSelected =
                  engine.id === (activeSystemEngineId ?? engines[0]?.id);
                return (
                  <Pressable
                    key={engine.id}
                    accessibilityRole="radio"
                    accessibilityState={{checked: isSelected}}
                    onPress={() => {
                      selectSystemEngine(engine.id)
                        .then(() => {
                          setActiveSystemEngineId(engine.id);
                          updatePreferences({systemEngineId: engine.id});
                          loadSystemVoices();
                        })
                        .catch(() => {
                          // Reverting is handled natively; surface nothing.
                        });
                    }}
                    style={[styles.filterChip, isSelected && styles.filterChipSelected]}
                    testID={`voice-manager-engine-${engine.id}`}>
                    <Text
                      style={[
                        styles.filterChipText,
                        isSelected && styles.filterChipTextSelected,
                      ]}>
                      {engine.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
