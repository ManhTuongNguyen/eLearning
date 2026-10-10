/**
 * Keep-screen-awake seam for long speech playback (karaoke listen mode).
 *
 * Delegates to the native Speech module's setKeepScreenOn(), which toggles
 * FLAG_KEEP_SCREEN_ON on the activity window so the display does not sleep
 * while the engine is reading a whole practice text aloud. Environments
 * without the native module (Jest, previews, iOS stub) silently no-op —
 * the screen may sleep there, but playback never breaks.
 *
 * The hold is reference-free and idempotent: callers turn it on when
 * playback starts and off whenever playback stops (pause, end, unmount),
 * and the last call wins.
 */
import {NativeModules} from 'react-native';

/** Shape of the keep-awake method on the native Speech module. */
interface NativeKeepAwake {
  setKeepScreenOn(enabled: boolean): void;
}

/** True when the native module exposes the keep-screen-on control. */
export function isKeepScreenOnAvailable(): boolean {
  const candidate = NativeModules.Speech as NativeKeepAwake | null | undefined;
  return (
    !!candidate && typeof candidate.setKeepScreenOn === 'function'
  );
}

/**
 * Hold (or release) the screen-awake flag. Never throws; a missing native
 * module makes this a no-op.
 */
export function setKeepScreenAwake(enabled: boolean): void {
  if (!isKeepScreenOnAvailable()) {
    return;
  }
  try {
    (NativeModules.Speech as NativeKeepAwake).setKeepScreenOn(enabled);
  } catch {
    // Keep-awake is an enhancement; failures must never break playback.
  }
}
