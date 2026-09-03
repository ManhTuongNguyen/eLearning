import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {render, screen, waitFor} from '@testing-library/react-native';

import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {setRuntimeApplicationMode} from '../src/mode/runtime';
import {DEFAULT_APPLICATION_MODE} from '../src/mode/types';
import type {AIProviderSettingsScreenProps} from '../src/navigation/types';
import {AIProviderSettingsScreen} from '../src/screens/AIProviderSettingsScreen';
import * as modelCatalog from '../src/serverless/modelCatalog';
import * as serverlessSettings from '../src/serverless/settings';
import {createStyles} from '../src/screens/AIProviderSettingsScreen';
import {lightColors} from '../src/theme/colors';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/db/database');
jest.mock('../src/serverless/settings');
jest.mock('../src/serverless/modelCatalog');
jest.mock('../src/serverless/openrouterClient');

const mockedLoadProvider = jest.mocked(serverlessSettings.loadServerlessProvider);
const mockedLoadProviderState = jest.mocked(serverlessSettings.loadServerlessProviderState);
const mockedGetCached = jest.mocked(modelCatalog.getCachedModelCatalog);
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

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
    route: {key: 'ai-provider-settings-test', name: 'AIProviderSettings', params: undefined},
  } as unknown as AIProviderSettingsScreenProps;

  // The layout test targets the editor body, which only exists in
  // serverless mode (TASK-AUDIT-016), so mount under the real providers.
  await render(
    <ModeProvider>
      <ThemeProvider>
        <AIProviderSettingsScreen {...props} />
      </ThemeProvider>
    </ModeProvider>,
  );
}

beforeEach(async () => {
  asyncStorage.__resetAsyncStorageStore();
  jest.clearAllMocks();
  await saveApplicationMode('serverless');
  setRuntimeApplicationMode('serverless');
  mockedLoadProvider.mockResolvedValue('openrouter');
  mockedLoadProviderState.mockResolvedValue({
    apiKey: null,
    primaryModel: null,
    fallbackModels: [],
  });
  mockedGetCached.mockResolvedValue(null);
});

afterEach(() => {
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

describe('AIProviderSettingsScreen layout (TASK-AUDIT-012)', () => {
  it('uses the shared pushed-screen header spacing on top of the app-shell inset padding', () => {
    const styles = createStyles(lightColors);

    expect(styles.container.paddingTop).toBe(16);
    expect(flattenStyle(styles.container).marginTop).toBeUndefined();
  });

  it('never applies negative margins to the container', () => {
    const flat = flattenStyle(createStyles(lightColors).container);
    for (const [key, value] of Object.entries(flat)) {
      if (key.startsWith('margin')) {
        expect(value).not.toBeLessThan(0);
      }
    }
  });

  it('renders with the fixed header spacing; the app shell adds the device inset', async () => {
    // Edge-to-edge devices draw under the system status bar, and the shell
    // in App.tsx pads the whole tree by the safe-area inset; the screen
    // itself always renders its own fixed spacing.
    await renderScreen();

    const container = screen.getByTestId('ai-provider-settings-screen');
    expect(flattenStyle(container.props.style).paddingTop).toBe(16);
    await waitFor(() =>
      expect(screen.getByTestId('ai-provider-save')).toBeOnTheScreen(),
    );
  });
});

describe('AIProviderSettingsScreen scrollbar anchoring (TASK-IMPROVEMENT-001)', () => {
  // On Android the scroll indicator draws at the ScrollView's own frame
  // edge (ReactScrollView uses SCROLLBARS_OUTSIDE_OVERLAY), so any
  // horizontal padding on the ScrollView's parent would pull the
  // indicator inward. The gutter must live on the header and the scroll
  // content container instead.
  it('keeps horizontal padding off the container wrapping the ScrollView', () => {
    const flat = flattenStyle(createStyles(lightColors).container);

    expect(flat.paddingHorizontal).toBeUndefined();
    expect(flat.paddingLeft).toBeUndefined();
    expect(flat.paddingRight).toBeUndefined();
  });

  it('applies the screen gutter to the header and scroll content container', () => {
    const styles = createStyles(lightColors);

    expect(styles.header.paddingHorizontal).toBe(24);
    expect(styles.scroll.paddingHorizontal).toBe(24);
  });
});
