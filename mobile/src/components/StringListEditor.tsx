/**
 * Dynamic list editor for one sentence field (MANUAL_SENTENCES).
 *
 * Each entry is a text box with a remove control on its last line, and an
 * "Add" button appends a new empty row. Used by the sentence edit screen for
 * meanings, situations, alternative phrasings, register notes and grammar
 * notes, so a sentence can carry any number of each.
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from './Icon';

export interface StringListEditorProps {
  /** Section label, e.g. "Meanings". */
  label: string;
  /** Current entries. */
  values: string[];
  /** Report the next entries (add/remove/edit). */
  onChange: (values: string[]) => void;
  /** Per-row placeholder. */
  placeholder?: string;
  /** Label of the add button; defaults to "Add". */
  addLabel?: string;
  /** Test-id prefix; rows use `${prefix}-input-${index}` / `${prefix}-remove-${index}`. */
  testIDPrefix: string;
  /**
   * Rows that cannot be removed, keeping at least this many text boxes visible.
   * Defaults to 0 (every row removable).
   */
  minRows?: number;
}

export function StringListEditor({
  label,
  values,
  onChange,
  placeholder,
  addLabel = 'Add',
  testIDPrefix,
  minRows = 0,
}: StringListEditorProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const update = (index: number, text: string) => {
    onChange(values.map((value, i) => (i === index ? text : value)));
  };
  const remove = (index: number) => {
    if (values.length <= minRows) {
      return;
    }
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      {values.map((value, index) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and edited in place
          key={`${testIDPrefix}-${index}`}
          style={styles.row}>
          <TextInput
            value={value}
            onChangeText={text => update(index, text)}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            multiline
            style={styles.input}
            testID={`${testIDPrefix}-input-${index}`}
            accessibilityLabel={`${label} ${index + 1}`}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${label} ${index + 1}`}
            accessibilityState={{ disabled: values.length <= minRows }}
            disabled={values.length <= minRows}
            onPress={() => remove(index)}
            testID={`${testIDPrefix}-remove-${index}`}
            style={({ pressed }) => [
              styles.removeButton,
              values.length <= minRows && styles.removeDisabled,
              pressed && styles.pressedFade,
            ]}>
            <Icon name="close" size={16} color={colors.danger} />
          </Pressable>
        </View>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Add ${label.toLowerCase()}`}
        onPress={() => onChange([...values, ''])}
        testID={`${testIDPrefix}-add`}
        style={({ pressed }) => [styles.addButton, pressed && styles.pressedFade]}>
        <Icon name="plus" size={16} color={colors.primary} />
        <Text style={styles.addText}>{addLabel}</Text>
      </Pressable>
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    section: {
      gap: 8,
    },
    label: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    row: {
      flexDirection: 'row',
      // Bottom-aligned so the remove control sits on the entry's last line.
      alignItems: 'flex-end',
      gap: 8,
    },
    input: {
      flex: 1,
      minHeight: 44,
      maxHeight: 140,
      backgroundColor: c.surface,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: c.textPrimary,
      textAlignVertical: 'top',
    },
    removeButton: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    removeDisabled: {
      opacity: 0.4,
    },
    addButton: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 8,
    },
    addText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.primary,
    },
    pressedFade: {
      opacity: 0.7,
    },
  });
}
