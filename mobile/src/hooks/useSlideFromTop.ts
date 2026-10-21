/**
 * Top-drop transition for the Settings screen opened from Chat.
 *
 * react-native-screens exposes no `slide_from_top` stack animation, so this
 * hook animates the screen itself:
 *
 *   - on mount, the content slides down from above the viewport
 *     (top to bottom);
 *   - every removal — the header Back affordance, the Android hardware back
 *     button or a programmatic pop — is intercepted, the content retracts
 *     upwards (bottom to top) and only then is the original navigation
 *     action dispatched.
 *
 * The route opts into this by presenting itself as a transparent modal with
 * `animation: 'none'` (see `settingsScreenOptions`), which keeps the Chat
 * screen visible beneath the sliding panel and prevents the native stack
 * from animating at the same time.
 */
import {useEffect, useRef} from 'react';
import {Animated, Easing, useWindowDimensions} from 'react-native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import type {MainStackParamList} from '../navigation/types';

const ENTER_DURATION_MS = 260;
const EXIT_DURATION_MS = 220;

type SettingsNavigation = NativeStackNavigationProp<MainStackParamList, 'Settings'>;

export function useSlideFromTop(
  enabled: boolean,
  navigation: SettingsNavigation,
): Animated.Value {
  const {height: windowHeight} = useWindowDimensions();

  // Start offscreen so the very first frame cannot flash the panel at its
  // resting position before the entrance animation starts.
  const translateYRef = useRef<Animated.Value | null>(null);
  if (translateYRef.current === null) {
    translateYRef.current = new Animated.Value(enabled ? -windowHeight : 0);
  }
  const translateY = translateYRef.current;

  // Guards the recursive dispatch: once the exit animation has finished, the
  // same action is dispatched again and must be allowed through.
  const allowRemoveRef = useRef(false);
  const exitingRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    Animated.timing(translateY, {
      toValue: 0,
      duration: ENTER_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    return () => {
      translateY.stopAnimation();
    };
  }, [enabled, translateY]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const unsubscribe = navigation.addListener?.('beforeRemove', event => {
      if (allowRemoveRef.current) {
        return;
      }
      // Always keep the screen alive while the exit animation runs; a second
      // back press during that window must not pop it instantly.
      event.preventDefault();
      if (exitingRef.current) {
        return;
      }
      exitingRef.current = true;
      Animated.timing(translateY, {
        toValue: -windowHeight,
        duration: EXIT_DURATION_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        allowRemoveRef.current = true;
        navigation.dispatch(event.data.action);
      });
    });
    return unsubscribe;
  }, [enabled, navigation, translateY, windowHeight]);

  return translateY;
}
