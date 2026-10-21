/**
 * Navigation transition regression test.
 *
 * Native stack transitions are handled by the platform, but leaving the
 * animation implicit means Android can pick a different motion depending on
 * the OS version/theme. Both application stacks share this explicit config.
 * `ios_from_right` keeps the outgoing screen rendered during pop and uses
 * the shorter Android animation duration.
 *
 * Settings is the one route with a per-entry override: opening it from the
 * Chat header (`slideFromTop`) swaps the native push for the custom top-drop
 * transition, while every other entry keeps the shared push.
 */
import {
  settingsScreenOptions,
  stackScreenOptions,
} from '../src/navigation/stackScreenOptions';
import type {MainStackParamList} from '../src/navigation/types';
import type {RouteProp} from '@react-navigation/native';

function settingsRoute(
  params?: MainStackParamList['Settings'],
): RouteProp<MainStackParamList, 'Settings'> {
  return {key: 'settings-test', name: 'Settings', params};
}

describe('navigation transitions', () => {
  it('uses the shared native-stack parallax transition', () => {
    expect(stackScreenOptions).toMatchObject({
      headerShown: false,
      animation: 'ios_from_right',
      gestureEnabled: true,
    });
  });

  it('presents Settings as a non-animated transparent modal when opened from Chat', () => {
    expect(
      settingsScreenOptions({route: settingsRoute({slideFromTop: true})}),
    ).toEqual({
      animation: 'none',
      presentation: 'transparentModal',
      gestureEnabled: false,
    });
  });

  it('keeps the shared push animation for every other Settings entry', () => {
    expect(settingsScreenOptions({route: settingsRoute()})).toEqual({});
    expect(
      settingsScreenOptions({route: settingsRoute({configSaved: true})}),
    ).toEqual({});
  });
});
