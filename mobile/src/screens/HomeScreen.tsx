/**
 * Minimal authenticated home screen. The real chat experience arrives in
 * later phases; for now it proves the authenticated state and hosts logout.
 */
import React from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';

import {useAuth} from '../auth/AuthContext';

export function HomeScreen() {
  const {user, logout, busy} = useAuth();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome{user ? `, ${user.username}` : ''}</Text>
      {user ? <Text style={styles.subtitle}>{user.email}</Text> : null}

      <Pressable
        style={[styles.button, busy && styles.buttonDisabled]}
        disabled={busy}
        onPress={() => {logout();}}
        testID="home-logout">
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
});
