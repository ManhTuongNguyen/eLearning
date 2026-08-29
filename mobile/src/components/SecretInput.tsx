/**
 * SecretInput (SPEC TASK-AUTH-UI): a reusable masked text field with an
 * eye toggle. Used for passwords, API keys, tokens, etc.
 *
 * - `secureTextEntry` is used while hidden so the platform masks every
 *   keystroke uniformly (no per-OS "show last char then mask" animation).
 *   We defeat the side-effect of the first letter being auto-capitalized
 *   with `autoCapitalize="none"`.
 * - When the user taps the eye icon we turn `secureTextEntry` off and pin
 *   the native selection to position 0. Without that, Android keeps the
 *   visible region anchored to the cursor (which is at the end of the
 *   string) and only the trailing character is in view. The
 *   `selection` prop re-syncs in the same paint as the value change.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';

export interface SecretInputProps {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  /** Optional label rendered above the field. */
  label?: string;
  /** Initial visibility. Defaults to hidden. */
  defaultVisible?: boolean;
  /** Test hook forwarded to the underlying text input. */
  testID?: string;
  /** Container style override. */
  containerStyle?: StyleProp<ViewStyle>;
  /** Input style override. */
  inputStyle?: StyleProp<TextStyle>;
  /** Forwarded to the TextInput onSubmitEditing chain. */
  onSubmitEditing?: () => void;
  /** Return-key label. */
  returnKeyType?: 'done' | 'go' | 'next' | 'search' | 'send';
  /** Auto-focus on mount. */
  autoFocus?: boolean;
  /** Editable flag forwarded to TextInput. */
  editable?: boolean;
  /**
   * Forwarded to the underlying TextInput's `textContentType` so platform
   * password managers can match the field correctly. Defaults to
   * `'password'`; pass `'none'` for API keys / tokens.
   */
  textContentType?: 'password' | 'none' | 'username' | 'emailAddress';
  /** Whether to render the field's border. Defaults to true. */
  showBorder?: boolean;
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    wrapper: {
      gap: 6,
    },
    label: {
      fontSize: 13,
      color: c.textSecondary,
      fontWeight: '500',
    },
    fieldRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 10,
      backgroundColor: c.surface,
    },
    input: {
      flex: 1,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: c.textPrimary,
      letterSpacing: 1,
    },
    eyeButton: {
      width: 44,
      height: 44,
      justifyContent: 'center',
      alignItems: 'center',
    },
  });
}

/**
 * Hand-drawn eye icon rendered with plain Views — no icon library or font
 * asset. A diagonal slash is drawn on top while the value is hidden.
 */
function EyeIcon({ hidden, color }: { hidden: boolean; color: string }) {
  return (
    <View
      style={eyeStyles.container}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <View style={[eyeStyles.outer, { borderColor: color }]} />
      <View style={[eyeStyles.pupil, { backgroundColor: color }]} />
      {hidden ? (
        <View
          pointerEvents="none"
          style={[eyeStyles.slash, { backgroundColor: color }]}
        />
      ) : null}
    </View>
  );
}

const EYE_SIZE = 22;

const eyeStyles = StyleSheet.create({
  container: {
    width: EYE_SIZE,
    height: EYE_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  outer: {
    position: 'absolute',
    width: EYE_SIZE * 0.6,
    height: EYE_SIZE * 0.6,
    borderRadius: EYE_SIZE,
    borderWidth: 1.6,
    backgroundColor: 'transparent',
  },
  pupil: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  slash: {
    position: 'absolute',
    width: EYE_SIZE - 2,
    height: 1.8,
    transform: [{ rotate: '-45deg' }],
    borderRadius: 1,
  },
});

export function SecretInput({
  value,
  onChangeText,
  placeholder,
  label,
  defaultVisible = false,
  testID,
  containerStyle,
  inputStyle,
  onSubmitEditing,
  returnKeyType,
  autoFocus,
  editable,
  textContentType = 'password',
  showBorder = true,
}: SecretInputProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [visible, setVisible] = useState(defaultVisible);
  // While true, the TextInput is forced to selection {0,0} on the next
  // render so the native view scrolls to the start of the revealed value.
  // It auto-clears on the next frame so the user can move the cursor
  // freely afterwards.
  const [pinSelection, setPinSelection] = useState(false);

  const toggleVisible = useCallback(() => {
    setVisible(v => {
      const next = !v;
      if (next) {
        setPinSelection(true);
      }
      return next;
    });
  }, []);

  // Release the selection pin after one paint so the user can move the
  // cursor once the field is revealed.
  useEffect(() => {
    if (!pinSelection) {
      return;
    }
    const handle = setTimeout(() => setPinSelection(false), 50);
    return () => clearTimeout(handle);
  }, [pinSelection]);

  const toggleColor = visible ? colors.textSecondary : colors.accent;

  return (
    <View style={[styles.wrapper, containerStyle]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View
        style={[
          styles.fieldRow,
          !showBorder && { borderWidth: 0, backgroundColor: 'transparent' },
        ]}
      >
        <TextInput
          style={[styles.input, inputStyle]}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          keyboardType="default"
          textContentType={textContentType}
          secureTextEntry={!visible}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmitEditing}
          returnKeyType={returnKeyType}
          autoFocus={autoFocus}
          editable={editable}
          // Pin the cursor to position 0 only for the render immediately
          // after a reveal, so the user can move the cursor afterwards.
          selection={pinSelection ? { start: 0, end: 0 } : undefined}
          testID={testID}
          accessibilityLabel={label ?? placeholder}
        />
        <Pressable
          onPress={toggleVisible}
          accessibilityRole="button"
          accessibilityLabel={visible ? 'Hide value' : 'Show value'}
          hitSlop={8}
          style={styles.eyeButton}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <EyeIcon hidden={!visible} color={toggleColor} />
        </Pressable>
      </View>
    </View>
  );
}
