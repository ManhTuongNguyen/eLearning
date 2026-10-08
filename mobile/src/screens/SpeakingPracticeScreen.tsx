/**
 * Speaking practice screen — karaoke-style read-aloud trainer.
 *
 * Form: the learner types a topic, a list of questions or their own text,
 * picks a session length in minutes, and ONE completion through the
 * configured serverless provider (the user's own key; no backend traffic,
 * ROADMAP Rule 9) returns a reading-aloud text sized to the minutes via the
 * prompt's word budget (../serverless/speakingPractice).
 *
 * Practice view: the generated text sits centered in the viewport and
 * auto-scrolls smoothly and slowly so the learner reads it aloud at their
 * own pace — a teleprompter, not a highlighter. The scroll speed is a
 * slider (pixels per second), playback pauses/resumes, restart rewinds and
 * the elapsed timer keeps the session honest. Reaching the end of the text
 * (or pressing End) shows the summary with the elapsed time and word count.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';

import {
  generateSpeakingPracticeText,
} from '../serverless/speakingPractice';
import {
  countWords,
  formatElapsed,
  stepOffset,
} from '../practice/karaokeScroll';
import {createProviderClient} from '../serverless/providerRegistry';
import {loadServerlessOpenRouterConfig} from '../serverless/settings';
import {getLocalDatabase} from '../db/database';
import {toErrorMessage} from '../auth/AuthContext';
import type {SpeakingPracticeScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

/** Session-length chips in minutes (the AI sizes the text to these). */
const MINUTES_OPTIONS = [1, 2, 3, 5, 10] as const;

/** Auto-scroll tick interval; small enough to look smooth, cheap enough on JS. */
const SCROLL_TICK_MS = 16;

/** Scroll speed bounds (pixels per second). Slow by design. */
export const SPEED_MIN_PX_PER_S = 10;
export const SPEED_MAX_PX_PER_S = 150;
export const SPEED_STEP_PX_PER_S = 5;
const SPEED_DEFAULT_PX_PER_S = 30;

type Phase = 'form' | 'practicing' | 'complete';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: 16,
      paddingHorizontal: 24,
      paddingBottom: 24,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
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
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    subtitle: {
      marginTop: 8,
      marginBottom: 12,
      fontSize: 14,
      color: c.textSecondary,
    },
    input: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 10,
      backgroundColor: c.surface,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: c.textPrimary,
      marginBottom: 16,
      minHeight: 96,
      textAlignVertical: 'top',
    },
    minutesRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 16,
    },
    minutesChip: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 10,
      alignItems: 'center',
    },
    minutesChipSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    minutesText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
    },
    primaryButton: {
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    primaryButtonText: {
      color: c.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    secondaryButton: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
    },
    secondaryButtonText: {
      color: c.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    error: {
      color: c.errorText,
      fontSize: 13,
      marginTop: 12,
    },
    loadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      marginTop: 16,
    },
    loadingText: {
      fontSize: 13,
      color: c.textSecondary,
    },
    // Practice view: timer + controls above the karaoke surface.
    statusBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingBottom: 8,
    },
    elapsed: {
      fontSize: 15,
      fontWeight: '700',
      color: c.textPrimary,
    },
    controlButton: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 14,
    },
    controlButtonText: {
      color: c.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    speedRow: {
      paddingVertical: 4,
    },
    speedHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    speedLabel: {
      fontSize: 13,
      color: c.textSecondary,
    },
    speedValue: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textPrimary,
    },
    karaoke: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      backgroundColor: c.surface,
      overflow: 'hidden',
    },
    textArea: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: 20,
    },
    paragraph: {
      fontSize: 22,
      lineHeight: 32,
      color: c.textPrimary,
      textAlign: 'center',
      marginVertical: 10,
    },
    summary: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 20,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
    },
    summaryTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    summaryDetail: {
      fontSize: 15,
      color: c.textSecondary,
      textAlign: 'center',
    },
  });
}

export function SpeakingPracticeScreen({navigation}: SpeakingPracticeScreenProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [phase, setPhase] = useState<Phase>('form');
  const [material, setMaterial] = useState('');
  const [minutes, setMinutes] = useState(3);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Practice-view state: paragraphs, elapsed timer, pause and scroll speed.
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [fullText, setFullText] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(SPEED_DEFAULT_PX_PER_S);

  // Latest-ref seams (the app's TASK-048 gotcha pattern): the scroll loop
  // and the finish callback read fresh values from stable refs, so speed
  // changes and paragraph loads never re-trigger the interval effect.
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const scrollRef = useRef<ScrollView | null>(null);
  const offsetRef = useRef(0);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);

  const finish = useCallback(() => {
    setPhase(currentPhase => (currentPhase === 'practicing' ? 'complete' : currentPhase));
  }, []);

  // Elapsed timer: one second at a time while practicing and not paused.
  useEffect(() => {
    if (phase !== 'practicing' || paused) {
      return;
    }
    const id = setInterval(() => {
      setElapsedMs(prev => prev + 1000);
    }, 1000);
    return () => clearInterval(id);
  }, [phase, paused]);

  // Smooth slow auto-scroll: every tick advances the offset by speed × dt,
  // clamped to the scrollable range, and the scroll position is applied
  // without animation so the motion follows the slider in real time.
  useEffect(() => {
    if (phase !== 'practicing' || paused) {
      return;
    }
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      const maxOffset = Math.max(0, contentHeightRef.current - viewportHeightRef.current);
      const next = stepOffset(offsetRef.current, speedRef.current, dt, maxOffset);
      offsetRef.current = next.offset;
      if (next.done) {
        scrollRef.current?.scrollTo({y: next.offset, animated: false});
        finish();
        return;
      }
      scrollRef.current?.scrollTo({y: next.offset, animated: false});
    }, SCROLL_TICK_MS);
    return () => clearInterval(id);
  }, [phase, paused, finish]);

  const rewind = useCallback(() => {
    offsetRef.current = 0;
    setElapsedMs(0);
    setPaused(false);
    scrollRef.current?.scrollTo({y: 0, animated: false});
  }, []);

  /** Generate the practice text through the configured serverless provider. */
  const handleGenerate = useCallback(async () => {
    if (generating) {
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const config = await loadServerlessOpenRouterConfig();
      if (!config) {
        throw new Error(
          'Add your provider API key in Settings to generate practice text.',
        );
      }
      const client = createProviderClient(config);
      const db = await getLocalDatabase();
      const {text, paragraphs: displayParagraphs} = await generateSpeakingPracticeText(
        db,
        request => client.complete(request),
        {material: material.trim(), minutes},
      );
      setFullText(text);
      setParagraphs(displayParagraphs);
      setElapsedMs(0);
      setPaused(false);
      offsetRef.current = 0;
      setPhase('practicing');
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  }, [generating, material, minutes]);

  const handlePracticeAgain = useCallback(() => {
    setParagraphs([]);
    setFullText('');
    setElapsedMs(0);
    setPhase('form');
  }, []);

  const words = useMemo(() => countWords(fullText), [fullText]);

  if (phase === 'complete') {
    return (
      <View style={styles.container} testID="speaking-practice-screen">
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Go back"
            hitSlop={8}
            onPress={() => navigation.goBack()}
            testID="speaking-back">
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Speaking practice</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.summary} testID="speaking-summary">
          <Text style={styles.summaryTitle}>Practice complete</Text>
          <Text style={styles.summaryDetail} testID="speaking-summary-detail">
            {formatElapsed(elapsedMs)} of reading · {words} words
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={handlePracticeAgain}
            style={styles.primaryButton}
            testID="speaking-practice-again">
            <Text style={styles.primaryButtonText}>Practice again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'practicing') {
    return (
      <View style={styles.container} testID="speaking-practice-screen">
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Go back"
            hitSlop={8}
            onPress={() => navigation.goBack()}
            testID="speaking-back">
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Speaking practice</Text>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.statusBar} testID="speaking-status">
          <Text style={styles.elapsed} testID="speaking-elapsed">
            {formatElapsed(elapsedMs)}
          </Text>
          <View style={{flexDirection: 'row', gap: 8}}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={paused ? 'Resume scrolling' : 'Pause scrolling'}
              onPress={() => setPaused(current => !current)}
              style={styles.controlButton}
              testID="speaking-pause">
              <Text style={styles.controlButtonText}>{paused ? 'Resume' : 'Pause'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Restart from the beginning"
              onPress={rewind}
              style={styles.controlButton}
              testID="speaking-restart">
              <Text style={styles.controlButtonText}>Restart</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End practice"
              onPress={finish}
              style={styles.controlButton}
              testID="speaking-end">
              <Text style={styles.controlButtonText}>End</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.speedRow}>
          <View style={styles.speedHeader}>
            <Text style={styles.speedLabel}>Scroll speed</Text>
            <Text style={styles.speedValue} testID="speaking-speed-value">
              {speed} px/s
            </Text>
          </View>
          <Slider
            minimumValue={SPEED_MIN_PX_PER_S}
            maximumValue={SPEED_MAX_PX_PER_S}
            step={SPEED_STEP_PX_PER_S}
            value={speed}
            onValueChange={setSpeed}
            testID="speaking-speed"
          />
        </View>

        <View style={styles.karaoke} testID="speaking-karaoke">
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.textArea}
            scrollEventThrottle={16}>
            <View
              testID="speaking-text-block"
              onLayout={event => {
                contentHeightRef.current = event.nativeEvent.layout.height;
              }}>
              {paragraphs.map((paragraph, index) => (
                <Text key={index} style={styles.paragraph}>
                  {paragraph}
                </Text>
              ))}
            </View>
          </ScrollView>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'android' ? undefined : 'padding'}
      testID="speaking-practice-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          hitSlop={8}
          onPress={() => navigation.goBack()}
          testID="speaking-back">
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Speaking practice</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Text style={styles.subtitle}>
        Read aloud while the text scrolls at your speed. Type a topic, a list
        of questions, or your own text, and pick how long you want to speak.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="e.g. My weekend plans — or paste your own text"
        placeholderTextColor={colors.textMuted}
        multiline
        value={material}
        onChangeText={setMaterial}
        editable={!generating}
        testID="speaking-input"
      />

      <View style={styles.minutesRow}>
        {MINUTES_OPTIONS.map(option => {
          const isSelected = option === minutes;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{checked: isSelected}}
              onPress={() => setMinutes(option)}
              style={[
                styles.minutesChip,
                isSelected && styles.minutesChipSelected,
              ]}
              testID={`speaking-minutes-${option}`}>
              <Text style={styles.minutesText}>{`${option} min`}</Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Generate practice text"
        onPress={handleGenerate}
        disabled={generating}
        style={[styles.primaryButton, generating && styles.buttonDisabled]}
        testID="speaking-generate">
        <Text style={styles.primaryButtonText}>Generate text</Text>
      </Pressable>

      {error !== null ? (
        <Text role="alert" style={styles.error} testID="form-error">
          {error}
        </Text>
      ) : null}

      {generating ? (
        <View style={styles.loadingRow} testID="speaking-generating">
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.loadingText}>Writing your practice text…</Text>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
