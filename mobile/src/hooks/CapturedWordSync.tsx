/**
 * Startup/foreground sync for captured words (WORD_CAPTURE_V1 TASK-WC-004).
 *
 * A null-rendering component mounted once beside the root navigator: whenever
 * the app becomes active it drains the native capture queue into the seeded
 * collected-words topic. The run is deliberately silent — the native toast
 * already confirmed each capture at selection time, and the words simply
 * appear in the topic. It is mode-independent: the write is a local database
 * insert, so captures land even while the app is in server mode and surface
 * when the learner next opens the word bank.
 */

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { getLocalDatabase } from '../db/database';
import { lookupDictionaryWord } from '../serverless/dictionaryApi';
import { processCapturedWords } from '../serverless/wordCapture';

async function syncCapturedWords(running: { current: boolean }): Promise<void> {
  if (running.current) {
    return;
  }
  running.current = true;
  try {
    const db = await getLocalDatabase();
    await processCapturedWords(db, { lookup: word => lookupDictionaryWord(word, fetch) });
  } catch {
    // Best-effort: an untouched queue is replayed on the next activation.
  } finally {
    running.current = false;
  }
}

/** Mount once inside the providers; renders nothing. */
export function CapturedWordSync(): null {
  const running = useRef(false);

  useEffect(() => {
    syncCapturedWords(running);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        syncCapturedWords(running);
      }
    });
    return () => subscription.remove();
  }, []);

  return null;
}
