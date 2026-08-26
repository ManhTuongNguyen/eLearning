/**
 * Placeholder history screen (TASK-043). Session listing lands in Phase 8;
 * this screen anchors the History route of the main stack.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import type {MainStackParamList} from '../navigation/types';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'History'>;
};

export function HistoryScreen({navigation}: Props) {
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f6f8',
    padding: 24,
    gap: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#111827',
  },
  subtitle: {
    fontSize: 14,
    color: '#4b5563',
    textAlign: 'center',
    marginBottom: 16,
  },
  link: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  linkText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
