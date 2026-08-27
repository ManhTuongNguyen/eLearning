/**
 * History screen (SPEC TASK-055/056): the authenticated user's past sessions.
 * The data source follows the application mode (TASK-090): server mode reads
 * the backend — the API already returns sessions most-recently-updated first,
 * so pages render in delivery order, and further pages append through a
 * "Load more" control while the DRF envelope reports a next page. Serverless
 * mode instead lists the on-device SQLite conversations through the local
 * repository, so server history disappears and local history appears with a
 * mode switch, without any backend traffic. The first page loads on mount
 * (and on retry); loading, empty and error states are all explicit.
 * Failures never destroy rows that are already visible — pagination errors
 * surface as a banner above the list. Each row also offers an inline rename
 * editor: saving persists the title through the active backend and swaps the
 * authoritative result into local state immediately, while failures keep the
 * editor open for another attempt. Rows likewise offer a deletion flow: the
 * entry control swaps THAT row into an inline confirmation step, and a
 * confirmed DELETE removes the session from local state immediately —
 * failures keep the confirmation open with an explanation.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type {Session} from '../api/sessions';
import {deleteSession, listSessions, renameSession} from '../api/sessions';
import {toErrorMessage, useAuth} from '../auth/AuthContext';
import {LocalConversationRepository} from '../db/conversationRepository';
import type {LocalSession} from '../db/types';
import {useApplicationMode} from '../mode/ModeContext';
import type {MainStackParamList} from '../navigation/types';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'History'>;
};

/** Local rows mirror server fields; copy only the UI-model fields across. */
function toSessionModel(local: LocalSession): Session {
  return {
    id: local.id,
    title: local.title,
    topic: local.topic,
    topic_hint: local.topic_hint,
    learning_level: local.learning_level,
    created_at: local.created_at,
  };
}

/**
 * Stateless serverless-data seam (TASK-090): one repository instance per
 * mount covers every load/rename/delete of that screen's lifetime.
 */
function useLocalRepository(): LocalConversationRepository {
  return useMemo(() => new LocalConversationRepository(), []);
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      padding: 24,
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
    },
    error: {
      color: c.errorText,
      fontSize: 13,
      marginBottom: 12,
    },
    retryButton: {
      alignSelf: 'center',
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 20,
      marginBottom: 12,
    },
    retryButtonText: {
      color: c.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
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
    loadMore: {
      alignSelf: 'center',
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 20,
      marginTop: 6,
      marginBottom: 16,
    },
    loadMoreDisabled: {
      opacity: 0.5,
    },
    loadMoreText: {
      color: c.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
  });
}

export function HistoryScreen({navigation}: Props) {
  const {getAccessToken} = useAuth();
  const {colors} = useTheme();
  // TASK-090: the active application mode selects the history data source.
  // Nothing is fetched until the persisted mode has been restored, so a
  // fast-tapped History screen never touches the wrong backend mid-restore.
  const {status: modeStatus, mode} = useApplicationMode();
  const localRepository = useLocalRepository();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadedPages, setLoadedPages] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  // AuthContext's value object is recreated on every auth-state change, so
  // the load effect reads the token through a latest ref instead of taking
  // getAccessToken as a dependency (TASK-048 gotcha).
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;

  useEffect(() => {
    if (modeStatus !== 'ready') {
      return;
    }
    let cancelled = false;

    setError(null);
    setSessions([]);
    setHasMore(false);
    setLoadedPages(0);
    setLoading(true);
    setRenamingId(null);
    setDraftTitle('');
    setSavingRename(false);
    setDeletingId(null);
    setDeleting(false);
    (async () => {
      try {
        if (mode === 'serverless') {
          // Serverless history (TASK-090): read straight from the on-device
          // SQLite store. Local rows are already ordered most-recently-active
          // first and are delivered in one shot — no pagination.
          const rows = await localRepository.listSessions();
          if (!cancelled) {
            setSessions(rows.map(toSessionModel));
            setHasMore(false);
          }
          return;
        }
        const token = await getAccessTokenRef.current();
        if (!token) {
          throw new Error('You need to sign in again to see your history.');
        }
        const page = await listSessions(token, 1);
        if (!cancelled) {
          setSessions(page.results);
          setHasMore(page.next !== null);
          setLoadedPages(1);
        }
      } catch (err) {
        if (!cancelled) {
          setError(toErrorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [localRepository, reloadKey, modeStatus, mode]);

  /** Append the next page; failures keep the rendered rows and show why. */
  const handleLoadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const token = await getAccessTokenRef.current();
      if (!token) {
        throw new Error('You need to sign in again to see your history.');
      }
      const page = await listSessions(token, loadedPages + 1);
      setSessions(prev => [...prev, ...page.results]);
      setHasMore(page.next !== null);
      setLoadedPages(pages => pages + 1);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadedPages, loading, loadingMore]);

  /** Open the inline editor pre-filled with the current title. */
  const startRename = useCallback((session: Session) => {
    setError(null);
    setDeletingId(null);
    setRenamingId(session.id);
    setDraftTitle(session.title);
  }, []);

  const cancelRename = useCallback(() => {
    if (savingRename) {
      return;
    }
    setRenamingId(null);
    setDraftTitle('');
  }, [savingRename]);

  /**
   * Persist the new title through the active backend and swap the
   * authoritative result into local state — the row updates immediately
   * without refetching the list. Failures keep the editor open with the
   * draft intact for another try.
   */
  const handleRenameSave = useCallback(async () => {
    const sessionId = renamingId;
    const trimmed = draftTitle.trim();
    if (sessionId === null || savingRename || trimmed === '') {
      return;
    }
    setSavingRename(true);
    // A fresh attempt supersedes any previous failure message.
    setError(null);
    try {
      if (mode === 'serverless') {
        await localRepository.renameSession(sessionId, trimmed);
        setSessions(prev =>
          prev.map(session =>
            session.id === sessionId ? {...session, title: trimmed} : session,
          ),
        );
      } else {
        const token = await getAccessTokenRef.current();
        if (!token) {
          throw new Error('You need to sign in again to see your history.');
        }
        const updated = await renameSession(token, sessionId, trimmed);
        setSessions(prev =>
          prev.map(session => (session.id === updated.id ? {...session, ...updated} : session)),
        );
      }
      setRenamingId(null);
      setDraftTitle('');
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSavingRename(false);
    }
  }, [draftTitle, localRepository, mode, renamingId, savingRename]);

  /** Swap THAT row into the inline confirmation step. */
  const startDelete = useCallback((session: Session) => {
    setError(null);
    setRenamingId(null);
    setDraftTitle('');
    setDeletingId(session.id);
  }, []);

  const cancelDelete = useCallback(() => {
    if (deleting) {
      return;
    }
    setDeletingId(null);
  }, [deleting]);

  /**
   * DELETE the session after confirmation through the active backend and
   * drop it from local state — the row disappears immediately without
   * refetching the list. Failures keep the confirmation open with a banner
   * for another attempt.
   */
  const handleDeleteConfirm = useCallback(async () => {
    const sessionId = deletingId;
    if (sessionId === null || deleting) {
      return;
    }
    setDeleting(true);
    // A fresh attempt supersedes any previous failure message.
    setError(null);
    try {
      if (mode === 'serverless') {
        await localRepository.deleteSession(sessionId);
      } else {
        const token = await getAccessTokenRef.current();
        if (!token) {
          throw new Error('You need to sign in again to see your history.');
        }
        await deleteSession(token, sessionId);
      }
      setSessions(prev => prev.filter(session => session.id !== sessionId));
      setDeletingId(null);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  }, [deleting, deletingId, localRepository, mode]);

  return (
    <View style={styles.container} testID="history-screen">
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
        <Pressable onPress={() => navigation.goBack()} testID="history-back">
          <Text style={styles.backLink}>Close</Text>
        </Pressable>
      </View>

      {error !== null ? (
        <Text role="alert" style={styles.error} testID="form-error">
          {error}
        </Text>
      ) : null}
      {!loading && error !== null ? (
        <Pressable
          style={styles.retryButton}
          onPress={() => {
            setReloadKey(key => key + 1);
          }}
          accessibilityRole="button"
          accessibilityLabel="Retry loading your conversations"
          testID="history-retry">
          <Text style={styles.retryButtonText}>Try again</Text>
        </Pressable>
      ) : null}

      {loading ? (
        <View style={styles.centered} testID="history-loading">
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.stateText}>Loading your conversations…</Text>
        </View>
      ) : sessions.length === 0 && error === null ? (
        <View style={styles.centered} testID="history-empty">
          <Text style={styles.stateText}>
            No conversations yet. Start a new one to practice English.
          </Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={item => String(item.id)}
          extraData={[renamingId, draftTitle, savingRename, deletingId, deleting]}
          renderItem={({item}) =>
            renamingId === item.id ? (
              <View style={[styles.row, styles.editor]} testID={`history-editor-${item.id}`}>
                <TextInput
                  style={styles.editorInput}
                  value={draftTitle}
                  onChangeText={setDraftTitle}
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
                      handleRenameSave();
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
                      cancelRename();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel renaming"
                    accessibilityState={{disabled: savingRename}}
                    testID="history-rename-cancel">
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : deletingId === item.id ? (
              <View style={styles.row} testID={`history-confirm-${item.id}`}>
                <Text style={styles.confirmText}>
                  Delete “{item.title}”? This cannot be undone.
                </Text>
                <View style={styles.editorActions}>
                  <Pressable
                    style={[styles.deleteButton, deleting && styles.buttonDisabled]}
                    disabled={deleting}
                    onPress={() => {
                      handleDeleteConfirm();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Confirm deleting ${item.title}`}
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
                      cancelDelete();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Keep this conversation"
                    accessibilityState={{disabled: deleting}}
                    testID="history-delete-cancel">
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                style={styles.row}
                onPress={() => {
                  navigation.navigate('Chat', {sessionId: item.id});
                }}
                accessibilityRole="button"
                accessibilityLabel={`Open conversation ${item.title}`}
                testID={`history-item-${item.id}`}>
                <Text style={styles.rowTitle}>{item.title}</Text>
                {item.topic ? (
                  <Text style={styles.rowTopic} numberOfLines={1}>
                    {item.topic}
                  </Text>
                ) : null}
                <View style={styles.rowActions}>
                  <Pressable
                    onPress={() => {
                      startRename(item);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Rename conversation ${item.title}`}
                    testID={`history-rename-${item.id}`}>
                    <Text style={styles.renameLink}>Rename</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      startDelete(item);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete conversation ${item.title}`}
                    testID={`history-delete-${item.id}`}>
                    <Text style={styles.deleteLink}>Delete</Text>
                  </Pressable>
                </View>
              </Pressable>
            )
          }
          ListFooterComponent={
            hasMore ? (
              <Pressable
                style={[styles.loadMore, loadingMore && styles.loadMoreDisabled]}
                disabled={loadingMore}
                onPress={() => {
                  handleLoadMore();
                }}
                accessibilityRole="button"
                accessibilityLabel="Load more conversations"
                accessibilityState={{disabled: loadingMore}}
                testID="history-load-more">
                <Text style={styles.loadMoreText}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Text>
              </Pressable>
            ) : null
          }
          testID="history-list"
        />
      )}
    </View>
  );
}
