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

import {
  generateSpeakingPracticeText,
  splitPracticeParagraphs,
} from '../serverless/speakingPractice';
import {
  countWords,
  formatElapsed,
  stepOffset,
} from '../practice/karaokeScroll';
import { createProviderClient } from '../serverless/providerRegistry';
import { loadServerlessOpenRouterConfig } from '../serverless/settings';
import { getLocalDatabase } from '../db/database';
import { getLearningProfile } from '../db/profileStore';
import { createSpeakingPracticeRecord } from '../db/speakingPracticeRepository';
import {
  SPEED_DEFAULT_PX_PER_S,
  loadSpeakingScrollSpeed,
} from '../preferences/speakingScrollSpeed';
import { toErrorMessage } from '../auth/AuthContext';
import type { SpeakingPracticeScreenProps } from '../navigation/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

/** Session-length chips in minutes (the AI sizes the text to these). */
const MINUTES_OPTIONS = [1, 2, 3, 5, 10] as const;

/** Auto-scroll tick interval; small enough to look smooth, cheap enough on JS. */
const SCROLL_TICK_MS = 16;

/**
 * Blank lead-in lines rendered above the first paragraph of the generated
 * text: reading never starts right at the top edge of the box, and the
 * auto-scroll gives the learner a moment before the first words arrive.
 */
const LEAD_IN_BLANK_LINES = 3;

// The scroll-speed bounds, step and default live in
// ../preferences/speakingScrollSpeed together with their persistence; the
// speed slider itself lives on the Settings screen.

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
      marginTop: 6,
      marginBottom: 10,
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
    },
    input: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 10,
      backgroundColor: c.surface,
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 14,
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
      paddingVertical: 16,
      paddingHorizontal: 20,
      alignItems: 'center',
      marginTop: 4,
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
      paddingVertical: 16,
      paddingHorizontal: 20,
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
    controlsRow: {
      flexDirection: 'row',
      gap: 8,
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
      // Lead-in space above and below the reading text: the first line never
      // starts glued to the top edge, so it is easy to begin speaking.
      paddingVertical: 48,
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
      padding: 24,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
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

export function SpeakingPracticeScreen({
  navigation,
  route,
}: SpeakingPracticeScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // SpeakingHistory hands over a saved session: the screen then opens
  // directly in the reading phase with the stored text — no provider call,
  // no form. Read once for the initial state; later param changes on a
  // live instance (e.g. popping back) do not restart a running session.
  const resumeText = route.params?.text ?? '';
  const resumeMaterial = route.params?.material ?? '';
  const resumeMinutes = route.params?.minutes;

  const [phase, setPhase] = useState<Phase>(resumeText ? 'practicing' : 'form');
  const [material, setMaterial] = useState(resumeMaterial);
  const [minutes, setMinutes] = useState(
    resumeMinutes !== undefined &&
      (MINUTES_OPTIONS as readonly number[]).includes(resumeMinutes)
      ? resumeMinutes
      : 3,
  );
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [paragraphs, setParagraphs] = useState<string[]>(() =>
    resumeText ? splitPracticeParagraphs(resumeText) : [],
  );
  const [fullText, setFullText] = useState(resumeText);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  // Starts at the shared default and picks up the persisted Settings value
  // as soon as it loads.
  const [speed, setSpeed] = useState(SPEED_DEFAULT_PX_PER_S);

  useEffect(() => {
    let cancelled = false;
    loadSpeakingScrollSpeed().then(value => {
      if (!cancelled) {
        setSpeed(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const speedRef = useRef(speed);
  speedRef.current = speed;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const scrollRef = useRef<ScrollView | null>(null);
  const offsetRef = useRef(0);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);

  const words = useMemo(() => countWords(fullText), [fullText]);

  const finish = useCallback(async () => {
    if (phase !== 'practicing') {
      return;
    }
    // Save practice history record
    try {
      const db = await getLocalDatabase();
      const profile = await getLearningProfile(db);
      await createSpeakingPracticeRecord(db, {
        userId: 0, // Anonymous user in serverless mode
        title: material.trim() || 'Untitled practice',
        description: '',
        rawPrompt: `Topic: ${material.trim()}, Minutes: ${minutes}`,
        englishLevel: profile.level,
        text: fullText,
        minutes,
        wordCount: words,
      });
    } catch {
      // Silently ignore history save failures
    }
    setPhase('complete');
  }, [phase, material, minutes, fullText, words]);

  useEffect(() => {
    if (phase !== 'practicing' || paused) {
      return;
    }
    const id = setInterval(() => {
      setElapsedMs(prev => prev + 1000);
    }, 1000);
    return () => clearInterval(id);
  }, [phase, paused]);

  useEffect(() => {
    if (phase !== 'practicing' || paused) {
      return;
    }
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      const maxOffset = Math.max(
        0,
        contentHeightRef.current - viewportHeightRef.current,
      );
      const next = stepOffset(
        offsetRef.current,
        speedRef.current,
        dt,
        maxOffset,
      );
      offsetRef.current = next.offset;
      if (next.done) {
        scrollRef.current?.scrollTo({ y: next.offset, animated: false });
        finish();
        return;
      }
      scrollRef.current?.scrollTo({ y: next.offset, animated: false });
    }, SCROLL_TICK_MS);
    return () => clearInterval(id);
  }, [phase, paused, finish]);

  const rewind = useCallback(() => {
    offsetRef.current = 0;
    setElapsedMs(0);
    setPaused(false);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, []);

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
      const { text, paragraphs: displayParagraphs } =
        await generateSpeakingPracticeText(
          db,
          request => client.complete(request),
          { material: material.trim(), minutes },
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
    offsetRef.current = 0;
    setElapsedMs(0);
    setPaused(false);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    setPhase('practicing');
  }, []);

  if (phase === 'complete') {
    return (
      <View style={styles.container} testID="speaking-practice-screen">
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Go back"
            hitSlop={8}
            onPress={() => navigation.goBack()}
            testID="speaking-back"
          >
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
            testID="speaking-practice-again"
          >
            <Text style={styles.primaryButtonText}>
              Practice again — same text
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Generate a new practice text"
            onPress={() => {
              setPhase('form');
              setMaterial('');
              setParagraphs([]);
              setFullText('');
              setElapsedMs(0);
            }}
            style={styles.secondaryButton}
            testID="speaking-practice-new"
          >
            <Text style={styles.secondaryButtonText}>Practice new text</Text>
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
            testID="speaking-back"
          >
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Speaking practice</Text>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.statusBar} testID="speaking-status">
          <Text style={styles.elapsed} testID="speaking-elapsed">
            {formatElapsed(elapsedMs)}
          </Text>
          <View style={styles.controlsRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                paused ? 'Resume scrolling' : 'Pause scrolling'
              }
              onPress={() => setPaused(current => !current)}
              style={styles.controlButton}
              testID="speaking-pause"
            >
              <Text style={styles.controlButtonText}>
                {paused ? 'Resume' : 'Pause'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Restart from the beginning"
              onPress={rewind}
              style={styles.controlButton}
              testID="speaking-restart"
            >
              <Text style={styles.controlButtonText}>Restart</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End practice"
              onPress={async () => await finish()}
              style={styles.controlButton}
              testID="speaking-end"
            >
              <Text style={styles.controlButtonText}>End</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.karaoke} testID="speaking-karaoke">
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.textArea}
            scrollEventThrottle={16}
            scrollEnabled={paused}
            pointerEvents={phase === 'practicing' && !paused ? 'none' : 'auto'}
          >
            <View
              testID="speaking-text-block"
              onLayout={event => {
                contentHeightRef.current = event.nativeEvent.layout.height;
              }}
            >
              {Array.from({ length: LEAD_IN_BLANK_LINES }, (_, index) => (
                <Text key={`lead-in-${index}`} style={styles.paragraph}>
                  {' '}
                </Text>
              ))}
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
      testID="speaking-practice-screen"
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          hitSlop={8}
          onPress={() => navigation.goBack()}
          testID="speaking-back"
        >
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Speaking practice</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Text style={styles.subtitle}>
        Read aloud while the text scrolls at your speed. Type a topic, a list of
        questions, or your own text, and pick how long you want to speak.
      </Text>

      <TextInput
        style={styles.input}
        placeholder={
          'Tap here to start typing\n\n\ne.g. My weekend plans\nor paste your own text'
        }
        placeholderTextColor={colors.textMuted}
        multiline
        value={material}
        onChangeText={setMaterial}
        editable={!generating}
        textAlignVertical="top"
        testID="speaking-input"
      />

      <View style={styles.minutesRow}>
        {MINUTES_OPTIONS.map(option => {
          const isSelected = option === minutes;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ checked: isSelected }}
              onPress={() => setMinutes(option)}
              style={[
                styles.minutesChip,
                isSelected && styles.minutesChipSelected,
              ]}
              testID={`speaking-minutes-${option}`}
            >
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
        testID="speaking-generate"
      >
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
