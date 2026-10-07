/**
 * Listening-practice trainer (numbers and letters, no backend, no AI).
 *
 * Reflex loop: the app speaks a word form through the device TTS engine
 * ("nineteen ninety-seven", "b"), the user picks the matching digits or
 * letter from four engineered, acoustically confusable options (13 ↔ 30,
 * 1997 ↔ 9719, B/D/P/T) and sees instant feedback with a live running
 * score. The flow is endless — the next question is always ready — and an
 * explicit button ends the practice and reveals the session summary.
 *
 * Questions come from the pure, deterministic generator in
 * ../practice/questionBank. Speech goes through the shared getSpeechEngine()
 * seam (the same one chat playback uses), so the native Android engine
 * swaps in behind it without this screen knowing.
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
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  createPracticeQuestion,
  PRACTICE_RECENT_ANSWER_LIMIT,
  type PracticeMode,
  type PracticeQuestion,
} from '../practice/questionBank';
import type {PracticeScreenProps} from '../navigation/types';
import {getSpeechEngine} from '../tts/textToSpeech';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

const MODE_OPTIONS: Array<{
  value: PracticeMode;
  label: string;
  testID: string;
}> = [
  {value: 'numbers', label: 'Numbers', testID: 'practice-mode-numbers'},
  {value: 'letters', label: 'Letters', testID: 'practice-mode-letters'},
  {value: 'mixed', label: 'Mixed', testID: 'practice-mode-mixed'},
];

const QUESTION_PROMPT: Record<PracticeMode, string> = {
  numbers: 'Tap play, then choose the digits you heard.',
  letters: 'Tap play, then choose the letter you heard.',
  mixed: 'Tap play, then choose the number or letter you heard.',
};

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingHorizontal: 24,
      // Same 16px header spacing as the other pushed screens.
      paddingTop: 16,
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
    scoreRow: {
      flexDirection: 'row',
      gap: 12,
      marginBottom: 12,
    },
    scoreCard: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 10,
      alignItems: 'center',
    },
    scoreValue: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    scoreLabel: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    segmentRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 12,
    },
    segment: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 10,
      alignItems: 'center',
    },
    segmentSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    segmentText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
    },
    questionCard: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 20,
      alignItems: 'center',
      gap: 12,
      marginBottom: 12,
    },
    playButton: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // A drawn triangle instead of the ▶ glyph: the glyph carries
    // font-dependent whitespace that left it sitting off-center inside the
    // circle. The small left margin shifts the visual mass onto the
    // circle's optical center.
    playTriangle: {
      width: 0,
      height: 0,
      borderLeftWidth: 16,
      borderTopWidth: 10,
      borderBottomWidth: 10,
      borderLeftColor: c.onPrimary,
      borderTopColor: 'transparent',
      borderBottomColor: 'transparent',
      marginLeft: 4,
    },
    restartButton: {
      width: 84,
      height: 84,
      borderRadius: 42,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    restartIcon: {
      fontSize: 32,
      color: c.onPrimary,
    },
    replayHint: {
      fontSize: 13,
      color: c.textMuted,
      textAlign: 'center',
    },
    scrollContent: {
      paddingBottom: 8,
    },
    prompt: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
    },
    optionsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      justifyContent: 'center',
      marginBottom: 16,
    },
    option: {
      flexGrow: 1,
      flexBasis: '45%',
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 18,
      alignItems: 'center',
    },
    optionSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    optionText: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    optionTextSelected: {
      color: c.accent,
    },
    optionCorrect: {
      borderColor: c.success,
      backgroundColor: c.accentSoft,
    },
    optionWrong: {
      borderColor: c.danger,
    },
    optionTextCorrect: {
      color: c.success,
    },
    optionTextWrong: {
      color: c.danger,
    },
    // Fixed-height slot for the prompt / reveal + feedback lines: the card
    // keeps the same height before and after an answer instead of growing
    // by a line when the result appears. Sized for one reveal line plus a
    // two-line feedback; overflow-hidden guarantees the budget holds.
    resultArea: {
      height: 64,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
      overflow: 'hidden',
    },
    reveal: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
      textAlign: 'center',
    },
    endButton: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
      marginBottom: 24,
    },
    endButtonText: {
      color: c.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    summary: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 20,
      alignItems: 'center',
      gap: 8,
    },
    summaryTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    summaryScore: {
      fontSize: 15,
      color: c.textSecondary,
    },
  });
}

/** Feedback line shown after an answer (kept short to stay on one line). */
function feedbackText(correct: boolean): string {
  return correct ? 'Correct!' : 'Not quite — see the highlighted option.';
}

export function PracticeScreen({navigation}: PracticeScreenProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [mode, setMode] = useState<PracticeMode>('numbers');
  const [question, setQuestion] = useState<PracticeQuestion | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const [attemptedCount, setAttemptedCount] = useState(0);
  const [ended, setEnded] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  // Sliding window of recent answers, handed back to the generator so the
  // same number/letter never shows up twice in a row.
  const [recentAnswers, setRecentAnswers] = useState<string[]>([]);

  // Latest-ref seams (the app's TASK-048 gotcha pattern): speak/stop and the
  // current question read fresh values from stable callbacks, so screens and
  // effects never re-trigger work when state identity changes.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const questionRef = useRef(question);
  questionRef.current = question;
  const recentAnswersRef = useRef(recentAnswers);
  recentAnswersRef.current = recentAnswers;
  const answeredRef = useRef(answered);
  answeredRef.current = answered;

  /**
   * speakQuestion resolves when playback finishes and never rejects:
   * engine failures clear the visible state instead of crashing, mirroring
   * the useSpeechPlayback contract the chat screen uses. The `alive` guard
   * stops a settled utterance of an unmounted screen from setting state.
   */
  /**
   * speakQuestion resolves when playback finishes and never rejects:
   * engine failures clear the visible state instead of crashing, mirroring
   * the useSpeechPlayback contract the chat screen uses. `isAlive` lets the
   * caller (the auto-play effect) cancel a stale utterance's settlement so
   * an old question can never clear the speaking state of a newer one.
   */
  const speakQuestion = useCallback(
    (target: PracticeQuestion, isAlive: () => boolean = () => true): void => {
      const engine = getSpeechEngine();
      setSpeaking(true);
      setSpeechError(null);
      engine
        .speak(target.spoken)
        .then(() => {
          if (isAlive()) {
            setSpeaking(false);
          }
        })
        .catch(() => {
          if (isAlive()) {
            setSpeaking(false);
            setSpeechError(
              'Speech is not available right now. Check your TTS settings.',
            );
          }
        });
    },
    [],
  );

  /**
   * Loads the next question and resets the per-question UI state. The
   * exclusion window is advanced SYNCHRONOUSLY through the ref — before the
   * new question is generated — so the just-shown item can never repeat,
   * no matter how fast the user taps Next.
   */
  const advance = useCallback(() => {
    const current = questionRef.current;
    if (current !== null) {
      // Record the question in the exclusion window whether it was answered
      // or skipped — nothing should come right back either way.
      recentAnswersRef.current = [
        ...recentAnswersRef.current,
        current.answer,
      ].slice(-PRACTICE_RECENT_ANSWER_LIMIT);
      setRecentAnswers(recentAnswersRef.current);
    }
    setQuestion(
      createPracticeQuestion(
        modeRef.current,
        Math.random,
        recentAnswersRef.current,
      ),
    );
    setSelected(null);
    setAnswered(false);
    setSpeechError(null);
  }, []);

  // Fresh question per mode switch; a stale question from the old mode
  // would confuse the answer options the user is about to see.
  useEffect(() => {
    advance();
  }, [advance, mode]);

  // Auto-play each new question as it appears; replays stay unlimited via
  // the play button. The liveness getter keeps a settled utterance of an
  // already-replaced question from touching the visible speaking state.
  useEffect(() => {
    if (!question) {
      return;
    }
    let alive = true;
    speakQuestion(question, () => alive);
    return () => {
      alive = false;
      getSpeechEngine().stop();
    };
  }, [question, speakQuestion]);

  const handleSelect = useCallback((value: string) => {
    const current = questionRef.current;
    if (!current || answeredRef.current) {
      return;
    }
    answeredRef.current = true;
    setSelected(value);
    setAnswered(true);
    setAttemptedCount(prev => prev + 1);
    if (value === current.answer) {
      setCorrectCount(prev => prev + 1);
    }
  }, []);

  const handleEndPractice = useCallback(() => {
    setEnded(true);
    try {
      getSpeechEngine().stop();
    } catch {
      // Stopping an idle engine is never an error.
    }
  }, []);

  const handleRestart = useCallback(() => {
    setEnded(false);
    setCorrectCount(0);
    setAttemptedCount(0);
    advance();
  }, [advance]);

  useEffect(
    () => () => {
      // Leaving the screen must silence the engine, like every other
      // speech surface.
      getSpeechEngine().stop();
    },
    [],
  );

  const accuracy =
    attemptedCount === 0
      ? null
      : Math.round((correctCount / attemptedCount) * 100);

  const isCorrect =
    question !== null && selected !== null && selected === question.answer;

  if (ended) {
    return (
      <View style={styles.container} testID="practice-screen">
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Go back"
            hitSlop={8}
            onPress={() => navigation.goBack()}
            testID="practice-back">
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Listening practice</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.summary} testID="practice-summary">
          <Text style={styles.summaryTitle}>Practice ended</Text>
          <Text style={styles.summaryScore} testID="practice-summary-score">
            {correctCount} of {attemptedCount} correct
            {accuracy !== null ? ` · ${accuracy}%` : ''}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={handleRestart}
            style={styles.restartButton}
            testID="practice-restart">
            <Text style={styles.restartIcon}>↻</Text>
          </Pressable>
          <Text style={styles.replayHint}>
            Practice again anytime — every round is different.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="practice-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          hitSlop={8}
          onPress={() => navigation.goBack()}
          testID="practice-back">
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Listening practice</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.scoreRow}>
        <View style={styles.scoreCard} testID="practice-correct-card">
          <Text style={styles.scoreValue} testID="practice-correct-count">
            {correctCount}
          </Text>
          <Text style={styles.scoreLabel}>Correct</Text>
        </View>
        <View style={styles.scoreCard} testID="practice-attempted-card">
          <Text style={styles.scoreValue} testID="practice-attempted-count">
            {attemptedCount}
          </Text>
          <Text style={styles.scoreLabel}>Answered</Text>
        </View>
        <View style={styles.scoreCard} testID="practice-accuracy-card">
          <Text style={styles.scoreValue} testID="practice-accuracy">
            {accuracy === null ? '–' : `${accuracy}%`}
          </Text>
          <Text style={styles.scoreLabel}>Accuracy</Text>
        </View>
      </View>

      <View style={styles.segmentRow}>
        {MODE_OPTIONS.map(option => {
          const isSelected = option.value === mode;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{checked: isSelected}}
              onPress={() => setMode(option.value)}
              style={[styles.segment, isSelected && styles.segmentSelected]}
              testID={option.testID}>
              <Text style={styles.segmentText}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.questionCard}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              speaking ? 'Speaking' : 'Play the number or letter'
            }
            accessibilityState={{busy: speaking}}
            onPress={() => {
              if (question) {
                speakQuestion(question);
              }
            }}
            disabled={speaking}
            style={styles.playButton}
            testID="practice-play">
            {speaking ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <View style={styles.playTriangle} />
            )}
          </Pressable>
          <Text style={styles.replayHint}>Replay as many times as you need.</Text>
          {/* Fixed-height result slot: answering swaps the prompt for the
              reveal + feedback lines inside the same box, so the card never
              changes height after an answer. The error line lives in the
              same slot and yields to the reveal once answered — the result
              is the info that matters then. */}
          <View style={styles.resultArea}>
            {answered && question ? (
              <>
                <Text
                  numberOfLines={1}
                  style={styles.reveal}
                  testID="practice-reveal">
                  {`It was ${question.answer} — "${question.spoken}"`}
                </Text>
                <Text
                  numberOfLines={2}
                  style={[
                    styles.reveal,
                    {color: isCorrect ? colors.success : colors.danger},
                  ]}
                  testID="practice-feedback">
                  {feedbackText(isCorrect)}
                </Text>
              </>
            ) : speechError ? (
              <Text
                role="alert"
                style={styles.reveal}
                testID="practice-speech-error">
                {speechError}
              </Text>
            ) : (
              <Text numberOfLines={2} style={styles.prompt}>
                {QUESTION_PROMPT[mode]}
              </Text>
            )}
          </View>
        </View>

        <View style={styles.optionsRow}>
          {(question?.options ?? []).map(option => {
            const isSelected = option === selected;
            const isAnswer = question !== null && option === question.answer;
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{checked: isSelected}}
                disabled={answered}
                onPress={() => handleSelect(option)}
                style={[
                  styles.option,
                  isSelected && styles.optionSelected,
                  answered && isAnswer && styles.optionCorrect,
                  answered && isSelected && !isAnswer && styles.optionWrong,
                ]}
                testID={`practice-option-${option}`}>
                <Text
                  style={[
                    styles.optionText,
                    isSelected && styles.optionTextSelected,
                    answered && isAnswer && styles.optionTextCorrect,
                    answered && isSelected && !isAnswer && styles.optionTextWrong,
                  ]}>
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={advance}
          style={styles.endButton}
          testID="practice-next">
          <Text style={styles.endButtonText}>Next question</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End practice"
          onPress={handleEndPractice}
          style={styles.endButton}
          testID="practice-end">
          <Text style={styles.endButtonText}>End practice</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
