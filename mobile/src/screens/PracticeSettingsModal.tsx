/**
 * Per-topic practice settings dialog (Anki's deck options): learn-ahead limit,
 * new cards/day, maximum reviews/day and the per-sitting session cap. Opened
 * from a topic row's ⋮ menu or the topic screen's header menu.
 *
 * Each setting is a labelled slider with a live value; Cancel/Save live in a
 * fixed footer below the scrollable body so they never scroll away. Save is
 * the only write path — the drafts live in local state until then.
 */

import Slider from '@react-native-community/slider';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { SCREEN_GUTTER } from '../components/ScreenLayout';
import {
  clampLearnAheadMinutes,
  clampMaxReviewsPerDay,
  clampMaxSessionCards,
  clampNewCardsPerDay,
  DEFAULT_LEARN_AHEAD_MINUTES,
  DEFAULT_MAX_REVIEWS_PER_DAY,
  DEFAULT_MAX_SESSION_CARDS,
  DEFAULT_NEW_CARDS_PER_DAY,
  MAX_LEARN_AHEAD_MINUTES,
  MAX_MAX_REVIEWS_PER_DAY,
  MAX_NEW_CARDS_PER_DAY,
  MAX_SESSION_CARDS_LIMIT,
  MIN_LEARN_AHEAD_MINUTES,
  MIN_MAX_REVIEWS_PER_DAY,
  MIN_NEW_CARDS_PER_DAY,
  MIN_SESSION_CARDS,
} from '../srs/session';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

/** The persisted, clamped practice limits of one topic. */
export interface TopicPracticeSettings {
  learn_ahead_minutes: number;
  new_cards_per_day: number;
  max_reviews_per_day: number;
  max_session_cards: number;
}

/** Seed used while a topic record is still loading. */
export const DEFAULT_TOPIC_PRACTICE_SETTINGS: TopicPracticeSettings = {
  learn_ahead_minutes: DEFAULT_LEARN_AHEAD_MINUTES,
  new_cards_per_day: DEFAULT_NEW_CARDS_PER_DAY,
  max_reviews_per_day: DEFAULT_MAX_REVIEWS_PER_DAY,
  max_session_cards: DEFAULT_MAX_SESSION_CARDS,
};
export interface PracticeSettingsModalProps {
  /** Whether the dialog is presented. */
  visible: boolean;
  /** Title of the topic being configured. */
  topicTitle: string;
  /** The topic's persisted settings; seed the sliders each opening. */
  settings: TopicPracticeSettings;
  /** True while the save is running. */
  saving: boolean;
  /** Message shown when the save failed; the dialog stays open. */
  error: string | null;
  /** Dismiss without saving (Cancel button or Android back). */
  onCancel: () => void;
  /** Persist the drafted settings. */
  onSave: (settings: TopicPracticeSettings) => void;
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: SCREEN_GUTTER,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 16,
      padding: 20,
      gap: 12,
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    topicTitle: {
      fontSize: 13,
      color: c.textMuted,
    },
    body: {
      gap: 4,
    },
    explanation: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textSecondary,
      paddingBottom: 6,
    },
    settingRow: {
      gap: 2,
      paddingVertical: 6,
    },
    settingHeader: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
    },
    settingLabel: {
      flex: 1,
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
    },
    settingValue: {
      fontSize: 14,
      fontWeight: '700',
      color: c.accent,
    },
    settingHint: {
      fontSize: 12,
      lineHeight: 16,
      color: c.textMuted,
    },
    error: {
      fontSize: 13,
      lineHeight: 18,
      color: c.errorText,
    },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
      marginTop: 4,
    },
    button: {
      minWidth: 88,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    cancelButton: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    saveButton: {
      backgroundColor: c.primary,
    },
    disabled: {
      opacity: 0.5,
    },
    cancelText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    saveText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.onPrimary,
    },
  });
}

interface SettingRowProps {
  label: string;
  hint: string;
  value: number;
  minimumValue: number;
  maximumValue: number;
  step: number;
  testKey: string;
  /** `true` when 0 is a meaningful "Off" state rather than a plain number. */
  hasOff?: boolean;
  /** Unit suffix shown after the number (e.g. "min"). */
  unit?: string;
  onValueChange: (value: number) => void;
  styles: ReturnType<typeof createStyles>;
}

function SettingRow({
  label,
  hint,
  value,
  minimumValue,
  maximumValue,
  step,
  testKey,
  hasOff = false,
  unit,
  onValueChange,
  styles,
}: SettingRowProps) {
  const valueLabel = hasOff && value === 0 ? 'Off' : unit ? `${value} ${unit}` : String(value);
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingHeader}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingValue} testID={`practice-settings-value-${testKey}`}>
          {valueLabel}
        </Text>
      </View>
      <Slider
        minimumValue={minimumValue}
        maximumValue={maximumValue}
        step={step}
        value={value}
        onValueChange={raw => onValueChange(Math.round(raw))}
        accessibilityLabel={label}
        testID={`practice-settings-slider-${testKey}`}
      />
      <Text style={styles.settingHint}>{hint}</Text>
    </View>
  );
}

export function PracticeSettingsModal({
  visible,
  topicTitle,
  settings,
  saving,
  error,
  onCancel,
  onSave,
}: PracticeSettingsModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // The drafts reset from the persisted values every time the dialog opens, so
  // a cancelled edit never leaks into the next opening.
  const [draft, setDraft] = useState<TopicPracticeSettings>(settings);
  useEffect(() => {
    if (visible) {
      setDraft({
        learn_ahead_minutes: clampLearnAheadMinutes(settings.learn_ahead_minutes),
        new_cards_per_day: clampNewCardsPerDay(settings.new_cards_per_day),
        max_reviews_per_day: clampMaxReviewsPerDay(settings.max_reviews_per_day),
        max_session_cards: clampMaxSessionCards(settings.max_session_cards),
      });
    }
  }, [visible, settings]);

  if (!visible) {
    return null;
  }

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!saving) {
          onCancel();
        }
      }}
      testID="practice-settings-modal"
      transparent
      visible>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <ScrollView
            nestedScrollEnabled
            showsVerticalScrollIndicator
            testID="practice-settings-scroll">
            <Text style={styles.title} testID="practice-settings-title">
              Practice settings
            </Text>
            <Text style={styles.topicTitle} numberOfLines={1} testID="practice-settings-topic">
              {topicTitle}
            </Text>

            <View style={styles.body}>
              <Text style={styles.explanation} testID="practice-settings-explanation">
                Anki-style deck options for this topic. The daily limits reset at your study-day
                rollover; cards still in a learning step are never limited.
              </Text>

              <SettingRow
                label="Learn ahead limit"
                hint="Learning cards due within this many minutes may be shown early once nothing is due. 0 waits for the exact due time."
                value={draft.learn_ahead_minutes}
                minimumValue={MIN_LEARN_AHEAD_MINUTES}
                maximumValue={MAX_LEARN_AHEAD_MINUTES}
                step={1}
                testKey="learnAhead"
                hasOff
                unit="min"
                onValueChange={value =>
                  setDraft(previous => ({ ...previous, learn_ahead_minutes: value }))
                }
                styles={styles}
              />

              <SettingRow
                label="New cards per day"
                hint="At most this many new cards enter practice per study day; the rest wait for tomorrow. 0 hides new cards."
                value={draft.new_cards_per_day}
                minimumValue={MIN_NEW_CARDS_PER_DAY}
                maximumValue={MAX_NEW_CARDS_PER_DAY}
                step={1}
                testKey="newPerDay"
                hasOff
                onValueChange={value =>
                  setDraft(previous => ({ ...previous, new_cards_per_day: value }))
                }
                styles={styles}
              />

              <SettingRow
                label="Max reviews per day"
                hint="At most this many review cards per study day. 0 hides review cards."
                value={draft.max_reviews_per_day}
                minimumValue={MIN_MAX_REVIEWS_PER_DAY}
                maximumValue={MAX_MAX_REVIEWS_PER_DAY}
                step={5}
                testKey="maxReviews"
                hasOff
                onValueChange={value =>
                  setDraft(previous => ({ ...previous, max_reviews_per_day: value }))
                }
                styles={styles}
              />

              <SettingRow
                label="Max cards per session"
                hint="How many cards one practice sitting holds."
                value={draft.max_session_cards}
                minimumValue={MIN_SESSION_CARDS}
                maximumValue={MAX_SESSION_CARDS_LIMIT}
                step={5}
                testKey="sessionCards"
                onValueChange={value =>
                  setDraft(previous => ({ ...previous, max_session_cards: value }))
                }
                styles={styles}
              />

              {error ? (
                <Text role="alert" style={styles.error} testID="practice-settings-error">
                  {error}
                </Text>
              ) : null}
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saving }}
              testID="practice-settings-cancel"
              onPress={() => {
                if (!saving) {
                  onCancel();
                }
              }}
              disabled={saving}
              style={({ pressed }) => [
                styles.button,
                styles.cancelButton,
                saving && styles.disabled,
                pressed && styles.disabled,
              ]}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saving, busy: saving }}
              testID="practice-settings-save"
              onPress={() => onSave(draft)}
              disabled={saving}
              style={({ pressed }) => [
                styles.button,
                styles.saveButton,
                saving && styles.disabled,
                pressed && styles.disabled,
              ]}>
              {saving ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.saveText}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
