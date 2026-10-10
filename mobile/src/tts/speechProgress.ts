/**
 * Speech-progress seam (SpeakingHistory TTS listen mode).
 *
 * The Android Speech module emits a `SpeechProgress` event per spoken word
 * range ({charStart, charEnd} offsets into the utterance text) while an
 * utterance is in flight. The karaoke teleprompter subscribes through
 * addSpeechProgressListener() so the scroll follows the engine's ACTUAL
 * pace instead of the constant speed from Settings.
 *
 * The seam is deliberately tolerant: environments without the native module
 * (Jest, previews, iOS stub) simply never emit events, so subscribers see
 * silence rather than errors. Payloads are validated defensively because
 * bridge records arrive as untyped plain objects.
 */
import {DeviceEventEmitter, type EmitterSubscription} from 'react-native';

/** Name of the native progress event (mirrors SpeechModule.EVENT_PROGRESS). */
export const SPEECH_PROGRESS_EVENT = 'SpeechProgress';

/** Character range of the text currently being spoken. */
export interface SpeechProgress {
  /** First character index of the spoken range (inclusive). */
  readonly charStart: number;
  /** First character index after the spoken range (exclusive). */
  readonly charEnd: number;
}

export type SpeechProgressListener = (progress: SpeechProgress) => void;

/** True when the value is a finite integer-like number. */
function isCharOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Parses a raw bridge payload; null when malformed. */
export function parseSpeechProgress(raw: unknown): SpeechProgress | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const {charStart, charEnd} = record;
  if (!isCharOffset(charStart) || !isCharOffset(charEnd)) {
    return null;
  }
  return {charStart, charEnd};
}

/**
 * Subscribes to per-word progress of the in-flight utterance. Returns an
 * unsubscribe function; listeners must tolerate gaps (events only flow
 * while a native utterance is actually speaking).
 */
export function addSpeechProgressListener(
  listener: SpeechProgressListener,
): () => void {
  const subscription: EmitterSubscription = DeviceEventEmitter.addListener(
    SPEECH_PROGRESS_EVENT,
    (raw: unknown) => {
      const progress = parseSpeechProgress(raw);
      if (progress !== null) {
        listener(progress);
      }
    },
  );
  return () => subscription.remove();
}
