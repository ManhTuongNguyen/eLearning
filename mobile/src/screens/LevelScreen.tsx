/**
 * Learning-level screen (SPEC TASK-018): onboarding/settings UI listing every
 * CEFR level plus AUTO. The current level is loaded from the server profile
 * and each selection is persisted immediately via PATCH /api/v1/profile/.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {getProfile, LEVELS, updateProfile} from '../api/profile';
import type {EnglishLevel, LevelOption} from '../api/profile';
import {toErrorMessage, useAuth} from '../auth/AuthContext';

export function LevelScreen({onBack}: {onBack: () => void}) {
  const {getAccessToken} = useAuth();
  const [selected, setSelected] = useState<EnglishLevel | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<EnglishLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const token = await getAccessToken();
      if (!token) {
        if (!cancelled) {
          setError('You need to sign in again to load your profile.');
          setLoading(false);
        }
        return;
      }
      try {
        const profile = await getProfile(token);
        if (!cancelled) {
          setSelected(profile.level);
        }
      } catch (err) {
        if (!cancelled) {
          setError(toErrorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getAccessToken]);

  const handleSelect = useCallback(
    async (option: LevelOption) => {
      if (saving !== null || option.value === selected) {
        return;
      }
      const token = await getAccessToken();
      if (!token || saving !== null || option.value === selected) {
        return;
      }

      setSaving(option.value);
      setError(null);
      setSaved(false);
      try {
        const profile = await updateProfile(token, option.value);
        setSelected(profile.level);
        setSaved(true);
      } catch (err) {
        // Selection stays on the last server-confirmed value.
        setError(toErrorMessage(err));
      } finally {
        setSaving(null);
      }
    },
    [getAccessToken, saving, selected],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          onPress={onBack}
          testID="level-back"
          hitSlop={8}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Your English level</Text>
        <View style={styles.headerSpacer} />
      </View>
      <Text style={styles.subtitle}>
        This shapes topics, vocabulary and corrections. You can change it anytime.
      </Text>

      {loading ? <ActivityIndicator style={styles.loading} testID="level-loading" /> : null}
      {error ? (
        <Text role="alert" style={styles.error} testID="form-error">
          {error}
        </Text>
      ) : null}
      {saved ? <Text style={styles.saved}>Saved.</Text> : null}

      <ScrollView contentContainerStyle={styles.list}>
        {LEVELS.map(option => {
          const isSelected = option.value === selected;
          const isSaving = option.value === saving;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{checked: isSelected}}
              disabled={loading || saving !== null}
              onPress={() => {
                handleSelect(option);
              }}
              style={({pressed}) => [
                styles.row,
                isSelected && styles.rowSelected,
                pressed && styles.rowPressed,
              ]}
              testID={`level-${option.value}`}>
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, isSelected && styles.rowLabelSelected]}>
                  {option.label}
                </Text>
                <Text style={styles.rowDescription}>{option.description}</Text>
              </View>
              {isSaving ? (
                <ActivityIndicator testID={`level-saving-${option.value}`} />
              ) : (
                <View style={[styles.radio, isSelected && styles.radioSelected]} />
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f6f8',
    paddingHorizontal: 24,
    paddingTop: 60,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backText: {
    fontSize: 16,
    color: '#2563eb',
    fontWeight: '600',
  },
  headerSpacer: {
    width: 48,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  },
  subtitle: {
    marginTop: 8,
    marginBottom: 12,
    fontSize: 14,
    color: '#4b5563',
  },
  loading: {
    marginVertical: 8,
  },
  error: {
    color: '#b91c1c',
    fontSize: 14,
    marginVertical: 8,
  },
  saved: {
    color: '#15803d',
    fontSize: 14,
    marginVertical: 8,
    fontWeight: '600',
  },
  list: {
    paddingBottom: 24,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    borderColor: '#e5e7eb',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  rowSelected: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  rowPressed: {
    opacity: 0.8,
  },
  rowText: {
    flex: 1,
    paddingRight: 12,
    gap: 2,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  rowLabelSelected: {
    color: '#1d4ed8',
  },
  rowDescription: {
    fontSize: 13,
    color: '#6b7280',
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#9ca3af',
  },
  radioSelected: {
    borderColor: '#2563eb',
    backgroundColor: '#2563eb',
  },
});
