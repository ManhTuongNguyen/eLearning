/**
 * Real-life sentences topics hub (TASK-SENT-008).
 *
 * Lists the learner's topics newest first, each with its sentence count and the
 * number of sentences due today, and lets a learner create one. A topic needs
 * a title; the description is optional and may be left blank or filled with a
 * real-life scenario such as "meeting someone new in a new city".
 *
 * A topic row carries a ⋮ overflow menu with the per-topic settings (learn
 * ahead limit) and Delete. Deleting asks for confirmation and then removes the
 * topic together with its sentences and review history (the schema's
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
import {
  deleteSentenceTopic,
  listSentenceTopics,
  updateSentenceTopic,
} from '../db/sentenceRepository';
import type { SentenceTopicSummary } from '../db/types';
import { useApplicationMode } from '../mode/ModeContext';
import type { SentenceTopicsScreenProps } from '../navigation/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import {
  DEFAULT_TOPIC_PRACTICE_SETTINGS,
  PracticeSettingsModal,
  type TopicPracticeSettings,
} from './PracticeSettingsModal';

const MODE_NOTICE_TEXT =
  'Real-life sentences are saved on this device only. Switch to server mode to ' +
  'manage your server account — your local sentences are never sent there.';

/** Describe exactly what the cascade removes, avoiding "0 sentences". */
function describeDeletedTopic(sentenceCount: number): string {
  if (sentenceCount === 0) {
    return 'its practice history';
  }
  if (sentenceCount === 1) {
    return 'its sentence and practice history';
  }
  return `its ${sentenceCount} sentences and practice history`;
}

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: SCREEN_TOP_SPACING,
    },
    newTopicButton: {
      // Compact 32x32 circle so the header row height matches the title text
      // (a 44x44 button inflated the row and pushed the title down).
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
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

export function SentenceTopicsScreen({ navigation }: SentenceTopicsScreenProps) {
  const { status: modeStatus, mode } = useApplicationMode();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [topics, setTopics] = useState<SentenceTopicSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SentenceTopicSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [menuTarget, setMenuTarget] = useState<{
    item: SentenceTopicSummary;
    anchor: ContextMenuAnchor;
  } | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<SentenceTopicSummary | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

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
      const items = await listSentenceTopics(db);
      setTopics(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [serverlessMode]);

  const refresh = useCallback(() => {
    setReloadKey(key => key + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional reload trigger
  useEffect(() => {
    loadTopics();
  }, [loadTopics, reloadKey]);

  // Re-list when the screen regains focus so it reflects topics added or
  // removed while it was backgrounded (the same contract as HistoryScreen).
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('focus', () => {
      if (serverlessMode) {
        refresh();
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, serverlessMode, refresh]);

  // --- Render -------------------------------------------------------------
  const handleTopicPress = useCallback(
    (item: SentenceTopicSummary) => navigation.navigate('SentenceTopic', { topicId: item.id }),
    [navigation],
  );

  const handleNewTopic = useCallback(() => {
    navigation.navigate('SentenceTopicNew');
  }, [navigation]);

  /**
   * Open the themed confirmation dialog. Nothing is written until the learner
   * presses the destructive button inside it.
   */
  const handleDeleteTopic = useCallback(
    (item: SentenceTopicSummary) => {
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
   * Delete the confirmed topic. The schema cascades its sentences and review
   * log, so a single DELETE clears all related data. Failures keep the dialog
   * open with the message; the row is removed only after the write succeeds.
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
      await deleteSentenceTopic(db, target.id);
      setTopics(previous => previous.filter(topic => topic.id !== target.id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }, [deletingId, deleteTarget]);

  /** The ⋮ actions of the row that opened the menu. */
  const menuItems: readonly ContextMenuItem[] = useMemo(() => {
    const target = menuTarget?.item ?? null;
    if (target === null) {
      return [];
    }
    return [
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
  }, [menuTarget, handleDeleteTopic]);

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
        await updateSentenceTopic(db, settingsTarget.id, settings);
        setSettingsTarget(null);
        setReloadKey(key => key + 1);
      } catch (err) {
        setSettingsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingsSaving(false);
      }
    },
    [settingsTarget, settingsSaving],
  );

  return (
    <Screen style={styles.container} testID="sentence-topics-screen">
      <ScreenTitleBar
        title="Real-life sentences"
        onBack={() => navigation.goBack()}
        backTestID="sentence-topics-back"
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New topic"
            testID="sentence-topics-new"
            onPress={handleNewTopic}
            style={({ pressed }) => [styles.newTopicButton, pressed && styles.pressedFade]}
            disabled={!serverlessMode}>
            <Icon name="plus" size={22} color={colors.onPrimary} />
          </Pressable>
        }
      />

      {serverMode ? (
        <View style={styles.centered} testID="sentence-mode-notice">
          <Text style={styles.stateText}>{MODE_NOTICE_TEXT}</Text>
        </View>
      ) : modeStatus !== 'ready' || loading ? (
        <View style={styles.centered} testID="sentence-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.centered} testID="sentence-error">
          <Text role="alert" style={styles.errorText}>
            {error}
          </Text>
          <Pressable testID="sentence-retry" onPress={() => setReloadKey(key => key + 1)}>
            <Text style={styles.actionText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {serverMode ? null : topics.length === 0 ? (
        <View style={styles.centered} testID="sentence-empty">
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
                icon="sentences"
                countLabel={`${item.sentence_count} sentence${item.sentence_count === 1 ? '' : 's'}`}
                dueCount={item.due_count}
                onPress={() => handleTopicPress(item)}
                onMenuPress={event =>
                  setMenuTarget({
                    item,
                    anchor: {
                      x: event.nativeEvent.pageX,
                      y: event.nativeEvent.pageY - 25,
                    },
                  })
                }
                testID={`topic-${item.id}`}
                menuTestID={`topic-menu-${item.id}`}
              />
            </>
          )}
          contentContainerStyle={styles.listContent}
          onRefresh={() => setReloadKey(key => key + 1)}
          refreshing={loading}
        />
      )}

      <ConfirmModal
        visible={deleteTarget !== null}
        title="Delete topic?"
        message={`"${deleteTarget?.title ?? ''}" and ${describeDeletedTopic(deleteTarget?.sentence_count ?? 0)} will be permanently deleted. This cannot be undone.`}
        busy={deletingId !== null}
        error={deleteError}
        onCancel={cancelDeleteTopic}
        onConfirm={() => {
          // confirmDeleteTopic handles its own errors, so it never rejects.
          confirmDeleteTopic();
        }}
        testID="delete-topic"
      />

      {/* Row context menu (learn ahead / delete), anchored to the ⋮. */}
      <ContextMenu
        visible={menuTarget !== null}
        anchor={menuTarget?.anchor ?? null}
        items={menuItems}
        onCancel={() => setMenuTarget(null)}
        testID="sentence-topic-row-menu"
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
