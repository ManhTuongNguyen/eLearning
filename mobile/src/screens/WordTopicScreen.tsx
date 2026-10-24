/**
 * One word topic's bank (WORD_BANK_V1 TASK-WB-009).
 *
 * TASK-WB-008 registers this screen with a minimal placeholder so creating a
 * topic can navigate to it; TASK-WB-009 fleshes out the list, the search box,
 * generation, the review modal and practice unlock. The mode gating and the
 * topic header are final.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { SCREEN_GUTTER, Screen, ScreenHeader } from '../components/ScreenLayout';
import { getLocalDatabase } from '../db/database';
import { getWordTopicById } from '../db/wordRepository';
import type { WordTopicRecord } from '../db/types';
import { useApplicationMode } from '../mode/ModeContext';
import type { WordTopicScreenProps } from '../navigation/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

export function createStyles(c: ThemeColors) {
  return {
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: 16,
    },
    header: {
      marginBottom: 16,
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
  } as const;
}

export function WordTopicScreen({ route }: WordTopicScreenProps) {
  const { status: modeStatus, mode } = useApplicationMode();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const topicId = route.params.topicId;

  const [topic, setTopic] = useState<WordTopicRecord | null>(null);
  const [loading, setLoading] = useState(true);

  const serverMode = modeStatus === 'ready' && mode === 'server';

  const loadTopic = useCallback(async () => {
    if (serverMode) {
      return;
    }
    setLoading(true);
    try {
      const db = await getLocalDatabase();
      setTopic(await getWordTopicById(db, topicId));
    } finally {
      setLoading(false);
    }
  }, [serverMode, topicId]);

  useEffect(() => {
    loadTopic();
  }, [loadTopic]);

  return (
    <Screen style={styles.container} testID="word-topic-screen">
      <ScreenHeader style={styles.header}>
        <Text style={{ fontSize: 24, fontWeight: '700', color: colors.textPrimary }} numberOfLines={1}>
          {topic?.title ?? 'Topic'}
        </Text>
      </ScreenHeader>

      {serverMode ? (
        <View style={styles.centered} testID="word-topic-mode-notice">
          <Text style={styles.stateText}>The word bank is saved on this device only.</Text>
        </View>
      ) : modeStatus !== 'ready' || loading ? (
        <View style={styles.centered} testID="word-topic-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <View style={styles.centered} testID="word-topic-empty">
          <Text style={styles.stateText}>No words yet.</Text>
        </View>
      )}
    </Screen>
  );
}
