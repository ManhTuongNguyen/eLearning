/**
 * Text-to-speech settings screen (TASK-TTS-001): the single surface for
 * configuring speech output. The system Android TTS engine renders speech
 * through the extended native module (voice, rate, pitch, engine switching);
 * voice selection lives on the VoiceManagerScreen. Persisted through
 * speechSettings (AsyncStorage) and applied to the system adapter
 * immediately, so the chat screen picks up every change without any extra
 * wiring. A preview control speaks a fixed sample sentence with the current
 * configuration; reset restores the previous app behavior (system default
 * voice).
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';

import {applySpeechPreferences, getSpeechEngineSnapshot} from '../tts/androidSpeech';
import {
  clearSpeechPreferences,
  loadSpeechPreferences,
  saveSpeechPreferences,
} from '../tts/speechSettings';
import type {ThemeColors} from '../theme/colors';
import {
  DEFAULT_SPEECH_PREFERENCES,
  SPEECH_PITCH_MAX,
  SPEECH_PITCH_MIN,
  SPEECH_PITCH_STEP,
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  SPEECH_RATE_STEP,
} from '../tts/types';
import type {TTSSettingsScreenProps} from '../navigation/types';
import {useTheme} from '../theme/ThemeContext';

/** Sentence spoken by the preview control. */
export const PREVIEW_SENTENCE = 'Hello! This is how your assistant will sound.';

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
      gap: 20,
      paddingHorizontal: 24,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: c.textMuted,
    },
    engineGroup: {
      gap: 10,
      alignSelf: 'stretch',
    },
    engineCard: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 2,
      alignSelf: 'stretch',
    },
    engineCardSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    engineLabel: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    engineDescription: {
      fontSize: 13,
      color: c.textSecondary,
      lineHeight: 18,
    },
    manageVoicesRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
      alignSelf: 'stretch',
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
    card: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 16,
      gap: 12,
      alignSelf: 'stretch',
    },
    cardTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    sliderRow: {
      gap: 4,
    },
    sliderHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    sliderLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textSecondary,
    },
    sliderValue: {
      fontSize: 13,
      fontWeight: '700',
      color: c.textPrimary,
    },
    previewButton: {
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 24,
      alignItems: 'center',
      alignSelf: 'flex-start',
      flexDirection: 'row',
      gap: 8,
    },
    previewButtonDisabled: {
      opacity: 0.5,
    },
    previewButtonText: {
      color: c.onPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    resetButton: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 24,
      alignItems: 'center',
      alignSelf: 'flex-start',
    },
    resetButtonText: {
      color: c.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    notice: {
      fontSize: 12,
      color: c.textMuted,
      lineHeight: 16,
    },
    loadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
    },
    actionGroup: {
      gap: 10,
      alignSelf: 'stretch',
    },
  });
}

export function TTSSettingsScreen({navigation}: TTSSettingsScreenProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [preferences, setPreferences] = useState<
    import('../tts/types').SpeechPreferences | null
  >(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);

  /**
   * Single mutation seam: every control flows through here so persistence
   * and the live system adapter can never drift apart.
   */
  const updatePreferences = useCallback(
    (patch: Partial<import('../tts/types').SpeechPreferences>) => {
      setPreferences(prev => {
        if (!prev) {
          return prev;
        }
        const updated = {...prev, ...patch};
        saveSpeechPreferences(updated);
        applySpeechPreferences(updated);
        return updated;
      });
    },
    [],
  );

  // Restore persisted preferences on mount — and re-read on focus, so a
  // voice selection made on the manager screen is reflected immediately
  // when the user comes back.
  useEffect(() => {
    let cancelled = false;
    const restore = () => {
      loadSpeechPreferences().then(stored => {
        if (!cancelled) {
          setPreferences(stored);
          applySpeechPreferences(stored);
        }
      });
    };
    restore();
    const unsubscribe = navigation.addListener?.('focus', restore);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [navigation]);

  /** Speaks the preview sentence with the current configuration. */
  const preview = useCallback(() => {
    if (!preferences) {
      return;
    }
    setPreviewPlaying(true);
    // The preview runs through the shared engine registry (the adapter
    // already applies the preferences) so what the user hears is exactly
    // what chat playback will sound like.
    getSpeechEngineSnapshot()
      .speak(PREVIEW_SENTENCE)
      .catch(() => {
        // Preview failures are non-fatal; the state simply clears.
      })
      .finally(() => setPreviewPlaying(false));
  }, [preferences]);

  /** Restores the pre-TTS-settings behavior (system default voice). */
  const resetPreferences = useCallback(() => {
    clearSpeechPreferences().then(() => {
      setPreferences(DEFAULT_SPEECH_PREFERENCES);
      applySpeechPreferences(DEFAULT_SPEECH_PREFERENCES);
    });
  }, []);

  if (!preferences) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Go back"
            hitSlop={8}
            onPress={() => navigation.goBack()}
            testID="tts-settings-back">
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Speech</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" testID="tts-settings-loading" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="tts-settings-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          hitSlop={8}
          onPress={() => navigation.goBack()}
          testID="tts-settings-back">
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Speech</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Engine status */}
        <View style={styles.engineGroup}>
          <Text style={styles.sectionLabel}>Speech engine</Text>
          <View style={[styles.engineCard, styles.engineCardSelected]}>
            <Text style={[styles.engineLabel, styles.engineDescription]}>
              System voice
            </Text>
            <Text style={styles.engineDescription}>
              Instant, built into the device. Always available.
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Manage voices"
            onPress={() => navigation.navigate('VoiceManager')}
            style={({pressed}) => [styles.manageVoicesRow, pressed && styles.rowPressed]}
            testID="tts-manage-voices">
            <View style={styles.rowTexts}>
              <Text style={styles.rowTitle}>Voice manager</Text>
              <Text style={styles.rowDescription}>
                Pick the speaking voice from the ones installed on this device.
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
          {preferences.systemVoiceId ? (
            <Text style={styles.notice} testID="tts-system-active">
              Active voice: {preferences.systemVoiceId}
            </Text>
          ) : (
            <Text style={styles.notice} testID="tts-system-active">
              Active voice: device default
            </Text>
          )}
        </View>

        {/* Speed & pitch */}
        <View style={styles.card} testID="tts-rate-section">
          <Text style={styles.cardTitle}>Speed &amp; pitch</Text>
          <View style={styles.sliderRow}>
            <View style={styles.sliderHeader}>
              <Text style={styles.sliderLabel}>Speed</Text>
              <Text style={styles.sliderValue} testID="tts-rate-value">
                {preferences.rate.toFixed(2)}×
              </Text>
            </View>
            <Slider
              minimumValue={SPEECH_RATE_MIN}
              maximumValue={SPEECH_RATE_MAX}
              step={SPEECH_RATE_STEP}
              value={preferences.rate}
              onValueChange={value =>
                updatePreferences({rate: Math.round(value * 100) / 100})
              }
              testID="tts-rate-slider"
            />
          </View>
          <View style={styles.sliderRow}>
            <View style={styles.sliderHeader}>
              <Text style={styles.sliderLabel}>Pitch</Text>
              <Text style={styles.sliderValue} testID="tts-pitch-value">
                {preferences.pitch.toFixed(2)}×
              </Text>
            </View>
            <Slider
              minimumValue={SPEECH_PITCH_MIN}
              maximumValue={SPEECH_PITCH_MAX}
              step={SPEECH_PITCH_STEP}
              value={preferences.pitch}
              onValueChange={value =>
                updatePreferences({pitch: Math.round(value * 100) / 100})
              }
              testID="tts-pitch-slider"
            />
          </View>
        </View>

        {/* Latency & quality (instant-only switch) lives on the Voice
            manager screen, directly above the voice list it filters. */}

        {/* Preview & reset */}
        <View style={styles.actionGroup}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Preview speech"
            onPress={preview}
            disabled={previewPlaying}
            style={({pressed}) => [
              styles.previewButton,
              previewPlaying && styles.previewButtonDisabled,
              pressed && styles.rowPressed,
            ]}
            testID="tts-preview">
            {previewPlaying ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : null}
            <Text style={styles.previewButtonText}>
              {previewPlaying ? 'Speaking…' : 'Preview voice'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset speech settings"
            onPress={resetPreferences}
            style={({pressed}) => [styles.resetButton, pressed && styles.rowPressed]}
            testID="tts-reset">
            <Text style={styles.resetButtonText}>Reset to defaults</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
