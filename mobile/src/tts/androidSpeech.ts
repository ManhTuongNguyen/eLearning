/**
 * Android-native speech engine (SPEC TASK-077). Adapts the native `Speech`
 * module to the TextToSpeechEngine contract from TASK-076: speak() settles
 * when playback finishes or is interrupted, stop() is always safe. The
 * native module is resolved lazily on every call, so the adapter stays
 * importable in plain Node/Jest environments (where NativeModules.Speech is
 * absent) and installAndroidSpeechEngine() simply keeps the stub in place.
 * Native rejections arrive with normalized codes — notably
 * E_TTS_LANGUAGE_UNAVAILABLE when no English voice data exists — and surface
 * as ordinary promise rejections instead of crashes.
 */
import {NativeModules} from 'react-native';

import {setSpeechEngine} from './textToSpeech';
import type {TextToSpeechEngine} from './textToSpeech';

/** Shape of the Kotlin module registered by SpeechPackage. */
interface NativeSpeechModule {
  /** Speaks English text; resolves when playback ends, rejects on failure. */
  speak(text: string): Promise<void>;
  /** Halts playback immediately; safe when nothing is playing. */
  stop(): void;
}

function resolveNativeSpeech(): NativeSpeechModule | null {
  const candidate = NativeModules.Speech as NativeSpeechModule | null | undefined;
  if (
    candidate &&
    typeof candidate.speak === 'function' &&
    typeof candidate.stop === 'function'
  ) {
    return candidate;
  }
  return null;
}

/** True when the Android TTS module is present and usable. */
export function isAndroidSpeechAvailable(): boolean {
  return resolveNativeSpeech() !== null;
}

/** Builds the engine around the live native module; throws if unavailable. */
export function androidSpeechEngine(): TextToSpeechEngine {
  const native = resolveNativeSpeech();
  if (!native) {
    throw new Error('Android speech module is not available');
  }
  return {
    async speak(text: string) {
      await native.speak(text);
    },
    stop() {
      native.stop();
    },
  };
}

/**
 * Installs the Android engine into the registry at startup. Returns whether
 * an engine was installed; callers can stay silent when it was not.
 */
export function installAndroidSpeechEngine(): boolean {
  if (!isAndroidSpeechAvailable()) {
    return false;
  }
  setSpeechEngine(androidSpeechEngine());
  return true;
}
