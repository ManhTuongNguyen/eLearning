/**
 * Home hub icons (TASK-SENT-002).
 *
 * Every Home row must carry a leading icon without changing what the row does:
 * the same route is pushed, the title and description still render, and the
 * row keeps a two-column layout (fixed-width icon, flexible text) so long
 * descriptions wrap instead of being squeezed.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { HomeScreenProps } from '../src/navigation/types';
import { saveThemeMode } from '../src/preferences/theme';
import { HomeScreen } from '../src/screens/HomeScreen';
import { darkColors, lightColors } from '../src/theme/colors';
import { ThemeProvider } from '../src/theme/ThemeContext';

const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

interface JsonNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: (JsonNode | string)[] | null;
}

/** Rows under test: icon name, row testID, expected navigation target. */
const ROWS = [
  { icon: 'chat', testID: 'home-open-chat', route: 'Chat', title: 'Conversations' },
  { icon: 'history', testID: 'home-open-history', route: 'History', title: 'History' },
  {
    icon: 'listening',
    testID: 'home-open-listening',
    route: 'Practice',
    title: 'Listening practice',
  },
  {
    icon: 'speaking',
    testID: 'home-open-speaking',
    route: 'SpeakingPractice',
    title: 'Speaking practice',
  },
  {
    icon: 'speakingHistory',
    testID: 'home-open-speaking-history',
    route: 'SpeakingHistory',
    title: 'Speaking history',
  },
  {
    icon: 'sentences',
    testID: 'home-open-sentences',
    route: 'SentenceTopics',
    title: 'Real-life sentences',
  },
  { icon: 'settings', testID: 'home-open-settings', route: 'Settings', title: 'Settings' },
] as const;

function homeProps(): HomeScreenProps {
  const navigate = jest.fn();
  return {
    navigation: { navigate },
    route: { key: 'home-test', name: 'Home' },
  } as unknown as HomeScreenProps;
}

/** Depth-first search over the rendered tree for a node matching a predicate. */
function findNode(
  node: JsonNode | string | null,
  predicate: (candidate: JsonNode) => boolean,
): JsonNode | null {
  if (!node || typeof node === 'string') {
    return null;
  }
  if (predicate(node)) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Flatten a React Native style prop (object or array of objects). */
function flattenStyle(style: unknown): Record<string, unknown> {
  const entries = Array.isArray(style) ? style : [style];
  return Object.assign(
    {},
    ...entries.filter(Boolean).map(entry => (typeof entry === 'object' ? entry : {})),
  );
}

async function renderHome(props: HomeScreenProps = homeProps()) {
  await saveApplicationMode('serverless');
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <HomeScreen {...props} />
      </ThemeProvider>
    </ModeProvider>,
  );
  // The serverless-only sentence row appears once ModeProvider has restored
  // the persisted mode (TASK-SENT-014).
  await waitFor(() => {
    expect(view.getByTestId('home-open-sentences')).toBeTruthy();
  });
  return { view, props };
}

beforeEach(() => {
  asyncStorage.__resetAsyncStorageStore();
});

describe('Home hub icons', () => {
  it('renders a leading icon on every row', async () => {
    const { view } = await renderHome();

    for (const row of ROWS) {
      expect(view.getByTestId(`icon-${row.icon}`, { includeHiddenElements: true })).toBeTruthy();
    }
  });

  it('keeps the row title and description next to the icon', async () => {
    const { view } = await renderHome();

    for (const row of ROWS) {
      expect(view.getByText(row.title)).toBeTruthy();
    }
    // The description of the first row is still rendered as its own line.
    expect(view.getByText('Chat with the AI tutor about a topic or your questions.')).toBeTruthy();
  });

  it('still pushes the same route from every row', async () => {
    const { view, props } = await renderHome();
    const navigate = (props.navigation as unknown as { navigate: jest.Mock }).navigate;

    for (const row of ROWS) {
      await fireEvent.press(view.getByTestId(row.testID));
      expect(navigate).toHaveBeenLastCalledWith(row.route);
    }
  });

  it('lays each row out as a fixed icon column beside a flexible text column', async () => {
    const { view } = await renderHome();
    const json = view.toJSON() as unknown as JsonNode;

    const row = findNode(json, node => node.props?.testID === 'home-open-chat');
    expect(row).not.toBeNull();
    const rowStyle = flattenStyle(row?.props?.style);
    expect(rowStyle.flexDirection).toBe('row');
    expect(rowStyle.alignItems).toBe('center');

    // Exactly one fixed-width icon column and one flexible text column.
    const fixedIconColumn = findNode(row, node => {
      const style = flattenStyle(node.props?.style);
      return style.width === 24;
    });
    expect(fixedIconColumn).not.toBeNull();

    const flexibleTextColumn = findNode(row, node => {
      const style = flattenStyle(node.props?.style);
      return style.flex === 1;
    });
    expect(flexibleTextColumn).not.toBeNull();
  });

  it('colors icons from the active theme, including dark mode', async () => {
    const light = await renderHome();
    const lightIcon = light.view.getByTestId('icon-chat', { includeHiddenElements: true });
    expect(lightIcon.props.stroke).toBe(lightColors.accent);
    await light.view.unmount();

    await saveThemeMode('dark');
    const dark = await renderHome();
    await waitFor(() => {
      const darkIcon = dark.view.getByTestId('icon-chat', { includeHiddenElements: true });
      expect(darkIcon.props.stroke).toBe(darkColors.accent);
    });
  });
});
