/**
 * The app's single nav-bar: back on the left, the title dead-center, and
 * optional right-side actions. One component serves every pushed screen so
 * position, title size (18pt — the listening-practice reference) and spacing
 * cannot drift between screens again.
 *
 * The title is absolutely centered over the bar and ignores touches, so it
 * never blocks the back button or the right actions.
 */
import { type ReactNode, useMemo } from 'react';
import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { ScreenBackButton } from './ScreenBackButton';
import { ScreenHeader } from './ScreenLayout';

export interface ScreenTitleBarProps {
  /** Centered bar title. */
  title: string;
  /** Present the back button; every pushed screen does. */
  onBack?: () => void;
  /** The screen's existing back testID, kept unchanged. */
  backTestID?: string;
  /** Optional right-aligned actions (menu trigger, buttons, links). */
  right?: ReactNode;
  /** The screen's existing title testID, kept unchanged. */
  titleTestID?: string;
  /** Optional content stacked under the bar (e.g. a topic description box). */
  below?: ReactNode;
  /**
   * Set when the screen's container already applies the horizontal gutter, so
   * the bar does not inset a second time (16px + 16px pushed the back button
   * off the other screens' alignment).
   */
  gutterInset?: boolean;
  /** Extra style for the header row (e.g. a bottom border). */
  style?: StyleProp<ViewStyle>;
}

export function ScreenTitleBar({
  title,
  onBack,
  backTestID,
  right,
  titleTestID,
  below,
  gutterInset = true,
  style,
}: ScreenTitleBarProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <ScreenHeader style={[styles.header, !gutterInset && styles.noGutter, style]}>
      <View style={styles.bar}>
        {onBack ? <ScreenBackButton onPress={onBack} testID={backTestID} /> : null}
        <View pointerEvents="none" style={styles.titleWrap}>
          <Text numberOfLines={1} style={styles.title} testID={titleTestID}>
            {title}
          </Text>
        </View>
        {right !== undefined ? (
          <View style={styles.rightWrap} pointerEvents="box-none">
            {right}
          </View>
        ) : null}
      </View>
      {below}
    </ScreenHeader>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    header: {
      // The shared header gutter applies; nothing else needed here.
    },
    noGutter: {
      // The screen container already insets the content horizontally.
      paddingHorizontal: 0,
    },
    bar: {
      position: 'relative',
      // Everything shares ONE line: back left, actions right, and the title
      // absolutely centered over the bar regardless of how many items exist.
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 44,
    },
    titleWrap: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
      marginHorizontal: 48,
    },
    rightWrap: {
      // Pushed to the row's far right; the back button keeps the left edge.
      marginLeft: 'auto',
      justifyContent: 'center',
    },
  });
}
