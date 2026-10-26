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
 *
 * Listen mode (route param mode: 'listen', pushed from SpeakingHistory):
 * the TTS engine speaks the stored text aloud and the teleprompter scroll
 * follows the engine's REAL pace through per-word SpeechProgress events —
 * the Settings speed slider is deliberately ignored. Pause halts speech at
 * the last spoken word; Resume re-speaks from that word (Android TTS cannot
 * continue a stopped utterance); End/finish never saves a new history
 * record — the session was opened from one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { toErrorMessage } from '../auth/AuthContext';
import { SCREEN_GUTTER, SCREEN_TOP_SPACING } from '../components/ScreenLayout';
import { ScreenTitleBar } from '../components/ScreenTitleBar';
import { getLocalDatabase } from '../db/database';
import { getLearningProfile } from '../db/profileStore';
import { createSpeakingPracticeRecord } from '../db/speakingPracticeRepository';
import type { SpeakingPracticeScreenProps } from '../navigation/types';
import {
  countWords,
  formatElapsed,
  offsetForCharProgress,
  offsetForSpokenChar,
  type ParagraphSpan,
  paragraphCharRanges,
} from '../practice/karaokeScroll';
import {
  loadSpeakingScrollSpeed,
  SPEED_DEFAULT_PX_PER_S,
} from '../preferences/speakingScrollSpeed';
import { createProviderClient } from '../serverless/providerRegistry';
import { loadServerlessConfig } from '../serverless/settings';
import {
  generateSpeakingPracticeText,
  splitPracticeParagraphs,
} from '../serverless/speakingPractice';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { setKeepScreenAwake } from '../tts/keepAwake';
import { getSpeechEngine } from '../tts/textToSpeech';
import { copyText } from '../utils/clipboard';
import { ClipboardIcon, KaraokeText } from './KaraokeText';

/** Session-length chips in minutes (the AI sizes the text to these). */
const MINUTES_OPTIONS = [1, 2, 3, 5, 10] as const;

/**
 * Blank lead-in lines rendered above the first paragraph of the generated
 * text: reading never starts right at the top edge of the box, and the
 * auto-scroll gives the learner a moment before the first words arrive.
 */

/** Vertical padding of the karaoke text area (lead-in room above/below). */
const TEXT_AREA_PADDING_V = 48;

/** Tolerance (px) for treating the scroll as having reached its end. */
const SCROLL_END_EPSILON_PX = 0.5;

/**
 * Listen-mode glide bounds (milliseconds). Each spoken word retargets the
 * native glide over the time since the previous word, clamped to this range,
 * so the text keeps moving continuously between words.
 */
const LISTEN_MIN_GLIDE_MS = 180;
const LISTEN_MAX_GLIDE_MS = 700;
/** Glide used for the first word after (re)starting playback. */
const LISTEN_FIRST_GLIDE_MS = 400;
/** Glide that carries the text to its end once speech has finished. */
const LISTEN_SETTLE_MS = 1200;
/** Read mode: time the session keeps running after the glide reaches the end. */
const READ_END_HOLD_MS = 30000;

// The scroll-speed bounds, step and default live in
// ../preferences/speakingScrollSpeed together with their persistence; the
// speed slider itself lives on the Settings screen.

type Phase = 'form' | 'practicing' | 'complete';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: SCREEN_TOP_SPACING,
      paddingHorizontal: SCREEN_GUTTER,
      paddingBottom: 24,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingBottom: 8,
    },
    copyButton: {
      position: 'absolute',
      top: 10,
      right: 10,
      zIndex: 1,
      padding: 6,
      borderRadius: 8,
      backgroundColor: c.surface,
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
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      paddingHorizontal: 20,
      // Lead-in space above and below the reading text: the first line never
      // starts glued to the top edge, so it is easy to begin speaking.
      paddingVertical: TEXT_AREA_PADDING_V,
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

export function SpeakingPracticeScreen({ navigation, route }: SpeakingPracticeScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // SpeakingHistory hands over a saved session: the screen then opens
  // directly in the reading phase with the stored text — no provider call,
  // no form. Read once for the initial state; later param changes on a
  // live instance (e.g. popping back) do not restart a running session.
  const resumeText = route.params?.text ?? '';
  const resumeMaterial = route.params?.material ?? '';
  const resumeMinutes = route.params?.minutes;
  // 'listen' = TTS session: the engine speaks, the scroll follows the
  // playback pace instead of the learner reading (and the Settings speed).
  const [listenMode, setListenMode] = useState(route.params?.mode === 'listen');

  const [phase, setPhase] = useState<Phase>(resumeText ? 'practicing' : 'form');
  const [material, setMaterial] = useState(resumeMaterial);
  const [minutes, setMinutes] = useState(
    resumeMinutes !== undefined && (MINUTES_OPTIONS as readonly number[]).includes(resumeMinutes)
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
    // Listen mode derives the scroll from the TTS progress events; the
    // persisted Settings speed is deliberately not loaded or applied.
    if (listenMode) {
      return;
    }
    let cancelled = false;
    loadSpeakingScrollSpeed().then(value => {
      if (!cancelled) {
        setSpeed(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [listenMode]);

  const speedRef = useRef(speed);
  speedRef.current = speed;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const offsetRef = useRef(0);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);

  // Listen-mode playback coordination (all in refs so callbacks keep
  // stable identities): a monotonic token supersedes stale utterances —
  // a late settlement of a stopped/superseded speak() must never finish
  // a newer playback — and the last spoken character anchors both the
  // scroll target and where Resume re-speaks from. A finished utterance
  // glides the text to its true end before the session is closed, instead
  // of ending while the text is still moving.
  const playbackTokenRef = useRef(0);
  const spokenCharRef = useRef(0);
  const speakBaseRef = useRef(0);
  const targetOffsetRef = useRef(0);
  const finishRef = useRef<() => Promise<void>>(async () => {});
  const lastProgressAtRef = useRef<number | null>(null);

  /**
   * Largest scroll offset: the text block plus the text area's vertical
   * padding (the lead-in and trailing room) minus the viewport. Measuring
   * only the block would stop the scroll short of the last lines.
   */
  const maxScrollOffset = useCallback(
    () =>
      Math.max(0, contentHeightRef.current + 2 * TEXT_AREA_PADDING_V - viewportHeightRef.current),
    [],
  );

  // Listen-mode scroll geometry: the character ranges of the displayed
  // paragraphs within the spoken text, plus their measured on-screen boxes
  // (filled as layout reports them). Together they map a spoken character
  // position onto the ACTUAL rendered position of that word, so the
  // teleprompter tracks the text evenly regardless of paragraph lengths.
  const paragraphRanges = useMemo(
    () => paragraphCharRanges(fullText, paragraphs),
    [fullText, paragraphs],
  );
  const paragraphLayoutsRef = useRef<Array<{ y: number; height: number } | null>>([]);

  /**
   * Target scroll offset for the currently spoken character: layout-based
   * when every paragraph box has been measured, whole-text proportional
   * mapping until then (first frames after mount).
   */
  const computeTargetOffset = useCallback(
    (absoluteChar: number): number => {
      const maxOffset = maxScrollOffset();
      const layouts = paragraphLayoutsRef.current;
      const complete =
        paragraphRanges.length > 0 && paragraphRanges.every((_, index) => layouts[index] != null);
      if (complete) {
        const spans: ParagraphSpan[] = paragraphRanges.map((range, index) => ({
          ...range,
          y: layouts[index]?.y ?? 0,
          height: layouts[index]?.height ?? 0,
        }));
        return offsetForSpokenChar(
          absoluteChar,
          spans,
          TEXT_AREA_PADDING_V,
          viewportHeightRef.current,
          maxOffset,
        );
      }
      return offsetForCharProgress(absoluteChar, fullText.length, maxOffset);
    },
    [fullText.length, paragraphRanges, maxScrollOffset],
  );

  /**
   * The teleprompter position is a native-driven Animated value that slides
   * the text layer on the UI thread. It replaces per-tick ScrollView.scrollTo
   * calls, which re-laid out the content from JS and produced the ghosted,
   * jittery text during playback.
   */
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  // The glide in flight, described in JS: its start time and endpoints let
  // the paused position be computed synchronously. A native-driven value
  // reports its position back asynchronously, which is too late for Resume.
  const activeGlideRef = useRef<{
    from: number;
    to: number;
    startedAt: number;
    duration: number;
  } | null>(null);
  // A text shorter than the viewport is vertically centered (the text area
  // used to flex-center it); longer texts start at the top, so the centering
  // shift is zero once the text scrolls.
  const [centerShift, setCenterShift] = useState(0);
  const layerTranslate = useMemo(
    () => Animated.subtract(centerShift, scrollY),
    [centerShift, scrollY],
  );
  const updateCenterShift = useCallback(() => {
    if (contentHeightRef.current <= 0 || viewportHeightRef.current <= 0) {
      return;
    }
    const blockHeight = contentHeightRef.current + 2 * TEXT_AREA_PADDING_V;
    setCenterShift(Math.max(0, (viewportHeightRef.current - blockHeight) / 2));
  }, []);

  const readEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Where the text layer is right now: the linear position of the glide in
   * flight, or the last settled offset when nothing is moving.
   */
  const currentScrollOffset = useCallback((): number => {
    const glide = activeGlideRef.current;
    if (glide === null) {
      return offsetRef.current;
    }
    const elapsed = Math.min(glide.duration, Date.now() - glide.startedAt);
    return glide.from + (glide.to - glide.from) * (elapsed / glide.duration);
  }, []);

  /**
   * Freezes the teleprompter at its current position. The exact position is
   * pinned into the native value and the JS mirror, so the next glide (Resume)
   * starts from where the text stopped rather than the pre-pause offset.
   */
  const stopScroll = useCallback(() => {
    const position = currentScrollOffset();
    scrollAnimRef.current?.stop();
    scrollAnimRef.current = null;
    activeGlideRef.current = null;
    if (readEndTimerRef.current !== null) {
      clearTimeout(readEndTimerRef.current);
      readEndTimerRef.current = null;
    }
    scrollY.setValue(position);
    offsetRef.current = position;
  }, [currentScrollOffset, scrollY]);

  /** Glides the text layer to `toOffset` over `durationMs` on the native thread. */
  const glideScrollTo = useCallback(
    (toOffset: number, durationMs: number, onArrive?: () => void) => {
      const from = currentScrollOffset();
      stopScroll();
      const duration = Math.max(1, durationMs);
      activeGlideRef.current = {
        from,
        to: toOffset,
        startedAt: Date.now(),
        duration,
      };
      const animation = Animated.timing(scrollY, {
        toValue: toOffset,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      });
      scrollAnimRef.current = animation;
      animation.start(({ finished }) => {
        if (finished && scrollAnimRef.current === animation) {
          scrollAnimRef.current = null;
          activeGlideRef.current = null;
          offsetRef.current = toOffset;
          onArrive?.();
        }
      });
    },
    [currentScrollOffset, scrollY, stopScroll],
  );

  const jumpScrollTo = useCallback(
    (offset: number) => {
      stopScroll();
      scrollY.setValue(offset);
      offsetRef.current = offset;
    },
    [scrollY, stopScroll],
  );

  // New paragraphs (regenerated text) invalidate every measured box; the
  // next layout pass refills the cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: paragraphs is an intentional layout-cache reset trigger
  useEffect(() => {
    paragraphLayoutsRef.current = [];
  }, [paragraphs]);

  /** Re-aim the scroll target after a layout measurement lands. */
  const remeasureParagraph = useCallback(
    (index: number, y: number, height: number) => {
      const layouts = paragraphLayoutsRef.current;
      while (layouts.length <= index) {
        layouts.push(null);
      }
      layouts[index] = { y, height };
      if (spokenCharRef.current > 0) {
        // Words were already spoken before layout finished: re-derive the
        // target from the fresh geometry instead of waiting for the next.
        targetOffsetRef.current = computeTargetOffset(spokenCharRef.current);
      }
    },
    [computeTargetOffset],
  );

  const handleContentLayout = useCallback(
    (height: number) => {
      contentHeightRef.current = height;
      updateCenterShift();
      refreshReadScrollRef.current();
    },
    [updateCenterShift],
  );

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const finishingRef = useRef(false);

  const words = useMemo(() => countWords(fullText), [fullText]);

  const finish = useCallback(async () => {
    // phaseRef (not phase) so async callers — the TTS completion callback
    // created in an earlier render — still see the live phase.
    if (phaseRef.current !== 'practicing' || finishingRef.current) {
      return;
    }
    finishingRef.current = true;
    if (listenMode) {
      // A listen session replays an EXISTING history record; saving again
      // would duplicate it. Only silence any still-running playback.
      playbackTokenRef.current += 1;
      stopScroll();
      getSpeechEngine().stop();
      setKeepScreenAwake(false);
      setPhase('complete');
      return;
    }
    setPhase('complete');
  }, [listenMode, stopScroll]);

  finishRef.current = finish;

  /**
   * Start (or resume from `fromChar`) TTS playback of the practice text in
   * listen mode. Per-word progress events map the spoken character
   * position onto a scroll target, so the teleprompter follows the engine's
   * real pace. Natural completion or a terminal engine failure ends the
   * session; stale settlements (superseded by pause/stop/restart) are
   * ignored via the playback token.
   */
  const startPlayback = useCallback(
    (fromChar: number) => {
      const token = ++playbackTokenRef.current;
      speakBaseRef.current = fromChar;
      lastProgressAtRef.current = null;
      const text = fullText.slice(fromChar);
      if (!text.trim()) {
        finishRef.current();
        return;
      }
      const settleIfCurrent = () => {
        if (playbackTokenRef.current !== token) {
          return;
        }
        // Speech ended: glide the teleprompter to the real end of the text
        // and close the session only once it arrives there. A text that fits
        // without scrolling closes right away.
        const end = maxScrollOffset();
        targetOffsetRef.current = end;
        if (end <= SCROLL_END_EPSILON_PX) {
          finishRef.current();
          return;
        }
        glideScrollTo(end, LISTEN_SETTLE_MS, () => {
          if (playbackTokenRef.current === token) {
            finishRef.current();
          }
        });
      };
      try {
        getSpeechEngine()
          .speak(text, progress => {
            if (playbackTokenRef.current !== token) {
              return;
            }
            const absolute = speakBaseRef.current + progress.charEnd;
            if (absolute > spokenCharRef.current) {
              spokenCharRef.current = absolute;
            }
            const now = Date.now();
            const gap =
              lastProgressAtRef.current === null
                ? LISTEN_FIRST_GLIDE_MS
                : now - lastProgressAtRef.current;
            lastProgressAtRef.current = now;
            const target = Math.min(Math.max(computeTargetOffset(absolute), 0), maxScrollOffset());
            targetOffsetRef.current = target;
            glideScrollTo(
              target,
              Math.min(LISTEN_MAX_GLIDE_MS, Math.max(LISTEN_MIN_GLIDE_MS, gap)),
            );
          })
          .then(settleIfCurrent, settleIfCurrent);
      } catch {
        settleIfCurrent();
      }
      // Long read-alouds must not let the display sleep mid-sentence.
      setKeepScreenAwake(true);
    },
    [fullText, computeTargetOffset, maxScrollOffset, glideScrollTo],
  );

  /** Supersede any in-flight utterance and silence the engine. */
  const stopPlayback = useCallback(() => {
    playbackTokenRef.current += 1;
    stopScroll();
    getSpeechEngine().stop();
    setKeepScreenAwake(false);
  }, [stopScroll]);

  // Kick off TTS playback when a listen session first reaches the reading
  // phase. startedRef keeps this to one start per screen instance; Restart
  // and Practice-again re-invoke startPlayback explicitly.
  const listenStartedRef = useRef(false);
  useEffect(() => {
    if (!listenMode || listenStartedRef.current || phase !== 'practicing') {
      return;
    }
    listenStartedRef.current = true;
    startPlayback(0);
  }, [listenMode, phase, startPlayback]);

  // Leaving the screen silences any running listen-mode playback and
  // releases the screen-awake hold.
  useEffect(
    () => () => {
      playbackTokenRef.current += 1;
      stopScroll();
      if (listenMode) {
        getSpeechEngine().stop();
        setKeepScreenAwake(false);
      }
    },
    [listenMode, stopScroll],
  );

  useEffect(() => {
    if (phase !== 'practicing' || paused) {
      return;
    }
    setKeepScreenAwake(true);
    return () => setKeepScreenAwake(false);
  }, [phase, paused]);

  useEffect(() => {
    if (phase !== 'practicing' || paused) {
      return;
    }
    const id = setInterval(() => {
      setElapsedMs(prev => prev + 1000);
    }, 1000);
    return () => clearInterval(id);
  }, [phase, paused]);

  /**
   * Read mode: glide to the end of the text at the Settings speed. The
   * native animation is cancelled on pause, restart and leaving the screen.
   * When the glide arrives the session keeps running for READ_END_HOLD_MS so
   * the learner can finish the last lines, then ends by itself (End still
   * ends it sooner).
   */
  const startReadScroll = useCallback(() => {
    const maxOffset = maxScrollOffset();
    const speedPx = speedRef.current;
    if (maxOffset <= 0 || speedPx <= 0) {
      return;
    }
    const remaining = Math.max(0, maxOffset - currentScrollOffset());
    glideScrollTo(maxOffset, (remaining / speedPx) * 1000, () => {
      readEndTimerRef.current = setTimeout(() => {
        readEndTimerRef.current = null;
        finishRef.current();
      }, READ_END_HOLD_MS);
    });
  }, [currentScrollOffset, glideScrollTo, maxScrollOffset]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: speed restarts the glide when the reader speed changes
  useEffect(() => {
    if (listenMode || phase !== 'practicing' || paused) {
      return;
    }
    startReadScroll();
    return stopScroll;
  }, [listenMode, phase, paused, speed, startReadScroll, stopScroll]);

  /** Re-aim the read glide when a layout measurement changes the scroll range. */
  const refreshReadScrollRef = useRef<() => void>(() => {});
  refreshReadScrollRef.current = () => {
    if (!listenMode && phaseRef.current === 'practicing' && !pausedRef.current) {
      startReadScroll();
    }
  };

  const dragStartOffsetRef = useRef(0);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          pausedRef.current &&
          Math.abs(gesture.dy) > 4 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderGrant: () => {
          stopScroll();
          dragStartOffsetRef.current = currentScrollOffset();
        },
        onPanResponderMove: (_event, gesture) => {
          const next = Math.min(
            Math.max(dragStartOffsetRef.current - gesture.dy, 0),
            maxScrollOffset(),
          );
          offsetRef.current = next;
          targetOffsetRef.current = next;
          scrollY.setValue(next);
        },
      }),
    [currentScrollOffset, maxScrollOffset, scrollY, stopScroll],
  );

  const rewind = useCallback(() => {
    targetOffsetRef.current = 0;
    spokenCharRef.current = 0;
    lastProgressAtRef.current = null;
    setElapsedMs(0);
    setPaused(false);
    jumpScrollTo(0);
    if (listenMode) {
      stopPlayback();
      startPlayback(0);
    } else {
      refreshReadScrollRef.current();
    }
  }, [listenMode, stopPlayback, startPlayback, jumpScrollTo]);

  /**
   * Pause/Resume: in listen mode a pause silences the engine at the last
   * spoken word, and resume re-speaks from that word onward (Android TTS
   * cannot continue a stopped utterance). Read mode just flips the flag.
   */
  const togglePause = useCallback(() => {
    if (!listenMode) {
      setPaused(current => !current);
      return;
    }
    if (pausedRef.current) {
      setPaused(false);
      startPlayback(spokenCharRef.current);
    } else {
      setPaused(true);
      stopPlayback();
    }
  }, [listenMode, startPlayback, stopPlayback]);

  const handleGenerate = useCallback(async () => {
    if (generating) {
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const config = await loadServerlessConfig();
      if (!config) {
        throw new Error('Add your provider API key in Settings to generate practice text.');
      }
      const client = createProviderClient(config);
      const db = await getLocalDatabase();
      const { text, paragraphs: displayParagraphs } = await generateSpeakingPracticeText(
        db,
        request => client.complete(request),
        { material: material.trim(), minutes },
      );
      const profile = await getLearningProfile(db);
      try {
        await createSpeakingPracticeRecord(db, {
          userId: 0, // Anonymous user in serverless mode
          title: material.trim() || 'Untitled practice',
          description: '',
          rawPrompt: `Topic: ${material.trim()}, Minutes: ${minutes}`,
          englishLevel: profile.level,
          text,
          minutes,
          wordCount: countWords(text),
        });
      } catch {
        // Silently ignore history save failures
      }
      setFullText(text);
      setParagraphs(displayParagraphs);
      setElapsedMs(0);
      setPaused(false);
      jumpScrollTo(0);
      finishingRef.current = false;
      setPhase('practicing');
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  }, [generating, material, minutes, jumpScrollTo]);

  const startSameText = useCallback(
    (asListen: boolean) => {
      targetOffsetRef.current = 0;
      spokenCharRef.current = 0;
      lastProgressAtRef.current = null;
      setElapsedMs(0);
      setPaused(false);
      jumpScrollTo(0);
      finishingRef.current = false;
      setListenMode(asListen);
      setPhase('practicing');
      if (asListen) {
        startPlayback(0);
      }
    },
    [startPlayback, jumpScrollTo],
  );

  const handlePracticeSpeakingAgain = useCallback(() => startSameText(false), [startSameText]);

  const handleListeningAgain = useCallback(() => startSameText(true), [startSameText]);

  const handlePracticeNewText = useCallback(() => {
    setListenMode(false);
    setPhase('form');
    setMaterial('');
    setParagraphs([]);
    setFullText('');
    setElapsedMs(0);
  }, []);

  if (phase === 'complete') {
    return (
      <View style={styles.container} testID="speaking-practice-screen">
        <ScreenTitleBar
          title={listenMode ? 'Listening practice' : 'Speaking practice'}
          onBack={() => navigation.goBack()}
          backTestID="speaking-back"
          gutterInset={false}
        />
        <View style={styles.summary} testID="speaking-summary">
          <Text style={styles.summaryTitle}>
            {listenMode ? 'Listening complete' : 'Practice complete'}
          </Text>
          <Text style={styles.summaryDetail} testID="speaking-summary-detail">
            {formatElapsed(elapsedMs)} of {listenMode ? 'listening' : 'reading'} · {words} words
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={handlePracticeSpeakingAgain}
            style={styles.primaryButton}
            testID="speaking-practice-again">
            <Text style={styles.primaryButtonText}>Practice speaking again</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={handleListeningAgain}
            style={styles.secondaryButton}
            testID="speaking-listen-again">
            <Text style={styles.secondaryButtonText}>Listening again</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Generate a new practice text"
            onPress={handlePracticeNewText}
            style={styles.secondaryButton}
            testID="speaking-practice-new">
            <Text style={styles.secondaryButtonText}>Practice new text</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'practicing') {
    return (
      <View style={styles.container} testID="speaking-practice-screen">
        <ScreenTitleBar
          title={listenMode ? 'Listening practice' : 'Speaking practice'}
          onBack={() => navigation.goBack()}
          backTestID="speaking-back"
          gutterInset={false}
        />

        <View style={styles.statusBar} testID="speaking-status">
          <Text style={styles.elapsed} testID="speaking-elapsed">
            {formatElapsed(elapsedMs)}
          </Text>
          <View style={styles.controlsRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={paused ? 'Resume scrolling' : 'Pause scrolling'}
              onPress={togglePause}
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
              onPress={async () => await finish()}
              style={styles.controlButton}
              testID="speaking-end">
              <Text style={styles.controlButtonText}>End</Text>
            </Pressable>
          </View>
        </View>

        <View
          style={styles.karaoke}
          testID="speaking-karaoke"
          {...panResponder.panHandlers}
          onLayout={event => {
            viewportHeightRef.current = event.nativeEvent.layout.height;
            updateCenterShift();
            refreshReadScrollRef.current();
          }}>
          {paused ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy the whole text"
              hitSlop={8}
              onPress={() => copyText(fullText)}
              style={styles.copyButton}
              testID="speaking-copy">
              <ClipboardIcon color={colors.accent} />
            </Pressable>
          ) : null}
          <Animated.View style={[styles.textArea, { transform: [{ translateY: layerTranslate }] }]}>
            <KaraokeText
              paragraphs={paragraphs}
              onContentLayout={handleContentLayout}
              onParagraphLayout={remeasureParagraph}
            />
          </Animated.View>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'android' ? undefined : 'padding'}
      testID="speaking-practice-screen">
      <ScreenTitleBar
        title="Speaking practice"
        onBack={() => navigation.goBack()}
        backTestID="speaking-back"
        gutterInset={false}
      />

      <Text style={styles.subtitle}>
        Read aloud while the text scrolls at your speed. Type a topic, a list of questions, or your
        own text, and pick how long you want to speak.
      </Text>

      <TextInput
        style={styles.input}
        placeholder={'Tap here to start typing\ne.g. My weekend plans\nor paste your own text'}
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
              style={[styles.minutesChip, isSelected && styles.minutesChipSelected]}
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
