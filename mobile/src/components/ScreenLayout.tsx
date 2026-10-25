/**
 * The application's single screen-layout seam.
 *
 * Android draws a ScrollView/FlatList scroll indicator at the scrollable's
 * own frame edge (ReactScrollView uses SCROLLBARS_OUTSIDE_OVERLAY), so any
 * horizontal padding on an ancestor pulls the indicator away from the
 * screen edge. The screen gutter therefore never belongs on the container:
 *
 *   - the container (`Screen`) stretches edge to edge;
 *   - headers (`ScreenHeader`) and non-scrolling body rows (`ScreenContent`)
 *     carry the gutter themselves;
 *   - scrollable content (`ScreenScrollView` / `ScreenList`) applies the
 *     gutter to its content container, which keeps the indicator anchored
 *     to the right screen edge.
 *
 * Every screen uses the same tokens, so margins line up across the app
 * instead of drifting between 16/20/24px per screen.
 */
import type React from 'react';
import { useMemo } from 'react';
import type { FlatListProps, ScrollViewProps, StyleProp, ViewProps, ViewStyle } from 'react-native';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext';

/** Shared horizontal screen gutter (px). */
export const SCREEN_GUTTER = 16;
/**
 * Fixed spacing between the app-shell inset and a pushed screen header (px).
 *
 * The shell (App.tsx `InsetShell`) already clears the system status bar with
 * the safe-area inset, so this is the whole deliberate gap on top of it —
 * kept at 0 so a pushed screen starts flush under the status bar like a
 * native nav bar, with the header row's own padding providing the touch
 * breathing room.
 */
export const SCREEN_TOP_SPACING = 0;
/** Breathing room below scrollable content (px). */
export const SCREEN_BOTTOM_SPACING = 32;

/**
 * Static layout tokens. Kept as plain styles (not theme-derived) so screens
 * and tests can reference the exact same numbers.
 */
export const screenLayoutStyles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    paddingHorizontal: SCREEN_GUTTER,
  },
  content: {
    paddingHorizontal: SCREEN_GUTTER,
  },
  scrollContent: {
    paddingHorizontal: SCREEN_GUTTER,
    paddingBottom: SCREEN_BOTTOM_SPACING,
  },
});

interface ScreenProps extends ViewProps {
  children: React.ReactNode;
}

/**
 * Full-bleed screen container. Never applies horizontal padding: the
 * scrollable inside must reach the right screen edge.
 */
export function Screen({ children, style, ...rest }: ScreenProps) {
  const { colors } = useTheme();
  const themeStyle = useMemo(() => ({ backgroundColor: colors.background }), [colors]);

  return (
    <View {...rest} style={StyleSheet.flatten([screenLayoutStyles.screen, themeStyle, style])}>
      {children}
    </View>
  );
}

interface ScreenSectionProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Header row outside the scrollable, aligned to the shared gutter. */
export function ScreenHeader({ children, style, testID }: ScreenSectionProps) {
  return (
    <View style={[screenLayoutStyles.header, style]} testID={testID}>
      {children}
    </View>
  );
}

/**
 * Non-scrolling body content (status rows, notices, toolbars) aligned to the
 * shared gutter. Use this instead of padding the screen container.
 */
export function ScreenContent({ children, style, testID }: ScreenSectionProps) {
  return (
    <View style={[screenLayoutStyles.content, style]} testID={testID}>
      {children}
    </View>
  );
}

interface ScreenScrollViewProps extends ScrollViewProps {
  children: React.ReactNode;
}

/**
 * ScrollView whose content carries the screen gutter. The scrollable itself
 * stays full-bleed so the indicator binds to the right edge.
 */
export function ScreenScrollView({
  children,
  contentContainerStyle,
  ...rest
}: ScreenScrollViewProps) {
  return (
    <ScrollView
      {...rest}
      contentContainerStyle={[screenLayoutStyles.scrollContent, contentContainerStyle]}>
      {children}
    </ScrollView>
  );
}

type ScreenListProps<ItemT> = FlatListProps<ItemT> & {
  ref?: React.Ref<FlatList<ItemT>>;
};

/** FlatList counterpart of {@link ScreenScrollView}. */
export function ScreenList<ItemT>({ contentContainerStyle, ref, ...rest }: ScreenListProps<ItemT>) {
  return (
    <FlatList
      {...rest}
      ref={ref}
      contentContainerStyle={[screenLayoutStyles.scrollContent, contentContainerStyle]}
    />
  );
}
