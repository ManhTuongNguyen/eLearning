/**
 * Speaking history screen: shows the user's past speaking practice sessions.
 * Lists records from the local SQLite database with title, date, duration,
 * word count, and a delete action. Each saved record with a reading text is
 * also the entry point to practice it again — the WHOLE row is pressable and
 * pushes SpeakingPractice with the stored text, so the screen reopens
 * directly in the reading phase without a provider call (the nested Delete
 * button keeps its own tap target). Each record with a text additionally
 * carries a "Listen" button at the bottom of the row: it reopens the same
 * text in TTS listen mode, where the engine reads it aloud and the
 * teleprompter scroll follows the playback pace. Serverless mode only — no
 * backend traffic.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SCREEN_GUTTER, SCREEN_TOP_SPACING, Screen, ScreenList } from '../components/ScreenLayout';
import { ScreenTitleBar } from '../components/ScreenTitleBar';
import { getLocalDatabase } from '../db/database';
import {
  deleteSpeakingPracticeRecord,
  listSpeakingPracticeRecords,
} from '../db/speakingPracticeRepository';
import type { LocalPracticeHistoryRecord } from '../db/types';
import type { SpeakingHistoryScreenProps } from '../navigation/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { describeError } from '../utils/describeError';

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
  onDelete: (id: number) => void;
  confirmingDelete: boolean;
  colors: ThemeColors;
}

function RecordRow({
  record,
  onPractice,
  onListen,
  onDelete,
  confirmingDelete,
  colors,
}: RecordRowProps) {
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
    // The whole row reopens the saved text for another reading; the Delete
    // button nested inside still wins the tap when you press it directly.
    <Pressable
      onPress={canPractice ? () => onPractice(record) : undefined}
      style={styles.container}
      accessibilityRole={canPractice ? 'button' : undefined}
      accessibilityLabel={canPractice ? `Practice speaking again: ${record.title}` : undefined}
      testID={canPractice ? 'history-practice-again' : undefined}>
      <View style={styles.topRow}>
        <View style={styles.content}>{content}</View>
        {confirmingDelete ? (
          <View style={styles.confirmRow}>
            <Pressable
              onPress={() => onDelete(record.id)}
              style={[styles.button, styles.confirmButton]}
              accessibilityRole="button"
              accessibilityLabel="Confirm delete"
              testID="history-confirm-delete">
              <Text style={styles.confirmButtonText}>Delete</Text>
            </Pressable>
            <Pressable
              onPress={() => {}}
              style={[styles.button, styles.cancelButton]}
              accessibilityRole="button"
              accessibilityLabel="Cancel delete"
              testID="history-cancel-delete">
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => onDelete(record.id)}
            style={styles.deleteButton}
            accessibilityRole="button"
            accessibilityLabel="Delete this practice session"
            testID="history-delete">
            <Text style={styles.deleteButtonText}>Delete</Text>
          </Pressable>
        )}
      </View>
      {canPractice ? (
        // TTS listen mode: the engine reads the saved text aloud and the
        // scroll follows the spoken pace. Sits BELOW the row so it never
        // competes with the whole-row "practice again" tap or Delete.
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
    confirmRow: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 8,
    },
    button: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
    },
    confirmButton: {
      backgroundColor: c.danger,
    },
    confirmButtonText: {
      color: '#ffffff',
      fontSize: 13,
      fontWeight: '600',
    },
    cancelButton: {
      backgroundColor: c.borderStrong,
    },
    cancelButtonText: {
      color: c.textPrimary,
      fontSize: 13,
      fontWeight: '600',
    },
    deleteButton: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.danger,
      borderRadius: 8,
      marginLeft: 8,
    },
    deleteButtonText: {
      color: c.danger,
      fontSize: 13,
      fontWeight: '600',
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
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 16,
    },
    title: {
      fontSize: 26,
      fontWeight: '700',
      color: c.textPrimary,
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
  const [deletingId, setDeletingId] = useState<number | null>(null);

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
    } finally {
      setDeletingId(null);
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
              onDelete={handleDelete}
              confirmingDelete={deletingId === item.id}
              colors={colors}
            />
          )}
          testID="speaking-history-list"
        />
      )}
    </Screen>
  );
}
