/**
 * Debounced side effects shared by the settings surfaces (TTS settings, the
 * speaking-practice scroll speed): a control's visible state follows the user
 * immediately, but the expensive/committing work — writing the preference to
 * storage and pushing it to the live engine adapter — runs once, after the
 * user stops moving, instead of on every tick.
 *
 * The returned callback keeps the newest `callback` in a ref, so a timer that
 * outlives a render still fires the current closure rather than a stale one.
 * A change still waiting out its quiet period when the component unmounts is
 * committed on the way out, so navigating away never drops the last edit.
 *
 * Callers that run a competing, non-debounced action on the same state (e.g.
 * "reset to defaults") must `cancel()` the pending call first, or it will fire
 * afterwards and clobber the newer state. `flush()` commits it immediately.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';

/** Quiet period applied when no explicit delay is passed. */
export const DEFAULT_DEBOUNCE_DELAY_MS = 400;

export interface DebouncedCallback<Args extends unknown[]> {
  (...args: Args): void;
  /** Drop a pending call without committing it. */
  cancel(): void;
  /** Commit a pending call immediately, if there is one. */
  flush(): void;
}

export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay: number = DEFAULT_DEBOUNCE_DELAY_MS,
): DebouncedCallback<Args> {
  const callbackRef = useRef(callback);
  // Re-point the ref after every render so the pending timer always invokes
  // the latest callback, never a stale closure from an earlier render.
  useEffect(() => {
    callbackRef.current = callback;
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgsRef = useRef<Args | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingArgsRef.current = null;
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingArgsRef.current;
    pendingArgsRef.current = null;
    if (pending !== null) {
      callbackRef.current(...pending);
    }
  }, []);

  const debounced = useMemo(() => {
    const run = (...args: Args) => {
      pendingArgsRef.current = args;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      // Debounced: the change fires only after this period elapses with no
      // further calls — never immediately.
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingArgsRef.current;
        pendingArgsRef.current = null;
        if (pending !== null) {
          callbackRef.current(...pending);
        }
      }, delay);
    };
    run.cancel = cancel;
    run.flush = flush;
    return run as DebouncedCallback<Args>;
  }, [delay, cancel, flush]);

  // Unmount: commit whichever call is still waiting out its quiet period
  // (best-effort — there is no UI left to revert on failure).
  useEffect(() => flush, [flush]);

  return debounced;
}
