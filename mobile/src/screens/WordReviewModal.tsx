/**
 * Review modal for one generation run (WORD_BANK_V1 TASK-WB-010).
 *
 * One row per candidate the pipeline produced: the word, its POS labels and
 * first sense, a keep toggle (default: keep) and two hints — a word that
 * already exists in ANOTHER topic shows "already in <topic>" without blocking
 * the insert, and a word kept despite a dictionary error shows "dictionary
 * unavailable — fetch its data later from Word detail".
 *
 * Persistence model: the generation pipeline (TASK-WB-004) has already stored
 * every kept candidate before this modal opens, so the modal's writes are a
 * reconciliation, not the first insert:
 *
 * - **Keep all** closes the modal; every candidate stays.
 * - **Keep selected** removes the rows the learner toggled off (exactly the
 *   kept selection survives; a removed candidate is never re-persisted).
 * - **Discard all** is the escape: it closes without writing anything, so the
 *   learner can also curate the words later from the list.
 *
 * Duplicates within the topic are skipped silently by the repository, so a
 * kept candidate whose row already exists never fails the reconciliation.
 */
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

import { Icon } from '../components/Icon';
import { SCREEN_GUTTER } from '../components/ScreenLayout';
import type { WordRecord } from '../db/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

export interface WordReviewModalProps {
  visible: boolean;
  /** The candidates of this run, already persisted by the pipeline. */
  candidates: readonly WordRecord[];
  /** Per-candidate cross-topic hint: the other topic's title, when any. */
  duplicateTopicTitles: Readonly<Record<number, string>>;
  /** True while the reconciliation write is running. */
  busy: boolean;
  /** Message shown when the reconciliation failed; the modal stays open. */
  error: string | null;
  /** Keep every candidate (no write needed) and close. */
  onKeepAll: () => void;
  /** Keep exactly these candidate ids; the others are removed. */
  onKeepSelected: (keptIds: number[]) => void;
  /** Close without writing anything. */
  onDiscard: () => void;
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
      maxWidth: 460,
      maxHeight: '85%',
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
    subtitle: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textSecondary,
    },
    list: {
      gap: 8,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: c.background,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 10,
    },
    rowText: {
      flex: 1,
      gap: 2,
    },
    rowWord: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    rowSense: {
      fontSize: 12,
      color: c.textSecondary,
      lineHeight: 16,
    },
    rowHint: {
      fontSize: 11,
      color: c.textMuted,
      fontStyle: 'italic',
    },
    rowHintWarning: {
      color: c.errorText,
      fontStyle: 'italic',
    },
    toggle: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    toggleKept: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    error: {
      fontSize: 13,
      lineHeight: 18,
      color: c.errorText,
    },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      flexWrap: 'wrap',
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
    keepButton: {
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
    keepText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.onPrimary,
    },
    listScroll: {
      flexGrow: 0,
      // Full-bleed over the card's horizontal padding so the Android
      // scrollbar anchors to the card's right edge instead of floating
      // inside the padding gutter; the content keeps its original inset.
      marginLeft: -20,
      marginRight: -20,
      paddingHorizontal: 20,
    },
  });
}

/** The first POS label across the candidate's senses, or a placeholder. */
function posLabel(word: WordRecord): string {
  const labels = word.senses_json.map(sense => sense.partOfSpeech).filter(Boolean);
  return labels.length > 0 ? labels.join(', ') : 'no data yet';
}

/** The first definition the candidate carries, for the row preview. */
function firstSensePreview(word: WordRecord): string {
  return word.senses_json[0]?.definitions[0]?.definition ?? '';
}

export function WordReviewModal({
  visible,
  candidates,
  duplicateTopicTitles,
  busy,
  error,
  onKeepAll,
  onKeepSelected,
  onDiscard,
}: WordReviewModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [keptIds, setKeptIds] = useState<Set<number>>(new Set());

  // Each run starts with every candidate kept.
  useEffect(() => {
    if (visible) {
      setKeptIds(new Set(candidates.map(candidate => candidate.id)));
    }
  }, [visible, candidates]);

  if (!visible) {
    return null;
  }

  const selectedCount = keptIds.size;
  const allKept = selectedCount === candidates.length;
  const keepSelectedDisabled = busy || selectedCount === 0 || allKept;

  const toggle = (id: number) => {
    setKeptIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={onDiscard}
      testID="word-review-modal"
      transparent
      visible>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.title} testID="word-review-title">
            Review new words
          </Text>
          <Text style={styles.subtitle}>
            {`${candidates.length} candidate${candidates.length === 1 ? '' : 's'} — untick the ` +
              'ones you do not want, then keep your selection.'}
          </Text>

          <ScrollView
            style={styles.listScroll}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            testID="word-review-list-scroll">
            <View style={styles.list}>
              {candidates.map(candidate => {
                const kept = keptIds.has(candidate.id);
                const duplicateOf = duplicateTopicTitles[candidate.id];
                return (
                  <View
                    key={candidate.id}
                    style={styles.row}
                    testID={`word-review-row-${candidate.id}`}>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={`Keep ${candidate.text}`}
                      accessibilityState={{ checked: kept }}
                      testID={`word-review-keep-${candidate.id}`}
                      onPress={() => toggle(candidate.id)}
                      style={[styles.toggle, kept && styles.toggleKept]}>
                      {kept ? <Icon name="check" size={18} color={colors.onPrimary} /> : null}
                    </Pressable>
                    <View style={styles.rowText}>
                      <Text style={styles.rowWord}>{candidate.text}</Text>
                      {firstSensePreview(candidate) ? (
                        <Text style={styles.rowSense} numberOfLines={2}>
                          {`${posLabel(candidate)} — ${firstSensePreview(candidate)}`}
                        </Text>
                      ) : (
                        <Text style={styles.rowSense}>{posLabel(candidate)}</Text>
                      )}
                      {duplicateOf ? (
                        <Text
                          style={styles.rowHint}
                          testID={`word-review-duplicate-${candidate.id}`}>
                          {`already in ${duplicateOf}`}
                        </Text>
                      ) : null}
                      {candidate.data_status === 'missing' ? (
                        <Text
                          style={[styles.rowHint, styles.rowHintWarning]}
                          testID={`word-review-missing-${candidate.id}`}>
                          dictionary unavailable — fetch its data later from Word detail
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          </ScrollView>

          {error ? (
            <Text role="alert" style={styles.error} testID="word-review-error">
              {error}
            </Text>
          ) : null}

          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              testID="word-review-discard"
              onPress={onDiscard}
              disabled={busy}
              style={({ pressed }) => [
                styles.button,
                styles.cancelButton,
                busy && styles.disabled,
                pressed && styles.disabled,
              ]}>
              <Text style={styles.cancelText}>Discard all</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: keepSelectedDisabled, busy }}
              testID="word-review-keep-selected"
              onPress={() =>
                onKeepSelected(candidates.filter(c => keptIds.has(c.id)).map(c => c.id))
              }
              disabled={keepSelectedDisabled}
              style={({ pressed }) => [
                styles.button,
                styles.cancelButton,
                keepSelectedDisabled && styles.disabled,
                pressed && styles.disabled,
              ]}>
              <Text style={styles.cancelText}>
                {selectedCount === 0 ? 'Keep selected' : `Keep ${selectedCount} selected`}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy, busy }}
              testID="word-review-keep-all"
              onPress={onKeepAll}
              disabled={busy}
              style={({ pressed }) => [
                styles.button,
                styles.keepButton,
                busy && styles.disabled,
                pressed && styles.disabled,
              ]}>
              {busy ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.keepText}>Keep all</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
