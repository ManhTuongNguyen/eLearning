/**
 * One history list row (TASK-055/056; TASK-AUDIT-014 decomposition of the
 * history screen): the plain pressable row plus its two inline variants —
 * the rename editor and the delete confirmation. The screen owns the flows
 * and their persistence; this component renders whichever variant is active
 * for its session and reports intents back through callbacks.
 */
import React, {useMemo} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';

import type {Session} from '../api/sessions';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

function createRowStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
      marginBottom: 10,
    },
    rowTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    rowTopic: {
      fontSize: 13,
      color: c.textSecondary,
      marginTop: 4,
    },
    renameLink: {
      fontSize: 13,
      fontWeight: '600',
      color: c.accent,
      alignSelf: 'flex-start',
    },
    rowActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      marginTop: 10,
    },
    deleteLink: {
      fontSize: 13,
      fontWeight: '600',
      color: c.danger,
      alignSelf: 'flex-start',
    },
    confirmText: {
      fontSize: 14,
      color: c.textPrimary,
      marginBottom: 12,
    },
    editor: {
      gap: 10,
    },
    editorInput: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 15,
      color: c.textPrimary,
      backgroundColor: c.background,
    },
    editorActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    saveButton: {
      backgroundColor: c.primary,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 18,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    saveButtonText: {
      color: c.onPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    cancelButton: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 18,
    },
    cancelButtonText: {
      color: c.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    deleteButton: {
      backgroundColor: c.danger,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 18,
    },
    deleteButtonText: {
      color: c.onPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
  });
}

interface HistorySessionRowProps {
  session: Session;
  /** The inline rename editor replaces this row's plain body. */
  renaming: boolean;
  /** The inline delete confirmation replaces this row's plain body. */
  confirmingDelete: boolean;
  draftTitle: string;
  savingRename: boolean;
  deleting: boolean;
  onDraftTitleChange(text: string): void;
  onRenameSave(): void;
  onRenameCancel(): void;
  onDeleteConfirm(): void;
  onDeleteCancel(): void;
  onStartRename(): void;
  onStartDelete(): void;
  onOpen(): void;
}

export function HistorySessionRow({
  session,
  renaming,
  confirmingDelete,
  draftTitle,
  savingRename,
  deleting,
  onDraftTitleChange,
  onRenameSave,
  onRenameCancel,
  onDeleteConfirm,
  onDeleteCancel,
  onStartRename,
  onStartDelete,
  onOpen,
}: HistorySessionRowProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createRowStyles(colors), [colors]);

  if (renaming) {
    return (
      <View style={[styles.row, styles.editor]} testID={`history-editor-${session.id}`}>
        <TextInput
          style={styles.editorInput}
          value={draftTitle}
          onChangeText={onDraftTitleChange}
          editable={!savingRename}
          autoFocus
          accessibilityLabel="Conversation name"
          testID="history-rename-input"
        />
        <View style={styles.editorActions}>
          <Pressable
            style={[
              styles.saveButton,
              (savingRename || draftTitle.trim() === '') && styles.buttonDisabled,
            ]}
            disabled={savingRename || draftTitle.trim() === ''}
            onPress={() => {
              onRenameSave();
            }}
            accessibilityRole="button"
            accessibilityLabel="Save conversation name"
            accessibilityState={{disabled: savingRename || draftTitle.trim() === ''}}
            testID="history-rename-save">
            <Text style={styles.saveButtonText}>
              {savingRename ? 'Saving…' : 'Save'}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.cancelButton, savingRename && styles.buttonDisabled]}
            disabled={savingRename}
            onPress={() => {
              onRenameCancel();
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel renaming"
            accessibilityState={{disabled: savingRename}}
            testID="history-rename-cancel">
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (confirmingDelete) {
    return (
      <View style={styles.row} testID={`history-confirm-${session.id}`}>
        <Text style={styles.confirmText}>
          Delete “{session.title}”? This cannot be undone.
        </Text>
        <View style={styles.editorActions}>
          <Pressable
            style={[styles.deleteButton, deleting && styles.buttonDisabled]}
            disabled={deleting}
            onPress={() => {
              onDeleteConfirm();
            }}
            accessibilityRole="button"
            accessibilityLabel={`Confirm deleting ${session.title}`}
            accessibilityState={{disabled: deleting}}
            testID="history-delete-confirm">
            <Text style={styles.deleteButtonText}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.cancelButton, deleting && styles.buttonDisabled]}
            disabled={deleting}
            onPress={() => {
              onDeleteCancel();
            }}
            accessibilityRole="button"
            accessibilityLabel="Keep this conversation"
            accessibilityState={{disabled: deleting}}
            testID="history-delete-cancel">
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <Pressable style={styles.row} onPress={onOpen} testID={`history-item-${session.id}`}>
      <Text style={styles.rowTitle}>{session.title}</Text>
      {session.topic ? (
        <Text style={styles.rowTopic} numberOfLines={1}>
          {session.topic}
        </Text>
      ) : null}
      <View style={styles.rowActions}>
        <Pressable
          onPress={onStartRename}
          accessibilityRole="button"
          accessibilityLabel={`Rename conversation ${session.title}`}
          testID={`history-rename-${session.id}`}>
          <Text style={styles.renameLink}>Rename</Text>
        </Pressable>
        <Pressable
          onPress={onStartDelete}
          accessibilityRole="button"
          accessibilityLabel={`Delete conversation ${session.title}`}
          testID={`history-delete-${session.id}`}>
          <Text style={styles.deleteLink}>Delete</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}
