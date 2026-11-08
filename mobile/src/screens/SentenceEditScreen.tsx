/**
 * Sentence edit screen (MANUAL_SENTENCES).
 *
 * Edits everything stored for one real-life sentence: its text, every meaning,
 * every situation, other ways to say it, register/nuance notes and grammar
 * notes. Each list is its own {@link StringListEditor}, so the learner adds a
 * text box per entry with the "+" button and removes any row from its own
 * remove control.
 *
 * Changing the sentence TEXT by its normalised duplicate key starts the card
 * over as a fresh `new` card (its review history is kept), so the screen asks
 * for confirmation first when the schedule would be lost. Editing only the
 * content lists leaves the FSRS schedule untouched. A text that duplicates
 * another sentence of the topic is refused by the repository and shown inline.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ConfirmModal } from '../components/ConfirmModal';
import {
  SCREEN_GUTTER,
  SCREEN_TOP_SPACING,
  Screen,
  ScreenScrollView,
} from '../components/ScreenLayout';
import { ScreenTitleBar } from '../components/ScreenTitleBar';
import { StringListEditor } from '../components/StringListEditor';
import { getLocalDatabase } from '../db/database';
import { getSentenceById, updateSentence } from '../db/sentenceRepository';
import type { SentenceRecord } from '../db/types';
import { useApplicationMode } from '../mode/ModeContext';
import type { SentenceEditScreenProps } from '../navigation/types';
import { normalizeSentenceText } from '../srs/normalize';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { describeError } from '../utils/describeError';

const MODE_NOTICE_TEXT = 'Real-life sentences are saved on this device only.';

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: SCREEN_TOP_SPACING,
    },
    body: {
      gap: 18,
      paddingBottom: 40,
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
    actionText: {
      color: c.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    saveButton: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    saveText: {
      color: c.primary,
      fontSize: 16,
      fontWeight: '700',
    },
    saveDisabled: {
      opacity: 0.5,
    },
    label: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    sentenceInput: {
      minHeight: 96,
      maxHeight: 200,
      backgroundColor: c.surface,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      lineHeight: 22,
      color: c.textPrimary,
      textAlignVertical: 'top',
    },
    resetHint: {
      fontSize: 13,
      lineHeight: 18,
      color: c.warning,
    },
    errorText: {
      fontSize: 13,
      color: c.errorText,
    },
    pressedFade: {
      opacity: 0.85,
    },
  });
}

export function SentenceEditScreen({ route, navigation }: SentenceEditScreenProps) {
  const { status: modeStatus, mode } = useApplicationMode();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const sentenceId = route.params.sentenceId;

  const [sentence, setSentence] = useState<SentenceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [text, setText] = useState('');
  const [meanings, setMeanings] = useState<string[]>([]);
  const [situations, setSituations] = useState<string[]>([]);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [registers, setRegisters] = useState<string[]>([]);
  const [grammarNotes, setGrammarNotes] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const serverMode = modeStatus === 'ready' && mode === 'server';

  const loadSentence = useCallback(async () => {
    if (serverMode) {
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const db = await getLocalDatabase();
      const record = await getSentenceById(db, sentenceId);
      if (!record) {
        throw new Error('This sentence no longer exists.');
      }
      setSentence(record);
      setText(record.text);
      setMeanings(record.meanings ?? (record.meaning ? [record.meaning] : []));
      setSituations(record.situations ?? (record.situation ? [record.situation] : []));
      setAlternatives(record.alternatives ?? []);
      setRegisters(record.registers ?? []);
      setGrammarNotes(record.grammar_notes ?? []);
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [serverMode, sentenceId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional reload trigger
  useEffect(() => {
    loadSentence();
  }, [loadSentence, reloadKey]);

  const trimmedText = text.trim();
  const textMissing = trimmedText.length === 0;
  const textChanged =
    sentence !== null && normalizeSentenceText(trimmedText) !== sentence.normalized_text;
  // Only a card that already earned progress loses anything when the text
  // changes, so only then is a confirmation warranted.
  const resetsProgress =
    textChanged && sentence !== null && (sentence.reps > 0 || sentence.state !== 'new');

  /** The actual write; the repository owns duplicate detection and the reset. */
  const performSave = useCallback(async () => {
    if (sentence === null || saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const db = await getLocalDatabase();
      const updated = await updateSentence(db, sentence.id, {
        text: trimmedText,
        meanings,
        situations,
        alternatives,
        registers,
        grammar_notes: grammarNotes,
      });
      if (!updated) {
        throw new Error('This sentence no longer exists.');
      }
      setConfirmOpen(false);
      navigation.goBack();
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  }, [
    sentence,
    saving,
    trimmedText,
    meanings,
    situations,
    alternatives,
    registers,
    grammarNotes,
    navigation,
  ]);

  const handleSave = useCallback(() => {
    if (sentence === null || saving) {
      return;
    }
    if (textMissing) {
      setSaveError('A sentence needs its text.');
      return;
    }
    setSaveError(null);
    if (resetsProgress) {
      setConfirmOpen(true);
      return;
    }
    // performSave handles its own errors, so it never rejects.
    performSave();
  }, [sentence, saving, textMissing, resetsProgress, performSave]);

  return (
    <Screen style={styles.container} testID="sentence-edit-screen">
      <ScreenTitleBar
        title={sentence ? 'Edit sentence' : 'Sentence'}
        titleTestID="sentence-edit-title"
        onBack={() => navigation.goBack()}
        backTestID="sentence-edit-back"
        right={
          serverMode ? undefined : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saving, busy: saving }}
              accessibilityLabel="Save sentence"
              testID="sentence-edit-save"
              onPress={handleSave}
              disabled={saving}
              style={({ pressed }) => [
                styles.saveButton,
                saving && styles.saveDisabled,
                pressed && styles.pressedFade,
              ]}>
              {saving ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={styles.saveText}>Save</Text>
              )}
            </Pressable>
          )
        }
      />

      {serverMode ? (
        <View style={styles.centered} testID="sentence-edit-mode-notice">
          <Text style={styles.stateText}>{MODE_NOTICE_TEXT}</Text>
        </View>
      ) : modeStatus !== 'ready' || loading ? (
        <View style={styles.centered} testID="sentence-edit-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loadError || !sentence ? (
        <View style={styles.centered} testID="sentence-edit-error">
          <Text role="alert" style={styles.stateText}>
            {loadError ?? 'This sentence no longer exists.'}
          </Text>
          <Pressable testID="sentence-edit-retry" onPress={() => setReloadKey(key => key + 1)}>
            <Text style={styles.actionText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ScreenScrollView contentContainerStyle={styles.body}>
          <Text style={styles.label}>Sentence</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            style={styles.sentenceInput}
            testID="sentence-edit-text"
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="e.g. Could I get a flat white, please?"
          />

          {resetsProgress ? (
            <Text style={styles.resetHint} testID="sentence-edit-reset-hint">
              Changing the sentence starts it over as a new card. Its review history is kept.
            </Text>
          ) : null}

          {saveError ? (
            <Text role="alert" style={styles.errorText} testID="sentence-edit-save-error">
              {saveError}
            </Text>
          ) : null}

          <StringListEditor
            label="Meanings"
            values={meanings}
            onChange={setMeanings}
            placeholder="What it means in plain English"
            addLabel="Add meaning"
            testIDPrefix="sentence-edit-meanings"
          />
          <StringListEditor
            label="Situations"
            values={situations}
            onChange={setSituations}
            placeholder="When a native speaker would say it"
            addLabel="Add situation"
            testIDPrefix="sentence-edit-situations"
          />
          <StringListEditor
            label="Other ways to say it"
            values={alternatives}
            onChange={setAlternatives}
            placeholder="Another natural phrasing"
            addLabel="Add alternative"
            testIDPrefix="sentence-edit-alternatives"
          />
          <StringListEditor
            label="Register / nuance"
            values={registers}
            onChange={setRegisters}
            placeholder="Formal, casual, who says it to whom..."
            addLabel="Add note"
            testIDPrefix="sentence-edit-registers"
          />
          <StringListEditor
            label="Grammar / structure"
            values={grammarNotes}
            onChange={setGrammarNotes}
            placeholder="The grammar or structure it practises"
            addLabel="Add note"
            testIDPrefix="sentence-edit-grammar"
          />
        </ScreenScrollView>
      )}

      <ConfirmModal
        visible={confirmOpen}
        title="Start this card over?"
        message="Changing the sentence text resets its practice schedule: it becomes a new card and is due now. Its review history is kept."
        confirmLabel="Save"
        busy={saving}
        error={saveError}
        onCancel={() => {
          if (!saving) {
            setConfirmOpen(false);
            setSaveError(null);
          }
        }}
        onConfirm={() => {
          // performSave handles its own errors, so it never rejects.
          performSave();
        }}
        testID="sentence-edit-reset-confirm"
      />
    </Screen>
  );
}
