/**
 * The app's single back control: the `‹ Label` text link in the accent
 * color, left-aligned in a screen header. Every pushed screen uses it —
 * same position, size and pressed feedback — with a contextual label that
 * names the destination ("Back", "Topics", "Home", …).
 *
 * The touch target is padded to 44pt (hitSlop adds slack beyond the text)
 * per the mobile target minimum; the visual glyph stays the compact
 * `‹ Label` link the app has always used.
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

export interface ScreenBackButtonProps {
  /** Contextual destination name, shown after the chevron; default "Back". */
  label?: string;
  onPress: () => void;
  /** The screen's existing back testID, kept unchanged. */
  testID?: string;
}

export function ScreenBackButton({ label = 'Back', onPress, testID }: ScreenBackButtonProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === 'Back' ? 'Go back' : `Back to ${label}`}
      hitSlop={{ top: 12, bottom: 12, right: 12, left: 0 }}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      testID={testID}>
      <Text style={styles.text}>{`‹ ${label}`}</Text>
    </Pressable>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    button: {
      minHeight: 44,
      justifyContent: 'center',
      paddingRight: 8,
    },
    text: {
      fontSize: 16,
      color: c.accent,
      fontWeight: '600',
    },
    pressed: {
      opacity: 0.72,
    },
  });
}
