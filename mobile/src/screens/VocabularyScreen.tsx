/**
 * Vocabulary screen (SPEC TASK-072): the authenticated user's saved
 * expressions. The backend already returns items newest-first, so pages
 * render in delivery order. The first page loads on mount (and on retry);
 * further pages append through a "Load more" control while the DRF envelope
 * reports a next page. Each row shows the asynchronous enrichment state:
 * `pending` rows are marked "Enriching…", `failed` rows surface a retryable
 * failure note, and `complete` rows reveal the enriched fields (definition,
 * translation, pronunciation, part of speech, example) whenever present.
 * Loading, empty and error states are all explicit; failures never destroy
 * rows that are already visible — pagination errors surface as a banner
 * above the list.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {VocabularyItem} from '../api/vocabulary';
import {listVocabulary} from '../api/vocabulary';
import {toErrorMessage, useAuth} from '../auth/AuthContext';
import type {VocabularyScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

type Props = VocabularyScreenProps;

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
    rowHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    rowExpression: {
      flexShrink: 1,
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    badge: {
      borderWidth: 1,
      borderRadius: 999,
      paddingVertical: 3,
      paddingHorizontal: 10,
    },
    badgePending: {
      borderColor: c.borderStrong,
      backgroundColor: c.accentSoft,
    },
    badgePendingText: {
      fontSize: 11,
      fontWeight: '600',
      color: c.accent,
    },
    badgeFailed: {
      borderColor: c.danger,
      backgroundColor: 'transparent',
    },
    badgeFailedText: {
      fontSize: 11,
      fontWeight: '600',
      color: c.danger,
    },
    rowPos: {
      fontSize: 13,
      fontStyle: 'italic',
      color: c.textSecondary,
      marginTop: 6,
    },
    rowDefinition: {
      fontSize: 14,
      color: c.textPrimary,
      marginTop: 6,
    },
    rowTranslation: {
      fontSize: 14,
      color: c.textSecondary,
      marginTop: 4,
    },
    rowExample: {
      fontSize: 13,
      fontStyle: 'italic',
      color: c.textSecondary,
      marginTop: 6,
    },
    rowPronunciation: {
      fontSize: 13,
      color: c.textMuted,
      marginTop: 4,
    },
    failedNote: {
      fontSize: 12,
      color: c.errorText,
      marginTop: 6,
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

function StatusBadge({item, styles}: {item: VocabularyItem; styles: ReturnType<typeof createStyles>}) {
  if (item.status === 'pending') {
    return (
      <View style={[styles.badge, styles.badgePending]} testID="vocab-badge-pending">
        <Text style={styles.badgePendingText}>Enriching…</Text>
      </View>
    );
  }
  if (item.status === 'failed') {
    return (
      <View style={[styles.badge, styles.badgeFailed]} testID="vocab-badge-failed">
        <Text style={styles.badgeFailedText}>Failed</Text>
      </View>
    );
  }
  return null;
}

export function VocabularyScreen({navigation}: Props) {
  const {getAccessToken} = useAuth();
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [items, setItems] = useState<VocabularyItem[]>([]);
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
    setItems([]);
    setHasMore(false);
    setLoadedPages(0);
    setLoading(true);
    (async () => {
      try {
        const token = await getAccessTokenRef.current();
        if (!token) {
          throw new Error('You need to sign in again to see your vocabulary.');
        }
        const page = await listVocabulary(token, 1);
        if (!cancelled) {
          setItems(page.results);
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
        throw new Error('You need to sign in again to see your vocabulary.');
      }
      const page = await listVocabulary(token, loadedPages + 1);
      setItems(prev => [...prev, ...page.results]);
      setHasMore(page.next !== null);
      setLoadedPages(pages => pages + 1);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadedPages, loading, loadingMore]);

  return (
    <View style={styles.container} testID="vocabulary-screen">
      <View style={styles.header}>
        <Text style={styles.title}>Vocabulary</Text>
        <Pressable onPress={() => navigation.goBack()} testID="vocabulary-back">
          <Text style={styles.backLink}>Close</Text>
        </Pressable>
      </View>

      {error !== null ? (
        <Text role="alert" style={styles.error} testID="form-error">
          {error}
        </Text>
      ) : null}
      {!loading && error !== null && items.length === 0 ? (
        <Pressable
          style={styles.retryButton}
          onPress={() => {
            setReloadKey(key => key + 1);
          }}
          accessibilityRole="button"
          accessibilityLabel="Retry loading your saved words"
          testID="vocabulary-retry">
          <Text style={styles.retryButtonText}>Try again</Text>
        </Pressable>
      ) : null}

      {loading ? (
        <View style={styles.centered} testID="vocabulary-loading">
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.stateText}>Loading your saved words…</Text>
        </View>
      ) : items.length === 0 && error === null ? (
        <View style={styles.centered} testID="vocabulary-empty">
          <Text style={styles.stateText}>
            No saved words yet. Select text in a chat to save it here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => String(item.id)}
          renderItem={({item}) => (
            <View style={styles.row} testID={`vocabulary-item-${item.id}`}>
              <View style={styles.rowHeader}>
                <Text style={styles.rowExpression}>{item.expression}</Text>
                <StatusBadge item={item} styles={styles} />
              </View>
              {item.part_of_speech ? (
                <Text style={styles.rowPos}>{item.part_of_speech}</Text>
              ) : null}
              {item.definition ? (
                <Text style={styles.rowDefinition}>{item.definition}</Text>
              ) : null}
              {item.translation ? (
                <Text style={styles.rowTranslation}>{item.translation}</Text>
              ) : null}
              {item.pronunciation ? (
                <Text style={styles.rowPronunciation}>{item.pronunciation}</Text>
              ) : null}
              {item.example ? <Text style={styles.rowExample}>{item.example}</Text> : null}
              {item.status === 'failed' ? (
                <Text style={styles.failedNote}>
                  Enrichment failed — it will be retried automatically.
                </Text>
              ) : null}
            </View>
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
                accessibilityLabel="Load more saved words"
                accessibilityState={{disabled: loadingMore}}
                testID="vocabulary-load-more">
                <Text style={styles.loadMoreText}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Text>
              </Pressable>
            ) : null
          }
          testID="vocabulary-list"
        />
      )}
    </View>
  );
}
