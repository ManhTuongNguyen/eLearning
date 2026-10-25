/**
 * Spaced-repetition practice for one real-life sentence topic (TASK-SENT-012,
 * TASK-SENT-015, SENTENCE_LIVE_V1 §2.3/§2.6).
 *
 * The screen turns the topic's due sentences into a finite session (at most 20
 * cards, oldest due first) and picks each card's shape from the FSRS state:
 * `new`/`learning`/`relearning` sentences are dictated, `review` sentences are
 * recalled from their situation. A forced practice mode from Settings overrides
 * that mix.
 *
 * Every grade goes through the FSRS scheduler and is persisted with its
 * Anki-shaped review-log row (memory state, elapsed days, duration) in one
 * repository transaction. The four buttons carry the interval each one would
 * schedule, like Anki. A card that is still in a learning/relearning step stays
 * in the session queue, so `Again` (and the first `Good` of a new card) brings
 * it back until FSRS graduates it to `review`. TTS follows the shared
 * one-playback contract: one utterance at a time, stopped when the card
 * changes, the screen blurs or it unmounts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextStyle,
  View,
} from 'react-native';
import { EMPTY_GRADE_COUNTS, GradeButtons, type GradeCounts } from '../components/GradeButtons';
import { Icon } from '../components/Icon';
import {
  SCREEN_GUTTER,
  SCREEN_TOP_SPACING,
  Screen,
  ScreenHeader,
  ScreenScrollView,
} from '../components/ScreenLayout';
import { getLocalDatabase } from '../db/database';
import {
  countNewSentencesIntroducedToday,
  countSentenceReviewsToday,
  getSentenceTopicById,
  listSentencesByTopic,
  recordSentenceReview,
} from '../db/sentenceRepository';
import { getSrsConfig } from '../db/srsConfigStore';
import type { ReviewCardMode, ReviewGrade, SentenceRecord, SentenceTopicRecord } from '../db/types';
import type { SentencePracticeScreenProps } from '../navigation/types';
import { loadPracticeMode, type PracticeMode } from '../preferences/practiceMode';
import {
  type DiffKind,
  type DiffSegment,
  diffDisplayTokens,
  diffTokens,
  suggestGrade,
  summarizeDiff,
} from '../srs/answerCheck';
import { selectCardMode } from '../srs/cardMode';
import { DEFAULT_FSRS_CONFIG, type FsrsConfig } from '../srs/config';
import { startOfStudyDay } from '../srs/dayBoundary';
import { formatNextDueLabel as formatNextDueTimestampLabel } from '../srs/nextDue';
import { previewSchedule, reviewSentence, schedulerStateFrom } from '../srs/scheduler';
import {
  applyPracticeGrade,
  createPracticeSessionState,
  type PracticeSessionState,
  type SessionBuildOptions,
} from '../srs/session';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import type { TextToSpeechEngine } from '../tts/textToSpeech';
import { getSpeechEngine } from '../tts/textToSpeech';
import { useSpeechPlayback } from '../tts/useSpeechPlayback';
import { describeError } from '../utils/describeError';

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: SCREEN_TOP_SPACING,
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
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    progress: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
      marginBottom: 12,
    },
    cardBody: {
      gap: 14,
    },
    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 18,
      gap: 14,
    },
    cardLabel: {
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: c.textMuted,
    },
    promptText: {
      fontSize: 16,
      lineHeight: 23,
      color: c.textPrimary,
    },
    situationText: {
      fontSize: 17,
      lineHeight: 24,
      fontWeight: '600',
      color: c.textPrimary,
    },
    meaningText: {
      fontSize: 14,
      lineHeight: 20,
      color: c.textSecondary,
      fontStyle: 'italic',
    },
    contextBlock: {
      gap: 4,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    contextLabel: {
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: c.textMuted,
    },
    answerBlock: {
      gap: 4,
      paddingVertical: 9,
      paddingHorizontal: 10,
      borderRadius: 10,
      backgroundColor: c.accentSoft,
    },
    answerText: {
      fontSize: 16,
      fontWeight: '600',
      lineHeight: 23,
      color: c.textPrimary,
    },
    recallHint: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textMuted,
    },
    replayButton: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 8,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: c.background,
    },
    replayText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
    },
    input: {
      backgroundColor: c.background,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      minHeight: 46,
      fontSize: 16,
      color: c.textPrimary,
    },
    primaryButton: {
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 16,
      backgroundColor: c.primary,
    },
    primaryButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.onPrimary,
    },
    secondaryButton: {
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    secondaryButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    linkButton: {
      alignSelf: 'flex-start',
      paddingVertical: 4,
    },
    linkButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.accent,
    },
    disabled: {
      opacity: 0.45,
    },
    pressedFade: {
      opacity: 0.9,
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
    suggestion: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textSecondary,
    },
    error: {
      color: c.errorText,
      fontSize: 13,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      paddingHorizontal: SCREEN_GUTTER,
    },
    stateTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
      textAlign: 'center',
    },
    stateText: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
      paddingHorizontal: 24,
      lineHeight: 20,
    },
    retryText: {
      color: c.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    summary: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 20,
      gap: 10,
    },
    summaryTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    summaryValue: {
      fontSize: 15,
      color: c.textSecondary,
    },
    summaryActions: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 4,
    },
    summaryAction: {
      flex: 1,
    },
  });
}

/**
 * Human-readable "when is the next card due" line for the caught-up state. Only
 * non-suspended sentences count; an empty topic yields null and the caller
 * shows its own copy.
 */
export function formatNextDueLabel(sentences: readonly SentenceRecord[], now: Date): string | null {
  return formatNextDueTimestampLabel(
    sentences.filter(sentence => !sentence.suspended).map(sentence => Date.parse(sentence.due_at)),
    now,
  );
}

function diffTokenStyle(kind: DiffKind, colors: ThemeColors): TextStyle {
  switch (kind) {
    case 'correct':
      return { color: colors.success };
    case 'missing':
      return { color: colors.danger };
    case 'extra':
      return { color: colors.warning, textDecorationLine: 'line-through' };
    case 'substituted':
      return { color: colors.danger, textDecorationLine: 'underline' };
  }
}

function diffSummary(segments: readonly DiffSegment[]): string {
  const summary = summarizeDiff(segments);
  const parts: string[] = [];
  if (summary.correct > 0) {
    parts.push(`${summary.correct} correct`);
  }
  if (summary.missing > 0) {
    parts.push(`${summary.missing} missing`);
  }
  if (summary.substituted > 0) {
    parts.push(`${summary.substituted} substituted`);
  }
  if (summary.extra > 0) {
    parts.push(`${summary.extra} extra`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Nothing typed yet.';
}

interface SentencePracticeScreenInternalProps extends SentencePracticeScreenProps {
  /** TTS seam; defaults to the active engine from the registry. */
  speech?: TextToSpeechEngine;
}

export function SentencePracticeScreen({
  navigation,
  route,
  speech = getSpeechEngine(),
}: SentencePracticeScreenInternalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const topicId = route.params.topicId;

  const [topic, setTopic] = useState<SentenceTopicRecord | null>(null);
  const [allSentences, setAllSentences] = useState<SentenceRecord[]>([]);
  const [session, setSession] = useState<PracticeSessionState<SentenceRecord>>({
    queue: [],
  });
  const [practiceMode, setPracticeMode] = useState<PracticeMode>('auto');
  const [config, setConfig] = useState<FsrsConfig>(DEFAULT_FSRS_CONFIG);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [reviewedCount, setReviewedCount] = useState(0);
  const [gradeCounts, setGradeCounts] = useState<GradeCounts>(EMPTY_GRADE_COUNTS);
  const [presentationKey, setPresentationKey] = useState(0);

  const [answer, setAnswer] = useState('');
  const [diff, setDiff] = useState<DiffSegment[] | null>(null);
  const [suggested, setSuggested] = useState<ReviewGrade | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [meaningVisible, setMeaningVisible] = useState(false);
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

  const loadSession = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    try {
      const db = await getLocalDatabase();
      const [mode, record, sentences, srsConfig] = await Promise.all([
        loadPracticeMode(),
        getSentenceTopicById(db, topicId),
        listSentencesByTopic(db, topicId),
        getSrsConfig(db),
      ]);
      if (!record) {
        throw new Error('This topic no longer exists.');
      }
      // Anki's daily deck limits: what the review log consumed since the study
      // day started is subtracted from the topic's per-day settings.
      const dayStartIso = startOfStudyDay(new Date(), srsConfig.rolloverHour).toISOString();
      const [newIntroduced, reviewsDone] = await Promise.all([
        countNewSentencesIntroducedToday(db, topicId, dayStartIso),
        countSentenceReviewsToday(db, topicId, dayStartIso),
      ]);
      sessionLimitsRef.current = {
        maxCards: record.max_session_cards,
        learnAheadMinutes: record.learn_ahead_minutes,
        newRemaining: record.new_cards_per_day - newIntroduced,
        reviewRemaining: record.max_reviews_per_day - reviewsDone,
      };
      setTopic(record);
      setPracticeMode(mode);
      setConfig(srsConfig);
      setAllSentences(sentences);
      setSession(createPracticeSessionState(sentences, new Date(), sessionLimitsRef.current));
      setReviewedCount(0);
      setGradeCounts(EMPTY_GRADE_COUNTS);
      setPresentationKey(key => key + 1);
      setAnswer('');
      setDiff(null);
      setSuggested(null);
      setRevealed(false);
      setMeaningVisible(false);
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [topicId]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // A pushed screen can lose focus while a sentence is still being spoken;
  // unmount silence alone would let audio continue behind the next screen.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('blur', () => {
      stop();
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, stop]);

  const currentCard = session.queue[0] ?? null;
  const currentMode: ReviewCardMode | null = currentCard
    ? selectCardMode(currentCard.state, practiceMode)
    : null;

  // Anki shows what each button will do before the answer is committed. The
  // preview is computed at render time from the same pure scheduler used to
  // save the review, so the labels can never disagree with the stored result.
  const previews = useMemo(() => {
    if (!currentCard) {
      return {} as Partial<Record<ReviewGrade, string>>;
    }
    const labels: Partial<Record<ReviewGrade, string>> = {};
    for (const preview of previewSchedule(schedulerStateFrom(currentCard), new Date(), config)) {
      labels[preview.grade] = preview.label;
    }
    return labels;
  }, [currentCard, config]);

  // Dictation cards speak once when they appear. `presentationKey` makes a
  // requeued card re-play even when it is the only card in the session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: presentationKey is an intentional re-play trigger
  useEffect(() => {
    if (!currentCard || selectCardMode(currentCard.state, practiceMode) !== 'dictation') {
      return;
    }
    speak(currentCard.id, currentCard.text);
  }, [currentCard, presentationKey, practiceMode, speak]);

  // Whatever the card shape, moving to the next card (or leaving the screen)
  // must silence the previous utterance first — including a recall answer that
  // was played by an explicit reveal.
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
      // Keep the keyboard up and the answer input focused so the learner can
      // keep typing while the sentence plays; the surrounding scroll view uses
      // `keyboardShouldPersistTaps="handled"` so the tap does not steal focus.
      speak(currentCard.id, currentCard.text);
    }
  }, [currentCard, speak]);

  const handleCheck = useCallback(() => {
    if (!currentCard) {
      return;
    }
    Keyboard.dismiss();
    setDiff(diffTokens(currentCard.text, answer));
    setSuggested(suggestGrade(currentCard.text, answer));
  }, [currentCard, answer]);

  const handleReveal = useCallback(() => {
    if (!currentCard) {
      return;
    }
    setRevealed(true);
    speak(currentCard.id, currentCard.text);
  }, [currentCard, speak]);

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
        const cardMode = selectCardMode(currentCard.state, practiceMode);
        const duration = Math.max(0, Math.min(3_600_000, Date.now() - cardShownAtRef.current));
        const db = await getLocalDatabase();
        await recordSentenceReview(db, {
          sentence_id: currentCard.id,
          topic_id: currentCard.topic_id,
          grade,
          mode: cardMode,
          state: outcome.state,
          log: outcome.log,
          review_duration_ms: duration,
        });
        const updated: SentenceRecord = {
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
        setAllSentences(previous =>
          previous.map(sentence => (sentence.id === updated.id ? updated : sentence)),
        );
        setSession(previous => applyPracticeGrade(previous, grade, updated));
        setReviewedCount(count => count + 1);
        setGradeCounts(counts => ({ ...counts, [grade]: counts[grade] + 1 }));
        setPresentationKey(key => key + 1);
        setAnswer('');
        setDiff(null);
        setSuggested(null);
        setRevealed(false);
        setMeaningVisible(false);
      } catch (err) {
        setActionError(`Could not save this review: ${describeError(err)}`);
      } finally {
        gradingRef.current = false;
        setSaving(false);
      }
    },
    [currentCard, practiceMode, config],
  );

  const handleReviewAgain = useCallback(() => {
    loadSession();
  }, [loadSession]);

  const nextDueLabel = formatNextDueLabel(allSentences, new Date());
  // The same limits the session was built with (including the daily quotas
  // consumed so far) decide whether "Review again" has anything to show.
  const hasRemainingDue =
    allSentences.length > 0 &&
    createPracticeSessionState(allSentences, new Date(), {
      ...sessionLimitsRef.current,
      maxCards: 1,
    }).queue.length > 0;

  const sessionFinished = !loading && !loadError && currentCard === null;
  const showGradeButtons = currentMode === 'dictation' ? diff !== null : revealed;

  return (
    <Screen style={styles.container} testID="sentence-practice-screen">
      <ScreenHeader style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to topic"
          testID="sentence-practice-back"
          onPress={() => navigation.goBack()}
          style={styles.backLinkButton}>
          <Text style={styles.backLinkText}>‹ Topic</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1} testID="sentence-practice-title">
          {topic ? topic.title : 'Practice'}
        </Text>
      </ScreenHeader>

      {loading ? (
        <View style={styles.centered} testID="sentence-practice-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loadError ? (
        <View style={styles.centered} testID="sentence-practice-load-error">
          <Text role="alert" style={styles.stateText}>
            {loadError}
          </Text>
          <Pressable testID="sentence-practice-retry" onPress={loadSession}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : sessionFinished && reviewedCount === 0 ? (
        <View style={styles.centered} testID="sentence-practice-empty">
          <Text style={styles.stateTitle}>All caught up</Text>
          <Text style={styles.stateText}>
            No cards are due right now. Come back when the next sentence is scheduled.
          </Text>
          {nextDueLabel ? (
            <Text style={styles.stateText} testID="sentence-practice-next-due">
              {nextDueLabel}
            </Text>
          ) : null}
        </View>
      ) : sessionFinished ? (
        <ScreenScrollView testID="sentence-practice-summary">
          <View style={styles.summary}>
            <Text style={styles.summaryTitle}>Session complete</Text>
            <Text style={styles.summaryValue} testID="sentence-practice-reviewed">
              {reviewedCount} card{reviewedCount === 1 ? '' : 's'} reviewed
            </Text>
            <Text style={styles.summaryValue} testID="sentence-practice-grades">
              Again {gradeCounts.again} · Hard {gradeCounts.hard} · Good {gradeCounts.good} · Easy{' '}
              {gradeCounts.easy}
            </Text>
            {hasRemainingDue ? (
              <Text style={styles.summaryValue} testID="sentence-practice-more-due">
                More sentences are due now.
              </Text>
            ) : (
              <Text style={styles.summaryValue} testID="sentence-practice-nothing-due">
                Nothing else is due right now.
              </Text>
            )}
            <View style={styles.summaryActions}>
              {hasRemainingDue ? (
                <Pressable
                  accessibilityRole="button"
                  testID="sentence-practice-review-again"
                  onPress={handleReviewAgain}
                  style={({ pressed }) => [
                    styles.summaryAction,
                    styles.primaryButton,
                    pressed && styles.pressedFade,
                  ]}>
                  <Text style={styles.primaryButtonText}>Review again</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                testID="sentence-practice-back-to-topic"
                onPress={() => navigation.goBack()}
                style={({ pressed }) => [
                  styles.summaryAction,
                  styles.secondaryButton,
                  pressed && styles.pressedFade,
                ]}>
                <Text style={styles.secondaryButtonText}>Back to topic</Text>
              </Pressable>
            </View>
          </View>
        </ScreenScrollView>
      ) : currentCard && currentMode ? (
        <ScreenScrollView
          contentContainerStyle={styles.cardBody}
          keyboardShouldPersistTaps="handled">
          <Text style={styles.progress} testID="sentence-practice-progress">
            {reviewedCount + 1} / {reviewedCount + session.queue.length}
          </Text>

          {currentMode === 'dictation' ? (
            <View style={styles.card} testID="sentence-dictation-card">
              <Text style={styles.cardLabel}>Listen and type</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Replay the sentence"
                testID="sentence-practice-replay"
                onPress={handleReplay}
                style={({ pressed }) => [styles.replayButton, pressed && styles.pressedFade]}>
                <Icon
                  name="speaker"
                  size={20}
                  color={speakingId === currentCard.id ? colors.primary : colors.textSecondary}
                />
                <Text style={styles.replayText}>
                  {speakingId === currentCard.id ? 'Playing…' : 'Replay'}
                </Text>
              </Pressable>

              <TextInput
                accessibilityLabel="Type the sentence you heard"
                placeholder="Type what you heard"
                value={answer}
                onChangeText={setAnswer}
                editable={diff === null && !saving}
                style={styles.input}
                testID="sentence-dictation-input"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleCheck}
              />

              {diff === null ? (
                <Pressable
                  accessibilityRole="button"
                  testID="sentence-dictation-check"
                  onPress={handleCheck}
                  disabled={saving}
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.pressedFade]}>
                  <Text style={styles.primaryButtonText}>Check</Text>
                </Pressable>
              ) : (
                <>
                  <View style={styles.diffRow} testID="sentence-diff">
                    {diffDisplayTokens(diff).map((token, index) => (
                      <Text
                        // biome-ignore lint/suspicious/noArrayIndexKey: diff tokens are positional
                        key={`${token.kind}-${index}`}
                        accessibilityLabel={
                          token.expected
                            ? `${token.kind}: ${token.text}, expected ${token.expected}`
                            : `${token.kind}: ${token.text}`
                        }
                        style={[styles.diffToken, diffTokenStyle(token.kind, colors)]}
                        testID={`sentence-diff-token-${index}`}>
                        {token.kind === 'substituted' && token.expected
                          ? `${token.text} → ${token.expected}`
                          : token.text}
                      </Text>
                    ))}
                  </View>
                  <View style={styles.answerBlock} testID="sentence-dictation-answer-block">
                    <Text style={styles.contextLabel}>Correct sentence</Text>
                    <Text style={styles.answerText} selectable testID="sentence-dictation-answer">
                      {currentCard.text}
                    </Text>
                  </View>
                  <Text style={styles.diffSummary} testID="sentence-diff-summary">
                    {diffSummary(diff)}
                  </Text>
                  <Text style={styles.suggestion} testID="sentence-suggested-grade">
                    Suggested: {suggested === 'good' ? 'Good' : 'Again'}
                  </Text>
                </>
              )}

              {diff !== null && (currentCard.meaning || currentCard.situation) ? (
                <View style={styles.contextBlock} testID="sentence-dictation-context">
                  {currentCard.meaning ? (
                    <>
                      <Text style={styles.contextLabel}>Meaning</Text>
                      <Text
                        style={styles.meaningText}
                        selectable
                        testID="sentence-dictation-meaning">
                        {currentCard.meaning}
                      </Text>
                    </>
                  ) : null}
                  {currentCard.situation ? (
                    <>
                      <Text style={styles.contextLabel}>Situation</Text>
                      <Text
                        style={styles.situationText}
                        selectable
                        testID="sentence-dictation-situation">
                        {currentCard.situation}
                      </Text>
                    </>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : (
            <View style={styles.card} testID="sentence-recall-card">
              <Text style={styles.cardLabel}>Recall the sentence</Text>
              <Text style={styles.contextLabel}>Situation</Text>
              <Text style={styles.situationText} selectable testID="sentence-recall-situation">
                {currentCard.situation || 'No situation was saved for this sentence.'}
              </Text>
              <Text style={styles.recallHint}>
                Say the English sentence a native speaker would use in this situation.
              </Text>

              <Pressable
                accessibilityRole="button"
                testID="sentence-recall-show-meaning"
                onPress={() => setMeaningVisible(value => !value)}
                style={styles.linkButton}>
                <Text style={styles.linkButtonText}>
                  {meaningVisible ? 'Hide meaning' : 'Show meaning'}
                </Text>
              </Pressable>
              {meaningVisible ? (
                <Text style={styles.meaningText} selectable testID="sentence-recall-meaning">
                  {currentCard.meaning || 'No meaning was saved.'}
                </Text>
              ) : null}

              {revealed ? (
                <>
                  <Text style={styles.promptText} testID="sentence-recall-answer">
                    {currentCard.text}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Replay the sentence"
                    testID="sentence-practice-replay"
                    onPress={handleReplay}
                    style={({ pressed }) => [styles.replayButton, pressed && styles.pressedFade]}>
                    <Icon
                      name="speaker"
                      size={20}
                      color={speakingId === currentCard.id ? colors.primary : colors.textSecondary}
                    />
                    <Text style={styles.replayText}>
                      {speakingId === currentCard.id ? 'Playing…' : 'Replay'}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  testID="sentence-recall-reveal"
                  onPress={handleReveal}
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.pressedFade]}>
                  <Text style={styles.primaryButtonText}>Reveal answer</Text>
                </Pressable>
              )}
            </View>
          )}

          {actionError ? (
            <Text role="alert" style={styles.error} testID="sentence-practice-action-error">
              {actionError}
            </Text>
          ) : null}

          {showGradeButtons ? (
            <GradeButtons
              suggested={currentMode === 'dictation' ? suggested : null}
              intervals={previews}
              saving={saving}
              onGrade={handleGrade}
              testIDPrefix="sentence-grade"
            />
          ) : null}

          {saving ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        </ScreenScrollView>
      ) : null}
    </Screen>
  );
}
