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
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ContextMenuAnchor, ContextMenuItem } from '../components/ContextMenu';
import { ContextMenu } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { SCREEN_GUTTER, Screen, ScreenHeader, ScreenList } from '../components/ScreenLayout';
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
import { DeleteTopicModal } from './DeleteTopicModal';
import {
  DEFAULT_TOPIC_PRACTICE_SETTINGS,
  PracticeSettingsModal,
  type TopicPracticeSettings,
} from './PracticeSettingsModal';

const MODE_NOTICE_TEXT =
  'Real-life sentences are saved on this device only. Switch to server mode to ' +
  'manage your server account — your local sentences are never sent there.';

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
    rowMenuButton: {
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
    badgeLabel: {
      fontSize: 12,
      fontWeight: '600',
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

type TopicRowProps = {
  item: SentenceTopicSummary;
  onPress: (item: SentenceTopicSummary) => void;
  onMenu: (item: SentenceTopicSummary, event: GestureResponderEvent) => void;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
};

function SentenceTopicRow({ item, onPress, onMenu, colors, styles }: TopicRowProps) {
  const dueBadge =
    item.due_count > 0 ? (
      <View style={styles.badge} testID={`topic-${item.id}-due`}>
        <Text style={[styles.badgeLabel, { color: colors.onPrimary }]}>{item.due_count} due</Text>
      </View>
    ) : (
      <View style={styles.badgeGhost} testID={`topic-${item.id}-done`}>
        <Text style={[styles.badgeLabel, { color: colors.textMuted }]}>all done</Text>
      </View>
    );

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.title} — ${item.sentence_count} sentences, ${item.due_count} due`}
        testID={`topic-${item.id}`}
        onPress={() => onPress(item)}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressedFade]}>
        <View style={styles.rowIcon}>
          <Icon name="sentences" color={colors.accent} />
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
              {item.sentence_count} sentence{item.sentence_count === 1 ? '' : 's'}
            </Text>
            {dueBadge}
          </View>
        </View>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Topic actions for ${item.title}`}
        testID={`topic-menu-${item.id}`}
        onPress={event => onMenu(item, event)}
        style={({ pressed }) => [styles.rowMenuButton, pressed && styles.pressedFade]}>
        <Icon name="more" size={18} color={colors.textMuted} />
      </Pressable>
    </View>
  );
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
      <ScreenHeader style={styles.header}>
        <Text style={styles.title}>Real-life sentences</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New topic"
          testID="sentence-topics-new"
          onPress={handleNewTopic}
          style={({ pressed }) => [styles.newTopicButton, pressed && styles.pressedFade]}
          disabled={!serverlessMode}>
          <Icon name="plus" size={20} color={colors.onPrimary} />
        </Pressable>
      </ScreenHeader>

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
              <SentenceTopicRow
                item={item}
                onPress={handleTopicPress}
                onMenu={(rowItem, event) =>
                  setMenuTarget({
                    item: rowItem,
                    anchor: {
                      x: event.nativeEvent.pageX,
                      y: event.nativeEvent.pageY,
                    },
                  })
                }
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

      <DeleteTopicModal
        visible={deleteTarget !== null}
        topicTitle={deleteTarget?.title ?? ''}
        sentenceCount={deleteTarget?.sentence_count ?? 0}
        deleting={deletingId !== null}
        error={deleteError}
        onCancel={cancelDeleteTopic}
        onConfirm={() => {
          // confirmDeleteTopic handles its own errors, so it never rejects.
          confirmDeleteTopic();
        }}
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
