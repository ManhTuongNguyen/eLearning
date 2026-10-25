/**
 * "Generate words" / "Generate similar words" dialog of a word topic
 * (WORD_BANK_V1 TASK-WB-004). The count is typed here (1–30); the hint text
 * and button labels switch between the ordinary and the collected-words
 * (system) topic variants. The screen owns the generation pipeline; this
 * dialog only reports the typed count and the submit/cancel intents.
 */
import { useMemo } from 'react';
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

function createStyles(c: ThemeColors) {
  const modal = createModalStyles(c);
  return StyleSheet.create({
    ...modal,
    hint: {
      fontSize: 12,
      lineHeight: 17,
      color: c.textMuted,
    },
    generatingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
  });
}

export interface GenerateWordsModalProps {
  /** Whether the dialog is presented. */
  visible: boolean;
  /** True for the seeded collected-words topic (the "similar words" variant). */
  isSystemTopic: boolean;
  /** The typed count text. */
  countText: string;
  /** Report a new count draft. */
  onCountChange: (text: string) => void;
  /** True when the typed count is non-empty but unparseable/out of range. */
  countInvalid: boolean;
  /** True when the collected-words topic has no words to grow from. */
  collectedEmpty: boolean;
  /** True while the generation pipeline is running. */
  generating: boolean;
  /** Dismiss (Cancel button or Android back). */
  onCancel: () => void;
  /** Start the generation with the typed count. */
  onSubmit: () => void;
}

export function GenerateWordsModal({
  visible,
  isSystemTopic,
  countText,
  onCountChange,
  countInvalid,
  collectedEmpty,
  generating,
  onCancel,
  onSubmit,
}: GenerateWordsModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // The submit needs a parseable count: the flagged invalid input or a plain
  // empty field both leave nothing to generate from.
  const submitDisabled = generating || collectedEmpty || countInvalid || countText.trim() === '';
  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!generating) {
          onCancel();
        }
      }}
      testID="word-generate-modal"
      transparent
      visible={visible}>
      <View style={styles.backdrop}>
        <View style={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} testID="word-generate-title">
            {isSystemTopic ? 'Generate similar words' : 'Generate words'}
          </Text>
          <Text style={styles.hint}>
            {isSystemTopic
              ? 'The AI picks words in the spirit of your collection; meanings and IPA come from the Free Dictionary API.'
              : 'The AI picks the words; meanings and IPA come from the Free Dictionary API.'}
          </Text>
          <Text style={styles.inputLabel}>How many words (1–30)?</Text>
          <TextInput
            value={countText}
            onChangeText={onCountChange}
            style={styles.input}
            testID="word-generate-count"
            keyboardType="number-pad"
            autoFocus
          />
          {countInvalid ? (
            <Text role="alert" style={styles.modalError} testID="word-generate-count-error">
              Enter a number between 1 and 30.
            </Text>
          ) : null}
          {collectedEmpty ? (
            <Text role="alert" style={styles.modalError} testID="word-generate-empty-error">
              Collect or add words first — similar words grow from your collection.
            </Text>
          ) : null}
          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              testID="word-generate-cancel"
              onPress={() => {
                if (!generating) {
                  onCancel();
                }
              }}
              disabled={generating}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalCancelButton,
                generating && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: submitDisabled, busy: generating }}
              testID="word-generate-submit"
              onPress={() => onSubmit()}
              disabled={submitDisabled}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalPrimaryButton,
                submitDisabled && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              {generating ? (
                <View style={styles.generatingRow}>
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                  <Text style={styles.modalPrimaryText}>Generating…</Text>
                </View>
              ) : (
                <Text style={styles.modalPrimaryText}>
                  {isSystemTopic ? 'Generate similar' : 'Generate'}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
