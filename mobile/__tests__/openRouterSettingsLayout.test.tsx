import React from 'react';
import {render, screen, waitFor} from '@testing-library/react-native';
import {initialWindowMetrics} from 'react-native-safe-area-context';

import type {OpenRouterSettingsScreenProps} from '../src/navigation/types';
import {OpenRouterSettingsScreen} from '../src/screens/OpenRouterSettingsScreen';
import * as modelCatalog from '../src/serverless/modelCatalog';
import * as serverlessSettings from '../src/serverless/settings';
import {createStyles} from '../src/screens/OpenRouterSettingsScreen';
import {lightColors} from '../src/theme/colors';
import {ThemeProvider} from '../src/theme/ThemeContext';

/**
 * The shared jest.setup.js mock returns ONE insets object that both
 * initialWindowMetrics and useSafeAreaInsets reference, so mutating
 * metrics.insets.top drives the hook inside the rendered screen — the way
 * real devices report per-device status-bar insets.
 */
const metrics = initialWindowMetrics as {insets: {top: number}};

jest.mock('../src/db/database');
jest.mock('../src/serverless/settings');
jest.mock('../src/serverless/modelCatalog');
jest.mock('../src/serverless/openrouterClient');

const mockedLoadConfig = jest.mocked(serverlessSettings.loadServerlessOpenRouterConfig);
const mockedGetCached = jest.mocked(modelCatalog.getCachedModelCatalog);

function flattenStyle(style: unknown): Record<string, unknown> {
  const entries = Array.isArray(style) ? style : [style];
  return Object.assign(
    {},
    ...entries.filter(Boolean).map(s => (typeof s === 'object' ? s : {})),
  );
}

async function renderScreen() {
  const props = {
    navigation: {navigate: jest.fn(), goBack: jest.fn()},
    route: {key: 'openrouter-settings-test', name: 'OpenRouterSettings', params: undefined},
  } as unknown as OpenRouterSettingsScreenProps;

  await render(
    <ThemeProvider>
      <OpenRouterSettingsScreen {...props} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedLoadConfig.mockResolvedValue(null);
  mockedGetCached.mockResolvedValue(null);
});

afterEach(() => {
  metrics.insets.top = 0;
});

describe('OpenRouterSettingsScreen layout (TASK-AUDIT-012)', () => {
  it('uses the shared pushed-screen header spacing on standard devices (no safe-area inset)', () => {
    const styles = createStyles(lightColors, 0);

    expect(styles.container.paddingTop).toBe(24);
    expect(flattenStyle(styles.container).marginTop).toBeUndefined();
  });

  it('adds the device top inset so edge-to-edge screens clear the status bar', () => {
    for (const topInset of [24, 42]) {
      const styles = createStyles(lightColors, topInset);
      expect(styles.container.paddingTop).toBe(24 + topInset);
    }
  });

  it('never applies negative margins to the container', () => {
    for (const topInset of [0, 42]) {
      const flat = flattenStyle(createStyles(lightColors, topInset).container);
      for (const [key, value] of Object.entries(flat)) {
        if (key.startsWith('margin')) {
          expect(value).not.toBeLessThan(0);
        }
      }
    }
  });

  it('derives the rendered top padding from the device inset', async () => {
    metrics.insets.top = 42;

    await renderScreen();

    const container = screen.getByTestId('openrouter-settings-screen');
    expect(flattenStyle(container.props.style).paddingTop).toBe(66);
    await waitFor(() =>
      expect(screen.getByTestId('openrouter-save')).toBeOnTheScreen(),
    );
  });
});
