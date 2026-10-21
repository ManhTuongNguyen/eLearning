/**
 * Global screen-layout regression tests.
 *
 * Android draws the scroll indicator on the scrollable's own frame, so the
 * screen gutter must never sit on the container: it belongs on headers and
 * scroll content containers. These tests pin the shared primitives that every
 * scrolling screen builds on.
 */

import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  SCREEN_GUTTER,
  Screen,
  ScreenContent,
  ScreenHeader,
  ScreenList,
  ScreenScrollView,
  screenLayoutStyles,
} from '../src/components/ScreenLayout';
import { ThemeProvider } from '../src/theme/ThemeContext';

function flattenStyle(style: unknown): Record<string, unknown> {
  const entries = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...entries.filter(Boolean).map(s => (typeof s === 'object' ? s : {})));
}

async function renderLayout() {
  return render(
    <ThemeProvider>
      <Screen testID="layout-screen">
        <ScreenHeader testID="layout-header" />
        <ScreenContent testID="layout-content" />
        <ScreenScrollView testID="layout-scroll">
          <Text>content</Text>
        </ScreenScrollView>
        <ScreenList data={[]} renderItem={() => null} testID="layout-list" />
      </Screen>
    </ThemeProvider>,
  );
}

describe('shared screen layout', () => {
  it('keeps the screen container full-bleed', async () => {
    await renderLayout();

    const style = flattenStyle(screen.getByTestId('layout-screen').props.style);
    expect(style.paddingHorizontal).toBeUndefined();
    expect(style.paddingLeft).toBeUndefined();
    expect(style.paddingRight).toBeUndefined();
  });

  it('applies the shared gutter to headers and non-scrolling content', () => {
    expect(flattenStyle(screenLayoutStyles.header).paddingHorizontal).toBe(SCREEN_GUTTER);
    expect(flattenStyle(screenLayoutStyles.content).paddingHorizontal).toBe(SCREEN_GUTTER);
  });

  it('applies the gutter to scroll content, never to the scroll frame', async () => {
    await renderLayout();

    const scroll = screen.getByTestId('layout-scroll');
    expect(flattenStyle(scroll.props.style).paddingHorizontal).toBeUndefined();
    expect(flattenStyle(scroll.props.contentContainerStyle).paddingHorizontal).toBe(SCREEN_GUTTER);

    const list = screen.getByTestId('layout-list');
    expect(flattenStyle(list.props.contentContainerStyle).paddingHorizontal).toBe(SCREEN_GUTTER);
  });
});
