/**
 * Frontend text-to-speech seam (ROADMAP §13, SPEC Phase 12). Every consumer
 * depends on this interface instead of native APIs; the Android-native
 * engine arrives with TASK-076/077 and swaps in behind it. Until then this
 * stub keeps the sample-conversation controls (TASK-053) fully wired:
 * speak() resolves immediately without producing audio and stop() is a
 * no-op. Playback-state tracking lives with the caller, so replacing the
 * engine changes nothing above this seam.
 */

export interface TextToSpeechEngine {
  /** Begin speaking the given text; resolves when playback finishes. */
  speak(text: string): Promise<void>;
  /** Stop current playback immediately; safe when nothing is playing. */
  stop(): void;
}

export const stubSpeechEngine: TextToSpeechEngine = {
  async speak() {},
  stop() {},
};
