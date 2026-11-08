/**
 * Manual "Add sentence" dialog of a sentence topic (MANUAL_SENTENCES).
 *
 * The learner types one sentence plus an optional meaning and situation; the
 * screen persists it through the same repository path as generated sentences.
 * The dialog holds its own draft (reset each time it opens) and reports the
 * submit/cancel intents; more meanings/situations can be added later from the
 * sentence detail screen.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { createModalStyles } from '../components/modalChrome';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

/** The draft captured by the manual add dialog. */
export interface ManualSentenceDraft {
  text: string;
  meaning: string;
  situation: string;
}

export interface AddSentenceModalProps {
  /** Whether the dialog is presented. */
  visible: boolean;
  /** True while the sentence is being saved. */
  busy: boolean;
  /** Failure message kept visible inside the dialog. */
  error: string | null;
  /** Dismiss (Cancel button or Android back). */
  onCancel: () => void;
  /** Save the draft; the screen owns persistence and error handling. */
  onSubmit: (draft: ManualSentenceDraft) => void;
}

export function AddSentenceModal({
  visible,
  busy,
  error,
  onCancel,
  onSubmit,
}: AddSentenceModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [text, setText] = useState('');
  const [meaning, setMeaning] = useState('');
  const [situation, setSituation] = useState('');

  // A fresh dialog starts empty.
  useEffect(() => {
    if (visible) {
      setText('');
      setMeaning('');
      setSituation('');
    }
  }, [visible]);

  const submitDisabled = busy || !text.trim();

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!busy) {
          onCancel();
        }
      }}
      testID="add-sentence-modal"
      transparent
      visible={visible}>
      <View style={styles.backdrop}>
        <View style={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} testID="add-sentence-title">
            Add sentence
          </Text>

          <Text style={styles.inputLabel}>Sentence</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            style={[styles.input, styles.sentenceInput]}
            testID="add-sentence-text"
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="e.g. Could I get a flat white, please?"
            autoFocus
          />

          <Text style={styles.inputLabel}>Meaning (optional)</Text>
          <TextInput
            value={meaning}
            onChangeText={setMeaning}
            style={[styles.input, styles.meaningInput]}
            testID="add-sentence-meaning"
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="What it means in plain English"
          />

          <Text style={styles.inputLabel}>Situation (optional)</Text>
          <TextInput
            value={situation}
            onChangeText={setSituation}
            style={[styles.input, styles.meaningInput]}
            testID="add-sentence-situation"
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="When a native speaker would say it"
          />

          {error ? (
            <Text role="alert" style={styles.modalError} testID="add-sentence-error">
              {error}
            </Text>
          ) : null}

          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              testID="add-sentence-cancel"
              onPress={() => {
                if (!busy) {
                  onCancel();
                }
              }}
              disabled={busy}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalCancelButton,
                busy && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: submitDisabled, busy }}
              testID="add-sentence-submit"
              onPress={() => onSubmit({ text, meaning, situation })}
              disabled={submitDisabled}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalPrimaryButton,
                submitDisabled && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              {busy ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.modalPrimaryText}>Add</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: ThemeColors) {
  const modal = createModalStyles(c);
  return StyleSheet.create({
    ...modal,
    sentenceInput: {
      minHeight: 72,
      maxHeight: 140,
    },
    meaningInput: {
      minHeight: 56,
      maxHeight: 120,
    },
  });
}
