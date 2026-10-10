/**
 * Frontend text-to-speech abstraction (ROADMAP §13, SPEC TASK-076). Every
 * consumer depends on this interface instead of native TTS APIs: speak()
 * resolves when playback finishes and stop() halts immediately (safe when
 * nothing is playing). The active engine is resolved through the registry
 * below, so the Android-native engine (TASK-077) swaps in behind the seam —
 * setSpeechEngine() at startup — without any UI changes. Until then the
 * stub keeps existing controls fully wired: it resolves immediately
 * without producing audio. Playback-state tracking lives with the caller.
 */

/**
 * Per-word progress report while an utterance speaks: the character range
 * of the text currently being voiced. Engines that cannot report progress
 * simply never invoke the callback.
 */
export interface SpeechProgressReport {
  readonly charStart: number;
  readonly charEnd: number;
}

export type SpeechProgressCallback = (progress: SpeechProgressReport) => void;

export interface TextToSpeechEngine {
  /**
   * Begin speaking the given text; resolves when playback finishes. When
   * `onProgress` is given and the engine supports it, it fires per spoken
   * word range so callers can follow the real playback pace (teleprompter
   * scroll). The callback is never invoked after the returned promise
   * settles.
   */
  speak(text: string, onProgress?: SpeechProgressCallback): Promise<void>;
  /** Stop current playback immediately; safe when nothing is playing. */
  stop(): void;
}

export const stubSpeechEngine: TextToSpeechEngine = {
  async speak() {},
  stop() {},
};

let activeEngine: TextToSpeechEngine = stubSpeechEngine;

/** Returns the engine UI code should use; never imports native modules. */
export function getSpeechEngine(): TextToSpeechEngine {
  return activeEngine;
}

/** Installs the platform engine; called once from native wiring (TASK-077). */
export function setSpeechEngine(engine: TextToSpeechEngine): void {
  activeEngine = engine;
}
