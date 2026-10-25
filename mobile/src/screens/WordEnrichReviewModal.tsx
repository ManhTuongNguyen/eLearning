/**
 * Enrichment change-review modal (WORD_BANK_V1 TASK-WB-014): the AI proposal
 * next to the current dictionary data, paired by part of speech (the
 * meaningful comparison) as aligned rows inside a scrollable list so the
 * Apply/Cancel actions are always reachable. Nothing is saved until the
 * learner approves.
 */
import { useMemo } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WordSenseList } from '../components/WordSenseList';
import type { WordSense } from '../db/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

export interface WordEnrichReviewModalProps {
  /** The proposed senses; null hides the modal. */
  proposal: WordSense[] | null;
  /** The word's currently stored senses. */
  currentSenses: readonly WordSense[];
  /** True while the approved proposal persists. */
  applying: boolean;
  /** Failure message kept visible inside the modal. */
  error: string | null;
  /** Dismiss without saving (Cancel or Android back). */
  onCancel: () => void;
  /** Apply the proposal; the screen owns persistence and error handling. */
  onApply: () => void;
}

export function WordEnrichReviewModal({
  proposal,
  currentSenses,
  applying,
  error,
  onCancel,
  onApply,
}: WordEnrichReviewModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  /**
   * One change-review cell: the sense group of that part of speech through
   * the shared renderer (POS is the row's identity, so the badge is hidden). A
   * side without that POS shows "No data."
   */
  const renderSenseCell = (senses: readonly WordSense[], partOfSpeech: string) => {
    const sense = senses.find(item => item.partOfSpeech === partOfSpeech);
    if (!sense) {
      return <Text style={styles.noDataText}>No data.</Text>;
    }
    return <WordSenseList senses={[sense]} showPosHeader={false} />;
  };

  /**
   * Paired rows align current and proposed groups by part of speech (the
   * meaningful comparison), not by position: one row per POS in the union of
   * both sides, current data first.
   */
  const sensePairKeys = useMemo(() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const sense of [...currentSenses, ...(proposal ?? [])]) {
      if (!seen.has(sense.partOfSpeech)) {
        seen.add(sense.partOfSpeech);
        keys.push(sense.partOfSpeech);
      }
    }
    return keys;
  }, [currentSenses, proposal]);

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      testID="word-enrich-modal"
      transparent
      visible={proposal !== null}>
      <View style={styles.backdrop}>
        <View style={styles.enrichCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} testID="word-enrich-title">
            Review proposed data
          </Text>
          <View style={styles.pairHeaderRow}>
            <Text style={styles.pairHeaderLabel} testID="word-enrich-old-label">
              Current
            </Text>
            <Text style={styles.pairHeaderLabel} testID="word-enrich-new-label">
              Proposed
            </Text>
          </View>
          <ScrollView
            style={styles.pairListScroll}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            testID="word-enrich-list-scroll">
            {sensePairKeys.map((partOfSpeech, index) => (
              <View key={partOfSpeech} style={styles.pairRow} testID={`word-enrich-row-${index}`}>
                <View style={styles.pairCell} testID={`word-enrich-old-${index}`}>
                  {renderSenseCell(currentSenses, partOfSpeech)}
                </View>
                <View style={styles.pairCell} testID={`word-enrich-new-${index}`}>
                  {renderSenseCell(proposal ?? [], partOfSpeech)}
                </View>
              </View>
            ))}
          </ScrollView>
          {error ? (
            <Text role="alert" style={styles.modalError} testID="word-enrich-error">
              {error}
            </Text>
          ) : null}
          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              testID="word-enrich-cancel"
              onPress={onCancel}
              disabled={applying}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalCancelButton,
                applying && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: applying, busy: applying }}
              testID="word-enrich-apply"
              onPress={() => {
                onApply();
              }}
              disabled={applying}
              style={({ pressed }) => [
                styles.modalButton,
                styles.modalPrimaryButton,
                applying && styles.modalDisabled,
                pressed && styles.modalDisabled,
              ]}>
              {applying ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.applyText}>Apply</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
    },
    enrichCard: {
      width: '100%',
      maxWidth: 560,
      maxHeight: '90%',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 16,
      padding: 20,
      gap: 12,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    pairHeaderRow: {
      flexDirection: 'row',
      gap: 12,
    },
    pairHeaderLabel: {
      flex: 1,
      fontSize: 12,
      fontWeight: '700',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    pairListScroll: {
      flexGrow: 0,
      // Full-bleed over the card's horizontal padding so the Android
      // scrollbar anchors to the card's right edge instead of floating
      // inside the padding gutter; the content keeps its original inset.
      marginLeft: -20,
      marginRight: -20,
      paddingHorizontal: 20,
    },
    pairRow: {
      flexDirection: 'row',
      gap: 12,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    pairCell: {
      flex: 1,
      gap: 6,
      backgroundColor: c.background,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 10,
    },
    modalError: {
      fontSize: 13,
      color: c.errorText,
    },
    modalFooter: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
      marginTop: 4,
    },
    modalButton: {
      minWidth: 88,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    modalCancelButton: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    modalPrimaryButton: {
      backgroundColor: c.primary,
    },
    modalDisabled: {
      opacity: 0.5,
    },
    modalCancelText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    applyText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.onPrimary,
    },
    noDataText: {
      fontSize: 14,
      color: c.textSecondary,
    },
    pressedFade: {
      opacity: 0.9,
    },
  });
}
