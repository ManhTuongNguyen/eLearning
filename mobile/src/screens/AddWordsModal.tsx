/**
 * Manual "Add words" dialog of a word topic (WORD_BANK_V1 TASK-WB-011):
 * comma-separated words that run through the same dictionary pipeline as
 * generated words. The screen owns the parsing and the add flow; this dialog
 * holds the raw text (with a live parsed count and the over-limit flag) and
 * reports the submit/cancel intents.
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
import { MAX_WORD_COUNT } from '../serverless/wordGeneration';
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
    manualInput: {
      height: 140,
      textAlignVertical: 'top',
    },
  });
}

export interface AddWordsModalProps {
  /** Whether the dialog is presented. */
  visible: boolean;
  /** The raw comma-separated draft. */
  text: string;
  /** Report a new raw draft. */
  onTextChange: (text: string) => void;
  /** Live label over the parsed (deduplicated) candidates, e.g. "3 words". */
  countLabel: string;
  /** True while the words are being added. */
  busy: boolean;
  /** True when the draft parses to no words at all. */
  invalid: boolean;
  /** True when the draft parses to more words than one run may add. */
  tooMany: boolean;
  /** Dismiss (Cancel button or Android back). */
  onCancel: () => void;
  /** Add the parsed words. */
  onSubmit: () => void;
}

export function AddWordsModal({
  visible,
  text,
  onTextChange,
  countLabel,
  busy,
  invalid,
  tooMany,
  onCancel,
  onSubmit,
}: AddWordsModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const submitDisabled = busy || invalid || tooMany;
  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!busy) {
          onCancel();
        }
      }}
      testID="word-manual-modal"
      transparent
      visible={visible}>
      <View style={styles.backdrop}>
        <View style={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} testID="word-manual-title">
            Add words
          </Text>
          <Text style={styles.inputLabel}>Words, separated by commas</Text>
          <TextInput
            value={text}
            onChangeText={onTextChange}
            style={[styles.input, styles.manualInput]}
            testID="word-manual-input"
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="type, words, separated, by, commas"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.hint}>
            Separate words with commas; a word cannot contain a comma. They run through the same
            dictionary check as generated words.
          </Text>
          <Text style={styles.inputLabel} testID="word-manual-count">
            {countLabel}
          </Text>
          {tooMany ? (
            <Text role="alert" style={styles.modalError} testID="word-manual-count-error">
              {`Up to ${MAX_WORD_COUNT} words at a time.`}
            </Text>
          ) : null}
          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              testID="word-manual-cancel"
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
              accessibilityState={{ disabled: submitDisabled, busy: busy }}
              testID="word-manual-submit"
              onPress={() => onSubmit()}
              disabled={submitDisabled}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalPrimaryButton,
                submitDisabled && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              {busy ? (
                <View style={styles.generatingRow}>
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                  <Text style={styles.modalPrimaryText}>Looking up…</Text>
                </View>
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
