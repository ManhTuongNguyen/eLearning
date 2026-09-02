/**
 * Learning-level screen (SPEC TASK-018/091): settings UI listing every CEFR
 * level plus AUTO. The data source follows the application mode: in server
 * mode the level loads through GET /api/v1/profile/ and each selection is
 * persisted immediately via PATCH; in serverless mode (TASK-091) the same UI
 * reads and writes the on-device SQLite profile through profileStore, so no
 * backend traffic happens while serverless is active. Selections persist
 * immediately in both modes; errors keep the last confirmed value selected.
 *
 * The top spacing is a fixed constant (the app shell in App.tsx already
 * pads the whole tree out of the system status bar), replacing the
 * fixed oversized padding, so the header sits at the same spacing as the
 * other pushed screens while devices that draw under the status bar
 * (edge-to-edge Android) still clear it.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
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
import {getLocalDatabase} from '../db/database';
import {getLearningProfile, saveLearningProfile} from '../db/profileStore';
import {useApplicationMode} from '../mode/ModeContext';
import type {LevelScreenProps} from '../navigation/types';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

/** Spacing between the safe-area top inset and the header row (px). */
const HEADER_TOP_SPACING = 24;

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingHorizontal: 24,
      // The app shell (App.tsx) pads the whole tree out of the system bars
      // on edge-to-edge devices (Android 15+); screens only add their own
      // fixed header spacing on top of that.
      paddingTop: HEADER_TOP_SPACING,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    backText: {
      fontSize: 16,
      color: c.accent,
      fontWeight: '600',
    },
    headerSpacer: {
      width: 48,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    subtitle: {
      marginTop: 8,
      marginBottom: 12,
      fontSize: 14,
      color: c.textSecondary,
    },
    loading: {
      marginVertical: 8,
    },
    error: {
      color: c.errorText,
      fontSize: 14,
      marginVertical: 8,
    },
    saved: {
      color: c.success,
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
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    rowSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
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
      color: c.textPrimary,
    },
    rowLabelSelected: {
      color: c.accent,
    },
    rowDescription: {
      fontSize: 13,
      color: c.textMuted,
    },
    radio: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: c.borderStrong,
    },
    radioSelected: {
      borderColor: c.primary,
      backgroundColor: c.primary,
    },
  });
}

export function LevelScreen({navigation}: LevelScreenProps) {
  const {authedRequest} = useAuth();
  const {status: modeStatus, mode} = useApplicationMode();
  const {colors} = useTheme();
  const styles = useMemo(
    () => createStyles(colors),
    [colors],
  );
  const [selected, setSelected] = useState<EnglishLevel | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<EnglishLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // authedRequest is read through a ref (TASK-048 gotcha): context value
  // changes — including the auth status settling after the application mode
  // (TASK-AUDIT-003) — must not re-trigger the load/save effects below, so
  // they depend on the stable mode only and always read the latest getter.
  // TASK-AUDIT-005: profile calls go through the central authed requester
  // (401 → one shared refresh → one retry).
  const authedRequestRef = useRef(authedRequest);
  authedRequestRef.current = authedRequest;

  // Reset the transient confirmations whenever the data source flips so a
  // mode switch cannot show a stale "Saved." from the other backend.
  useEffect(() => {
    setSaved(false);
    setError(null);
    setLoading(true);
  }, [mode]);

  useEffect(() => {
    let cancelled = false;

    // Nothing is fetched until the persisted mode has been restored, so a
    // fast-mounted screen never touches the wrong backend mid-restore.
    if (modeStatus !== 'ready') {
      return;
    }

    if (mode === 'serverless') {
      (async () => {
        try {
          const db = await getLocalDatabase();
          const profile = await getLearningProfile(db);
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
    }

    (async () => {
      try {
        const profile = await getProfile(authedRequestRef.current);
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
  }, [mode, modeStatus]);

  const handleSelect = useCallback(
    async (option: LevelOption) => {
      if (saving !== null || option.value === selected) {
        return;
      }

      setSaving(option.value);
      setError(null);
      setSaved(false);

      if (mode === 'serverless') {
        try {
          const db = await getLocalDatabase();
          const profile = await saveLearningProfile(db, option.value);
          setSelected(profile.level);
          setSaved(true);
        } catch (err) {
          // Selection stays on the last confirmed value.
          setError(toErrorMessage(err));
        } finally {
          setSaving(null);
        }
        return;
      }

      if (saving !== null || option.value === selected) {
        setSaving(null);
        return;
      }

      // A save before the mode settles could hit the wrong backend; the
      // screen is still loading anyway.
      if (modeStatus !== 'ready') {
        setSaving(null);
        return;
      }

      try {
        const profile = await updateProfile(authedRequestRef.current, option.value);
        setSelected(profile.level);
        setSaved(true);
      } catch (err) {
        // Selection stays on the last server-confirmed value.
        setError(toErrorMessage(err));
      } finally {
        setSaving(null);
      }
    },
    [mode, modeStatus, saving, selected],
  );

  return (
    <View style={styles.container} testID="level-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          onPress={() => navigation.goBack()}
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
