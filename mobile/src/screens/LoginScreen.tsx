/** Login screen: username-or-email + password against the backend API. */
import React, {useState} from 'react';
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

export function LoginScreen({onSwitchToRegister}: {onSwitchToRegister: () => void}) {
  const {login, busy, error} = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const canSubmit = identifier.trim().length > 0 && password.length > 0 && !busy;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'android' ? undefined : 'padding'}>
      <View style={styles.form}>
        <Text style={styles.title}>eLearning</Text>
        <Text style={styles.subtitle}>Practice English through conversation.</Text>

        <TextInput
          style={styles.input}
          placeholder="Username or email"
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
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.buttonText}>Log in</Text>
          )}
        </Pressable>

        <Pressable onPress={onSwitchToRegister} testID="login-switch-register">
          <Text style={styles.switchText}>
            No account yet? <Text style={styles.switchLink}>Register</Text>
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: '#f5f6f8',
    padding: 24,
  },
  form: {
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#4b5563',
    textAlign: 'center',
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111827',
  },
  error: {
    color: '#b91c1c',
    fontSize: 13,
  },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  switchText: {
    textAlign: 'center',
    color: '#4b5563',
    marginTop: 12,
    fontSize: 14,
  },
  switchLink: {
    color: '#2563eb',
    fontWeight: '600',
  },
});
