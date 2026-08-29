/**
 * New conversation screen (SPEC TASK-051): a single start action whose label
 * and style follow the optional topic hint from ROADMAP §6 — when the user
 * typed a non-empty hint the action is the primary "Start" button that ships
 * the hint to the backend; when the hint is blank the same control re-skins
 * to the secondary "Let AI choose a topic" style and sends an empty hint
 * (the server / provider picks the topic). In server mode both paths create
 * the session through POST /api/v1/sessions/; in serverless mode (TASK-085)
 * the topic is generated directly through the configured provider with the
 * user's own key and persisted in the local SQLite database — no backend
 * traffic happens (ROADMAP Rule 9). Both land in Chat; a blank Start behaves
 * exactly like the auto action, so empty input works too.
 * The server-mode creation response carries the generated sample conversation
 * (TASK-053), which is handed to Chat as a route param since no endpoint can
 * refetch it. Creation shows a spinner and disables the action; failures
 * surface in an inline banner and leave the form ready to retry.
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
import {getLocalDatabase} from '../db/database';
import {useApplicationMode} from '../mode/ModeContext';
import {createProviderClient} from '../serverless/providerRegistry';
import {createServerlessSession} from '../serverless/topicGeneration';
import {loadServerlessOpenRouterConfig} from '../serverless/settings';
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
  const {authedRequest} = useAuth();
  const {mode} = useApplicationMode();
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
        if (mode === 'serverless') {
          // TASK-085: topic generation runs directly against the user's
          // configured provider (registry-selected: OpenRouter, Gemini,
          // OpenAI, 9Router) with their own key; nothing touches the
          // backend (Rule 9).
          const config = await loadServerlessOpenRouterConfig();
          if (!config) {
            throw new Error(
              'Add your provider API key in Settings to chat without the server.',
            );
          }
          const client = createProviderClient(config);
          const db = await getLocalDatabase();
          const session = await createServerlessSession(
            db,
            request => client.complete(request),
            rawHint.trim(),
          );
          navigation.replace('Chat', {sessionId: session.id});
          return;
        }
        // TASK-AUDIT-005: creation goes through the central authed requester
        // (401 → one shared refresh → one retry). Signed out, it rejects
        // with the shared sign-in prompt before any transport work.
        const session = await createSession(authedRequest, rawHint.trim());
        navigation.replace('Chat', {
          sessionId: session.id,
          sampleTurns: session.sample_conversation?.turns,
        });
      } catch (err) {
        setError(toErrorMessage(err));
      } finally {
        setCreating(false);
      }
    },
    [authedRequest, creating, mode, navigation],
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

      {(() => {
        const hintEmpty = hint.trim().length === 0;
        const buttonStyle = hintEmpty
          ? [styles.secondaryButton, creating && styles.buttonDisabled]
          : [styles.primaryButton, creating && styles.buttonDisabled];
        const textStyle = hintEmpty
          ? styles.secondaryButtonText
          : styles.primaryButtonText;
        const label = hintEmpty ? 'Let AI choose a topic' : 'Start';
        const a11yLabel = hintEmpty
          ? 'Let AI choose a topic'
          : 'Start conversation with your topic hint';
        return (
          <Pressable
            style={buttonStyle}
            disabled={creating}
            onPress={() => {
              handleCreate(hint);
            }}
            accessibilityRole="button"
            accessibilityLabel={a11yLabel}
            testID="new-conversation-start">
            <Text style={textStyle}>{label}</Text>
          </Pressable>
        );
      })()}

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
