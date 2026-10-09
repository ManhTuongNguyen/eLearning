/**
 * Speaking history screen: shows the user's past speaking practice sessions.
 * Lists records from the local SQLite database with title, date, duration,
 * word count, and a delete action. Each saved record with a reading text is
 * also the entry point to practice it again — the WHOLE row is pressable and
 * pushes SpeakingPractice with the stored text, so the screen reopens
 * directly in the reading phase without a provider call (the nested Delete
 * button keeps its own tap target). Serverless mode only — no backend
 * traffic.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';

import {getLocalDatabase} from '../db/database';
import {listSpeakingPracticeRecords, deleteSpeakingPracticeRecord} from '../db/speakingPracticeRepository';
import type {LocalPracticeHistoryRecord} from '../db/types';
import type {SpeakingHistoryScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

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

/**
 * Extract a readable message from any thrown value: native SQLite and other
 * modules sometimes reject with plain objects or strings instead of Errors,
 * which used to collapse into a useless 'unknown error'.
 */
function describeError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message;
    }
    try {
      const serialized = JSON.stringify(err);
      if (serialized && serialized !== '{}') {
        return serialized.slice(0, 300);
      }
    } catch {
      // Fall through to the generic text.
    }
  }
  return 'unknown error';
}

interface RecordRowProps {
  record: LocalPracticeHistoryRecord;
  onPractice: (record: LocalPracticeHistoryRecord) => void;
  onDelete: (id: number) => void;
  confirmingDelete: boolean;
  colors: ThemeColors;
}

function RecordRow({
  record,
  onPractice,
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
      accessibilityLabel={
        canPractice ? `Practice speaking again: ${record.title}` : undefined
      }
      testID={canPractice ? 'history-practice-again' : undefined}>
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
    </Pressable>
  );
}

function createRowStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      padding: 12,
      marginHorizontal: 16,
      marginVertical: 6,
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
  });
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: 16,
      paddingHorizontal: 16,
      paddingBottom: 24,
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
    backLink: {
      fontSize: 15,
      fontWeight: '600',
      color: c.accent,
      paddingVertical: 4,
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
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
    },
  });
}

export function SpeakingHistoryScreen({navigation}: SpeakingHistoryScreenProps) {
  const {colors} = useTheme();
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

  if (loading) {
    return (
      <View style={styles.container} testID="speaking-history-screen">
        <View style={styles.header}>
          <Text style={styles.title}>Speaking history</Text>
          <Pressable onPress={() => navigation.goBack()} testID="speaking-history-back">
            <Text style={styles.backLink}>Close</Text>
          </Pressable>
        </View>
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="speaking-history-screen">
      <View style={styles.header}>
        <Text style={styles.title}>Speaking history</Text>
        <Pressable onPress={() => navigation.goBack()} testID="speaking-history-back">
          <Text style={styles.backLink}>Close</Text>
        </Pressable>
      </View>

      {error !== null ? (
        <Text role="alert" style={styles.error} testID="speaking-history-error">
          {error}
        </Text>
      ) : null}

      {records.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            No speaking practice sessions yet.
          </Text>
        </View>
      ) : (
        <FlatList
          data={records}
          keyExtractor={item => String(item.id)}
          renderItem={({item}) => (
            <RecordRow
              record={item}
              onPractice={handlePractice}
              onDelete={handleDelete}
              confirmingDelete={deletingId === item.id}
              colors={colors}
            />
          )}
          testID="speaking-history-list"
        />
      )}
    </View>
  );
}
