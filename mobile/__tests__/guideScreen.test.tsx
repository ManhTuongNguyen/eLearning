/**
 * Guide hub screen (in-app guide): lists every guide entry grouped like the
 * Home hub, badges mode-specific entries instead of hiding them, and pushes
 * GuideDetail with the tapped entry's id.
 */

import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { guideEntries, guideSections } from '../src/guide/guideContent';
import type { MainStackParamList } from '../src/navigation/types';
import { GuideDetailScreen } from '../src/screens/GuideDetailScreen';
import { GuideScreen } from '../src/screens/GuideScreen';
import { ThemeProvider } from '../src/theme/ThemeContext';

async function renderGuide() {
  const ref = createNavigationContainerRef<MainStackParamList>();
  const Stack = createNativeStackNavigator<MainStackParamList>();

  await render(
    <ThemeProvider>
      <NavigationContainer
        ref={ref}
        initialState={{
          index: 1,
          routes: [{ name: 'Home' }, { name: 'Guide' }],
        }}>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Home">{() => null}</Stack.Screen>
          <Stack.Screen name="Guide" component={GuideScreen} />
          <Stack.Screen name="GuideDetail" component={GuideDetailScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </ThemeProvider>,
  );

  return { ref };
}

describe('Guide hub', () => {
  it('lists one row per guide entry, grouped in sections', async () => {
    await renderGuide();

    for (const section of guideSections) {
      expect(screen.getByText(section.title)).toBeTruthy();
      for (const id of section.ids) {
        expect(screen.getByTestId(`guide-open-${id}`)).toBeTruthy();
        expect(screen.getByText(guideEntries[id].title)).toBeTruthy();
      }
    }
  });

  it('badges mode-specific entries instead of hiding them', async () => {
    await renderGuide();

    const serverlessEntries = Object.values(guideEntries).filter(
      entry => entry.mode === 'serverless',
    );
    expect(screen.getAllByText('Serverless only')).toHaveLength(serverlessEntries.length);
    expect(screen.getByText('Server only')).toBeTruthy();
  });

  it('pushes GuideDetail with the tapped entry id', async () => {
    const { ref } = await renderGuide();

    fireEvent.press(screen.getByTestId('guide-open-wordBank'));

    const route = ref.current?.getCurrentRoute();
    expect(route?.name).toBe('GuideDetail');
    expect(route?.params).toEqual({ guideId: 'wordBank' });
  });
});
