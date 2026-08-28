/**
 * Login screen: username-or-email + password against the backend API, plus
 * the serverless entry point (TASK-AUDIT-003): users can enable serverless
 * mode directly here, without any account.
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

import {useAuth} from '../auth/AuthContext';
import {useApplicationMode} from '../mode/ModeContext';
import type {LoginScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: 'center',
      backgroundColor: c.background,
      padding: 24,
    },
    form: {
      gap: 12,
    },
    title: {
      fontSize: 28,
      fontWeight: '700',
      color: c.textPrimary,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
      marginBottom: 16,
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
    },
    error: {
      color: c.errorText,
      fontSize: 13,
    },
    button: {
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 4,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    buttonText: {
      color: c.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    switchText: {
      textAlign: 'center',
      color: c.textSecondary,
      marginTop: 12,
      fontSize: 14,
    },
    switchLink: {
      color: c.accent,
      fontWeight: '600',
    },
    serverlessSection: {
      marginTop: 20,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 4,
    },
    serverlessTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
      textAlign: 'center',
    },
    serverlessDescription: {
      fontSize: 13,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: 18,
    },
  });
}

export function LoginScreen({navigation}: LoginScreenProps) {
  const {login, busy, error} = useAuth();
  const {setMode} = useApplicationMode();
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const canSubmit = identifier.trim().length > 0 && password.length > 0 && !busy;

  // TASK-AUDIT-003: serverless mode is entered straight from the login
  // screen without any account. Switching the application mode re-renders
  // the root navigator into the main stack — no navigation call needed.
  const enterServerless = useCallback(() => {
    setMode('serverless');
  }, [setMode]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'android' ? undefined : 'padding'}
      testID="login-screen">
      <View style={styles.form}>
        <Text style={styles.title}>eLearning</Text>
        <Text style={styles.subtitle}>Practice English through conversation.</Text>

        <TextInput
          style={styles.input}
          placeholder="Username or email"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={identifier}
          onChangeText={setIdentifier}
          testID="login-identifier"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          testID="login-password"
        />

        {error ? (
          <Text style={styles.error} testID="form-error">
            {error}
          </Text>
        ) : null}

        <Pressable
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          disabled={!canSubmit}
          onPress={() => {login(identifier.trim(), password);}}
          testID="login-submit">
          {busy ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.buttonText}>Log in</Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => navigation.replace('Register')}
          testID="login-switch-register">
          <Text style={styles.switchText}>
            No account yet? <Text style={styles.switchLink}>Register</Text>
          </Text>
        </Pressable>

        <Pressable
          onPress={enterServerless}
          style={styles.serverlessSection}
          accessibilityRole="button"
          accessibilityLabel="Continue without an account"
          testID="login-serverless">
          <Text style={styles.serverlessTitle}>Continue without an account</Text>
          <Text style={styles.serverlessDescription}>
            Serverless mode keeps your conversations on this device and sends
            AI requests directly to your configured provider.
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
