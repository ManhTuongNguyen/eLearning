/**
 * Speech-playback state for message surfaces (SPEC TASK-078). Wraps the
 * TextToSpeechEngine seam (TASK-076) with the single-playback contract the
 * chat needs: exactly one item is spoken at a time, starting another item
 * halts the current one first, stop() is always safe, unmounting silences
 * the engine and a failed utterance merely clears the visible state instead
 * of crashing. Callers render their own visible playback state from the
 * exposed speaking id.
 *
 * Utterance text is passed through the shared speech sanitizer
 * (toSpeechText) first, so screen-oriented decorations — inline markdown
 * delimiters, heading/bullet prefixes, emoji and pictographic icons — are
 * never read aloud.
 *
 * All mutable coordination lives in refs so speak()/stop() keep stable
 * identities across renders — screens may safely list them in effect
 * dependencies without re-triggering work.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {toSpeechText} from './speechText';
import type {TextToSpeechEngine} from './textToSpeech';
import {getSpeechEngine} from './textToSpeech';

/** Identifies the item being spoken (message id in chat). */
export type SpeechItemId = string | number;

export interface SpeechPlayback {
  /** Id of the item currently spoken; null while idle. */
  readonly speakingId: SpeechItemId | null;
  /**
   * Speaks text for the given id; any current playback stops first. The
   * returned promise never rejects — failures clear the state silently.
   */
  speak(id: SpeechItemId, text: string): void;
  /** Halts playback immediately and clears the visible state. */
  stop(): void;
}

export function useSpeechPlayback(
  engine: TextToSpeechEngine = getSpeechEngine(),
): SpeechPlayback {
  const [speakingId, setSpeakingId] = useState<SpeechItemId | null>(null);
  // Latest-ref seams keep the callbacks dependency-free while reading fresh
  // values: engine follows registry swaps, activeRef mirrors whether an
  // utterance is in flight so the engine is never stopped while idle.
  const engineRef = useRef(engine);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);
  const activeRef = useRef(false);

  // Monotonic playback token: every speak()/stop() supersedes everything
  // before it, so a stale utterance settlement can never clear the state of
  // a newer one (relevant when an interrupted promise settles late).
  const tokenRef = useRef(0);

  useEffect(
    () => () => {
      // Unmounting (screen exit) must also silence the engine.
      if (activeRef.current) {
        activeRef.current = false;
        engineRef.current.stop();
      }
    },
    [],
  );

  const stop = useCallback(() => {
    tokenRef.current += 1;
    if (activeRef.current) {
      activeRef.current = false;
      engineRef.current.stop();
    }
    setSpeakingId(null);
  }, []);

  const speak = useCallback((id: SpeechItemId, text: string) => {
    // Message surfaces hand over raw display content (markdown, emoji);
    // the engine only ever hears the sanitized words. Decoration-only
    // content has nothing to say: idle state and any current playback
    // stay untouched.
    const speakable = toSpeechText(text);
    if (!speakable) {
      return;
    }
    const token = ++tokenRef.current;
    // Starting another item halts the current one first so playback never
    // overlaps; the native module additionally supersedes an in-flight
    // utterance, whose late settlement is ignored via the token guard.
    if (activeRef.current) {
      engineRef.current.stop();
    } else {
      activeRef.current = true;
    }
    setSpeakingId(id);
    const clearIfCurrent = () => {
      if (tokenRef.current === token) {
        activeRef.current = false;
        setSpeakingId(prev => (prev === id ? null : prev));
      }
    };
    try {
      engineRef.current
        .speak(speakable)
        .then(clearIfCurrent, () => {
          // Missing voice data or a provider failure only ends this item's
          // visible playback state; it must never crash the application.
          clearIfCurrent();
        });
    } catch {
      clearIfCurrent();
    }
  }, []);

  return {speakingId, speak, stop};
}
