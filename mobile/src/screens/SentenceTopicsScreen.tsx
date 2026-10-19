/**
 * Real-life sentences topics hub (TASK-SENT-008).
 *
 * Lists the learner's topics newest first, each with its sentence count and the
 * number of sentences due today, and lets a learner create one. A topic needs
 * a title; the description is optional and may be left blank or filled with a
 * real-life scenario such as "meeting someone new in a new city".
 *
 * The whole feature is serverless-only: until the persisted mode has been
 * restored the screen shows its spinner, and in server mode it replaces the
 * list with an explicit notice instead of touching the local database.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {Icon} from '../components/Icon';
import {getLocalDatabase} from '../db/database';
import {
  createSentenceTopic,
  listSentenceTopics,
} from '../db/sentenceRepository';
import type {SentenceTopicSummary} from '../db/types';
import {useApplicationMode} from '../mode/ModeContext';
import type {SentenceTopicsScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

const MODE_NOTICE_TEXT =
  'Real-life sentences are saved on this device only. Switch to server mode to ' +
  'manage your server account — your local sentences are never sent there.';

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: 16,
      paddingHorizontal: 20,
      paddingBottom: 16,
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
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 12,
    },
    newTopicButtonText: {
      color: c.onPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    newTopicForm: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 16,
      gap: 12,
      marginBottom: 16,
    },
    input: {
      backgroundColor: c.background,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: c.textPrimary,
    },
    inputLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    saveButton: {
      alignSelf: 'flex-end',
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    saveButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.primary,
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
      gap: 14,
      paddingVertical: 14,
      paddingHorizontal: 16,
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
      paddingBottom: 24,
      gap: 12,
    },
    badgeLabel: {
      fontSize: 12,
      fontWeight: '600',
    },
    actionRow: {
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'flex-end',
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
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
};

function SentenceTopicRow({item, onPress, colors, styles}: TopicRowProps) {
  const dueBadge = item.due_count > 0 ? (
    <View style={styles.badge} testID={`topic-${item.id}-due`}>
      <Text style={[styles.badgeLabel, {color: colors.onPrimary}]}>
        {item.due_count} due
      </Text>
    </View>
  ) : (
    <View style={styles.badgeGhost} testID={`topic-${item.id}-done`}>
      <Text style={[styles.badgeLabel, {color: colors.textMuted}]}>all done</Text>
    </View>
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title} — ${item.sentence_count} sentences, ${item.due_count} due`}
      testID={`topic-${item.id}`}
      onPress={() => onPress(item)}
      style={({pressed}) => [styles.row, pressed && styles.pressedFade]}
    >
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
  );
}

export function SentenceTopicsScreen({navigation}: SentenceTopicsScreenProps) {
  const {status: modeStatus, mode} = useApplicationMode();
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [topics, setTopics] = useState<SentenceTopicSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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

  // --- The "new topic" inline form ---------------------------------------
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setShowForm(false);
    setTitle('');
    setDescription('');
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const db = await getLocalDatabase();
      const created = await createSentenceTopic(db, {
        title: trimmedTitle,
        description: description.trim(),
      });
      resetForm();
      navigation.navigate('SentenceTopic', {topicId: created.id});
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [title, description, saving, navigation, resetForm]);

  const handleCancel = useCallback(() => {
    if (saving) {
      return;
    }
    resetForm();
  }, [saving, resetForm]);

  // --- Render -------------------------------------------------------------
  const handleTopicPress = useCallback(
    (item: SentenceTopicSummary) => navigation.navigate('SentenceTopic', {topicId: item.id}),
    [navigation],
  );

  return (
    <View style={styles.container} testID="sentence-topics-screen">
      <View style={styles.header}>
        <Text style={styles.title}>Real-life sentences</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New topic"
          testID="sentence-topics-new"
          onPress={() => setShowForm(true)}
          style={({pressed}) => [styles.newTopicButton, pressed && styles.pressedFade]}
          disabled={!serverlessMode}
        >
          <Icon name="plus" color={colors.onPrimary} />
        </Pressable>
      </View>

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

      {serverMode ? null : (
        <>
          {showForm ? (
            <View style={styles.newTopicForm} testID="sentence-new-topic-form">
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
                style={styles.input}
                testID="sentence-topic-description"
                multiline
              />
              {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
              <View style={styles.actionRow}>
                <Pressable
                  testID="sentence-topic-cancel"
                  onPress={handleCancel}
                  disabled={saving}
                  style={styles.saveButton}
                >
                  <Text style={styles.saveButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  testID="sentence-topic-save"
                  onPress={handleSave}
                  disabled={saving || !title.trim()}
                  style={({pressed}) => [styles.saveButton, pressed && styles.pressedFade]}
                >
                  {saving ? <ActivityIndicator size="small" color={colors.primary} /> : null}
                  <Text style={styles.saveButtonText}>Save</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {serverMode ? null : topics.length === 0 ? (
            <View style={styles.centered} testID="sentence-empty">
              <Text style={styles.stateText}>
                No topics yet. Tap the + above to create one.
              </Text>
            </View>
          ) : (
            <FlatList
              data={topics}
              keyExtractor={item => String(item.id)}
              renderItem={({item, index}) => (
                <>
                  {index > 0 ? <View style={styles.rowDivider} /> : null}
                  <SentenceTopicRow
                    item={item}
                    onPress={handleTopicPress}
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
        </>
      )}
    </View>
  );
}

