/**
 * Create / edit a speaking-practice entry from the history screen.
 *
 * The same form serves both actions: "New custom topic" (title + content typed
 * by the learner, no AI) and "Edit" on a saved history row. The screen owns the
 * draft and the persistence flow; this modal only renders the fields, disables
 * Save while the title or content is blank, and keeps the content box at a
 * bounded height so a long text scrolls inside the card instead of pushing the
 * footer off screen.
 */
import { useMemo } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { createModalStyles } from '../components/modalChrome';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

/** The draft the history screen edits; `recordId: null` means a new entry. */
export interface SpeakingPracticeFormState {
  recordId: number | null;
  title: string;
  content: string;
}

export const EMPTY_SPEAKING_FORM: SpeakingPracticeFormState = {
  recordId: null,
  title: '',
  content: '',
};

export interface SpeakingPracticeFormModalProps {
  /** Current draft; null hides the modal. */
  form: SpeakingPracticeFormState | null;
  /** True while the create/update write runs. */
  saving: boolean;
  /** Failure message kept visible inside the form. */
  saveError: string | null;
  /** Patch one or more draft fields. */
  onChangeField: (patch: Partial<SpeakingPracticeFormState>) => void;
  /** Dismiss (Cancel or Android back); ignored while saving. */
  onCancel: () => void;
  /** Submit the draft; the screen owns validation and persistence. */
  onSave: () => void;
}

export function SpeakingPracticeFormModal({
  form,
  saving,
  saveError,
  onChangeField,
  onCancel,
  onSave,
}: SpeakingPracticeFormModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const isEdit = form !== null && form.recordId !== null;
  const invalid = form !== null && (form.title.trim() === '' || form.content.trim() === '');

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!saving) {
          onCancel();
        }
      }}
      testID="speaking-form-modal"
      transparent
      visible={form !== null}>
      <View style={styles.backdrop}>
        <View style={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} testID="speaking-form-heading">
            {isEdit ? 'Edit practice' : 'New custom topic'}
          </Text>

          <ScrollView
            style={styles.formScroll}
            contentContainerStyle={styles.contentContainer}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            testID="speaking-form-scroll">
            <View style={styles.block}>
              <Text style={styles.inputLabel}>Title</Text>
              <TextInput
                placeholder="e.g. My weekend plans"
                value={form?.title ?? ''}
                onChangeText={title => onChangeField({ title })}
                style={styles.input}
                testID="speaking-form-title-input"
                autoFocus
              />
            </View>

            <View style={styles.block}>
              <Text style={styles.inputLabel}>Content</Text>
              <TextInput
                placeholder={'The text you will read aloud.\n\nType or paste it here.'}
                placeholderTextColor={colors.textMuted}
                value={form?.content ?? ''}
                onChangeText={content => onChangeField({ content })}
                style={[styles.input, styles.contentInput]}
                testID="speaking-form-content-input"
                multiline
                scrollEnabled
                textAlignVertical="top"
              />
              <Text style={styles.hint}>
                This text is saved to your speaking history and read as-is — no AI is used.
              </Text>
            </View>

            {saveError ? (
              <Text role="alert" style={styles.modalError} testID="speaking-form-error">
                {saveError}
              </Text>
            ) : null}
          </ScrollView>

          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              testID="speaking-form-cancel"
              onPress={() => {
                if (!saving) {
                  onCancel();
                }
              }}
              disabled={saving}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalCancelButton,
                saving && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saving || invalid, busy: saving }}
              testID="speaking-form-save"
              onPress={() => {
                onSave();
              }}
              disabled={saving || invalid}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalPrimaryButton,
                (saving || invalid) && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              {saving ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.modalPrimaryText}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: ThemeColors) {
  const modal = createModalStyles(c, { cardMaxWidth: 460, cardMaxHeight: '90%' });
  return StyleSheet.create({
    ...modal,
    formScroll: {
      flexGrow: 0,
      // Full-bleed over the card's horizontal padding so the Android
      // scrollbar anchors to the card's right edge instead of floating
      // inside the padding gutter; the content keeps its original inset.
      marginLeft: -20,
      marginRight: -20,
      paddingHorizontal: 20,
    },
    contentContainer: {
      gap: 16,
    },
    block: {
      gap: 4,
    },
    contentInput: {
      minHeight: 140,
      // The practice text can be long: bound the field and let it scroll
      // internally so the modal footer always stays reachable.
      maxHeight: 220,
    },
    hint: {
      fontSize: 12,
      lineHeight: 17,
      color: c.textMuted,
    },
  });
}
