/**
 * Android-native speech engine adapter (SPEC TASK-077, TASK-TTS-001).
 * Adapts the native `Speech` module to the TextToSpeechEngine contract from
 * TASK-076: speak() settles when playback finishes or is interrupted, stop()
 * is always safe. The native module is resolved lazily on every call, so the
 * adapter stays importable in plain Node/Jest environments (where
 * NativeModules.Speech is absent) and installAndroidSpeechEngine() simply
 * keeps the stub in place. Native rejections arrive with normalized codes —
 * notably E_TTS_LANGUAGE_UNAVAILABLE when no English voice data exists and
 * E_TTS_VOICE_UNAVAILABLE when a saved voice has disappeared — and surface
 * as ordinary promise rejections instead of crashes.
 *
 * Every utterance is rendered with the persisted speech preferences (voice,
 * rate, pitch). Preferences are loaded lazily on the first speak and
 * refreshed whenever the settings layer applies a change, so the chat screen
 * needs no awareness of the configuration at all.
 */
import {NativeModules} from 'react-native';

import {loadSpeechPreferences} from './speechSettings';
import type {
  SpeechEngineInfo,
  SpeechPreferences,
  SpeechVoiceInfo,
} from './types';
import {
  DEFAULT_SPEECH_PREFERENCES,
  engineInfoFromNative,
  voiceInfoFromNative,
} from './types';
import {getSpeechEngine, setSpeechEngine} from './textToSpeech';
import type {TextToSpeechEngine} from './textToSpeech';

/** Raw voice/engine rows arrive from the bridge as plain records. */
type NativeRecord = Record<string, unknown>;

/** Shape of the Kotlin module registered by SpeechPackage (JS surface). */
interface NativeSpeechModule {
  /** Speaks text; resolves when playback ends, rejects on failure. */
  speak(text: string): Promise<void>;
  /** Speaks with per-utterance voice/rate/pitch options. */
  speakWith(
    text: string,
    options: {voiceId: string | null; rate: number; pitch: number} | null,
  ): Promise<void>;
  /** Halts playback immediately; safe when nothing is playing. */
  stop(): void;
  /** Lists installed voices with quality/latency/network/gender metadata. */
  getVoices(): Promise<SpeechVoiceInfo[]>;
  /** Lists installed system TTS engines. */
  getEngines(): Promise<SpeechEngineInfo[]>;
  /** Resolves the engine package currently backing the module. */
  getDefaultEngine(): Promise<string | null>;
  /** Rebuilds the engine with the requested package; reverts on failure. */
  setDefaultEngine(engineId: string): Promise<void>;
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

/**
 * Speech preferences currently applied to every utterance. The settings
 * screen keeps this in sync via applySpeechPreferences(); the first speak
 * lazy-loads the persisted values so startup needs no extra wiring.
 */
let activePreferences: SpeechPreferences = DEFAULT_SPEECH_PREFERENCES;
let preferencesLoaded: Promise<void> | null = null;

/** Awaited before every speak; loads persisted preferences at most once. */
function ensurePreferencesLoaded(): Promise<void> {
  if (!preferencesLoaded) {
    preferencesLoaded = loadSpeechPreferences()
      .then(preferences => {
        activePreferences = preferences;
      })
      .catch(() => {
        // A storage failure keeps the defaults; playback continues.
      });
  }
  return preferencesLoaded;
}

/**
 * Applies a new preferences snapshot to subsequent utterances. Called by the
 * TTS settings layer after every change (and by tests to seed state).
 */
export function applySpeechPreferences(preferences: SpeechPreferences): void {
  activePreferences = preferences;
  // The settings screen always persists before applying; warm the load-once
  // promise so a later reload cannot clobber fresher applied values with a
  // stale snapshot that was read before the write landed.
  if (!preferencesLoaded) {
    preferencesLoaded = Promise.resolve();
  }
}

/** Maps persisted preferences onto the native per-utterance options. */
function nativeOptions(preferences: SpeechPreferences): {
  voiceId: string | null;
  rate: number;
  pitch: number;
} {
  return {
    voiceId: preferences.systemVoiceId,
    rate: preferences.rate,
    pitch: preferences.pitch,
  };
}

/**
 * Builds the system-engine adapter: every utterance renders through the
 * platform Android TTS with the persisted voice/rate/pitch applied. The
 * engine satisfies the TextToSpeechEngine contract — speak() settles when
 * playback finishes or is superseded.
 */
export function androidSpeechEngine(): TextToSpeechEngine {
  const native = resolveNativeSpeech();
  if (!native) {
    throw new Error('Android speech module is not available');
  }
  return {
    async speak(text: string) {
      await ensurePreferencesLoaded();
      await native.speakWith(text, nativeOptions(activePreferences));
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

/**
 * Returns the currently installed speech engine through the registry seam
 * (falls back to the stub when no native engine was installed). Used by the
 * preview control so what the user hears is exactly what chat playback
 * sounds like — the adapter already applies the preferences.
 */
export function getSpeechEngineSnapshot(): TextToSpeechEngine {
  return getSpeechEngine();
}

/**
 * Auditions one system voice with the current rate/pitch without changing
 * the persisted selection. SpeakWith overrides the voice id for this single
 * utterance; the next regular speak re-applies the stored preferences.
 */
export async function previewSystemVoice(
  voiceId: string,
  text: string,
): Promise<void> {
  const native = resolveNativeSpeech();
  if (!native) {
    throw new Error('Android speech module is not available');
  }
  await ensurePreferencesLoaded();
  await native.speakWith(text, {
    voiceId,
    rate: activePreferences.rate,
    pitch: activePreferences.pitch,
  });
}

/** Lists installed system voices; rejects when the module is unavailable. */
export async function listSystemVoices(): Promise<SpeechVoiceInfo[]> {
  const native = resolveNativeSpeech();
  if (!native) {
    throw new Error('Android speech module is not available');
  }
  const rows = (await native.getVoices()) as unknown;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .filter(
      (row): row is NativeRecord =>
        typeof row === 'object' && row !== null && typeof (row as NativeRecord).id === 'string',
    )
    .map(voiceInfoFromNative);
}

/** Lists installed system TTS engines; rejects when unavailable. */
export async function listSystemEngines(): Promise<SpeechEngineInfo[]> {
  const native = resolveNativeSpeech();
  if (!native) {
    throw new Error('Android speech module is not available');
  }
  const rows = (await native.getEngines()) as unknown;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .filter(
      (row): row is NativeRecord =>
        typeof row === 'object' && row !== null && typeof (row as NativeRecord).id === 'string',
    )
    .map(engineInfoFromNative);
}

/** Resolves the engine package currently backing the system module. */
export async function getSystemEngineId(): Promise<string | null> {
  const native = resolveNativeSpeech();
  if (!native) {
    return null;
  }
  const engineId = (await native.getDefaultEngine()) as unknown;
  return typeof engineId === 'string' && engineId ? engineId : null;
}

/**
 * Switches the system TTS engine package. The native side rebuilds the
 * engine and reverts to the previous one when initialization fails.
 */
export async function selectSystemEngine(engineId: string): Promise<void> {
  const native = resolveNativeSpeech();
  if (!native) {
    throw new Error('Android speech module is not available');
  }
  await native.setDefaultEngine(engineId);
}
