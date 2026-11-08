/**
 * Sentence enrichment change-review modal (MANUAL_SENTENCES).
 *
 * Shows the AI proposal next to the sentence's current content, one paired row
 * per field (meanings, situations, alternatives, register notes, grammar notes)
 * inside a scrollable list, so the Apply/Cancel actions are always reachable.
 * Nothing is saved until the learner approves; the sentence text and schedule
 * are never part of the proposal.
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
import { createModalStyles } from '../components/modalChrome';
import type { SentenceEnrichmentProposal } from '../serverless/sentenceEnrichment';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

/** The content half of a sentence, as shown in the comparison. */
export interface SentenceContentSnapshot {
  meanings: string[];
  situations: string[];
  alternatives: string[];
  registers: string[];
  grammar_notes: string[];
}

export interface SentenceEnrichReviewModalProps {
  /** The proposed content; null hides the modal. */
  proposal: SentenceEnrichmentProposal | null;
  /** The sentence's currently stored content. */
  current: SentenceContentSnapshot;
  /** True while the approved proposal persists. */
  applying: boolean;
  /** Failure message kept visible inside the modal. */
  error: string | null;
  /** Dismiss without saving (Cancel or Android back). */
  onCancel: () => void;
  /** Apply the proposal; the screen owns persistence and error handling. */
  onApply: () => void;
}

interface FieldRow {
  key: keyof SentenceContentSnapshot;
  label: string;
}

const FIELDS: readonly FieldRow[] = [
  { key: 'meanings', label: 'Meanings' },
  { key: 'situations', label: 'Situations' },
  { key: 'alternatives', label: 'Other ways to say it' },
  { key: 'registers', label: 'Register / nuance' },
  { key: 'grammar_notes', label: 'Grammar / structure' },
];

export function SentenceEnrichReviewModal({
  proposal,
  current,
  applying,
  error,
  onCancel,
  onApply,
}: SentenceEnrichReviewModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const renderCell = (values: readonly string[]) =>
    values.length === 0 ? (
      <Text style={styles.noDataText}>None.</Text>
    ) : (
      values.map((value, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: values are positional display rows
          key={`value-${index}`}
          style={styles.valueText}>
          {values.length > 1 ? `• ${value}` : value}
        </Text>
      ))
    );

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      testID="sentence-enrich-modal"
      transparent
      visible={proposal !== null}>
      <View style={styles.backdrop}>
        <View style={styles.enrichCard} accessibilityViewIsModal>
          <Text style={styles.modalTitle} testID="sentence-enrich-title">
            Review proposed content
          </Text>
          <View style={styles.pairHeaderRow}>
            <Text style={styles.pairHeaderLabel} testID="sentence-enrich-old-label">
              Current
            </Text>
            <Text style={styles.pairHeaderLabel} testID="sentence-enrich-new-label">
              Proposed
            </Text>
          </View>
          <ScrollView
            style={styles.pairListScroll}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            testID="sentence-enrich-list-scroll">
            {FIELDS.map((field, index) => (
              <View
                key={field.key}
                style={styles.fieldBlock}
                testID={`sentence-enrich-row-${index}`}>
                <Text style={styles.fieldLabel}>{field.label}</Text>
                <View style={styles.pairRow}>
                  <View style={styles.pairCell} testID={`sentence-enrich-old-${index}`}>
                    {renderCell(current[field.key])}
                  </View>
                  <View style={styles.pairCell} testID={`sentence-enrich-new-${index}`}>
                    {renderCell(proposal?.[field.key] ?? [])}
                  </View>
                </View>
              </View>
            ))}
          </ScrollView>
          {error ? (
            <Text role="alert" style={styles.modalError} testID="sentence-enrich-error">
              {error}
            </Text>
          ) : null}
          <View style={styles.modalFooter}>
            <Pressable
              accessibilityRole="button"
              testID="sentence-enrich-cancel"
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
              testID="sentence-enrich-apply"
              onPress={() => onApply()}
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
                <Text style={styles.modalPrimaryText}>Apply</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: ThemeColors) {
  const modal = createModalStyles(c);
  return StyleSheet.create({
    ...modal,
    enrichCard: {
      ...modal.modalCard,
      maxWidth: 560,
      maxHeight: '90%',
    },
    fieldBlock: {
      gap: 6,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    fieldLabel: {
      fontSize: 12,
      fontWeight: '700',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 1,
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
      flexShrink: 1,
    },
    pairRow: {
      flexDirection: 'row',
      gap: 12,
    },
    pairCell: {
      flex: 1,
      gap: 4,
      backgroundColor: c.background,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 10,
    },
    valueText: {
      fontSize: 14,
      lineHeight: 19,
      color: c.textPrimary,
    },
    noDataText: {
      fontSize: 14,
      color: c.textSecondary,
    },
  });
}
