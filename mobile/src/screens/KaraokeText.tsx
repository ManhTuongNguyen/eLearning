/**
 * Teleprompter pieces of the speaking-practice screen.
 *
 * `ClipboardIcon` — hand-drawn clipboard icon (outlined board with a filled
 * clip on top), built from plain Views like the eye icon: no icon library.
 *
 * `KaraokeText` — the teleprompter text block. Memoized so the once-a-second
 * elapsed-timer re-render of the screen does not reconcile the whole text
 * while the scroll is running.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

const LEAD_IN_BLANK_LINES = 3;

/**
 * Hand-drawn clipboard icon (outlined board with a filled clip on top), built
 * from plain Views like the eye icon: no icon library.
 */
export function ClipboardIcon({ color }: { color: string }) {
  return (
    <View
      style={clipboardStyles.container}
      accessibilityElementsHidden
      importantForAccessibility="no">
      <View style={[clipboardStyles.board, { borderColor: color }]} />
      <View style={[clipboardStyles.clip, { backgroundColor: color }]} />
    </View>
  );
}

const CLIPBOARD_SIZE = 20;

const clipboardStyles = StyleSheet.create({
  container: {
    width: CLIPBOARD_SIZE,
    height: CLIPBOARD_SIZE,
    alignItems: 'center',
  },
  board: {
    position: 'absolute',
    top: 3,
    width: CLIPBOARD_SIZE - 4,
    height: CLIPBOARD_SIZE - 3,
    borderWidth: 2,
    borderRadius: 3,
  },
  clip: {
    position: 'absolute',
    top: 0,
    width: 8,
    height: 5,
    borderRadius: 2,
  },
});

export interface KaraokeTextProps {
  paragraphs: readonly string[];
  onContentLayout: (height: number) => void;
  onParagraphLayout: (index: number, y: number, height: number) => void;
}

export const KaraokeText = React.memo(function KaraokeText({
  paragraphs,
  onContentLayout,
  onParagraphLayout,
}: KaraokeTextProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View
      testID="speaking-text-block"
      onLayout={event => onContentLayout(event.nativeEvent.layout.height)}>
      {Array.from({ length: LEAD_IN_BLANK_LINES }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blank lead-in lines are positional
        <Text key={`lead-in-${index}`} style={styles.paragraph}>
          {' '}
        </Text>
      ))}
      {paragraphs.map((paragraph, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs map to layout offsets by position
          key={index}
          selectable
          style={styles.paragraph}
          onLayout={event => {
            const { y, height } = event.nativeEvent.layout;
            onParagraphLayout(index, y, height);
          }}>
          {paragraph}
        </Text>
      ))}
    </View>
  );
});

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    paragraph: {
      fontSize: 22,
      lineHeight: 32,
      color: c.textPrimary,
      textAlign: 'center',
      marginVertical: 10,
    },
  });
}
