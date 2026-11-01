/**
 * Speaking history screen: shows the user's past speaking practice sessions.
 * Lists records from the local SQLite database with title, date, duration,
 * word count, and a ⋮ action menu (Edit / Delete). Each saved record with a
 * reading text is also the entry point to practice it again — the WHOLE row is
 * pressable and pushes SpeakingPractice with the stored text, so the screen
 * reopens directly in the reading phase without a provider call (the nested ⋮
 * button keeps its own tap target). Each record with a text additionally
 * carries a "Listen" button at the bottom of the row: it reopens the same
 * text in TTS listen mode, where the engine reads it aloud and the
 * teleprompter scroll follows the playback pace.
 *
 * The header's + button creates a custom topic: the learner supplies the title
 * and the reading content themselves (no AI call), the entry is saved to this
 * history, and the practice screen opens with it immediately. Edit reuses the
 * same form pre-filled with the row's title and content.
 *
 * Serverless mode only — no backend traffic.
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
import { SCREEN_GUTTER, SCREEN_TOP_SPACING, Screen, ScreenList } from '../components/ScreenLayout';
import { ScreenTitleBar } from '../components/ScreenTitleBar';
import { getLocalDatabase } from '../db/database';
import {
  createSpeakingPracticeRecord,
  deleteSpeakingPracticeRecord,
  estimateSpeakingMinutes,
  listSpeakingPracticeRecords,
  updateSpeakingPracticeRecord,
} from '../db/speakingPracticeRepository';
import type { LocalPracticeHistoryRecord } from '../db/types';
import type { SpeakingHistoryScreenProps } from '../navigation/types';
import { countWords } from '../practice/karaokeScroll';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { describeError } from '../utils/describeError';
import {
  EMPTY_SPEAKING_FORM,
  SpeakingPracticeFormModal,
  type SpeakingPracticeFormState,
} from './SpeakingPracticeFormModal';

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
}

interface RecordRowProps {
  record: LocalPracticeHistoryRecord;
  onPractice: (record: LocalPracticeHistoryRecord) => void;
  onListen: (record: LocalPracticeHistoryRecord) => void;
  onMenu: (record: LocalPracticeHistoryRecord, event: GestureResponderEvent) => void;
  colors: ThemeColors;
}

function RecordRow({ record, onPractice, onListen, onMenu, colors }: RecordRowProps) {
  const styles = useMemo(() => createRowStyles(colors), [colors]);
  const canPractice = record.text.trim().length > 0;

  const content = (
    <>
      <Text style={styles.title} numberOfLines={1}>
        {record.title}
      </Text>
      <View style={styles.metaRow}>
        <Text style={styles.meta}>{formatDate(record.created_at)}</Text>
        <Text style={styles.meta}>{formatMinutes(record.minutes)}</Text>
        <Text style={styles.meta}>{record.word_count} words</Text>
      </View>
      {record.text ? (
        <Text style={styles.preview} numberOfLines={2}>
          {record.text}
        </Text>
      ) : null}
    </>
  );

  return (
    // The whole row reopens the saved text for another reading; the ⋮ menu
    // button nested inside still wins the tap when you press it directly.
    <Pressable
      onPress={canPractice ? () => onPractice(record) : undefined}
      style={styles.container}
      accessibilityRole={canPractice ? 'button' : undefined}
      accessibilityLabel={canPractice ? `Practice speaking again: ${record.title}` : undefined}
      testID={canPractice ? 'history-practice-again' : undefined}>
      <View style={styles.topRow}>
        <View style={styles.content}>{content}</View>
        <Pressable
          onPress={event => onMenu(record, event)}
          style={styles.menuButton}
          accessibilityRole="button"
          accessibilityLabel={`Actions for ${record.title}`}
          testID="history-menu">
          <Icon name="more" size={18} color={colors.textMuted} />
        </Pressable>
      </View>
      {canPractice ? (
        // TTS listen mode: the engine reads the saved text aloud and the
        // scroll follows the spoken pace. Sits BELOW the row so it never
        // competes with the whole-row "practice again" tap or the ⋮ menu.
        <Pressable
          onPress={() => onListen(record)}
          style={styles.listenButton}
          accessibilityRole="button"
          accessibilityLabel={`Listen to this session with text to speech: ${record.title}`}
          testID="history-listen">
          <Text style={styles.listenButtonText}>Listen (text to speech)</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function createRowStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      padding: 12,
      marginVertical: 6,
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    content: {
      flex: 1,
    },
    title: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
      marginBottom: 4,
    },
    metaRow: {
      flexDirection: 'row',
      gap: 12,
      marginBottom: 6,
    },
    meta: {
      fontSize: 12,
      color: c.textSecondary,
    },
    preview: {
      fontSize: 13,
      color: c.textSecondary,
      lineHeight: 18,
    },
    menuButton: {
      width: 30,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    listenButton: {
      marginTop: 10,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.accentSoft,
      borderWidth: 1,
      borderColor: c.accent,
      alignItems: 'center',
    },
    listenButtonText: {
      color: c.accent,
      fontSize: 14,
      fontWeight: '600',
    },
  });
}

function createStyles(c: ThemeColors) {
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
    pressedFade: {
      opacity: 0.9,
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: SCREEN_GUTTER,
    },
    emptyText: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
    },
    error: {
      color: c.errorText,
      fontSize: 13,
      marginBottom: 12,
      paddingHorizontal: SCREEN_GUTTER,
    },
  });
}

export function SpeakingHistoryScreen({ navigation }: SpeakingHistoryScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [records, setRecords] = useState<LocalPracticeHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuTarget, setMenuTarget] = useState<{
    record: LocalPracticeHistoryRecord;
    anchor: ContextMenuAnchor;
  } | null>(null);
  const [form, setForm] = useState<SpeakingPracticeFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadRecords = useCallback(async () => {
    try {
      const db = await getLocalDatabase();
      const list = await listSpeakingPracticeRecords(db, 0);
      setRecords(list);
      setError(null);
    } catch (err) {
      setError(`Failed to load history: ${describeError(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  const handleDelete = useCallback(async (id: number) => {
    try {
      const db = await getLocalDatabase();
      await deleteSpeakingPracticeRecord(db, id);
      setRecords(prev => prev.filter(r => r.id !== id));
    } catch (err) {
      setError(`Failed to delete: ${describeError(err)}`);
    }
  }, []);

  /** Reopen a saved session's text in the practice screen for another read. */
  const handlePractice = useCallback(
    (record: LocalPracticeHistoryRecord) => {
      if (!record.text.trim()) {
        return;
      }
      navigation.navigate('SpeakingPractice', {
        text: record.text,
        material: record.title,
        minutes: record.minutes,
      });
    },
    [navigation],
  );

  /** Reopen a saved session's text in TTS listen mode (engine reads it). */
  const handleListen = useCallback(
    (record: LocalPracticeHistoryRecord) => {
      if (!record.text.trim()) {
        return;
      }
      navigation.navigate('SpeakingPractice', {
        text: record.text,
        material: record.title,
        minutes: record.minutes,
        mode: 'listen',
      });
    },
    [navigation],
  );

  const handleNewTopic = useCallback(() => {
    setSaveError(null);
    setForm(EMPTY_SPEAKING_FORM);
  }, []);

  const handleEdit = useCallback((record: LocalPracticeHistoryRecord) => {
    setSaveError(null);
    setForm({
      recordId: record.id,
      title: record.title,
      content: record.text,
    });
  }, []);

  /**
   * Persist the form modal. A new entry is created first and then opened in
   * the practice screen (no AI call); an edit updates the row in place.
   * The derived word count and estimated duration stay in sync with the
   * content the learner saved.
   */
  const handleSaveForm = useCallback(async () => {
    if (form === null || saving) {
      return;
    }
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const db = await getLocalDatabase();
      const wordCount = countWords(content);
      const minutes = estimateSpeakingMinutes(wordCount);
      if (form.recordId === null) {
        const created = await createSpeakingPracticeRecord(db, {
          userId: 0, // Anonymous user in serverless mode
          title,
          description: '',
          rawPrompt: '',
          englishLevel: 'AUTO',
          text: content,
          minutes,
          wordCount,
        });
        setRecords(prev => [created, ...prev]);
        setForm(null);
        navigation.navigate('SpeakingPractice', {
          text: created.text,
          material: created.title,
          minutes: created.minutes,
        });
      } else {
        const updated = await updateSpeakingPracticeRecord(db, form.recordId, {
          title,
          text: content,
          minutes,
          wordCount,
        });
        if (updated !== null) {
          setRecords(prev => prev.map(record => (record.id === updated.id ? updated : record)));
        }
        setForm(null);
      }
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  }, [form, saving, navigation]);

  const menuItems: readonly ContextMenuItem[] = useMemo(() => {
    const target = menuTarget?.record ?? null;
    if (target === null) {
      return [];
    }
    return [
      {
        key: 'edit',
        label: 'Edit',
        icon: 'edit',
        onPress: () => {
          setMenuTarget(null);
          handleEdit(target);
        },
      },
      {
        key: 'delete',
        label: 'Delete',
        icon: 'trash',
        danger: true,
        onPress: () => {
          setMenuTarget(null);
          // Deletion keeps its existing immediate behaviour.
          handleDelete(target.id);
        },
      },
    ];
  }, [menuTarget, handleEdit, handleDelete]);

  if (loading) {
    return (
      <Screen style={styles.container} testID="speaking-history-screen">
        <ScreenTitleBar
          title="Speaking history"
          onBack={() => navigation.goBack()}
          backTestID="speaking-history-back"
        />
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen style={styles.container} testID="speaking-history-screen">
      <ScreenTitleBar
        title="Speaking history"
        onBack={() => navigation.goBack()}
        backTestID="speaking-history-back"
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New custom topic"
            testID="speaking-history-new"
            onPress={handleNewTopic}
            style={({ pressed }) => [styles.newTopicButton, pressed && styles.pressedFade]}>
            <Icon name="plus" size={22} color={colors.accent} />
          </Pressable>
        }
      />

      {error !== null ? (
        <Text role="alert" style={styles.error} testID="speaking-history-error">
          {error}
        </Text>
      ) : null}

      {records.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No speaking practice sessions yet.</Text>
        </View>
      ) : (
        <ScreenList
          data={records}
          keyExtractor={item => String(item.id)}
          renderItem={({ item }) => (
            <RecordRow
              record={item}
              onPractice={handlePractice}
              onListen={handleListen}
              onMenu={(record, event) =>
                setMenuTarget({
                  record,
                  anchor: {
                    x: event.nativeEvent.pageX,
                    y: event.nativeEvent.pageY - 25,
                  },
                })
              }
              colors={colors}
            />
          )}
          testID="speaking-history-list"
        />
      )}

      {/* Row context menu (edit / delete), anchored to the ⋮. */}
      <ContextMenu
        visible={menuTarget !== null}
        anchor={menuTarget?.anchor ?? null}
        items={menuItems}
        onCancel={() => setMenuTarget(null)}
        testID="speaking-history-row-menu"
      />

      {/* Create a custom topic / edit a saved entry. */}
      <SpeakingPracticeFormModal
        form={form}
        saving={saving}
        saveError={saveError}
        onChangeField={patch =>
          setForm(previous => (previous ? { ...previous, ...patch } : previous))
        }
        onCancel={() => setForm(null)}
        onSave={() => {
          // handleSaveForm handles its own errors, so it never rejects.
          handleSaveForm();
        }}
      />
    </Screen>
  );
}
