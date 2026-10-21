/**
 * Spaced-repetition practice for one real-life sentence topic (TASK-SENT-012,
 * SENTENCE_LIVE_V1 §2.3/§2.6).
 *
 * The screen turns the topic's due sentences into a finite session (at most 20
 * cards, oldest due first) and picks each card's shape from the schedule:
 * `new`/`learning` sentences are dictated, `review` sentences are recalled from
 * their situation. A forced practice mode from Settings overrides that mix.
 *
 * Every grade goes through the pure scheduler and is persisted with its review
 * log row in one repository transaction. An `Again` card is appended to the end
 * of the same session every time it is graded, so it keeps returning until the
 * learner grades it Good or Easy (Anki's learning-step behaviour). TTS follows
 * the shared one-playback contract: one utterance at a time, stopped when the
 * card changes, the screen blurs or it unmounts.
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
import { getLocalDatabase } from '../db/database';
import {
  getSentenceTopicById,
  listSentencesByTopic,
  recordSentenceReview,
} from '../db/sentenceRepository';
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
import { scheduleNext, schedulerStateFrom } from '../srs/scheduler';
import {
  applyPracticeGrade,
  createPracticeSessionState,
  type PracticeSessionState,
} from '../srs/session';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import type { TextToSpeechEngine } from '../tts/textToSpeech';
import { getSpeechEngine } from '../tts/textToSpeech';
import { useSpeechPlayback } from '../tts/useSpeechPlayback';

const GRADE_OPTIONS: Array<{ grade: ReviewGrade; label: string }> = [
  { grade: 'again', label: 'Again' },
  { grade: 'good', label: 'Good' },
  { grade: 'easy', label: 'Easy' },
];

type GradeCounts = Record<ReviewGrade, number>;

function emptyGradeCounts(): GradeCounts {
  return { again: 0, good: 0, easy: 0 };
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

/** Local, secret-free description of any thrown value. */
function describeError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  return 'unknown error';
}

/**
 * Human-readable "when is the next card due" line for the caught-up state. Only
 * non-suspended sentences count; an empty topic yields null and the caller
 * shows its own copy.
 */
export function formatNextDueLabel(sentences: readonly SentenceRecord[], now: Date): string | null {
  const pending = sentences
    .filter(sentence => sentence.status !== 'suspended')
    .map(sentence => Date.parse(sentence.due_at))
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

interface GradeButtonsProps {
  suggested: ReviewGrade | null;
  saving: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onGrade: (grade: ReviewGrade) => void;
}

function GradeButtons({ suggested, saving, colors, styles, onGrade }: GradeButtonsProps) {
  return (
    <View style={styles.gradeRow}>
      {GRADE_OPTIONS.map(option => {
        const isSuggested = suggested === option.grade;
        return (
          <Pressable
            key={option.grade}
            accessibilityRole="button"
            accessibilityLabel={`Grade ${option.label}`}
            accessibilityState={{ disabled: saving, selected: isSuggested }}
            testID={`sentence-grade-${option.grade}`}
            disabled={saving}
            onPress={() => onGrade(option.grade)}
            style={({ pressed }) => [
              styles.gradeButton,
              isSuggested && styles.gradeButtonSuggested,
              pressed && styles.pressedFade,
            ]}>
            <Text
              style={[
                styles.gradeText,
                { color: isSuggested ? colors.primary : colors.textPrimary },
              ]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
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
  const [session, setSession] = useState<PracticeSessionState>({
    queue: [],
  });
  const [practiceMode, setPracticeMode] = useState<PracticeMode>('auto');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [reviewedCount, setReviewedCount] = useState(0);
  const [gradeCounts, setGradeCounts] = useState<GradeCounts>(emptyGradeCounts);
  const [presentationKey, setPresentationKey] = useState(0);

  const [answer, setAnswer] = useState('');
  const [diff, setDiff] = useState<DiffSegment[] | null>(null);
  const [suggested, setSuggested] = useState<ReviewGrade | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [meaningVisible, setMeaningVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const gradingRef = useRef(false);
  const { speakingId, speak, stop } = useSpeechPlayback(speech);

  const loadSession = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    try {
      const db = await getLocalDatabase();
      const [mode, record, sentences] = await Promise.all([
        loadPracticeMode(),
        getSentenceTopicById(db, topicId),
        listSentencesByTopic(db, topicId),
      ]);
      if (!record) {
        throw new Error('This topic no longer exists.');
      }
      setTopic(record);
      setPracticeMode(mode);
      setAllSentences(sentences);
      setSession(createPracticeSessionState(sentences, new Date()));
      setReviewedCount(0);
      setGradeCounts(emptyGradeCounts());
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
    ? selectCardMode(currentCard.status, practiceMode)
    : null;

  // Dictation cards speak once when they appear. `presentationKey` makes a
  // requeued card re-play even when it is the only card in the session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: presentationKey is an intentional re-play trigger
  useEffect(() => {
    if (!currentCard || selectCardMode(currentCard.status, practiceMode) !== 'dictation') {
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

  const handleReplay = useCallback(() => {
    if (currentCard) {
      Keyboard.dismiss();
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
        const nextState = scheduleNext(schedulerStateFrom(currentCard), grade, now);
        const cardMode = selectCardMode(currentCard.status, practiceMode);
        const db = await getLocalDatabase();
        await recordSentenceReview(db, {
          sentence_id: currentCard.id,
          topic_id: currentCard.topic_id,
          grade,
          mode: cardMode,
          state: nextState,
        });
        const updated: SentenceRecord = {
          ...currentCard,
          ...nextState,
          updated_at: nextState.last_reviewed_at,
        };
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
    [currentCard, practiceMode],
  );

  const handleReviewAgain = useCallback(() => {
    loadSession();
  }, [loadSession]);

  const nextDueLabel = formatNextDueLabel(allSentences, new Date());
  const hasRemainingDue =
    allSentences.length > 0 &&
    createPracticeSessionState(allSentences, new Date(), 1).queue.length > 0;

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
              Again {gradeCounts.again} · Good {gradeCounts.good} · Easy {gradeCounts.easy}
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
              saving={saving}
              colors={colors}
              styles={styles}
              onGrade={handleGrade}
            />
          ) : null}

          {saving ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        </ScreenScrollView>
      ) : null}
    </Screen>
  );
}
