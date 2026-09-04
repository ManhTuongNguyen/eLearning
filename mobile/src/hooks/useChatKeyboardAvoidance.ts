/**
 * Keyboard avoidance for the chat shell (TASK-IMPROVEMENT-002).
 *
 * The shell must lift the composer above the reported keyboard frame — no
 * hard-coded keyboard height — and anchor it back to the shell bottom on
 * dismissal. This hook replaces the padding-behavior `KeyboardAvoidingView`
 * the screen used before, because its Android dismissal path is unreliable:
 * `keyboardDidHide` reports `endCoordinates.screenY` as the visible
 * display-frame height (ReactRootView.checkForKeyboardEvents), a window
 * metric that excludes the status bar, so re-deriving the overlap from it
 * left a status-bar-height residue above the composer instead of restoring
 * the plain layout (observed on Android 16 + Gboard with edge-to-edge
 * enforcement).
 *
 * Show events keep the KeyboardAvoidingView math: padding = shell-bottom
 * overlap with the keyboard top, offset by the status-bar inset the app
 * applies above the screen (edge-to-edge). Hide events ignore the reported
 * geometry entirely — the keyboard is gone, so the padding is exactly 0.
 * On devices where the system already shrinks the window under the keyboard
 * (non-edge-to-edge `adjustResize`), the measured overlap is zero and the
 * shell stays put, as before.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, Keyboard, LayoutAnimation, Platform} from 'react-native';
import type {KeyboardEvent, LayoutChangeEvent} from 'react-native';

export function useChatKeyboardAvoidance(keyboardVerticalOffset: number) {
  const [paddingBottom, setPaddingBottom] = useState(0);
  const bottomRef = useRef(0);
  const frameRef = useRef<{y: number; height: number} | null>(null);
  const keyboardFrameRef = useRef<KeyboardEvent['endCoordinates'] | null>(null);
  const offsetRef = useRef(keyboardVerticalOffset);
  offsetRef.current = keyboardVerticalOffset;

  const recompute = useCallback(async () => {
    const keyboard = keyboardFrameRef.current;
    const frame = frameRef.current;
    let next = 0;
    if (keyboard !== null && frame !== null) {
      // On iOS with "Prefer Cross-Fade Transitions" enabled, the keyboard
      // position is reported as 0 instead of a screenY matching the keyboard
      // height — verify before trusting the overlap math (as KAV does).
      const crossFadeQuirk =
        Platform.OS === 'ios' &&
        keyboard.screenY === 0 &&
        (await AccessibilityInfo.prefersCrossFadeTransitions());
      next = crossFadeQuirk
        ? 0
        : Math.max(
            frame.y + frame.height - (keyboard.screenY - offsetRef.current),
            0,
          );
    }
    if (bottomRef.current === next) {
      return;
    }
    bottomRef.current = next;
    setPaddingBottom(next);
  }, []);

  const handleKeyboardShow = useCallback(
    (event: KeyboardEvent) => {
      const {duration, easing} = event;
      if (duration && easing) {
        LayoutAnimation.configureNext({
          // Minimal accepted duration (RCTLayoutAnimation.m), as KAV does.
          duration: duration > 10 ? duration : 10,
          update: {
            duration: duration > 10 ? duration : 10,
            type: LayoutAnimation.Types[easing] || 'keyboard',
          },
        });
      }
      keyboardFrameRef.current = event.endCoordinates;
      recompute();
    },
    [recompute],
  );

  const handleKeyboardHide = useCallback(() => {
    keyboardFrameRef.current = null;
    recompute();
  }, [recompute]);

  const handleShellLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const {y, height} = event.nativeEvent.layout;
      const previous = frameRef.current;
      frameRef.current = {y, height};
      // Re-measure when the shell geometry changes (rotation, foldables,
      // multi-window) while the last reported keyboard frame still applies.
      if (previous === null || previous.y !== y || previous.height !== height) {
        recompute();
      }
    },
    [recompute],
  );

  useEffect(() => {
    // A screen remounted while the keyboard is already open receives no new
    // show event; seed the last known metrics so the first layout pass can
    // lift the composer immediately.
    const metrics = Keyboard.metrics();
    if (metrics) {
      keyboardFrameRef.current = metrics;
    }
    const subscriptions = [
      Keyboard.addListener('keyboardWillShow', handleKeyboardShow),
      Keyboard.addListener('keyboardDidShow', handleKeyboardShow),
      Keyboard.addListener('keyboardWillHide', handleKeyboardHide),
      Keyboard.addListener('keyboardDidHide', handleKeyboardHide),
    ];
    return () => {
      subscriptions.forEach(subscription => {
        subscription.remove();
      });
    };
  }, [handleKeyboardShow, handleKeyboardHide]);

  return {paddingBottom, handleShellLayout};
}
