/**
 * History screen (SPEC TASK-055): the authenticated user's past sessions.
 * The backend already returns sessions most-recently-updated first, so pages
 * render in delivery order. The first page loads on mount (and on retry);
 * further pages append through a "Load more" control while the DRF envelope
 * reports a next page. Tapping a session opens its conversation; loading,
 * empty and error states are all explicit. Failures never destroy rows that
 * are already visible — pagination errors surface as a banner above the list.
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
  View,
} from 'react-native';

import type {Session} from '../api/sessions';
import {listSessions} from '../api/sessions';
import {toErrorMessage, useAuth} from '../auth/AuthContext';
import type {MainStackParamList} from '../navigation/types';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'History'>;
};

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
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadedPages, setLoadedPages] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  // AuthContext's value object is recreated on every auth-state change, so
  // the load effect reads the token through a latest ref instead of taking
  // getAccessToken as a dependency (TASK-048 gotcha).
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;

  useEffect(() => {
    let cancelled = false;

    setError(null);
    setSessions([]);
    setHasMore(false);
    setLoadedPages(0);
    setLoading(true);
    (async () => {
      try {
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
  }, [reloadKey]);

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
          renderItem={({item}) => (
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
            </Pressable>
          )}
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
