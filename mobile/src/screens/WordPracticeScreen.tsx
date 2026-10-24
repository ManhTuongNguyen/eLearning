/**
 * Word practice screen (WORD_BANK_V1 §2.7, TASK-WB-012).
 *
 * Mirrors the sentence practice screen's structure and quality bar: the shared
 * queue selects the due cards (oldest due first, capped at 20, suspended and
 * dataless words excluded), a dictation card for `new`/`learning`/`relearning`
 * words and a meaning-recall card for `review` words.
 *
 * Dictation: the word is spoken once automatically on card open (device TTS)
 * with a replay button; the learner types it; `Check` pre-suggests Good for an
 * exact or one-typo answer (never Easy) and the learner can override; the
 * reveal shows the spelling, IPA and POS labels and replays the word.
 *
 * Recall: the front shows the meanings and examples with the target word
 * masked (first letter + underscores, inflections included — see wordMask);
 * the reveal plays the word, unmasks everything and shows the full data.
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
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import { SCREEN_GUTTER, Screen, ScreenHeader, ScreenScrollView } from '../components/ScreenLayout';
import { getLocalDatabase } from '../db/database';
import { getSrsConfig } from '../db/srsConfigStore';
import type { ReviewCardMode, ReviewGrade, WordRecord, WordTopicRecord } from '../db/types';
import { getWordTopicById, listWordsByTopic, recordWordReview } from '../db/wordRepository';
import { useApplicationMode } from '../mode/ModeContext';
import type { WordPracticeScreenProps } from '../navigation/types';
import { loadWordPracticeMode, type WordPracticeMode } from '../preferences/wordPracticeMode';
import { selectCardMode } from '../srs/cardMode';
import { DEFAULT_FSRS_CONFIG, type FsrsConfig } from '../srs/config';
import {
  diffDisplayTokens,
  diffTokens,
  suggestGrade,
  summarizeDiff,
  type DiffKind,
  type DiffSegment,
} from '../srs/answerCheck';
import { maskWordInText } from '../srs/wordMask';
import {
  previewSchedule,
  reviewSentence,
  schedulerStateFrom,
  type GradePreview,
} from '../srs/scheduler';
import {
  applyWordPracticeGrade,
  createWordPracticeSessionState,
  type PracticeSessionState,
  MAX_PRACTICE_SESSION_CARDS,
} from '../srs/session';
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

function diffTokenStyle(kind: DiffKind, colors: ThemeColors): TextStyle {
  switch (kind) {
    case 'correct':
      return { color: colors.success };
    case 'missing':
      return { color: colors.danger };
    case 'extra':
      return { color: colors.warning, textDecorationLine: 'line-through' };
    case 'substituted':
      return { color: colors.warning };
  }
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
    senseGroup: {
      gap: 6,
    },
    posLabel: {
      fontSize: 13,
      fontWeight: '700',
      color: c.accent,
      fontStyle: 'italic',
    },
    definition: {
      fontSize: 16,
      lineHeight: 22,
      color: c.textPrimary,
    },
    example: {
      fontSize: 14,
      lineHeight: 20,
      color: c.textMuted,
      fontStyle: 'italic',
      marginLeft: 12,
    },
    maskedSegment: {
      letterSpacing: 2,
      fontWeight: '700',
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
    buttonLabel: {
      fontSize: 11,
      fontWeight: '600',
      color: c.textMuted,
    },
    primaryButtonLabel: {
      fontSize: 11,
      fontWeight: '600',
      color: c.onPrimary,
    },
    againButton: {
      backgroundColor: c.danger,
      borderColor: c.danger,
    },
    againButtonText: {
      color: c.onPrimary,
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
  const [diff, setDiff] = useState<DiffSegment[] | null>(null);
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
      setTopic(topicRecord);
      setAllWords(words);
      setPracticeMode(storedMode);
      setConfig(srsConfig);
      setSession(createWordPracticeSessionState(words, new Date(), MAX_PRACTICE_SESSION_CARDS));
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
    setDiff(diffTokens(currentCard.text, answer));
    setSuggested(suggestGrade(currentCard.text, answer));
  }, [currentCard, answer]);

  const handleReveal = useCallback(() => {
    if (!currentCard) {
      return;
    }
    setRevealed(true);
    // The reveal also grades the typed answer, so the pre-suggested ✓ shows
    // on the buttons; the learner can still override it.
    setDiff(diffTokens(currentCard.text, answer));
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
        setAllWords(previous =>
          previous.map(word => (word.id === updated.id ? updated : word)),
        );
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
  const hasRemainingDue =
    allWords.length > 0 &&
    createWordPracticeSessionState(allWords, new Date(), 1).queue.length > 0;
  const showGradeButtons = cardMode === 'dictation' ? diff !== null : revealed;

  /** The masked front of the recall card: every sense rendered through wordMask. */
  const renderMaskedSenses = (word: WordRecord) =>
    word.senses_json.map((sense, senseIndex) => (
      <View
        // biome-ignore lint/suspicious/noArrayIndexKey: sense groups render positionally
        key={`${sense.partOfSpeech}-${senseIndex}`}
        style={styles.senseGroup}>
        <Text style={styles.posLabel}>{sense.partOfSpeech}</Text>
        {sense.definitions.map((definition, definitionIndex) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: definitions render positionally
            key={definitionIndex}>
            <Text style={styles.definition}>
              {maskWordInText(definition.definition, word.text).map((segment, segmentIndex) =>
                segment.kind === 'masked' ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: mask segments are positional
                  <Text key={segmentIndex} style={styles.maskedSegment}>
                    {segment.text}
                  </Text>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: mask segments are positional
                  <Text key={segmentIndex}>{segment.text}</Text>
                ),
              )}
            </Text>
            {definition.example ? (
              <Text style={styles.example}>
                {maskWordInText(definition.example, word.text).map((segment, segmentIndex) =>
                  segment.kind === 'masked' ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: mask segments are positional
                    <Text key={segmentIndex} style={styles.maskedSegment}>
                      {segment.text}
                    </Text>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: mask segments are positional
                    <Text key={segmentIndex}>{segment.text}</Text>
                  ),
                )}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    ));

  return (
    <Screen style={styles.container} testID="word-practice-screen">
      <ScreenHeader style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to topic"
          testID="word-practice-back"
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.button, { flex: 0, borderWidth: 0, backgroundColor: 'transparent' }, pressed && styles.pressedFade]}>
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
                  createWordPracticeSessionState(allWords, new Date(), MAX_PRACTICE_SESSION_CARDS),
                );
                setPresentationKey(key => key + 1);
              }}
              style={({ pressed }) => [styles.button, styles.primaryButton, pressed && styles.pressedFade]}>
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
                  style={({ pressed }) => [styles.button, { flex: 0, alignSelf: 'center', paddingHorizontal: 20 }, pressed && styles.pressedFade]}>
                  <Icon name={speakingId === currentCard.id ? 'speaker' : 'play'} color={colors.accent} />
                </Pressable>
                <TextInput
                  value={answer}
                  onChangeText={setAnswer}
                  style={styles.answerInput}
                  testID="word-practice-answer"
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Type the word you hear"
                />
                {diff !== null ? (
                  <View testID="word-practice-diff">
                    <Text style={styles.definition}>
                      {diffDisplayTokens(diff).map((token, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: diff tokens are positional
                        <Text key={index} style={diffTokenStyle(token.kind, colors)}>
                          {token.text}{' '}
                        </Text>
                      ))}
                    </Text>
                  </View>
                ) : null}
                {diff !== null ? (
                  <View>
                    <Text style={styles.definition} testID="word-practice-correct-word">
                      {currentCard.text}
                    </Text>
                    {currentCard.phonetics_json.length > 0 ? (
                      <Text style={styles.phonetics}>{currentCard.phonetics_json.join('  ')}</Text>
                    ) : null}
                    <View style={{ gap: 6 }}>
                      {currentCard.senses_json.map((sense, index) => (
                        <View
                          // biome-ignore lint/suspicious/noArrayIndexKey: sense groups render positionally
                          key={`${sense.partOfSpeech}-${index}`}
                          style={styles.senseGroup}>
                          <Text style={styles.posLabel}>{sense.partOfSpeech}</Text>
                          {sense.definitions.slice(0, 1).map((definition, definitionIndex) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: definitions render positionally
                            <Text key={definitionIndex} style={styles.definition}>
                              {definition.definition}
                            </Text>
                          ))}
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null}
              </>
            ) : (
              <>
                <Text style={styles.modeLabel}>Recall — which word is this?</Text>
                <View testID="word-practice-recall-front">{renderMaskedSenses(currentCard)}</View>
                <TextInput
                  value={answer}
                  onChangeText={setAnswer}
                  style={styles.answerInput}
                  testID="word-practice-answer"
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Type the word"
                />
                {revealed ? (
                  <View testID="word-practice-recall-reveal">
                    <Text style={styles.wordText}>{currentCard.text}</Text>
                    {currentCard.phonetics_json.length > 0 ? (
                      <Text style={styles.phonetics}>{currentCard.phonetics_json.join('  ')}</Text>
                    ) : null}
                    <View style={{ gap: 10 }}>
                      {currentCard.senses_json.map((sense, index) => (
                        <View
                          // biome-ignore lint/suspicious/noArrayIndexKey: sense groups render positionally
                          key={`${sense.partOfSpeech}-${index}`}
                          style={styles.senseGroup}>
                          <Text style={styles.posLabel}>{sense.partOfSpeech}</Text>
                          {sense.definitions.map((definition, definitionIndex) => (
                            <View
                              // biome-ignore lint/suspicious/noArrayIndexKey: definitions render positionally
                              key={definitionIndex}>
                              <Text style={styles.definition}>{definition.definition}</Text>
                              {definition.example ? (
                                <Text style={styles.example}>{definition.example}</Text>
                              ) : null}
                            </View>
                          ))}
                        </View>
                      ))}
                    </View>
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
              <View style={styles.buttonRow}>
                {previews.map(preview => {
                  const isSuggested = suggested === preview.grade;
                  const gradeStyle =
                    preview.grade === 'again'
                      ? [styles.button, styles.againButton]
                      : [styles.button];
                  const textStyle =
                    preview.grade === 'again' ? [styles.buttonText, styles.againButtonText] : [styles.buttonText];
                  return (
                    <Pressable
                      key={preview.grade}
                      accessibilityRole="button"
                      accessibilityLabel={`${preview.grade} — schedules ${preview.label}`}
                      testID={`word-practice-grade-${preview.grade}`}
                      onPress={() => {
                        // handleGrade handles its own errors, so it never rejects.
                        handleGrade(preview.grade);
                      }}
                      disabled={saving}
                      style={({ pressed }) => [
                        ...gradeStyle,
                        saving && styles.buttonDisabled,
                        pressed && styles.pressedFade,
                      ]}>
                      <Text style={textStyle}>
                        {preview.grade}
                        {isSuggested ? ' ✓' : ''}
                      </Text>
                      <Text style={styles.buttonLabel}>{preview.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {diff !== null ? (
              <Text style={styles.stateText} testID="word-practice-suggestion">
                {summarizeDiff(diff).correct === diff.length
                  ? 'Exact match.'
                  : 'Close — check the marked words.'}
              </Text>
            ) : null}
          </View>
        </ScreenScrollView>
      ) : null}
    </Screen>
  );
}
