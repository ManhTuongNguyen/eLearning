/**
 * Create / edit word-topic form modal (WORD_BANK_V1 TASK-WB-008).
 *
 * Presentational: the screen owns the draft state (`TopicFormState`) and the
 * save flow; this modal renders the fields, disables Save while the title is
 * blank or a save is running, and keeps the form scrolling inside the card so
 * the footer buttons stay reachable on small screens.
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
import { MAX_GENERATION_PROMPT_LENGTH } from '../serverless/sentenceGeneration';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

const LEARNER_CONTEXT_PLACEHOLDER =
  "I'm a chef, I often read cooking blogs, I can understand about 85 percent of simple texts";

/** The draft the screen edits; `topicId: null` means a new topic. */
export interface TopicFormState {
  topicId: number | null;
  title: string;
  description: string;
  extraPrompt: string;
}

export const EMPTY_TOPIC_FORM: TopicFormState = {
  topicId: null,
  title: '',
  description: '',
  extraPrompt: '',
};

export interface WordTopicFormModalProps {
  /** Current draft; null hides the modal. */
  form: TopicFormState | null;
  /** True while the create/update request runs. */
  saving: boolean;
  /** Failure message kept visible inside the form. */
  saveError: string | null;
  /** True when the title is blank; Save disables. */
  titleInvalid: boolean;
  /** Patch one or more draft fields. */
  onChangeField: (patch: Partial<TopicFormState>) => void;
  /** Dismiss (Cancel or Android back); ignored while saving. */
  onCancel: () => void;
  /** Submit the draft; the screen owns validation and persistence. */
  onSave: () => void;
}

export function WordTopicFormModal({
  form,
  saving,
  saveError,
  titleInvalid,
  onChangeField,
  onCancel,
  onSave,
}: WordTopicFormModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const isEdit = form !== null && form.topicId !== null;

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!saving) {
          onCancel();
        }
      }}
      testID="word-topic-form-modal"
      transparent
      visible={form !== null}>
      <View style={styles.backdrop}>
        <View style={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} testID="word-topic-form-title">
            {isEdit ? 'Edit topic' : 'New topic'}
          </Text>

          <ScrollView
            style={styles.formScroll}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            testID="word-topic-form-scroll">
            <Text style={styles.inputLabel}>Topic</Text>
            <TextInput
              placeholder="e.g. Cooking"
              value={form?.title ?? ''}
              onChangeText={title => onChangeField({ title })}
              style={styles.input}
              testID="word-topic-form-title-input"
              autoFocus
            />

            <Text style={styles.inputLabel}>Learner context (recommended)</Text>
            <TextInput
              placeholder={LEARNER_CONTEXT_PLACEHOLDER}
              value={form?.description ?? ''}
              onChangeText={description => onChangeField({ description })}
              style={[styles.input, styles.descriptionInput]}
              testID="word-topic-form-description"
              multiline
              scrollEnabled
            />
            <Text style={styles.hint}>
              Describe your domain, habits and level — this shapes which words the AI picks.
            </Text>

            <Text style={styles.inputLabel}>Additional prompt (optional)</Text>
            <TextInput
              placeholder="e.g. focus on words about cooking"
              value={form?.extraPrompt ?? ''}
              onChangeText={extraPrompt => onChangeField({ extraPrompt })}
              style={[styles.input, styles.descriptionInput]}
              testID="word-topic-form-extra-prompt"
              multiline
              scrollEnabled
              maxLength={MAX_GENERATION_PROMPT_LENGTH}
            />

            {saveError ? (
              <Text role="alert" style={styles.modalError} testID="word-topic-form-error">
                {saveError}
              </Text>
            ) : null}
          </ScrollView>

          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              testID="word-topic-form-cancel"
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
              accessibilityState={{ disabled: saving || titleInvalid, busy: saving }}
              testID="word-topic-form-save"
              onPress={() => {
                onSave();
              }}
              disabled={saving || titleInvalid}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalPrimaryButton,
                (saving || titleInvalid) && styles.modalDisabled,
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
    descriptionInput: {
      minHeight: 84,
      maxHeight: 160,
      textAlignVertical: 'top',
    },
    hint: {
      fontSize: 12,
      lineHeight: 17,
      color: c.textMuted,
    },
  });
}
