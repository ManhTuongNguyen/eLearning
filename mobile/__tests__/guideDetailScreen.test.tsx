/**
 * Guide detail screen (in-app guide): renders one entry's full page — intro,
 * numbered steps, AI request card, prompt notes, tips and the mode notice —
 * and proves every Try it deep link actually navigates to its target screen.
 */

import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { guideEntries } from '../src/guide/guideContent';
import type { GuideEntry, GuideId, GuideTryIt } from '../src/guide/types';
import type { MainStackParamList } from '../src/navigation/types';
import { GuideDetailScreen } from '../src/screens/GuideDetailScreen';
import { ThemeProvider } from '../src/theme/ThemeContext';

/** Entries with a deep link, narrowed so the it.each rows need no assertion. */
const LINKED_ENTRIES = Object.values(guideEntries).filter(
  (entry): entry is GuideEntry & { tryIt: GuideTryIt } => entry.tryIt !== undefined,
);

/** Every stack route, so deep links always have a real destination. */
const ALL_ROUTES: (keyof MainStackParamList)[] = [
  'Home',
  'Chat',
  'NewConversation',
  'History',
  'Settings',
  'Level',
  'Vocabulary',
  'AIProviderSettings',
  'TTSSettings',
  'VoiceManager',
  'Practice',
  'SpeakingPractice',
  'SpeakingHistory',
  'SentenceTopics',
  'SentenceTopicNew',
  'SentenceTopic',
  'SentencePractice',
  'WordTopics',
  'WordTopic',
  'WordDetail',
  'WordPractice',
  'Guide',
  'GuideDetail',
];

async function renderDetail(guideId: GuideId | string) {
  const ref = createNavigationContainerRef<MainStackParamList>();
  const Stack = createNativeStackNavigator<MainStackParamList>();

  const view = await render(
    <ThemeProvider>
      <NavigationContainer
        ref={ref}
        initialState={{
          index: 1,
          routes: [{ name: 'Guide' }, { name: 'GuideDetail', params: { guideId } as never }],
        }}>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          {ALL_ROUTES.filter(name => name !== 'GuideDetail').map(name => (
            <Stack.Screen key={name} name={name}>
              {() => null}
            </Stack.Screen>
          ))}
          <Stack.Screen name="GuideDetail" component={GuideDetailScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </ThemeProvider>,
  );

  return { ref, unmount: () => view.unmount() };
}

describe('Guide detail', () => {
  it('renders the full page for an entry', async () => {
    await renderDetail('conversations');
    const entry = guideEntries.conversations;

    expect(screen.getByTestId('guide-detail-screen')).toBeTruthy();
    expect(screen.getByText(entry.title)).toBeTruthy();
    // The intro opens with a stable phrase and the AI card is present.
    expect(screen.getByText(/Conversations are the heart of the app/)).toBeTruthy();
    expect(screen.getByTestId('guide-ai-card')).toBeTruthy();
    expect(screen.getByText('How to use it')).toBeTruthy();
    expect(screen.getByText('AI requests')).toBeTruthy();
    expect(screen.getByText('Getting better results')).toBeTruthy();
    expect(screen.getByText('Tips')).toBeTruthy();
    expect(screen.getByTestId('guide-tryit-conversations')).toBeTruthy();
  });

  it('numbers the usage steps in order', async () => {
    await renderDetail('conversations');

    const steps = guideEntries.conversations.steps;
    steps.forEach((step, index) => {
      expect(screen.getByText(step)).toBeTruthy();
      expect(screen.getByText(String(index + 1))).toBeTruthy();
    });
  });

  it('shows the mode notice only for mode-specific entries', async () => {
    const { unmount } = await renderDetail('wordBank');
    expect(screen.getByTestId('guide-mode-notice-wordBank')).toBeTruthy();
    expect(screen.getByText('Serverless only')).toBeTruthy();
    await unmount();

    await renderDetail('conversations');
    expect(screen.queryByTestId('guide-mode-notice-conversations')).toBeNull();
  });

  it.each(LINKED_ENTRIES.map(entry => [entry.id, entry.tryIt.route] as const))(
    'deep links %s to its target screen',
    async (id, route) => {
      const { ref } = await renderDetail(id);

      fireEvent.press(screen.getByTestId(`guide-tryit-${id}`));
      expect(ref.current?.getCurrentRoute()?.name).toBe(route);
    },
  );

  it('renders an explicit missing-entry state for an unknown id', async () => {
    await renderDetail('doesNotExist');

    expect(screen.getByText('This guide entry does not exist.')).toBeTruthy();
    expect(screen.queryByTestId('guide-tryit-conversations')).toBeNull();
  });
});
