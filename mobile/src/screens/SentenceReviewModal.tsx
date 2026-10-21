/**
 * Sentence generation review modal (SENTENCE_LIVE_V1 §2.7, TASK-SENT-010).
 *
 * After the AI generates a batch of candidate sentences the learner reviews
 * them in this modal before any of them are persisted. Each candidate shows
 * its sentence, meaning and situation with a keep toggle (default: keep);
 * the actions are Keep all, Keep selected (disabled when nothing is selected)
 * and a Discard all escape hatch that closes without writing. Kept
 * candidates are persisted in one repository transaction; duplicates —
 * either against existing sentences of the topic or within the kept set —
 * are skipped silently.
 */
import React, {useCallback, useMemo, useState} from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {Icon} from '../components/Icon';
import {SCREEN_GUTTER} from '../components/ScreenLayout';
import type {SentenceCandidate} from '../serverless/sentenceGeneration';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

export interface SentenceReviewModalProps {
  /** Whether the modal is presented. */
  visible: boolean;
  /** The candidate sentences returned by generation. */
  candidates: SentenceCandidate[];
  /** Dismissal callback (Discard all, Keep actions, Android back). */
  onClose: () => void;
  /**
   * Persist only the kept candidates. Receives the count actually written
   * (duplicates may be skipped) and the kept candidates for confirmation.
   */
  onKeep: (kept: SentenceCandidate[]) => Promise<void>;
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    container: {
      maxHeight: '90%',
      backgroundColor: c.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      overflow: 'hidden',
    },
    list: {
      flexGrow: 0,
      flexShrink: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: SCREEN_GUTTER,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      justifyContent: 'flex-end',
      paddingHorizontal: SCREEN_GUTTER,
      paddingVertical: 14,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.surface,
    },
    actionButton: {
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    actionText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.primary,
    },
    actionTextDisabled: {
      color: c.textMuted,
    },
    candidate: {
      flexDirection: 'row',
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: SCREEN_GUTTER,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      alignItems: 'flex-start',
    },
    candidateText: {
      flex: 1,
      gap: 2,
    },
    candidateIndex: {
      fontSize: 11,
      fontWeight: '700',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 2,
    },
    sentence: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
      lineHeight: 21,
    },
    meaning: {
      fontSize: 13,
      color: c.textSecondary,
      lineHeight: 18,
      marginTop: 2,
    },
    situation: {
      fontSize: 12,
      color: c.textMuted,
      fontStyle: 'italic',
      lineHeight: 17,
      marginTop: 2,
    },
    keepToggle: {
      width: 24,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 2,
    },
    keepIcon: {
      color: c.primary,
    },
    keepIconOff: {
      color: c.textMuted,
    },
  });
}

/**
 * The review modal for generated sentence candidates. Let the learner keep or
 * discard each sentence before it is written to the database.
 */
export function SentenceReviewModal({
  visible,
  candidates,
  onClose,
  onKeep,
}: SentenceReviewModalProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Track which candidates are kept; default all to true.
  const initialToggles = useMemo(
    () => candidates.map(() => true),
    [candidates],
  );
  const [toggles, setToggles] = useState<boolean[]>(initialToggles);

  // When the candidate set changes (e.g. re-opened), reset the toggles.
  React.useEffect(() => {
    if (visible) {
      setToggles(candidates.map(() => true));
    }
  }, [visible, candidates]);

  const keptCount = useMemo(() => toggles.filter(Boolean).length, [toggles]);
  const hasSelection = keptCount > 0;

  const handleToggle = useCallback((index: number) => {
    setToggles(prev =>
      prev.map((value, i) => (i === index ? !value : value)),
    );
  }, []);

  const handleKeepSelected = useCallback(async () => {
    const kept = candidates.filter((_, index) => toggles[index]);
    await onKeep(kept);
    onClose();
  }, [candidates, toggles, onKeep, onClose]);

  const handleKeepAll = useCallback(async () => {
    await onKeep(candidates);
    onClose();
  }, [candidates, onKeep, onClose]);

  const handleDiscard = useCallback(() => {
    // Close without persisting anything.
    onClose();
  }, [onClose]);

  if (!visible) {
    return null;
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={handleDiscard}
      testID="sentence-review-modal"
      transparent
      visible
    >
      <View style={styles.backdrop}>
        <View style={styles.container} accessibilityViewIsModal>
          <View style={styles.header}>
            <Text style={styles.title} testID="sentence-review-title">
              Review sentences
            </Text>
            <Text style={styles.candidateIndex} testID="sentence-review-count">
              {keptCount} of {candidates.length} kept
            </Text>
          </View>

          <ScrollView style={styles.list}>
            {candidates.map((candidate, index) => {
              const kept = toggles[index] ?? true;
              return (
                <View
                  key={`candidate-${index}`}
                  style={styles.candidate}
                  testID={`sentence-candidate-${index}`}
                >
                  <View style={styles.keepToggle}>
                    <Pressable
                      onPress={() => handleToggle(index)}
                      testID={`sentence-toggle-${index}`}
                      accessibilityRole="checkbox"
                      accessibilityLabel={
                        kept ? 'Remove from kept' : 'Keep sentence'
                      }
                      accessibilityState={{checked: kept}}
                    >
                      <Icon
                        name="check"
                        size={20}
                        color={kept ? colors.primary : colors.textMuted}
                        testID={`sentence-toggle-icon-${index}`}
                      />
                    </Pressable>
                  </View>
                  <View style={styles.candidateText}>
                    <Text style={styles.candidateIndex}>{index + 1}</Text>
                    <Text style={styles.sentence}>{candidate.sentence}</Text>
                    {candidate.meaning ? (
                      <Text style={styles.meaning}>{candidate.meaning}</Text>
                    ) : null}
                    {candidate.situation ? (
                      <Text style={styles.situation}>{candidate.situation}</Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              onPress={handleDiscard}
              testID="sentence-discard-all"
              style={styles.actionButton}
            >
              <Text style={[styles.actionText, {color: colors.textMuted}]}>
                Discard all
              </Text>
            </Pressable>
            <Pressable
              onPress={handleKeepAll}
              testID="sentence-keep-all"
              style={styles.actionButton}
            >
              <Text style={styles.actionText}>Keep all</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{disabled: !hasSelection}}
              onPress={handleKeepSelected}
              testID="sentence-keep-selected"
              disabled={!hasSelection}
              style={styles.actionButton}
            >
              <Text
                style={[
                  styles.actionText,
                  !hasSelection && {color: colors.textMuted},
                ]}
              >
                Keep selected
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
