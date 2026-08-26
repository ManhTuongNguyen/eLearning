/**
 * New conversation screen (SPEC TASK-051): optional topic hint plus the two
 * start actions from ROADMAP §6 — "Start" with whatever hint the user typed
 * and "Let AI choose a topic" which always sends an empty hint. Both create
 * the session through POST /api/v1/sessions/ and land in Chat; a blank
 * Start behaves exactly like the auto action, so empty input works too.
 * Creation shows a spinner and disables both buttons; failures surface in
 * an inline banner and leave the form ready to retry.
 */
import React, {useCallback, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {createSession} from '../api/sessions';
import {toErrorMessage, useAuth} from '../auth/AuthContext';
import type {NewConversationScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

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
      marginBottom: 24,
    },
    backLink: {
      fontSize: 15,
      fontWeight: '600',
      color: c.accent,
      paddingVertical: 4,
    },
    title: {
      fontSize: 26,
      fontWeight: '700',
      color: c.textPrimary,
    },
    subtitle: {
      fontSize: 14,
      color: c.textSecondary,
      marginBottom: 20,
    },
    input: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 10,
      backgroundColor: c.surface,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: c.textPrimary,
      marginBottom: 16,
    },
    primaryButton: {
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
    },
    secondaryButton: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 12,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    primaryButtonText: {
      color: c.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    secondaryButtonText: {
      color: c.textPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    error: {
      color: c.errorText,
      fontSize: 13,
      marginTop: 12,
    },
    loadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      marginTop: 16,
    },
    loadingText: {
      fontSize: 13,
      color: c.textSecondary,
    },
  });
}

export function NewConversationScreen({navigation}: NewConversationScreenProps) {
  const {getAccessToken} = useAuth();
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [hint, setHint] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Create the session with the given (possibly empty) hint and swap this
   * screen for the new conversation. Replace — not push — so Android-back
   * never returns to an already-submitted form.
   */
  const handleCreate = useCallback(
    async (rawHint: string) => {
      if (creating) {
        return;
      }
      setCreating(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) {
          throw new Error('You need to sign in again to start a conversation.');
        }
        const session = await createSession(token, rawHint.trim());
        navigation.replace('Chat', {sessionId: session.id});
      } catch (err) {
        setError(toErrorMessage(err));
      } finally {
        setCreating(false);
      }
    },
    [creating, getAccessToken, navigation],
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'android' ? undefined : 'padding'}
      testID="new-conversation-screen">
      <View style={styles.header}>
        <Text style={styles.title}>New conversation</Text>
        <Pressable onPress={() => navigation.goBack()} testID="new-conversation-back">
          <Text style={styles.backLink}>Cancel</Text>
        </Pressable>
      </View>

      <Text style={styles.subtitle}>
        What would you like to talk about? Leave it blank and the AI picks a
        topic for you.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="e.g. Traveling"
        placeholderTextColor={colors.textMuted}
        multiline
        value={hint}
        onChangeText={setHint}
        editable={!creating}
        testID="new-conversation-hint"
      />

      <Pressable
        style={[styles.primaryButton, creating && styles.buttonDisabled]}
        disabled={creating}
        onPress={() => {
          handleCreate(hint);
        }}
        accessibilityRole="button"
        accessibilityLabel="Start conversation with your topic hint"
        testID="new-conversation-start">
        <Text style={styles.primaryButtonText}>Start</Text>
      </Pressable>
      <Pressable
        style={[styles.secondaryButton, creating && styles.buttonDisabled]}
        disabled={creating}
        onPress={() => {
          handleCreate('');
        }}
        accessibilityRole="button"
        accessibilityLabel="Let AI choose a topic"
        testID="new-conversation-auto">
        <Text style={styles.secondaryButtonText}>Let AI choose a topic</Text>
      </Pressable>

      {error !== null ? (
        <Text role="alert" style={styles.error} testID="form-error">
          {error}
        </Text>
      ) : null}

      {creating ? (
        <View style={styles.loadingRow} testID="new-conversation-loading">
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.loadingText}>Preparing your conversation…</Text>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
