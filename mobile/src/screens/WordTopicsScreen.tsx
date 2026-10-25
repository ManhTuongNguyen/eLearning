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
 * A topic row carries a ⋮ overflow menu with Edit, the per-topic settings
 * (learn ahead limit) and Delete. Deleting asks for confirmation and then
 * removes the topic together with its words and review history (the schema's
 * `ON DELETE CASCADE`).
 *
 * The whole feature is serverless-only: until the persisted mode has been
 * restored the screen shows its spinner, and in server mode it replaces the
 * list with an explicit notice instead of touching the local database.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ConfirmModal } from '../components/ConfirmModal';
import type { ContextMenuAnchor, ContextMenuItem } from '../components/ContextMenu';
import { ContextMenu } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { SCREEN_GUTTER, SCREEN_TOP_SPACING, Screen, ScreenList } from '../components/ScreenLayout';
import { ScreenTitleBar } from '../components/ScreenTitleBar';
import { TopicRow } from '../components/TopicRow';
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
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { describeError } from '../utils/describeError';
import {
  DEFAULT_TOPIC_PRACTICE_SETTINGS,
  PracticeSettingsModal,
  type TopicPracticeSettings,
} from './PracticeSettingsModal';
import { EMPTY_TOPIC_FORM, WordTopicFormModal } from './WordTopicFormModal';

const MODE_NOTICE_TEXT =
  'The word bank is saved on this device only. Switch to server mode to manage ' +
  'your server account — your local words are never sent there.';

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
  });
}

/** Which the form modal is for: creating a new topic or editing an existing one. */
interface TopicFormState {
  /** null while creating; the id of the topic being edited otherwise. */
  topicId: number | null;
  title: string;
  description: string;
  extraPrompt: string;
}

const _EMPTY_FORM: TopicFormState = { topicId: null, title: '', description: '', extraPrompt: '' };

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
  const [menuTarget, setMenuTarget] = useState<{
    item: WordTopicSummary;
    anchor: ContextMenuAnchor;
  } | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<WordTopicSummary | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
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
      setError(describeError(err));
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
    setForm(EMPTY_TOPIC_FORM);
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
      setSaveError(describeError(err));
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
      setDeleteError(describeError(err));
    } finally {
      setDeletingId(null);
    }
  }, [deletingId, deleteTarget]);

  const formTitleInvalid = form !== null && form.title.trim() === '';

  /**
   * The ⋮ actions of the row that opened the menu. The seeded collected-words
   * topic offers only its practice settings: its title, description and extra
   * prompt are locked and it cannot be deleted.
   */
  const menuItems: readonly ContextMenuItem[] = useMemo(() => {
    const target = menuTarget?.item ?? null;
    if (target === null) {
      return [];
    }
    const editItems: readonly ContextMenuItem[] = target.is_system
      ? []
      : [
          {
            key: 'edit',
            label: 'Edit topic',
            icon: 'edit',
            onPress: () => {
              setMenuTarget(null);
              handleEditTopic(target);
            },
          },
        ];
    const deleteItems: readonly ContextMenuItem[] = target.is_system
      ? []
      : [
          {
            key: 'delete',
            label: 'Delete topic',
            icon: 'trash',
            danger: true,
            onPress: () => {
              setMenuTarget(null);
              handleDeleteTopic(target);
            },
          },
        ];
    return [
      ...editItems,
      {
        key: 'practice-settings',
        label: 'Practice settings',
        icon: 'settings',
        detail: `${target.learn_ahead_minutes}m ahead · ${target.max_session_cards}/session`,
        onPress: () => {
          setMenuTarget(null);
          setSettingsError(null);
          setSettingsTarget(target);
        },
      },
      ...deleteItems,
    ];
  }, [menuTarget, handleEditTopic, handleDeleteTopic]);

  /**
   * Persist the settings drafted in the modal. Failures keep the dialog open
   * with the message; success closes it and reloads the list so the due badges
   * reflect the new limits immediately.
   */
  const handleSaveSettings = useCallback(
    async (settings: TopicPracticeSettings) => {
      if (settingsTarget === null || settingsSaving) {
        return;
      }
      setSettingsSaving(true);
      setSettingsError(null);
      try {
        const db = await getLocalDatabase();
        await updateWordTopic(db, settingsTarget.id, settings);
        setSettingsTarget(null);
        setReloadKey(key => key + 1);
      } catch (err) {
        setSettingsError(describeError(err));
      } finally {
        setSettingsSaving(false);
      }
    },
    [settingsTarget, settingsSaving],
  );

  return (
    <Screen style={styles.container} testID="word-topics-screen">
      <ScreenTitleBar
        title="Word bank"
        onBack={() => navigation.goBack()}
        backTestID="word-topics-back"
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New topic"
            testID="word-topics-new"
            onPress={handleNewTopic}
            style={({ pressed }) => [styles.newTopicButton, pressed && styles.pressedFade]}
            disabled={!serverlessMode}>
            <Icon name="plus" size={20} color={colors.onPrimary} />
          </Pressable>
        }
      />

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
              <TopicRow
                title={item.title}
                description={item.description}
                icon="words"
                countLabel={`${item.word_count} word${item.word_count === 1 ? '' : 's'}`}
                dueCount={item.due_count}
                onPress={() => handleTopicPress(item)}
                onMenuPress={event =>
                  setMenuTarget({
                    item,
                    anchor: {
                      x: event.nativeEvent.pageX,
                      y: event.nativeEvent.pageY,
                    },
                  })
                }
                testID={`word-topic-${item.id}`}
                menuTestID={`word-topic-menu-${item.id}`}
              />
            </>
          )}
          contentContainerStyle={styles.listContent}
          onRefresh={() => setReloadKey(key => key + 1)}
          refreshing={loading}
        />
      )}

      {/* Create / edit topic form. */}
      <WordTopicFormModal
        form={form}
        saving={saving}
        saveError={saveError}
        titleInvalid={formTitleInvalid}
        onChangeField={patch =>
          setForm(previous => (previous ? { ...previous, ...patch } : previous))
        }
        onCancel={() => setForm(null)}
        onSave={() => {
          // handleSaveForm handles its own errors, so it never rejects.
          handleSaveForm();
        }}
      />

      {/* Delete confirmation. */}
      <ConfirmModal
        visible={deleteTarget !== null}
        title="Delete topic?"
        message={`"${deleteTarget?.title ?? ''}" and its words and practice history will be permanently deleted. This cannot be undone.`}
        busy={deletingId !== null}
        error={deleteError}
        onCancel={cancelDeleteTopic}
        onConfirm={() => {
          // confirmDeleteTopic handles its own errors, so it never rejects.
          confirmDeleteTopic();
        }}
        testID="word-topic-delete"
      />

      {/* Row context menu (edit / learn ahead / delete), anchored to the ⋮. */}
      <ContextMenu
        visible={menuTarget !== null}
        anchor={menuTarget?.anchor ?? null}
        items={menuItems}
        onCancel={() => setMenuTarget(null)}
        testID="word-topic-row-menu"
      />

      {/* Per-topic practice settings. */}
      <PracticeSettingsModal
        visible={settingsTarget !== null}
        topicTitle={settingsTarget?.title ?? ''}
        settings={settingsTarget ?? DEFAULT_TOPIC_PRACTICE_SETTINGS}
        saving={settingsSaving}
        error={settingsError}
        onCancel={() => {
          if (!settingsSaving) {
            setSettingsTarget(null);
            setSettingsError(null);
          }
        }}
        onSave={settings => {
          // handleSaveSettings handles its own errors, so it never rejects.
          handleSaveSettings(settings);
        }}
      />
    </Screen>
  );
}
