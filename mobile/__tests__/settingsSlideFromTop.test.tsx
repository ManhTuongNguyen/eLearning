/**
 * Top-drop transition for Settings opened from Chat.
 *
 * react-native-screens has no `slide_from_top` stack animation, so the
 * Settings screen animates itself: it slides down on mount and intercepts
 * every removal to retract upwards before the navigation action is
 * dispatched. These tests pin both halves of that contract.
 */
import { act, renderHook } from '@testing-library/react-native';
import { Animated, Dimensions } from 'react-native';

import { useSlideFromTop } from '../src/hooks/useSlideFromTop';

interface BeforeRemoveEvent {
  preventDefault: () => void;
  data: { action: { type: string } };
}

interface PendingAnimation {
  toValue: number;
  finish?: (result: { finished: boolean }) => void;
}

const WINDOW_HEIGHT = Dimensions.get('window').height;

/** Captures Animated.timing configs without running the native animation. */
function captureTimings(completeEntrances: boolean) {
  const animations: PendingAnimation[] = [];
  const timing = jest.spyOn(Animated, 'timing').mockImplementation((_value, config) => {
    const animation: PendingAnimation = {
      toValue: (config as { toValue: number }).toValue,
    };
    animations.push(animation);
    return {
      start: (callback?: (result: { finished: boolean }) => void) => {
        animation.finish = callback;
        // Entrances finish immediately; exits stay pending so the test can
        // assert that removal waits for the retract animation.
        if (completeEntrances && animation.toValue === 0) {
          callback?.({ finished: true });
        }
      },
      stop: jest.fn(),
      reset: jest.fn(),
    } as never;
  });
  return { timing, animations };
}

function makeNavigation() {
  let beforeRemove: ((event: BeforeRemoveEvent) => void) | undefined;
  const unsubscribe = jest.fn();
  const navigation = {
    addListener: jest.fn((event: string, callback: (event: BeforeRemoveEvent) => void) => {
      if (event === 'beforeRemove') {
        beforeRemove = callback;
      }
      return unsubscribe;
    }),
    dispatch: jest.fn(),
  };
  return {
    navigation,
    unsubscribe,
    removeListener: () => beforeRemove,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useSlideFromTop', () => {
  it('starts above the viewport and slides down when enabled', async () => {
    const { timing, animations } = captureTimings(true);
    const { navigation } = makeNavigation();

    const { result } = await renderHook(() => useSlideFromTop(true, navigation as never));

    expect(timing).toHaveBeenCalledTimes(1);
    expect(animations[0].toValue).toBe(0);
    expect((result.current as unknown as { __getValue: () => number }).__getValue()).toBe(
      -WINDOW_HEIGHT,
    );
    expect(navigation.addListener).toHaveBeenCalledWith('beforeRemove', expect.any(Function));
  });

  it('stays put and does not intercept removal when disabled', async () => {
    const { timing } = captureTimings(true);
    const { navigation } = makeNavigation();

    await renderHook(() => useSlideFromTop(false, navigation as never));

    expect(timing).not.toHaveBeenCalled();
    expect(navigation.addListener).not.toHaveBeenCalled();
  });

  it('retracts upwards before dispatching the removal action', async () => {
    const { animations } = captureTimings(true);
    const { navigation, removeListener } = makeNavigation();
    await renderHook(() => useSlideFromTop(true, navigation as never));

    const preventDefault = jest.fn();
    const action = { type: 'GO_BACK' };

    await act(async () => {
      removeListener()?.({ preventDefault, data: { action } });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(animations[1].toValue).toBe(-WINDOW_HEIGHT);
    expect(navigation.dispatch).not.toHaveBeenCalled();

    // A second back press while retracting must not pop the screen early.
    await act(async () => {
      removeListener()?.({ preventDefault, data: { action } });
    });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(animations).toHaveLength(2);
    expect(navigation.dispatch).not.toHaveBeenCalled();

    await act(async () => {
      animations[1].finish?.({ finished: true });
    });

    expect(navigation.dispatch).toHaveBeenCalledWith(action);

    // The re-dispatched action is allowed through without another animation.
    const allowedPreventDefault = jest.fn();
    await act(async () => {
      removeListener()?.({ preventDefault: allowedPreventDefault, data: { action } });
    });
    expect(allowedPreventDefault).not.toHaveBeenCalled();
    expect(animations).toHaveLength(2);
  });
});
