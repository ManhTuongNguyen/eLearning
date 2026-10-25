/**
 * One word row of a topic's bank (WORD_BANK_V1 TASK-WB-009, §2.8): the word
 * with its primary part of speech and a due/status hint, plus device-TTS
 * playback and a delete trigger. The screen owns the flows (navigation,
 * playback session, delete confirmation); this row reports intents back
 * through callbacks.
 */
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import type { WordRecord } from '../db/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingLeft: 16,
      paddingRight: 6,
    },
    rowMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    rowText: {
      flex: 1,
      gap: 1,
    },
    rowTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    rowSub: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    posLabel: {
      fontSize: 12,
      color: c.textMuted,
      fontStyle: 'italic',
    },
    statusHint: {
      fontSize: 11,
      fontWeight: '600',
      color: c.textMuted,
      backgroundColor: c.background,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 1,
      overflow: 'hidden',
    },
    statusDue: {
      color: c.onPrimary,
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    statusMissing: {
      color: c.errorText,
      borderColor: c.errorText,
    },
    rowIconButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressedFade: {
      opacity: 0.9,
    },
  });
}

/** The first POS label of the stored senses, or a placeholder. */
export function primaryPosLabel(word: WordRecord): string {
  return word.senses_json[0]?.partOfSpeech ?? '';
}

/** Short per-row schedule hint: due, in-learning, scheduled, or no data. */
export function wordStatusHint(
  word: WordRecord,
  nowMs: number,
): {
  label: string;
  due: boolean;
  missing: boolean;
} {
  if (word.data_status === 'missing') {
    return { label: 'no data', due: false, missing: true };
  }
  const dueMs = Date.parse(word.due_at);
  if (Number.isFinite(dueMs) && dueMs <= nowMs && !word.suspended) {
    return { label: 'due', due: true, missing: false };
  }
  if (word.suspended) {
    return { label: 'suspended', due: false, missing: false };
  }
  if (word.state === 'new') {
    return { label: 'new', due: false, missing: false };
  }
  return { label: word.state === 'review' ? 'scheduled' : 'learning', due: false, missing: false };
}

export interface WordRowProps {
  item: WordRecord;
  onPress: (item: WordRecord) => void;
  onSpeak: (item: WordRecord) => void;
  onDelete: (item: WordRecord) => void;
  speaking: boolean;
  deleting: boolean;
}

export function WordRow({ item, onPress, onSpeak, onDelete, speaking, deleting }: WordRowProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const pos = primaryPosLabel(item);
  const hint = wordStatusHint(item, Date.now());
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.text}`}
        testID={`word-${item.id}`}
        onPress={() => onPress(item)}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressedFade]}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.text}
          </Text>
          <View style={styles.rowSub}>
            {pos ? (
              <Text style={styles.posLabel} numberOfLines={1}>
                {pos}
              </Text>
            ) : null}
            <Text
              style={[
                styles.statusHint,
                hint.due && styles.statusDue,
                hint.missing && styles.statusMissing,
              ]}
              testID={`word-${item.id}-status`}>
              {hint.label}
            </Text>
          </View>
        </View>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Play ${item.text}`}
        accessibilityState={{ busy: speaking }}
        testID={`word-speak-${item.id}`}
        onPress={() => onSpeak(item)}
        style={({ pressed }) => [styles.rowIconButton, pressed && styles.pressedFade]}>
        <Icon name={speaking ? 'speaker' : 'play'} size={18} color={colors.accent} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${item.text}`}
        accessibilityState={{ disabled: deleting, busy: deleting }}
        testID={`word-delete-${item.id}`}
        onPress={() => onDelete(item)}
        disabled={deleting}
        style={({ pressed }) => [styles.rowIconButton, pressed && styles.pressedFade]}>
        {deleting ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : (
          <Icon name="trash" size={18} color={colors.danger} />
        )}
      </Pressable>
    </View>
  );
}
