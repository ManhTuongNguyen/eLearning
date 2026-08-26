/**
 * Placeholder history screen (TASK-043). Session listing lands in Phase 8;
 * this screen anchors the History route of the main stack.
 */
import React, {useMemo} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import type {MainStackParamList} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'History'>;
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.background,
      padding: 24,
      gap: 8,
    },
    title: {
      fontSize: 26,
      fontWeight: '700',
      color: c.textPrimary,
    },
    subtitle: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
      marginBottom: 16,
    },
    link: {
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 24,
    },
    linkText: {
      color: c.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
  });
}

export function HistoryScreen({navigation}: Props) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.container} testID="history-screen">
      <Text style={styles.title}>History</Text>
      <Text style={styles.subtitle}>
        Past conversations will be listed here.
      </Text>

      <Pressable
        style={styles.link}
        onPress={() => navigation.goBack()}
        testID="history-back">
        <Text style={styles.linkText}>Back to chat</Text>
      </Pressable>
    </View>
  );
}
