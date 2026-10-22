/**
 * Listening-practice trainer (numbers and letters, no backend, no AI).
 *
 * Reflex loop: the app speaks a word form through the device TTS engine
 * ("nineteen ninety-seven", "b"), the learner either picks the matching
 * digits/letter from four engineered, acoustically confusable options or
 * types what was heard, and sees instant feedback with a live running score.
 * The flow is endless — the next question is always ready — and an explicit
 * button ends the practice and reveals the session summary.
 *
 * The screen is deliberately built around one focal listening card: a large
 * replay control with a soft halo, a stable answer/reveal area, and the answer
 * affordances directly underneath. Typed mode collapses that card into a slim
 * replay row and keeps Next/End immediately below the answer controls, so the
 * learner can check and advance without reaching for the screen footer. Score
 * and round-mode controls stay compact so the ear-training loop gets the
 * visual weight.
 *
 * Questions come from the pure, deterministic generator in
 * ../practice/questionBank. Speech goes through the shared getSpeechEngine()
 * seam (the same one chat playback uses), so the native Android engine
 * swaps in behind it without this screen knowing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Icon } from '../components/Icon';
import { Screen, ScreenContent, ScreenHeader, ScreenScrollView } from '../components/ScreenLayout';
import type { PracticeScreenProps } from '../navigation/types';
import {
  createPracticeQuestion,
  PRACTICE_RECENT_ANSWER_LIMIT,
  type PracticeMode,
  type PracticeQuestion,
} from '../practice/questionBank';
import {
  type AnswerInputMode,
  isTypedAnswerCorrect,
  keyboardTypeForMode,
  typedAnswerPlaceholder,
} from '../practice/typedAnswer';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { getSpeechEngine } from '../tts/textToSpeech';

const MODE_OPTIONS: Array<{
  value: PracticeMode;
  label: string;
  testID: string;
}> = [
  { value: 'numbers', label: 'Numbers', testID: 'practice-mode-numbers' },
  { value: 'letters', label: 'Letters', testID: 'practice-mode-letters' },
  { value: 'phones', label: 'Phones', testID: 'practice-mode-phones' },
  { value: 'mixed', label: 'Mixed', testID: 'practice-mode-mixed' },
];

const MODE_LABELS: Record<PracticeMode, string> = {
  numbers: 'Numbers',
  letters: 'Letters',
  phones: 'Phone numbers',
  mixed: 'Mixed',
};

const QUESTION_PROMPT: Record<PracticeMode, string> = {
  numbers: 'Tap play, then choose the digits you heard.',
  letters: 'Tap play, then choose the letter you heard.',
  mixed: 'Tap play, then choose what you heard.',
  phones: 'Tap play, then choose the phone number you heard.',
};

/** Short typed-mode hint for the minimal listening card. */
const TYPED_CARD_HINTS: Record<PracticeMode, string> = {
  numbers: 'Then type the digits',
  letters: 'Then type the letter',
  phones: 'Then type the phone number',
  mixed: 'Then type what you hear',
};

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      // Horizontal padding lives on the shared header/scroll containers so
      // the scroll indicator binds to the right screen edge. Same 16px
      // header spacing as the other pushed screens.
      paddingTop: 16,
    },
    keyboardShell: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingBottom: 6,
    },
    headerSide: {
      width: 64,
      alignItems: 'flex-start',
    },
    headerSideRight: {
      alignItems: 'flex-end',
    },
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      minHeight: 36,
      paddingRight: 4,
    },
    backText: {
      fontSize: 15,
      color: c.accent,
      fontWeight: '600',
    },
    title: {
      flex: 1,
      textAlign: 'center',
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    modeToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      minHeight: 30,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 999,
      paddingHorizontal: 8,
    },
    modeToggleActive: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    modeToggleText: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textPrimary,
    },
    modeToggleTextActive: {
      color: c.accent,
    },
    pressed: {
      opacity: 0.72,
    },
    scrollContent: {
      paddingTop: 6,
      paddingBottom: 12,
      gap: 9,
    },
    scroll: {
      flex: 1,
    },
    footer: {
      paddingTop: 8,
      paddingBottom: 12,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.background,
    },
    // One quiet score strip instead of three separate cards: the numbers stay
    // glanceable without competing with the listening card for attention.
    statsBar: {
      flexDirection: 'row',
      alignItems: 'stretch',
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 14,
      paddingVertical: 7,
    },
    stat: {
      flex: 1,
      alignItems: 'center',
      gap: 1,
      paddingHorizontal: 6,
    },
    statDivider: {
      width: 1,
      backgroundColor: c.border,
      marginVertical: 1,
    },
    statValueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    statValue: {
      fontSize: 15,
      fontWeight: '700',
      color: c.textPrimary,
    },
    statLabel: {
      fontSize: 10,
      fontWeight: '500',
      color: c.textMuted,
    },
    modeTrack: {
      flexDirection: 'row',
      gap: 3,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 3,
    },
    segment: {
      flex: 1,
      minHeight: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 8,
    },
    segmentSelected: {
      backgroundColor: c.primary,
    },
    segmentText: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textSecondary,
    },
    segmentTextSelected: {
      color: c.onPrimary,
    },
    // The listening card is the screen's focal surface: soft layered halo,
    // big replay target, and a fixed answer/reveal slot that never resizes
    // the card when a result appears.
    listeningCard: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 12,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    listenPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      minWidth: 80,
      backgroundColor: c.accentSoft,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    listenPillText: {
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 0.8,
      color: c.accent,
    },
    cardMode: {
      fontSize: 11,
      fontWeight: '600',
      color: c.textMuted,
    },
    playStage: {
      height: 82,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 2,
    },
    playHalo: {
      position: 'absolute',
      width: 78,
      height: 78,
      borderRadius: 39,
      backgroundColor: c.accentSoft,
    },
    playHaloActive: {
      borderWidth: 1,
      borderColor: c.primary,
    },
    playButton: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    playButtonPressed: {
      opacity: 0.88,
    },
    playHint: {
      fontSize: 11,
      lineHeight: 14,
      textAlign: 'center',
      color: c.textMuted,
    },
    minimalCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 10,
    },
    minimalPlayButton: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    minimalCopy: {
      flex: 1,
      minWidth: 0,
      gap: 1,
    },
    minimalTitle: {
      fontSize: 13,
      lineHeight: 17,
      fontWeight: '700',
      color: c.textPrimary,
    },
    minimalHint: {
      fontSize: 11,
      lineHeight: 14,
      color: c.textMuted,
    },
    resultArea: {
      marginTop: 8,
      minHeight: 92,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
      borderRadius: 12,
      padding: 10,
      justifyContent: 'center',
      gap: 3,
    },
    resultAreaCorrect: {
      borderColor: c.success,
    },
    resultAreaWrong: {
      borderColor: c.danger,
    },
    typedFeedback: {
      minHeight: 64,
      justifyContent: 'center',
      gap: 2,
      backgroundColor: c.background,
      borderRadius: 12,
      paddingHorizontal: 2,
      paddingVertical: 2,
    },
    typedFeedbackHint: {
      fontSize: 11,
      lineHeight: 15,
      color: c.textMuted,
    },
    typedReveal: {
      fontSize: 12,
      lineHeight: 16,
    },
    typedSpokenReveal: {
      fontSize: 11,
      lineHeight: 14,
    },
    typedFeedbackText: {
      fontSize: 11,
      lineHeight: 14,
    },
    inlineActions: {
      marginTop: 2,
    },
    prompt: {
      fontSize: 13,
      lineHeight: 18,
      textAlign: 'center',
      color: c.textSecondary,
    },
    reveal: {
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '600',
      textAlign: 'left',
      color: c.textPrimary,
    },
    spokenReveal: {
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '400',
      color: c.textMuted,
    },
    feedbackRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 4,
    },
    feedbackText: {
      flex: 1,
      fontSize: 12,
      lineHeight: 15,
      fontWeight: '600',
      textAlign: 'left',
    },
    errorText: {
      fontSize: 12,
      lineHeight: 17,
      textAlign: 'center',
      color: c.errorText,
    },
    answerBlock: {
      gap: 6,
    },
    fieldHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      paddingHorizontal: 2,
    },
    fieldHeaderText: {
      flex: 1,
      gap: 1,
    },
    fieldLabel: {
      fontSize: 12,
      fontWeight: '700',
      color: c.textPrimary,
    },
    fieldHint: {
      fontSize: 10,
      color: c.textMuted,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    input: {
      flex: 1,
      minHeight: 46,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    checkButton: {
      minHeight: 46,
      borderRadius: 12,
      backgroundColor: c.primary,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkButtonDisabled: {
      opacity: 0.4,
    },
    checkButtonText: {
      color: c.onPrimary,
      fontSize: 14,
      fontWeight: '700',
    },
    optionsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    option: {
      flexGrow: 1,
      flexBasis: '46%',
      minHeight: 50,
      borderWidth: 1.5,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 13,
      paddingVertical: 9,
      paddingHorizontal: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    optionSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    optionCorrect: {
      borderColor: c.success,
      backgroundColor: c.surface,
    },
    optionWrong: {
      borderColor: c.danger,
      backgroundColor: c.surface,
    },
    optionText: {
      fontSize: 18,
      fontWeight: '700',
      textAlign: 'center',
      color: c.textPrimary,
    },
    optionTextSelected: {
      color: c.accent,
    },
    optionTextCorrect: {
      color: c.success,
    },
    optionTextWrong: {
      color: c.danger,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: 8,
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: c.primary,
      paddingHorizontal: 8,
    },
    primaryButtonPressed: {
      opacity: 0.9,
    },
    primaryButtonText: {
      color: c.onPrimary,
      fontSize: 14,
      fontWeight: '700',
    },
    nextButton: {
      flex: 1,
    },
    nextButtonDisabled: {
      opacity: 0.42,
    },
    endButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      minHeight: 48,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingHorizontal: 8,
    },
    endButtonText: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textSecondary,
    },
    summaryScroll: {
      paddingTop: 12,
      paddingBottom: 24,
    },
    summary: {
      alignItems: 'center',
      gap: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 22,
      padding: 24,
    },
    summaryIcon: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.accentSoft,
      marginBottom: 4,
    },
    summaryEyebrow: {
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 1.2,
      color: c.accent,
    },
    summaryTitle: {
      fontSize: 24,
      fontWeight: '700',
      textAlign: 'center',
      color: c.textPrimary,
    },
    summaryScore: {
      fontSize: 15,
      fontWeight: '600',
      textAlign: 'center',
      color: c.textSecondary,
    },
    summaryHint: {
      maxWidth: 260,
      marginTop: 2,
      fontSize: 12,
      lineHeight: 18,
      textAlign: 'center',
      color: c.textMuted,
    },
    summaryPrimary: {
      alignSelf: 'stretch',
      marginTop: 10,
    },
    secondaryButton: {
      alignSelf: 'stretch',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 14,
    },
    secondaryButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
  });
}

/** Feedback line shown after an answer (kept short to stay on one line). */
function feedbackText(correct: boolean, answerMode: AnswerInputMode): string {
  if (correct) {
    return 'Correct!';
  }
  return answerMode === 'type'
    ? 'Not quite — check the answer above.'
    : 'Not quite — see the highlighted option.';
}

export function PracticeScreen({ navigation }: PracticeScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [mode, setMode] = useState<PracticeMode>('numbers');
  const [answerMode, setAnswerMode] = useState<AnswerInputMode>('choose');
  const [question, setQuestion] = useState<PracticeQuestion | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [typedAnswer, setTypedAnswer] = useState('');
  const [wasCorrect, setWasCorrect] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const [attemptedCount, setAttemptedCount] = useState(0);
  const [ended, setEnded] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  // Sliding window of recent answers, handed back to the generator so the
  // same number/letter never shows up twice in a row.
  const [recentAnswers, setRecentAnswers] = useState<string[]>([]);
  const answerInputRef = useRef<TextInput>(null);

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
            setSpeechError('Speech is not available right now. Check your TTS settings.');
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
      recentAnswersRef.current = [...recentAnswersRef.current, current.answer].slice(
        -PRACTICE_RECENT_ANSWER_LIMIT,
      );
      setRecentAnswers(recentAnswersRef.current);
    }
    setQuestion(createPracticeQuestion(modeRef.current, Math.random, recentAnswersRef.current));
    setSelected(null);
    setTypedAnswer('');
    setWasCorrect(false);
    setAnswered(false);
    answeredRef.current = false;
    setSpeechError(null);
  }, []);

  // Fresh question per mode switch; a stale question from the old mode
  // would confuse the answer options the user is about to see.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mode is an intentional round-reset trigger
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
    const correct = value === current.answer;
    setSelected(value);
    setWasCorrect(correct);
    setAnswered(true);
    setAttemptedCount(prev => prev + 1);
    if (correct) {
      setCorrectCount(prev => prev + 1);
    }
  }, []);

  /**
   * Grades a typed answer exactly like a tapped option: one attempt, one
   * correctness flag, no keyboard dismissal. Keeping the input focused is
   * what lets the learner replay the audio and keep typing without the
   * keyboard closing under their hands.
   */
  const handleCheck = useCallback(() => {
    const current = questionRef.current;
    if (!current || answeredRef.current || typedAnswer.trim().length === 0) {
      return;
    }
    answeredRef.current = true;
    const correct = isTypedAnswerCorrect(current.answer, typedAnswer);
    setSelected(null);
    setWasCorrect(correct);
    setAnswered(true);
    setAttemptedCount(prev => prev + 1);
    if (correct) {
      setCorrectCount(prev => prev + 1);
    }
  }, [typedAnswer]);

  /**
   * The top-right toggle switches the whole round between tapping an option
   * and typing the answer. A fresh question keeps the old mode's answer from
   * leaking into the new one; the running score is untouched.
   */
  const handleToggleAnswerMode = useCallback(() => {
    setAnswerMode(prev => (prev === 'choose' ? 'type' : 'choose'));
    Keyboard.dismiss();
    advance();
  }, [advance]);

  const handleModeChange = useCallback((nextMode: PracticeMode) => {
    // The keyboard type follows the practice mode, so close the old keyboard
    // before the letter/number switch instead of leaving the wrong one open.
    Keyboard.dismiss();
    setMode(nextMode);
  }, []);

  const handlePlay = useCallback(() => {
    if (questionRef.current) {
      speakQuestion(questionRef.current);
    }
    // Keep the cursor in the answer box while the replay starts. On Android
    // the ScrollView's `keyboardShouldPersistTaps="handled"` already keeps
    // the keyboard up; focusing again covers engines that blur on tap.
    if (answerMode === 'type') {
      answerInputRef.current?.focus();
    }
  }, [answerMode, speakQuestion]);

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

  const accuracy = attemptedCount === 0 ? null : Math.round((correctCount / attemptedCount) * 100);

  const isCorrect = answered && wasCorrect;
  const checkDisabled = answered || typedAnswer.trim().length === 0;
  const nextDisabled = !answered;

  // The answer-mode switch sits with the answer controls rather than in the
  // header: it changes how the learner answers, not where the screen goes.
  // Moving it here keeps the header calm and makes the choice discoverable
  // exactly where its effect appears.
  const answerModeToggle = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        answerMode === 'choose'
          ? 'Switch to typing the answer'
          : 'Switch to choosing from four options'
      }
      accessibilityState={{ selected: answerMode === 'type' }}
      onPress={handleToggleAnswerMode}
      style={({ pressed }) => [
        styles.modeToggle,
        answerMode === 'type' && styles.modeToggleActive,
        pressed && styles.pressed,
      ]}
      testID="practice-answer-mode-toggle">
      <Icon
        name={answerMode === 'choose' ? 'keyboard' : 'list'}
        size={13}
        color={answerMode === 'type' ? colors.accent : colors.textSecondary}
      />
      <Text style={[styles.modeToggleText, answerMode === 'type' && styles.modeToggleTextActive]}>
        {answerMode === 'type' ? 'Choose' : 'Type answer'}
      </Text>
    </Pressable>
  );

  if (ended) {
    return (
      <Screen style={styles.container} testID="practice-screen">
        <ScreenHeader style={styles.header}>
          <View style={styles.headerSide}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go back"
              hitSlop={8}
              onPress={() => navigation.goBack()}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
              testID="practice-back">
              <Icon name="arrowLeft" size={18} color={colors.accent} />
              <Text style={styles.backText}>Back</Text>
            </Pressable>
          </View>
          <Text style={styles.title}>Listening practice</Text>
          <View style={[styles.headerSide, styles.headerSideRight]} />
        </ScreenHeader>
        <ScreenScrollView contentContainerStyle={styles.summaryScroll}>
          <View style={styles.summary} testID="practice-summary">
            <View style={styles.summaryIcon}>
              <Icon name="listening" size={32} color={colors.primary} />
            </View>
            <Text style={styles.summaryEyebrow}>SESSION COMPLETE</Text>
            <Text style={styles.summaryTitle}>Practice ended</Text>
            <Text style={styles.summaryScore} testID="practice-summary-score">
              {correctCount} of {attemptedCount} correct
              {accuracy !== null ? ` · ${accuracy}%` : ''}
            </Text>
            <Text style={styles.summaryHint}>
              Every replay sharpens your ear. Ready for another round?
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={handleRestart}
              style={({ pressed }) => [
                styles.primaryButton,
                styles.summaryPrimary,
                pressed && styles.primaryButtonPressed,
              ]}
              testID="practice-restart">
              <Icon name="refresh" size={18} color={colors.onPrimary} />
              <Text style={styles.primaryButtonText}>Practice again</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.goBack()}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              testID="practice-summary-done">
              <Text style={styles.secondaryButtonText}>Done</Text>
            </Pressable>
          </View>
        </ScreenScrollView>
      </Screen>
    );
  }

  const isTyping = answerMode === 'type';

  // Both answer modes share the same reveal/feedback treatment; only where it
  // appears changes. Typed mode keeps it under the input, choose mode keeps it
  // inside the listening card.
  const answerFeedback =
    answered && question ? (
      <>
        <Text style={[styles.reveal, isTyping && styles.typedReveal]} testID="practice-reveal">
          {`It was ${question.answer} —`}
          {'\n'}
          <Text style={[styles.spokenReveal, isTyping && styles.typedSpokenReveal]}>
            {`"${question.spoken}"`}
          </Text>
        </Text>
        <View style={styles.feedbackRow}>
          <Icon
            name={isCorrect ? 'check' : 'close'}
            size={isTyping ? 14 : 15}
            color={isCorrect ? colors.success : colors.danger}
          />
          <Text
            style={[
              styles.feedbackText,
              isTyping && styles.typedFeedbackText,
              { color: isCorrect ? colors.success : colors.danger },
            ]}
            testID="practice-feedback">
            {feedbackText(isCorrect, answerMode)}
          </Text>
        </View>
      </>
    ) : speechError ? (
      <Text role="alert" style={styles.errorText} testID="practice-speech-error">
        {speechError}
      </Text>
    ) : null;

  const actionButtons = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="End practice"
        onPress={handleEndPractice}
        style={({ pressed }) => [styles.endButton, pressed && styles.pressed]}
        testID="practice-end">
        <Icon name="close" size={13} color={colors.textSecondary} />
        <Text style={styles.endButtonText}>End practice</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={nextDisabled ? 'Answer the current question first' : undefined}
        accessibilityState={{ disabled: nextDisabled }}
        disabled={nextDisabled}
        onPress={advance}
        style={({ pressed }) => [
          styles.primaryButton,
          styles.nextButton,
          nextDisabled && styles.nextButtonDisabled,
          !nextDisabled && pressed && styles.primaryButtonPressed,
        ]}
        testID="practice-next">
        <Text style={styles.primaryButtonText}>Next question</Text>
        <Icon name="arrowRight" size={16} color={colors.onPrimary} />
      </Pressable>
    </>
  );

  return (
    <KeyboardAvoidingView
      style={styles.keyboardShell}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen style={styles.container} testID="practice-screen">
        <ScreenHeader style={styles.header}>
          <View style={styles.headerSide}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go back"
              hitSlop={8}
              onPress={() => navigation.goBack()}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
              testID="practice-back">
              <Icon name="arrowLeft" size={18} color={colors.accent} />
              <Text style={styles.backText}>Back</Text>
            </Pressable>
          </View>
          <Text style={styles.title}>Listening practice</Text>
          <View style={[styles.headerSide, styles.headerSideRight]} />
        </ScreenHeader>

        <ScreenScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
          testID="practice-scroll">
          <View style={styles.statsBar}>
            <View style={styles.stat} testID="practice-correct-card">
              <View style={styles.statValueRow}>
                <Icon name="check" size={12} color={colors.success} />
                <Text style={styles.statValue} testID="practice-correct-count">
                  {correctCount}
                </Text>
              </View>
              <Text style={styles.statLabel}>Correct</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat} testID="practice-attempted-card">
              <View style={styles.statValueRow}>
                <Icon name="speakingHistory" size={12} color={colors.accent} />
                <Text style={styles.statValue} testID="practice-attempted-count">
                  {attemptedCount}
                </Text>
              </View>
              <Text style={styles.statLabel}>Answered</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat} testID="practice-accuracy-card">
              <View style={styles.statValueRow}>
                <Icon name="target" size={12} color={colors.textSecondary} />
                <Text style={styles.statValue} testID="practice-accuracy">
                  {accuracy === null ? '–' : `${accuracy}%`}
                </Text>
              </View>
              <Text style={styles.statLabel}>Accuracy</Text>
            </View>
          </View>

          <View style={styles.modeTrack}>
            {MODE_OPTIONS.map(option => {
              const isSelected = option.value === mode;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected }}
                  onPress={() => handleModeChange(option.value)}
                  style={({ pressed }) => [
                    styles.segment,
                    isSelected && styles.segmentSelected,
                    pressed && styles.pressed,
                  ]}
                  testID={option.testID}>
                  <Text style={[styles.segmentText, isSelected && styles.segmentTextSelected]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {isTyping ? (
            <View style={styles.minimalCard} testID="practice-minimal-card">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={speaking ? 'Playing audio' : 'Play the number or letter again'}
                accessibilityState={{ busy: speaking, disabled: speaking }}
                onPress={handlePlay}
                disabled={speaking}
                style={({ pressed }) => [
                  styles.minimalPlayButton,
                  pressed && styles.playButtonPressed,
                ]}
                testID="practice-play">
                {speaking ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Icon name="play" size={20} color={colors.onPrimary} />
                )}
              </Pressable>
              <View style={styles.minimalCopy}>
                <Text style={styles.minimalTitle} numberOfLines={1}>
                  {speaking ? 'Playing…' : answered ? 'Replay the prompt' : 'Tap to listen'}
                </Text>
                <Text style={styles.minimalHint} numberOfLines={1}>
                  {speaking
                    ? 'Hear it again anytime'
                    : answered
                      ? 'Compare with the answer below'
                      : TYPED_CARD_HINTS[mode]}
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.listeningCard} testID="practice-listening-card">
              <View style={styles.cardHeader}>
                <View style={styles.listenPill}>
                  <Icon name="audioLines" size={11} color={colors.accent} />
                  <Text style={styles.listenPillText}>{speaking ? 'PLAYING' : 'LISTENING'}</Text>
                </View>
                <Text style={styles.cardMode}>{MODE_LABELS[mode]}</Text>
              </View>

              <View style={styles.playStage}>
                <View style={[styles.playHalo, speaking && styles.playHaloActive]} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    speaking ? 'Playing audio' : 'Play the number or letter again'
                  }
                  accessibilityState={{ busy: speaking, disabled: speaking }}
                  onPress={handlePlay}
                  disabled={speaking}
                  style={({ pressed }) => [styles.playButton, pressed && styles.playButtonPressed]}
                  testID="practice-play">
                  {speaking ? (
                    <ActivityIndicator size="small" color={colors.onPrimary} />
                  ) : (
                    <Icon name="play" size={22} color={colors.onPrimary} />
                  )}
                </Pressable>
              </View>
              <Text style={styles.playHint}>{speaking ? 'Playing…' : 'Tap to hear it again'}</Text>

              {/* The reveal lives in its own reserved slot under the replay
                  control, so long phone numbers wrap onto extra lines without
                  the card changing height when the answer appears. */}
              <View
                style={[
                  styles.resultArea,
                  answered && (isCorrect ? styles.resultAreaCorrect : styles.resultAreaWrong),
                ]}
                testID="practice-result-area">
                {answerFeedback ?? <Text style={styles.prompt}>{QUESTION_PROMPT[mode]}</Text>}
              </View>
            </View>
          )}

          {answerMode === 'type' ? (
            <View style={styles.answerBlock}>
              <View style={styles.fieldHeader}>
                <View style={styles.fieldHeaderText}>
                  <Text style={styles.fieldLabel}>Type the answer</Text>
                  <Text style={styles.fieldHint}>
                    {answered ? 'Round checked' : 'Spaces are optional'}
                  </Text>
                </View>
                {answerModeToggle}
              </View>
              <View style={styles.inputRow}>
                <TextInput
                  ref={answerInputRef}
                  accessibilityLabel="Type the answer you heard"
                  placeholder={typedAnswerPlaceholder(mode)}
                  placeholderTextColor={colors.textMuted}
                  value={typedAnswer}
                  onChangeText={setTypedAnswer}
                  keyboardType={keyboardTypeForMode(mode)}
                  autoCapitalize={mode === 'letters' ? 'characters' : 'none'}
                  autoCorrect={false}
                  returnKeyType="done"
                  submitBehavior="submit"
                  onSubmitEditing={handleCheck}
                  style={styles.input}
                  testID="practice-answer-input"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Check answer"
                  accessibilityState={{ disabled: checkDisabled }}
                  disabled={checkDisabled}
                  onPress={handleCheck}
                  style={({ pressed }) => [
                    styles.checkButton,
                    checkDisabled && styles.checkButtonDisabled,
                    pressed && !checkDisabled && styles.primaryButtonPressed,
                  ]}
                  testID="practice-check">
                  <Text style={styles.checkButtonText}>Check</Text>
                </Pressable>
              </View>
              <View
                style={styles.typedFeedback}
                accessibilityLiveRegion="polite"
                testID="practice-result-area">
                {answerFeedback ?? (
                  <Text style={styles.typedFeedbackHint}>
                    Check to reveal the answer and spoken form.
                  </Text>
                )}
              </View>
              <View style={[styles.actions, styles.inlineActions]}>{actionButtons}</View>
            </View>
          ) : (
            <View style={styles.answerBlock}>
              <View style={styles.fieldHeader}>
                <View style={styles.fieldHeaderText}>
                  <Text style={styles.fieldLabel}>Choose the answer</Text>
                  <Text style={styles.fieldHint}>{answered ? 'Round locked' : 'One tap'}</Text>
                </View>
                {answerModeToggle}
              </View>
              <View style={styles.optionsGrid}>
                {(question?.options ?? []).map(option => {
                  const isSelected = option === selected;
                  const isAnswer = question !== null && option === question.answer;
                  return (
                    <Pressable
                      key={option}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: isSelected, disabled: answered }}
                      disabled={answered}
                      onPress={() => handleSelect(option)}
                      style={({ pressed }) => [
                        styles.option,
                        isSelected && styles.optionSelected,
                        answered && isAnswer && styles.optionCorrect,
                        answered && isSelected && !isAnswer && styles.optionWrong,
                        pressed && styles.pressed,
                      ]}
                      testID={`practice-option-${option}`}>
                      <Text
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.7}
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
            </View>
          )}
        </ScreenScrollView>
        {!isTyping && (
          <ScreenContent style={styles.footer}>
            <View style={styles.actions}>{actionButtons}</View>
          </ScreenContent>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}
