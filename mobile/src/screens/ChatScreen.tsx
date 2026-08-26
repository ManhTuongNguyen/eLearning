/**
 * Placeholder chat screen (TASK-043). The real conversation UI with streaming
 * arrives in Phase 7; this screen anchors the Chat route of the main stack.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import type {MainStackParamList} from '../navigation/types';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'Chat'>;
};

export function ChatScreen({navigation}: Props) {
  return (
    <View style={styles.container} testID="chat-screen">
      <Text style={styles.title}>Chat</Text>
      <Text style={styles.subtitle}>
        Your English conversations will stream here.
      </Text>

      <View style={styles.links}>
        <Pressable
          style={styles.link}
          onPress={() => navigation.navigate('History')}
          testID="chat-open-history">
          <Text style={styles.linkText}>History</Text>
        </Pressable>
        <Pressable
          style={styles.link}
          onPress={() => navigation.navigate('Settings')}
          testID="chat-open-settings">
          <Text style={styles.linkText}>Settings</Text>
        </Pressable>
      </View>
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
  links: {
    flexDirection: 'row',
    gap: 12,
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
