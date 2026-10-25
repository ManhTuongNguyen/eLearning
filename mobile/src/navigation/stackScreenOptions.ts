/**
 * Shared native-stack transition options.
 *
 * The project already uses `createNativeStackNavigator`, so transitions run
 * on the platform's UI thread instead of the JS thread. Keeping the animation
 * explicit gives every push/pop the same familiar forward/back motion on
 * Android and iOS, where the platform default can vary by OS version/theme.
 *
 * `ios_from_right` is a parallax push: the incoming screen slides in from the
 * right while the current screen shifts 30% to the left. It also keeps the
 * outgoing screen's content during the pop animation — `slide_from_right`'s
 * full-screen translate leaves only the screen background visible on the
 * current native-stack/Fabric setup, which reads as a grey flash.
 *
 * On Android the preset uses the platform's short animation time (200ms)
 * instead of the medium time (400ms) used by the full-slide presets. On iOS
 * it resolves to the native default push, preserving the interactive
 * swipe-back gesture.
 */
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

export const stackScreenOptions: NativeStackNavigationOptions = {
  headerShown: false,
  animation: 'ios_from_right',
  gestureEnabled: true,
};
