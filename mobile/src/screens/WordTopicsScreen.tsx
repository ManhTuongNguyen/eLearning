/**
 * Word bank topics hub (WORD_BANK_V1 TASK-WB-008).
 *
 * Lists the learner's vocabulary topics newest first, each with its word count
 * and the number of words due today, and lets a learner create, edit and
 * delete a topic. The form is a small modal on this screen: a title (required),
 * the learner-context description (domain, habits, self-described level) and an
 * optional additional AI prompt. Creating a topic navigates straight to its
 * (empty) topic screen; editing reuses the same form pre-filled.
 *
 * A topic row also carries a delete action. Deleting asks for confirmation and
 * then removes the topic together with its words and review history (the
 * schema's `ON DELETE CASCADE`).
 *
 * The whole feature is serverless-only: until the persisted mode has been
 * restored the screen shows its spinner, and in server mode it replaces the
 * list with an explicit notice instead of touching the local database.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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

import { Icon } from '../components/Icon';
import { SCREEN_GUTTER, Screen, ScreenHeader, ScreenList } from '../components/ScreenLayout';
import { getLocalDatabase } from '../db/database';
import type { WordTopicSummary } from '../db/types';
import {
  createWordTopic,
  deleteWordTopic,
  listWordTopics,
  updateWordTopic,
} from '../db/wordRepository';
import { useApplicationMode } from '../mode/ModeContext';
import type { WordTopicsScreenProps } from '../navigation/types';
import { MAX_GENERATION_PROMPT_LENGTH } from '../serverless/sentenceGeneration';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

const MODE_NOTICE_TEXT =
  'The word bank is saved on this device only. Switch to server mode to manage ' +
  'your server account — your local words are never sent there.';

const LEARNER_CONTEXT_PLACEHOLDER =
  "I'm a chef, I often read cooking blogs, I can understand about 85 percent of simple texts";

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
      marginBottom: 16,
    },
    title: {
      fontSize: 24,
      fontWeight: '700',
      color: c.textPrimary,
      flex: 1,
    },
    newTopicButton: {
      // Compact 32x32 circle so the header row height matches the title text
      // (a 44x44 button inflated the row and pushed the title down).
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.primary,
    },
    rowGroup: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      // No horizontal padding: the ScreenList gutter already insets the rows,
      // so the topic titles align with the screen title instead of sitting
      // 16px further in (a double inset that read as a redundant margin).
      paddingRight: 6,
    },
    rowMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
    },
    rowActions: {
      flexDirection: 'row',
    },
    rowIconButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowDivider: {
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    rowIcon: {
      width: 24,
      alignItems: 'center',
    },
    rowText: {
      flex: 1,
      gap: 2,
    },
    rowTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    rowDescription: {
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 18,
    },
    rowCounts: {
      flexDirection: 'row',
      gap: 8,
    },
    badge: {
      fontSize: 12,
      fontWeight: '600',
      color: c.onPrimary,
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    badgeGhost: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textMuted,
      backgroundColor: c.surface,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    badgeLabel: {
      fontSize: 12,
      fontWeight: '600',
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
    errorText: {
      color: c.errorText,
      fontSize: 13,
    },
    listContent: {
      gap: 12,
    },
    actionText: {
      color: c.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    pressedFade: {
      opacity: 0.9,
    },
    // --- Form / confirm modal ---
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: SCREEN_GUTTER,
    },
    modalCard: {
      width: '100%',
      maxWidth: 460,
      maxHeight: '90%',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 16,
      padding: 20,
      gap: 12,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    formScroll: {
      flexGrow: 0,
      // Full-bleed over the card's horizontal padding so the Android
      // scrollbar anchors to the card's right edge instead of floating
      // inside the padding gutter; the content keeps its original inset.
      marginLeft: -20,
      marginRight: -20,
      paddingHorizontal: 20,
    },
    inputLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    input: {
      backgroundColor: c.background,
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
    hint: {
      fontSize: 12,
      lineHeight: 17,
      color: c.textMuted,
    },
    modalError: {
      fontSize: 13,
      color: c.errorText,
    },
    modalFooter: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
      marginTop: 4,
    },
    modalButton: {
      minWidth: 88,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    modalCancelButton: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    modalPrimaryButton: {
      backgroundColor: c.primary,
    },
    modalDangerButton: {
      backgroundColor: c.danger,
    },
    modalDisabled: {
      opacity: 0.5,
    },
    modalCancelText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    modalPrimaryText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.onPrimary,
    },
  });
}

type TopicRowProps = {
  item: WordTopicSummary;
  onPress: (item: WordTopicSummary) => void;
  onEdit: (item: WordTopicSummary) => void;
  onDelete: (item: WordTopicSummary) => void;
  deleting: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
};

function WordTopicRow({
  item,
  onPress,
  onEdit,
  onDelete,
  deleting,
  colors,
  styles,
}: TopicRowProps) {
  const dueBadge =
    item.due_count > 0 ? (
      <View style={styles.badge} testID={`word-topic-${item.id}-due`}>
        <Text style={[styles.badgeLabel, { color: colors.onPrimary }]}>{item.due_count} due</Text>
      </View>
    ) : (
      <View style={styles.badgeGhost} testID={`word-topic-${item.id}-done`}>
        <Text style={[styles.badgeLabel, { color: colors.textMuted }]}>all done</Text>
      </View>
    );

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.title} — ${item.word_count} words, ${item.due_count} due`}
        testID={`word-topic-${item.id}`}
        onPress={() => onPress(item)}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressedFade]}>
        <View style={styles.rowIcon}>
          <Icon name="words" color={colors.accent} />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          {item.description ? (
            <Text style={styles.rowDescription} numberOfLines={2}>
              {item.description}
            </Text>
          ) : null}
          <View style={styles.rowCounts}>
            <Text style={styles.badgeGhost}>
              {item.word_count} word{item.word_count === 1 ? '' : 's'}
            </Text>
            {dueBadge}
          </View>
        </View>
      </Pressable>

      <View style={styles.rowActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit topic ${item.title}`}
          testID={`word-topic-edit-${item.id}`}
          onPress={() => onEdit(item)}
          style={({ pressed }) => [styles.rowIconButton, pressed && styles.pressedFade]}>
          <Icon name="edit" size={18} color={colors.textMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete topic ${item.title}`}
          accessibilityState={{ disabled: deleting, busy: deleting }}
          testID={`word-topic-delete-${item.id}`}
          onPress={() => onDelete(item)}
          disabled={deleting}
          style={({ pressed }) => [styles.rowIconButton, pressed && styles.pressedFade]}>
          {deleting ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : (
            <Icon name="trash" size={18} color={colors.danger} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

/** Which the form modal is for: creating a new topic or editing an existing one. */
interface TopicFormState {
  /** null while creating; the id of the topic being edited otherwise. */
  topicId: number | null;
  title: string;
  description: string;
  extraPrompt: string;
}

const EMPTY_FORM: TopicFormState = { topicId: null, title: '', description: '', extraPrompt: '' };

export function WordTopicsScreen({ navigation }: WordTopicsScreenProps) {
  const { status: modeStatus, mode } = useApplicationMode();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [topics, setTopics] = useState<WordTopicSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WordTopicSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [form, setForm] = useState<TopicFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const serverMode = modeStatus === 'ready' && mode === 'server';
  const serverlessMode = modeStatus === 'ready' && mode === 'serverless';

  const loadTopics = useCallback(async () => {
    if (!serverlessMode) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const db = await getLocalDatabase();
      const items = await listWordTopics(db);
      setTopics(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [serverlessMode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional reload trigger
  useEffect(() => {
    loadTopics();
  }, [loadTopics, reloadKey]);

  // Re-list when the screen regains focus so it reflects topics changed while
  // it was backgrounded (the same contract as the sentence topics screen).
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('focus', () => {
      if (serverlessMode) {
        setReloadKey(key => key + 1);
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, serverlessMode]);

  const handleTopicPress = useCallback(
    (item: WordTopicSummary) => navigation.navigate('WordTopic', { topicId: item.id }),
    [navigation],
  );

  const handleNewTopic = useCallback(() => {
    setSaveError(null);
    setForm(EMPTY_FORM);
  }, []);

  const handleEditTopic = useCallback((item: WordTopicSummary) => {
    setSaveError(null);
    setForm({
      topicId: item.id,
      title: item.title,
      description: item.description,
      extraPrompt: item.extra_prompt,
    });
  }, []);

  /** Persist the form modal: create when no topic id, update otherwise. */
  const handleSaveForm = useCallback(async () => {
    if (form === null || saving || !serverlessMode) {
      return;
    }
    const trimmedTitle = form.title.trim();
    if (!trimmedTitle) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const db = await getLocalDatabase();
      if (form.topicId === null) {
        const created = await createWordTopic(db, {
          title: trimmedTitle,
          description: form.description.trim(),
          extra_prompt: form.extraPrompt.trim(),
        });
        setForm(null);
        navigation.navigate('WordTopic', { topicId: created.id });
      } else {
        await updateWordTopic(db, form.topicId, {
          title: trimmedTitle,
          description: form.description.trim(),
          extra_prompt: form.extraPrompt.trim(),
        });
        setForm(null);
        setReloadKey(key => key + 1);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [form, saving, serverlessMode, navigation]);

  const handleDeleteTopic = useCallback(
    (item: WordTopicSummary) => {
      if (deletingId !== null) {
        return;
      }
      setDeleteError(null);
      setDeleteTarget(item);
    },
    [deletingId],
  );

  const cancelDeleteTopic = useCallback(() => {
    if (deletingId !== null) {
      return;
    }
    setDeleteTarget(null);
    setDeleteError(null);
  }, [deletingId]);

  /**
   * Delete the confirmed topic. The schema cascades its words and review log,
   * so a single DELETE clears all related data. Failures keep the dialog open
   * with the message; the row is removed only after the write succeeds.
   */
  const confirmDeleteTopic = useCallback(async () => {
    if (deletingId !== null || deleteTarget === null) {
      return;
    }
    const target = deleteTarget;
    setDeletingId(target.id);
    setDeleteError(null);
    try {
      const db = await getLocalDatabase();
      await deleteWordTopic(db, target.id);
      setTopics(previous => previous.filter(topic => topic.id !== target.id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }, [deletingId, deleteTarget]);

  const formTitleInvalid = form !== null && form.title.trim() === '';

  return (
    <Screen style={styles.container} testID="word-topics-screen">
      <ScreenHeader style={styles.header}>
        <Text style={styles.title}>Word bank</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New topic"
          testID="word-topics-new"
          onPress={handleNewTopic}
          style={({ pressed }) => [styles.newTopicButton, pressed && styles.pressedFade]}
          disabled={!serverlessMode}>
          <Icon name="plus" size={20} color={colors.onPrimary} />
        </Pressable>
      </ScreenHeader>

      {serverMode ? (
        <View style={styles.centered} testID="word-mode-notice">
          <Text style={styles.stateText}>{MODE_NOTICE_TEXT}</Text>
        </View>
      ) : modeStatus !== 'ready' || loading ? (
        <View style={styles.centered} testID="word-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.centered} testID="word-error">
          <Text role="alert" style={styles.errorText}>
            {error}
          </Text>
          <Pressable testID="word-retry" onPress={() => setReloadKey(key => key + 1)}>
            <Text style={styles.actionText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {serverMode ? null : topics.length === 0 ? (
        <View style={styles.centered} testID="word-empty">
          <Text style={styles.stateText}>No topics yet. Tap the + above to create one.</Text>
        </View>
      ) : (
        <ScreenList
          data={topics}
          keyExtractor={item => String(item.id)}
          renderItem={({ item, index }) => (
            <>
              {index > 0 ? <View style={styles.rowDivider} /> : null}
              <WordTopicRow
                item={item}
                onPress={handleTopicPress}
                onEdit={handleEditTopic}
                onDelete={handleDeleteTopic}
                deleting={deletingId === item.id}
                colors={colors}
                styles={styles}
              />
            </>
          )}
          contentContainerStyle={styles.listContent}
          onRefresh={() => setReloadKey(key => key + 1)}
          refreshing={loading}
        />
      )}

      {/* Create / edit topic form. */}
      <Modal
        animationType="fade"
        onRequestClose={() => {
          if (!saving) {
            setForm(null);
          }
        }}
        testID="word-topic-form-modal"
        transparent
        visible={form !== null}>
        <View style={styles.backdrop}>
          <View style={styles.modalCard} accessibilityViewIsModal>
            <Text style={styles.modalTitle} testID="word-topic-form-title">
              {form?.topicId === null || form === null ? 'New topic' : 'Edit topic'}
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
                onChangeText={title =>
                  setForm(previous => (previous ? { ...previous, title } : previous))
                }
                style={styles.input}
                testID="word-topic-form-title-input"
                autoFocus
              />

              <Text style={styles.inputLabel}>Learner context (recommended)</Text>
              <TextInput
                placeholder={LEARNER_CONTEXT_PLACEHOLDER}
                value={form?.description ?? ''}
                onChangeText={description =>
                  setForm(previous => (previous ? { ...previous, description } : previous))
                }
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
                onChangeText={extraPrompt =>
                  setForm(previous => (previous ? { ...previous, extraPrompt } : previous))
                }
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
                    setForm(null);
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
                accessibilityState={{ disabled: saving || formTitleInvalid, busy: saving }}
                testID="word-topic-form-save"
                onPress={() => {
                  // handleSaveForm handles its own errors, so it never rejects.
                  handleSaveForm();
                }}
                disabled={saving || formTitleInvalid}
                style={({ pressed }) => [
                  styles.modalButton,
                  styles.modalPrimaryButton,
                  (saving || formTitleInvalid) && styles.modalDisabled,
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

      {/* Delete confirmation. */}
      <Modal
        animationType="fade"
        onRequestClose={cancelDeleteTopic}
        testID="word-topic-delete-modal"
        transparent
        visible={deleteTarget !== null}>
        <View style={styles.backdrop}>
          <View style={styles.modalCard} accessibilityViewIsModal>
            <Text style={styles.modalTitle} testID="word-topic-delete-title">
              Delete topic?
            </Text>
            <Text style={styles.hint} testID="word-topic-delete-message">
              {`"${deleteTarget?.title ?? ''}" and its words and practice history will be ` +
                'permanently deleted. This cannot be undone.'}
            </Text>

            {deleteError ? (
              <Text role="alert" style={styles.modalError} testID="word-topic-delete-error">
                {deleteError}
              </Text>
            ) : null}

            <View style={styles.modalFooter}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: deletingId !== null }}
                testID="word-topic-delete-cancel"
                onPress={cancelDeleteTopic}
                disabled={deletingId !== null}
                style={({ pressed }) => [
                  styles.modalButton,
                  styles.modalCancelButton,
                  deletingId !== null && styles.modalDisabled,
                  pressed && styles.modalDisabled,
                ]}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: deletingId !== null, busy: deletingId !== null }}
                testID="word-topic-delete-confirm"
                onPress={() => {
                  // confirmDeleteTopic handles its own errors, so it never rejects.
                  confirmDeleteTopic();
                }}
                disabled={deletingId !== null}
                style={({ pressed }) => [
                  styles.modalButton,
                  styles.modalDangerButton,
                  deletingId !== null && styles.modalDisabled,
                  pressed && styles.modalDisabled,
                ]}>
                {deletingId !== null ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalPrimaryText}>Delete</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
