/**
 * Settings screen (TASK-043): hosts account actions for the authenticated
 * user — learning-level entry (SPEC TASK-018) and logout (SPEC TASK-015).
 */
import React from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';

import {useAuth} from '../auth/AuthContext';
import type {SettingsScreenProps} from '../navigation/types';

export function SettingsScreen({navigation}: SettingsScreenProps) {
  const {user, logout, busy} = useAuth();

  return (
    <View style={styles.container} testID="settings-screen">
      <Text style={styles.title}>Settings</Text>
      {user ? (
        <Text style={styles.subtitle}>{user.email}</Text>
      ) : null}

      <Pressable
        style={styles.secondaryButton}
        onPress={() => navigation.navigate('Level')}
        testID="settings-open-level">
        <Text style={styles.secondaryButtonText}>Learning level</Text>
      </Pressable>

      <Pressable
        style={[styles.button, busy && styles.buttonDisabled]}
        disabled={busy}
        onPress={() => {
          logout();
        }}
        testID="settings-logout">
        {busy ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.buttonText}>Log out</Text>
        )}
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
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#dc2626',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 32,
    alignItems: 'center',
    minWidth: 140,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 32,
    alignItems: 'center',
    minWidth: 140,
  },
  secondaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
