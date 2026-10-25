/**
 * Shared transient toast: the self-dismissing bottom card every screen uses
 * to confirm an action. Purely visual — each screen keeps its own timer and
 * visibility state and simply passes the current message; `null` renders
 * nothing. The card ignores touches (`pointerEvents="none"`) so it never
 * blocks the UI underneath.
 *
 * `testID` lands on the card and `<testID>-text` on the message, matching
 * the testIDs the screens already had. Error toasts switch the border/text
 * color and the accessibility role to alert.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

export interface ToastProps {
  /** Current message; null (or empty) hides the toast. */
  message: string | null;
  /** Error variant: error-colored border and text, alert role. */
  kind?: 'success' | 'error';
  /** Card testID; the message text gets `<testID>-text`. */
  testID: string;
  /** Distance from the screen bottom; the chat composer sits under its toast. */
  bottom?: number;
  /** Horizontal inset from the screen edges. */
  inset?: number;
}

export function Toast({ message, kind = 'success', testID, bottom = 24, inset = 24 }: ToastProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors, bottom, inset), [colors, bottom, inset]);

  if (message === null || message === '') {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      style={[styles.toast, kind === 'error' ? styles.toastError : null]}
      testID={testID}>
      <Text
        role={kind === 'error' ? 'alert' : 'status'}
        style={[styles.toastText, kind === 'error' ? styles.toastTextError : null]}
        testID={`${testID}-text`}>
        {message}
      </Text>
    </View>
  );
}

function createStyles(c: ThemeColors, bottom: number, inset: number) {
  return StyleSheet.create({
    toast: {
      position: 'absolute',
      bottom,
      left: inset,
      right: inset,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      alignItems: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.15,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 6,
    },
    toastText: {
      color: c.success,
      fontSize: 14,
      fontWeight: '600',
      textAlign: 'center',
    },
    toastError: {
      borderColor: c.errorText,
    },
    toastTextError: {
      color: c.errorText,
    },
  });
}
