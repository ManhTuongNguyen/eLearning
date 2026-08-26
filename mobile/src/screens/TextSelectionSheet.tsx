/**
 * Text selection sheet (SPEC TASK-069, ROADMAP §9): lets the learner mark a
 * single word, phrase or multi-word expression inside one message for the
 * vocabulary flow. React Native exposes no JavaScript callback for native
 * selections over static Text, so the message content renders in an editable
 * multiline input whose controlled value stays pinned to the original text —
 * edit attempts are discarded — while native selection handles report spans
 * through onSelectionChange. A live preview confirms exactly what will be
 * handed off before "Save word" passes the trimmed substring to the save
 * flow; Cancel, the Close control, a backdrop tap and the Android back
 * button dismiss without capturing anything. The surface only exists while
 * presented, so every opening starts with a clean selection, and it mirrors
 * MessageActionsMenu/ImprovementSheet: a bottom card over a dismissible
 * backdrop whose body is an accessibility modal with labeled controls.
 */
import React, {useCallback, useMemo, useState} from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type {TextInputSelectionChangeEvent} from 'react-native';

import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

/** A non-collapsed selection span within the pinned message content. */
interface SelectionSpan {
  start: number;
  end: number;
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: 16,
      paddingBottom: 20,
      paddingTop: 6,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 4,
    },
    title: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    closeText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.accent,
      paddingVertical: 4,
    },
    hintText: {
      fontSize: 13,
      lineHeight: 19,
      color: c.textSecondary,
      marginBottom: 10,
    },
    selectArea: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 12,
      backgroundColor: c.background,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      lineHeight: 21,
      color: c.textPrimary,
      maxHeight: 220,
      textAlignVertical: 'top',
    },
    sectionLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textMuted,
      marginTop: 14,
      marginBottom: 4,
      textTransform: 'uppercase',
    },
    previewBox: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 12,
      backgroundColor: c.background,
      paddingHorizontal: 14,
      paddingVertical: 12,
      minHeight: 46,
      justifyContent: 'center',
    },
    previewText: {
      fontSize: 15,
      lineHeight: 21,
      color: c.primary,
      fontWeight: '500',
    },
    previewEmpty: {
      color: c.textMuted,
      fontWeight: '400',
    },
    actionsRow: {
      flexDirection: 'row',
      gap: 10,
      marginTop: 16,
    },
    cancelButton: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: 'center',
    },
    cancelButtonText: {
      color: c.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    saveButton: {
      flex: 1,
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: 'center',
    },
    saveDisabled: {
      opacity: 0.5,
    },
    saveButtonText: {
      color: c.onPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
  });
}

interface SurfaceProps {
  /** Full message content offered for selection. */
  content: string;
  /** Dismissal callback (Cancel, Close, backdrop tap and Android back). */
  onClose: () => void;
  /** Receives the confirmed trimmed selection for the vocabulary flow. */
  onSave: (selectedText: string) => void;
}

/**
 * The interactive body of the sheet. Mounted only while the sheet is
 * presented, so its selection state never leaks across openings.
 */
function SelectionSurface({content, onClose, onSave}: SurfaceProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [selection, setSelection] = useState<SelectionSpan | null>(null);

  /**
   * Track the native selection handles. Collapsed ranges (a plain caret)
   * count as nothing selected, and out-of-bounds ends are clamped defensively.
   */
  const handleSelectionChange = useCallback(
    (event: TextInputSelectionChangeEvent) => {
      const {start, end} = event.nativeEvent.selection;
      const clampedEnd = Math.min(end, content.length);
      if (start >= clampedEnd) {
        setSelection(null);
        return;
      }
      setSelection({start, end: clampedEnd});
    },
    [content.length],
  );

  const selectedText = selection === null ? '' : content.slice(selection.start, selection.end);
  // Whitespace-only spans (e.g. a dragged range between words) are not a
  // savable expression.
  const trimmedSelection = selectedText.trim();

  const handleSave = useCallback(() => {
    if (trimmedSelection === '') {
      return;
    }
    onSave(trimmedSelection);
  }, [onSave, trimmedSelection]);

  return (
    <Pressable style={styles.backdrop} onPress={onClose} testID="chat-selection-backdrop">
      <Pressable style={styles.sheet} testID="chat-selection">
        <View accessibilityViewIsModal testID="chat-selection-content">
          <View style={styles.header}>
            <Text style={styles.title}>Select text</Text>
            <Pressable
              onPress={onClose}
              testID="chat-selection-close"
              accessibilityRole="button"
              accessibilityLabel="Close text selection">
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.hintText}>
            Select a word, phrase or expression below, then save it.
          </Text>
          <TextInput
            style={styles.selectArea}
            value={content}
            multiline
            onChangeText={() => {
              // Controlled pinning: the value never leaves the original
              // message, so keystrokes are dropped while selections keep
              // working.
            }}
            onSelectionChange={handleSelectionChange}
            testID="chat-selection-input"
            accessibilityLabel="Message text to select from"
          />
          <Text style={styles.sectionLabel}>Selected</Text>
          <View style={styles.previewBox} testID="chat-selection-preview">
            <Text
              style={[
                styles.previewText,
                trimmedSelection === '' && styles.previewEmpty,
              ]}>
              {trimmedSelection === '' ? 'Nothing selected yet.' : trimmedSelection}
            </Text>
          </View>
          <View style={styles.actionsRow}>
            <Pressable
              style={styles.cancelButton}
              onPress={onClose}
              testID="chat-selection-cancel"
              accessibilityRole="button"
              accessibilityLabel="Cancel text selection">
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.saveButton, trimmedSelection === '' && styles.saveDisabled]}
              disabled={trimmedSelection === ''}
              onPress={handleSave}
              testID="chat-selection-save"
              accessibilityRole="button"
              accessibilityLabel="Save selected word"
              accessibilityState={{disabled: trimmedSelection === ''}}>
              <Text style={styles.saveButtonText}>Save word</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Pressable>
  );
}

interface TextSelectionSheetProps {
  /** Whether the overlay is presented; closed sheets render nothing. */
  visible: boolean;
  /** Full message content offered for selection. */
  content: string;
  /** Dismissal callback (Cancel, Close, backdrop tap and Android back). */
  onClose: () => void;
  /** Receives the confirmed trimmed selection for the vocabulary flow. */
  onSave: (selectedText: string) => void;
}

export function TextSelectionSheet({
  visible,
  content,
  onClose,
  onSave,
}: TextSelectionSheetProps) {
  if (!visible) {
    return null;
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      testID="chat-selection-modal"
      transparent
      visible>
      <SelectionSurface content={content} onClose={onClose} onSave={onSave} />
    </Modal>
  );
}
