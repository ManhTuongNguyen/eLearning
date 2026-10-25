/**
 * Create a real-life sentence topic (TASK-SENT-008).
 *
 * Kept on its own pushed screen instead of an inline form so the topics list
 * stays readable and the keyboard/form state does not crowd the list. A title is
 * required; the description is optional. The "Advanced" checkbox reveals an
 * optional instruction field that is stored on the topic and passed to the
 * generation prompt as untrusted context.
 *
 * Saving replaces this screen with the new topic's detail screen, so Back from
 * the topic always returns to the topics list rather than to the form.
 */
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import {
  SCREEN_GUTTER,
  SCREEN_TOP_SPACING,
  Screen,
  ScreenHeader,
  ScreenScrollView,
} from '../components/ScreenLayout';
import { getLocalDatabase } from '../db/database';
import { createSentenceTopic } from '../db/sentenceRepository';
import { useApplicationMode } from '../mode/ModeContext';
import type { SentenceTopicNewScreenProps } from '../navigation/types';
import { MAX_GENERATION_PROMPT_LENGTH } from '../serverless/sentenceGeneration';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: SCREEN_TOP_SPACING,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 16,
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
    form: {
      gap: 14,
      paddingBottom: 24,
    },
    inputLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    input: {
      backgroundColor: c.surface,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: c.textPrimary,
    },
    descriptionInput: {
      minHeight: 84,
      maxHeight: 160,
      textAlignVertical: 'top',
    },
    advancedToggle: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingVertical: 2,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    checkboxChecked: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    advancedText: {
      flex: 1,
      gap: 2,
    },
    advancedLabel: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    hint: {
      fontSize: 12,
      lineHeight: 17,
      color: c.textMuted,
    },
    errorText: {
      color: c.errorText,
      fontSize: 13,
    },
    actionRow: {
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'flex-end',
      marginTop: 4,
    },
    actionButton: {
      minWidth: 84,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingVertical: 11,
      paddingHorizontal: 16,
    },
    cancelButton: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    saveButton: {
      backgroundColor: c.primary,
    },
    cancelButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    saveButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.onPrimary,
    },
    pressedFade: {
      opacity: 0.9,
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
  });
}

export function SentenceTopicNewScreen({ navigation }: SentenceTopicNewScreenProps) {
  const { status: modeStatus, mode } = useApplicationMode();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [generationPrompt, setGenerationPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const serverMode = modeStatus === 'ready' && mode === 'server';
  const ready = modeStatus === 'ready' && mode === 'serverless';

  const handleSave = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || saving || !ready) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const db = await getLocalDatabase();
      const created = await createSentenceTopic(db, {
        title: trimmedTitle,
        description: description.trim(),
        generation_prompt: advancedOpen ? generationPrompt.trim() : '',
      });
      // Replace the form: Back from the topic should land on the topics list.
      navigation.replace('SentenceTopic', { topicId: created.id });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [title, description, advancedOpen, generationPrompt, saving, ready, navigation]);

  return (
    <Screen style={styles.container} testID="sentence-new-topic-screen">
      <ScreenHeader style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to topics"
          testID="sentence-new-topic-back"
          onPress={() => navigation.goBack()}
          style={styles.backLinkButton}
          disabled={saving}>
          <Text style={styles.backLinkText}>‹ Topics</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          New topic
        </Text>
      </ScreenHeader>

      {modeStatus !== 'ready' ? (
        <View style={styles.centered} testID="sentence-new-topic-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : serverMode ? (
        <View style={styles.centered} testID="sentence-new-topic-mode-notice">
          <Text style={styles.stateText}>
            Topics are saved on this device only. Switch to serverless mode to create one.
          </Text>
        </View>
      ) : (
        <ScreenScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
          <Text style={styles.inputLabel}>Topic</Text>
          <TextInput
            placeholder="e.g. Meeting someone new"
            value={title}
            onChangeText={setTitle}
            style={styles.input}
            testID="sentence-topic-title"
            autoFocus
          />

          <Text style={styles.inputLabel}>Description (optional)</Text>
          <TextInput
            placeholder="A short real-life situation, or leave blank"
            value={description}
            onChangeText={setDescription}
            style={[styles.input, styles.descriptionInput]}
            testID="sentence-topic-description"
            multiline
            scrollEnabled
          />

          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel="Show advanced generation options"
            accessibilityState={{ checked: advancedOpen }}
            testID="sentence-topic-advanced-toggle"
            onPress={() => setAdvancedOpen(value => !value)}
            style={styles.advancedToggle}>
            <View style={[styles.checkbox, advancedOpen && styles.checkboxChecked]}>
              {advancedOpen ? <Icon name="check" size={15} color={colors.onPrimary} /> : null}
            </View>
            <View style={styles.advancedText}>
              <Text style={styles.advancedLabel}>Advanced</Text>
              <Text style={styles.hint}>
                Add extra guidance for the AI that writes this topic's sentences.
              </Text>
            </View>
          </Pressable>

          {advancedOpen ? (
            <>
              <Text style={styles.inputLabel}>Generation instructions (optional)</Text>
              <TextInput
                placeholder="e.g. Use British spelling and focus on phone calls"
                value={generationPrompt}
                onChangeText={setGenerationPrompt}
                style={[styles.input, styles.descriptionInput]}
                testID="sentence-topic-generation-prompt"
                multiline
                scrollEnabled
                maxLength={MAX_GENERATION_PROMPT_LENGTH}
              />
              <Text style={styles.hint}>
                This is sent as background context only. It is never treated as an instruction that
                can change the app's prompt or output format.
              </Text>
            </>
          ) : null}

          {saveError ? (
            <Text role="alert" style={styles.errorText} testID="sentence-topic-save-error">
              {saveError}
            </Text>
          ) : null}

          <View style={styles.actionRow}>
            <Pressable
              testID="sentence-topic-cancel"
              onPress={() => navigation.goBack()}
              disabled={saving}
              style={({ pressed }) => [
                styles.actionButton,
                styles.cancelButton,
                pressed && styles.pressedFade,
              ]}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                disabled: saving || !title.trim() || !ready,
              }}
              testID="sentence-topic-save"
              onPress={handleSave}
              disabled={saving || !title.trim() || !ready}
              style={({ pressed }) => [
                styles.actionButton,
                styles.saveButton,
                (saving || !title.trim()) && { opacity: 0.45 },
                pressed && styles.pressedFade,
              ]}>
              {saving ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.saveButtonText}>Save</Text>
              )}
            </Pressable>
          </View>
        </ScreenScrollView>
      )}
    </Screen>
  );
}
