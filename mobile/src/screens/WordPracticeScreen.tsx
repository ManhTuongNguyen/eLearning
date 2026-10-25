/**
 * Word practice screen (WORD_BANK_V1 §2.7, TASK-WB-012).
 *
 * Mirrors the sentence practice screen's structure and quality bar: the shared
 * queue selects the due cards (oldest due first, capped at 20, suspended and
 * dataless words excluded), a dictation card for `new`/`learning`/`relearning`
 * words and a meaning-recall card for `review` words.
 *
 * Dictation: the word is spoken once automatically on card open (device TTS)
 * with a replay button; the learner types it; `Check` locks the input and
 * shows a character-level diff of the answer (missing letters underlined in
 * the word's spelling, wrong typed letters struck through, plus a one-line
 * summary), pre-suggests Good for an exact or one-typo answer (never Easy) and
 * the reveal shows the spelling, IPA and POS labels and replays the word.
 *
 * Recall: the front shows the meanings and examples with the target word
 * masked (first letter + underscores, inflections included — see wordMask);
 * the reveal plays the word, unmasks everything, diffs the typed answer the
 * same way and shows the full data.
 *
 * Grading goes through the shared FSRS scheduler and persists the word state
 * plus an Anki-shaped review-log row in one transaction; a card still in a
 * short-term step is requeued (learn-ahead) until FSRS graduates it. The
 * session summary reports the Again/Hard/Good/Easy breakdown with actions to
 * review again (if anything is still due) or go back.
 *
 * Audio follows the one-playback contract: one utterance at a time, silenced
 * on card change, blur and unmount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextStyle } from 'react-native';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Icon } from '../components/Icon';
import { SCREEN_GUTTER, Screen, ScreenHeader, ScreenScrollView } from '../components/ScreenLayout';
import { WordSenseList } from '../components/WordSenseList';
import { getLocalDatabase } from '../db/database';
import { getSrsConfig } from '../db/srsConfigStore';
import type { ReviewCardMode, ReviewGrade, WordRecord, WordTopicRecord } from '../db/types';
import {
  countNewWordsIntroducedToday,
  countWordReviewsToday,
  getWordTopicById,
  listWordsByTopic,
  recordWordReview,
} from '../db/wordRepository';
import { useApplicationMode } from '../mode/ModeContext';
import type { WordPracticeScreenProps } from '../navigation/types';
import { loadWordPracticeMode, type WordPracticeMode } from '../preferences/wordPracticeMode';
import {
  type CharDiffKind,
  type CharDiffSegment,
  diffCharacters,
  suggestGrade,
} from '../srs/answerCheck';
import { selectCardMode } from '../srs/cardMode';
import { DEFAULT_FSRS_CONFIG, type FsrsConfig } from '../srs/config';
import { startOfStudyDay } from '../srs/dayBoundary';
import {
  type GradePreview,
  previewSchedule,
  reviewSentence,
  schedulerStateFrom,
} from '../srs/scheduler';
import {
  applyWordPracticeGrade,
  createWordPracticeSessionState,
  type PracticeSessionState,
  type SessionBuildOptions,
} from '../srs/session';
import { maskWordInText } from '../srs/wordMask';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import type { TextToSpeechEngine } from '../tts/textToSpeech';
import { getSpeechEngine } from '../tts/textToSpeech';
import { useSpeechPlayback } from '../tts/useSpeechPlayback';

function describeError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  return 'unknown error';
}

/**
 * Human-readable "when is the next card due" line for the caught-up state.
 * Suspended words and dataless words are excluded — they can never come due
 * as practiceable cards.
 */
export function formatNextWordDueLabel(words: readonly WordRecord[], now: Date): string | null {
  const pending = words
    .filter(word => !word.suspended && word.data_status === 'complete')
    .map(word => Date.parse(word.due_at))
    .filter(dueMs => Number.isFinite(dueMs));
  if (pending.length === 0) {
    return null;
  }

  const nextMs = Math.min(...pending);
  const deltaMs = nextMs - now.getTime();
  if (deltaMs <= 0) {
    return 'Next due now.';
  }

  const minutes = Math.ceil(deltaMs / 60_000);
  let relative: string;
  if (minutes < 60) {
    relative = `${minutes} min`;
  } else {
    const hours = Math.ceil(minutes / 60);
    if (hours < 24) {
      relative = `${hours} h`;
    } else {
      const days = Math.ceil(hours / 24);
      relative = `${days} day${days === 1 ? '' : 's'}`;
    }
  }

  const next = new Date(nextMs);
  const absolute = `${next.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })} at ${next.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
  return `Next due in ${relative} (${absolute}).`;
}

/** Character-level diff colors: typed-but-wrong struck, missing letters underlined. */
function charSegmentStyle(kind: CharDiffKind, colors: ThemeColors): TextStyle {
  switch (kind) {
    case 'correct':
      return { color: colors.success };
    case 'missing':
      return { color: colors.danger, textDecorationLine: 'underline' };
    case 'extra':
      return { color: colors.warning, textDecorationLine: 'line-through' };
  }
}

/** The one-line result summary for the character diff ("1 missing · 1 extra"). */
function diffSummary(segments: readonly CharDiffSegment[]): string {
  const counts = { missing: 0, extra: 0 };
  for (const segment of segments) {
    if (segment.kind === 'missing') {
      counts.missing += segment.text.length;
    } else if (segment.kind === 'extra') {
      counts.extra += segment.text.length;
    }
  }
  if (counts.missing === 0 && counts.extra === 0) {
    return 'Exact match.';
  }
  const parts: string[] = [];
  if (counts.missing > 0) {
    parts.push(`${counts.missing} missing`);
  }
  if (counts.extra > 0) {
    parts.push(`${counts.extra} extra`);
  }
  return parts.join(' · ');
}

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 12,
    },
    backLinkButton: {
      paddingVertical: 4,
    },
    backLinkText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.accent,
    },
    title: {
      flex: 1,
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    progress: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
      textAlign: 'center',
      marginBottom: 8,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: SCREEN_GUTTER,
    },
    stateText: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
      paddingHorizontal: 24,
    },
    stateTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
      textAlign: 'center',
    },
    errorText: {
      color: c.errorText,
      fontSize: 13,
      textAlign: 'center',
    },
    actionText: {
      color: c.primary,
      fontSize: 15,
      fontWeight: '600',
    },
    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 16,
      padding: 20,
      gap: 14,
    },
    modeLabel: {
      fontSize: 12,
      fontWeight: '700',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    wordText: {
      fontSize: 34,
      fontWeight: '700',
      color: c.textPrimary,
      textAlign: 'center',
    },
    phonetics: {
      fontSize: 15,
      color: c.textMuted,
      textAlign: 'center',
    },
    definition: {
      fontSize: 16,
      lineHeight: 22,
      color: c.textPrimary,
    },
    maskedSegment: {
      letterSpacing: 2,
      fontWeight: '700',
    },
    diffRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 10,
      backgroundColor: c.background,
    },
    diffToken: {
      fontSize: 16,
      fontWeight: '600',
    },
    diffSummary: {
      fontSize: 13,
      color: c.textSecondary,
    },
    answerInput: {
      backgroundColor: c.background,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: c.textPrimary,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: 10,
    },
    button: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 10,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
      gap: 2,
    },
    primaryButton: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    buttonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    primaryButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.onPrimary,
    },
    primaryButtonLabel: {
      fontSize: 11,
      fontWeight: '600',
      color: c.onPrimary,
    },
    gradeRow: {
      flexDirection: 'row',
      gap: 10,
    },
    gradeButton: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      paddingVertical: 12,
    },
    gradeButtonSuggested: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    gradeText: {
      fontSize: 14,
      fontWeight: '700',
      color: c.textPrimary,
    },
    gradeIntervalText: {
      fontSize: 11,
      fontWeight: '600',
      color: c.textMuted,
      marginTop: 2,
    },
    suggestion: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textSecondary,
    },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 16,
      flexWrap: 'wrap',
    },
    summaryItem: {
      alignItems: 'center',
    },
    summaryCount: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    summaryLabel: {
      fontSize: 12,
      color: c.textMuted,
    },
    pressedFade: {
      opacity: 0.9,
    },
  });
}

/** Per-grade count used by the summary. */
type GradeCounts = Record<ReviewGrade, number>;

const EMPTY_COUNTS: GradeCounts = { again: 0, hard: 0, good: 0, easy: 0 };

const GRADE_OPTIONS: Array<{ grade: ReviewGrade; label: string }> = [
  { grade: 'again', label: 'Again' },
  { grade: 'hard', label: 'Hard' },
  { grade: 'good', label: 'Good' },
  { grade: 'easy', label: 'Easy' },
];

/**
 * Anki's four grade buttons, identical in structure to the sentence practice
 * screen: uniform layout, and the pre-suggested grade is highlighted (border
 * + accent background + colored label) instead of an inline check mark that
 * would shift the text inside the button.
 */
function GradeButtons({
  suggested,
  previews,
  saving,
  colors,
  styles,
  onGrade,
}: {
  suggested: ReviewGrade | null;
  previews: GradePreview[];
  saving: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onGrade: (grade: ReviewGrade) => void;
}) {
  return (
    <View style={styles.gradeRow}>
      {GRADE_OPTIONS.map(option => {
        const preview = previews.find(item => item.grade === option.grade);
        const isSuggested = suggested === option.grade;
        return (
          <Pressable
            key={option.grade}
            accessibilityRole="button"
            accessibilityLabel={`Grade ${option.label}`}
            accessibilityState={{ disabled: saving, selected: isSuggested }}
            testID={`word-practice-grade-${option.grade}`}
            disabled={saving}
            onPress={() => onGrade(option.grade)}
            style={({ pressed }) => [
              styles.gradeButton,
              isSuggested && styles.gradeButtonSuggested,
              saving && styles.buttonDisabled,
              pressed && styles.pressedFade,
            ]}>
            <Text
              style={[
                styles.gradeText,
                { color: isSuggested ? colors.primary : colors.textPrimary },
              ]}>
              {option.label}
            </Text>
            {preview ? (
              <Text
                style={styles.gradeIntervalText}
                testID={`word-practice-grade-interval-${option.grade}`}>
                {preview.label}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

interface WordPracticeScreenInternalProps extends WordPracticeScreenProps {
  /** TTS seam; defaults to the active engine from the registry. */
  speech?: TextToSpeechEngine;
}

export function WordPracticeScreen({
  route,
  navigation,
  speech = getSpeechEngine(),
}: WordPracticeScreenInternalProps) {
  const { status: modeStatus, mode } = useApplicationMode();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const topicId = route.params.topicId;

  const [topic, setTopic] = useState<WordTopicRecord | null>(null);
  const [allWords, setAllWords] = useState<WordRecord[]>([]);
  const [session, setSession] = useState<PracticeSessionState<WordRecord>>({
    queue: [],
  });
  const [practiceMode, setPracticeMode] = useState<WordPracticeMode>('auto');
  const [config, setConfig] = useState<FsrsConfig>(DEFAULT_FSRS_CONFIG);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [answer, setAnswer] = useState('');
  const [diff, setDiff] = useState<CharDiffSegment[] | null>(null);
  const [suggested, setSuggested] = useState<ReviewGrade | null>(null);
  const [revealed, setRevealed] = useState(false);
  // Bumped on every card presentation so an auto-played dictation also fires
  // for a requeued card that is the same word row.
  const [presentationKey, setPresentationKey] = useState(0);

  const [reviewedCount, setReviewedCount] = useState(0);
  const [gradeCounts, setGradeCounts] = useState<GradeCounts>(EMPTY_COUNTS);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const gradingRef = useRef(false);
  const cardShownAtRef = useRef(Date.now());
  /**
   * The session's build options (session cap, learn-ahead window, remaining
   * daily quotas), refreshed by `loadSession` and decremented as cards are
   * graded so the "Review again" probe never promises cards the daily limits
   * have already spent.
   */
  const sessionLimitsRef = useRef<SessionBuildOptions>({});

  const { speakingId, speak, stop } = useSpeechPlayback(speech);

  const serverMode = modeStatus === 'ready' && mode === 'server';

  const loadSession = useCallback(async () => {
    if (serverMode) {
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const db = await getLocalDatabase();
      const [topicRecord, words, storedMode, srsConfig] = await Promise.all([
        getWordTopicById(db, topicId),
        listWordsByTopic(db, topicId),
        loadWordPracticeMode(),
        getSrsConfig(db),
      ]);
      if (!topicRecord) {
        throw new Error('This topic no longer exists.');
      }
      // Anki's daily deck limits: what the review log consumed since the study
      // day started is subtracted from the topic's per-day settings.
      const dayStartIso = startOfStudyDay(new Date(), srsConfig.rolloverHour).toISOString();
      const [newIntroduced, reviewsDone] = await Promise.all([
        countNewWordsIntroducedToday(db, topicId, dayStartIso),
        countWordReviewsToday(db, topicId, dayStartIso),
      ]);
      sessionLimitsRef.current = {
        maxCards: topicRecord.max_session_cards,
        learnAheadMinutes: topicRecord.learn_ahead_minutes,
        newRemaining: topicRecord.new_cards_per_day - newIntroduced,
        reviewRemaining: topicRecord.max_reviews_per_day - reviewsDone,
      };
      setTopic(topicRecord);
      setAllWords(words);
      setPracticeMode(storedMode);
      setConfig(srsConfig);
      setSession(createWordPracticeSessionState(words, new Date(), sessionLimitsRef.current));
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [serverMode, topicId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional reload trigger
  useEffect(() => {
    loadSession();
  }, [loadSession, reloadKey]);

  // TTS must stop when the screen loses focus. Unmount silencing lives in
  // useSpeechPlayback.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('blur', () => {
      stop();
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, stop]);

  const currentCard = session.queue[0] ?? null;
  const cardMode: ReviewCardMode | null = currentCard
    ? selectCardMode(currentCard.state, practiceMode)
    : null;

  // Dictation cards speak their word once, automatically, on open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: presentationKey is an intentional re-play trigger
  useEffect(() => {
    if (!currentCard || cardMode !== 'dictation') {
      return;
    }
    speak(currentCard.id, currentCard.text);
  }, [currentCard, presentationKey, cardMode, speak]);

  // Moving to the next card (or leaving the screen) silences the previous
  // utterance first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: presentationKey is an intentional card-change trigger
  useEffect(
    () => () => {
      stop();
    },
    [currentCard, presentationKey, stop],
  );

  // Measure how long the learner spends on a card (Anki's `revlog.time`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: presentationKey is an intentional card-change trigger
  useEffect(() => {
    cardShownAtRef.current = Date.now();
  }, [currentCard?.id, presentationKey]);

  const handleReplay = useCallback(() => {
    if (currentCard) {
      speak(currentCard.id, currentCard.text);
    }
  }, [currentCard, speak]);

  const handleCheck = useCallback(() => {
    if (!currentCard) {
      return;
    }
    Keyboard.dismiss();
    setDiff(diffCharacters(currentCard.text, answer));
    setSuggested(suggestGrade(currentCard.text, answer));
  }, [currentCard, answer]);

  const handleReveal = useCallback(() => {
    if (!currentCard) {
      return;
    }
    setRevealed(true);
    // The reveal also grades the typed answer, so the pre-suggested ✓ shows
    // on the buttons; the learner can still override it.
    setDiff(diffCharacters(currentCard.text, answer));
    setSuggested(suggestGrade(currentCard.text, answer));
    speak(currentCard.id, currentCard.text);
  }, [currentCard, answer, speak]);

  const previews: GradePreview[] = useMemo(() => {
    if (!currentCard) {
      return [];
    }
    return previewSchedule(schedulerStateFrom(currentCard), new Date(), config);
  }, [currentCard, config]);

  const handleGrade = useCallback(
    async (grade: ReviewGrade) => {
      if (!currentCard || gradingRef.current) {
        return;
      }
      gradingRef.current = true;
      setSaving(true);
      setActionError(null);
      try {
        const now = new Date();
        const outcome = reviewSentence(schedulerStateFrom(currentCard), grade, now, config);
        const cardModeForReview = selectCardMode(currentCard.state, practiceMode);
        const duration = Math.max(0, Math.min(3_600_000, Date.now() - cardShownAtRef.current));
        const db = await getLocalDatabase();
        await recordWordReview(db, {
          word_id: currentCard.id,
          topic_id: currentCard.topic_id,
          grade,
          mode: cardModeForReview,
          state: outcome.state,
          log: outcome.log,
          review_duration_ms: duration,
        });
        const updated: WordRecord = {
          ...currentCard,
          ...outcome.state,
          updated_at: now.toISOString(),
        };
        // Consume one unit of the matching daily quota (the card's state before
        // this grade decides which counter it burns, exactly like the log).
        const limits = sessionLimitsRef.current;
        if (currentCard.state === 'new') {
          sessionLimitsRef.current = {
            ...limits,
            newRemaining: Math.max(0, (limits.newRemaining ?? 0) - 1),
          };
        } else if (currentCard.state === 'review') {
          sessionLimitsRef.current = {
            ...limits,
            reviewRemaining: Math.max(0, (limits.reviewRemaining ?? 0) - 1),
          };
        }
        setAllWords(previous => previous.map(word => (word.id === updated.id ? updated : word)));
        setSession(previous => applyWordPracticeGrade(previous, grade, updated));
        setReviewedCount(count => count + 1);
        setGradeCounts(counts => ({ ...counts, [grade]: counts[grade] + 1 }));
        setPresentationKey(key => key + 1);
        setAnswer('');
        setDiff(null);
        setSuggested(null);
        setRevealed(false);
      } catch (err) {
        setActionError(`Could not save this review: ${describeError(err)}`);
      } finally {
        gradingRef.current = false;
        setSaving(false);
      }
    },
    [currentCard, practiceMode, config],
  );

  const totalCards = reviewedCount + session.queue.length;
  const sessionFinished = !loading && !loadError && !serverMode && currentCard === null;
  const nextDueLabel = formatNextWordDueLabel(allWords, new Date());
  // The same limits the session was built with (including the daily quotas
  // consumed so far) decide whether "Review again" has anything to show.
  const hasRemainingDue =
    allWords.length > 0 &&
    createWordPracticeSessionState(allWords, new Date(), {
      ...sessionLimitsRef.current,
      maxCards: 1,
    }).queue.length > 0;
  const showGradeButtons = cardMode === 'dictation' ? diff !== null : revealed;

  /**
   * The checked answer as a character-level diff: the word with missing
   * letters underlined and wrong typed letters struck through, plus a one-line
   * summary. Word-level diffs are meaningless for a single word — the learner
   * needs to see WHICH characters were wrong. Shared by dictation and recall.
   */
  const renderDiff = () => {
    if (diff === null) {
      return null;
    }
    return (
      <>
        <View style={styles.diffRow} testID="word-practice-diff">
          {diff.map((segment, index) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: diff segments are positional
              key={`${segment.kind}-${index}`}
              accessibilityLabel={`${segment.kind} characters: ${segment.text}`}
              style={[styles.diffToken, charSegmentStyle(segment.kind, colors)]}
              testID={`word-practice-diff-char-${index}`}>
              {segment.text}
            </Text>
          ))}
        </View>
        <Text style={styles.diffSummary} testID="word-practice-diff-summary">
          {diffSummary(diff)}
        </Text>
      </>
    );
  };

  /**
   * The recall front masks the target word (and its inflections) everywhere it
   * appears; the shared sense renderer calls this for every displayed string.
   */
  const renderMasked = (text: string) =>
    maskWordInText(text, currentCard?.text ?? '').map((segment, segmentIndex) =>
      segment.kind === 'masked' ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: mask segments are positional
        <Text key={segmentIndex} style={styles.maskedSegment}>
          {segment.text}
        </Text>
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: mask segments are positional
        <Text key={segmentIndex}>{segment.text}</Text>
      ),
    );

  return (
    <Screen style={styles.container} testID="word-practice-screen">
      <ScreenHeader style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to topic"
          testID="word-practice-back"
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.backLinkButton, pressed && styles.pressedFade]}>
          <Text style={styles.backLinkText}>‹ Topic</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1} testID="word-practice-title">
          {topic ? topic.title : 'Practice'}
        </Text>
      </ScreenHeader>

      {loading ? (
        <View style={styles.centered} testID="word-practice-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loadError ? (
        <View style={styles.centered} testID="word-practice-load-error">
          <Text role="alert" style={styles.stateText}>
            {loadError}
          </Text>
          <Pressable testID="word-practice-retry" onPress={() => setReloadKey(key => key + 1)}>
            <Text style={styles.actionText}>Try again</Text>
          </Pressable>
        </View>
      ) : sessionFinished ? (
        <View style={styles.centered} testID="word-practice-summary">
          <Text style={styles.stateTitle}>
            {reviewedCount === 0 ? 'All caught up' : 'Session complete'}
          </Text>
          {reviewedCount > 0 ? (
            <>
              <Text style={styles.stateText} testID="word-practice-summary-count">
                {`${reviewedCount} word${reviewedCount === 1 ? '' : 's'} reviewed.`}
              </Text>
              <View style={styles.summaryRow}>
                {(['again', 'hard', 'good', 'easy'] as const).map(grade => (
                  <View key={grade} style={styles.summaryItem}>
                    <Text style={styles.summaryCount} testID={`word-practice-summary-${grade}`}>
                      {gradeCounts[grade]}
                    </Text>
                    <Text style={styles.summaryLabel}>{grade}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {nextDueLabel ? (
            <Text style={styles.stateText} testID="word-practice-next-due">
              {nextDueLabel}
            </Text>
          ) : (
            <Text style={styles.stateText}>No words to practice yet.</Text>
          )}
          {hasRemainingDue ? (
            <Pressable
              accessibilityRole="button"
              testID="word-practice-review-again"
              onPress={() => {
                setReviewedCount(0);
                setGradeCounts(EMPTY_COUNTS);
                setSession(
                  createWordPracticeSessionState(allWords, new Date(), sessionLimitsRef.current),
                );
                setPresentationKey(key => key + 1);
              }}
              style={({ pressed }) => [
                styles.button,
                styles.primaryButton,
                pressed && styles.pressedFade,
              ]}>
              <Text style={styles.primaryButtonText}>Review again</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            testID="word-practice-back-to-topic"
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.button, pressed && styles.pressedFade]}>
            <Text style={styles.buttonText}>Back to topic</Text>
          </Pressable>
        </View>
      ) : currentCard ? (
        <ScreenScrollView keyboardShouldPersistTaps="handled">
          <Text style={styles.progress} testID="word-practice-progress">
            {`${totalCards - session.queue.length + 1} / ${totalCards}`}
          </Text>

          <View style={styles.card}>
            {cardMode === 'dictation' ? (
              <>
                <Text style={styles.modeLabel}>Dictation — type what you hear</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Replay the word"
                  accessibilityState={{ busy: speakingId === currentCard.id }}
                  testID="word-practice-replay"
                  onPress={handleReplay}
                  style={({ pressed }) => [
                    styles.button,
                    { flex: 0, alignSelf: 'center', paddingHorizontal: 20 },
                    pressed && styles.pressedFade,
                  ]}>
                  <Icon
                    name={speakingId === currentCard.id ? 'speaker' : 'play'}
                    color={colors.accent}
                  />
                </Pressable>
                <TextInput
                  value={answer}
                  onChangeText={setAnswer}
                  style={styles.answerInput}
                  testID="word-practice-answer"
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Type the word you hear"
                  editable={diff === null && !saving}
                />
                {renderDiff()}
                {diff !== null ? (
                  <View>
                    <Text selectable style={styles.definition} testID="word-practice-correct-word">
                      {currentCard.text}
                    </Text>
                    {currentCard.phonetics_json.length > 0 ? (
                      <Text selectable style={styles.phonetics}>
                        {currentCard.phonetics_json.join('\n')}
                      </Text>
                    ) : null}
                    <WordSenseList senses={currentCard.senses_json} />
                  </View>
                ) : null}
              </>
            ) : (
              <>
                <Text style={styles.modeLabel}>Recall — which word is this?</Text>
                <View testID="word-practice-recall-front">
                  <WordSenseList
                    senses={currentCard.senses_json}
                    variant="front"
                    renderText={renderMasked}
                  />
                </View>
                <TextInput
                  value={answer}
                  onChangeText={setAnswer}
                  style={styles.answerInput}
                  testID="word-practice-answer"
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Type the word"
                  editable={!revealed && !saving}
                />
                {revealed ? (
                  <View testID="word-practice-recall-reveal">
                    <Text selectable style={styles.wordText}>
                      {currentCard.text}
                    </Text>
                    {renderDiff()}
                    {currentCard.phonetics_json.length > 0 ? (
                      <Text selectable style={styles.phonetics}>
                        {currentCard.phonetics_json.join('\n')}
                      </Text>
                    ) : null}
                    <WordSenseList senses={currentCard.senses_json} />
                  </View>
                ) : null}
              </>
            )}

            {actionError ? (
              <Text role="alert" style={styles.errorText} testID="word-practice-action-error">
                {actionError}
              </Text>
            ) : null}

            {!showGradeButtons ? (
              <View style={styles.buttonRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: answer.trim().length === 0 }}
                  testID="word-practice-check"
                  onPress={() => {
                    // Dictation checks the typed answer; recall reveals.
                    if (cardMode === 'recall') {
                      handleReveal();
                    } else {
                      handleCheck();
                    }
                  }}
                  disabled={answer.trim().length === 0}
                  style={({ pressed }) => [
                    styles.button,
                    styles.primaryButton,
                    answer.trim().length === 0 && styles.buttonDisabled,
                    pressed && styles.pressedFade,
                  ]}>
                  <Text style={styles.primaryButtonText}>
                    {cardMode === 'recall' ? 'Reveal' : 'Check'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <GradeButtons
                suggested={suggested}
                previews={previews}
                saving={saving}
                colors={colors}
                styles={styles}
                onGrade={grade => {
                  // handleGrade handles its own errors, so it never rejects.
                  handleGrade(grade);
                }}
              />
            )}
            {suggested !== null ? (
              <Text style={styles.suggestion} testID="word-practice-suggestion">
                {`Suggested: ${suggested === 'good' ? 'Good' : 'Again'}`}
              </Text>
            ) : null}
          </View>
        </ScreenScrollView>
      ) : null}
    </Screen>
  );
}
