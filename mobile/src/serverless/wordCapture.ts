/**
 * Serverless pipeline for words captured from Android text selection
 * (WORD_CAPTURE_V1 TASK-WC-003).
 *
 * The native `WordCapture` module holds a queue of raw selected strings
 * (`CaptureActivity` appends to it without waking React Native), and this
 * module is the other half: drain a batch on app foreground, validate each
 * raw against the single-word rule, look it up in the dictionary, and insert
 * the survivors into the seeded collected-words topic.
 *
 * The capture policy deliberately differs from `lookupAndPersist` in
 * `wordGeneration.ts`: a captured word is NEVER dropped. `found` words are
 * stored complete; `not-found` and `unavailable` words are stored as
 * `data_status='missing'` so a misspelled or offline capture still lands in
 * the bank (the native toast already promised the save, and Word detail can
 * re-fetch or AI-enrich the word later).
 */

import { NativeModules } from 'react-native';
import type { SqlDriver } from '../db/driver';
import type { NewWord } from '../db/types';
import { getSystemWordTopic, insertWords } from '../db/wordRepository';
import { normalizeWordText } from '../srs/normalizeWord';
import type { DictionaryLookupFn } from './wordGeneration';

/** How many queued raws one foreground run processes; the rest wait for the next. */
export const MAX_CAPTURE_BATCH = 10;

/** A capture longer than this is not a word (the native layer pre-checks too). */
export const MAX_CAPTURED_WORD_LENGTH = 64;

/** The native queue seam, implemented by `WordCaptureModule` on Android. */
interface NativeWordCaptureModule {
  getPendingCapturedWords(): Promise<string[]>;
  removeCapturedWords(words: readonly string[]): Promise<void>;
}

function resolveNativeWordCapture(): NativeWordCaptureModule | null {
  const candidate = NativeModules.WordCapture as NativeWordCaptureModule | null | undefined;
  if (
    candidate &&
    typeof candidate.getPendingCapturedWords === 'function' &&
    typeof candidate.removeCapturedWords === 'function'
  ) {
    return candidate;
  }
  return null;
}

/** Raw strings waiting to be processed; empty when the native module is absent (iOS, tests). */
export async function getNativeCapturedWords(): Promise<string[]> {
  const native = resolveNativeWordCapture();
  if (!native) {
    return [];
  }
  return native.getPendingCapturedWords();
}

/** Remove exactly the processed raws; absent module is a no-op (nothing was read). */
export async function removeNativeCapturedWords(words: readonly string[]): Promise<void> {
  const native = resolveNativeWordCapture();
  if (!native) {
    return;
  }
  await native.removeCapturedWords(words);
}

/** One validation verdict for a raw captured string. */
export type CaptureValidation = { valid: true; normalized: string } | { valid: false };

/**
 * The single-word rule shared by the native pre-check and the JS pipeline:
 * one whitespace-free token, within the length cap, with at least one letter
 * or digit after normalisation. The returned `normalized` form — lowercased,
 * surrounding punctuation stripped — is what gets looked up and stored: the
 * dictionary API is case-sensitive, and selections arrive with sentence
 * casing (`Everything`) or trailing punctuation (`"word,"`).
 */
export function validateCapturedWord(raw: string): CaptureValidation {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CAPTURED_WORD_LENGTH || /\s/.test(trimmed)) {
    return { valid: false };
  }
  const normalized = normalizeWordText(trimmed);
  if (!normalized) {
    return { valid: false };
  }
  return { valid: true, normalized };
}

/** What one foreground run did with the queue. */
export interface CaptureProcessResult {
  /** Raw strings taken off the queue (valid and rejected alike). */
  captured: number;
  /** Raws that passed the single-word rule. */
  valid: number;
  /** Words actually inserted into the collected-words topic. */
  added: number;
  /** Inserted words stored with dictionary data. */
  withData: number;
  /** Inserted words stored without data (not-found or unavailable). */
  withoutData: number;
  /** Valid words skipped because the topic already holds them. */
  duplicates: number;
  /** Raws rejected by the single-word rule. */
  rejected: number;
}

const EMPTY_RESULT: CaptureProcessResult = {
  captured: 0,
  valid: 0,
  added: 0,
  withData: 0,
  withoutData: 0,
  duplicates: 0,
  rejected: 0,
};

/** Seams the startup hook injects; tests inject fakes. */
export interface CaptureSeams {
  lookup: DictionaryLookupFn;
  getPending?: () => Promise<string[]>;
  remove?: (words: readonly string[]) => Promise<void>;
}

/**
 * Process one batch of captured words: validate, look up sequentially, insert
 * into the system topic, then — only after the insert committed — remove the
 * processed raws from the native queue. A crash mid-run leaves the queue
 * intact and the retry is idempotent: `insertWords` skips duplicates.
 * Rejected raws are consumed too, so a bad capture cannot loop forever.
 */
export async function processCapturedWords(
  db: SqlDriver,
  seams: CaptureSeams,
): Promise<CaptureProcessResult> {
  const getPending = seams.getPending ?? getNativeCapturedWords;
  const remove = seams.remove ?? removeNativeCapturedWords;

  const pending = await getPending();
  if (pending.length === 0) {
    return EMPTY_RESULT;
  }
  const systemTopic = await getSystemWordTopic(db);
  if (!systemTopic) {
    // A pre-v10 database the migration has not reached; leave the queue alone.
    return EMPTY_RESULT;
  }

  const batch = pending.slice(0, MAX_CAPTURE_BATCH);
  const candidates: NewWord[] = [];
  const seen = new Set<string>();
  let valid = 0;
  let rejected = 0;
  for (const raw of batch) {
    const check = validateCapturedWord(raw);
    if (!check.valid || seen.has(check.normalized)) {
      rejected += 1;
      continue;
    }
    seen.add(check.normalized);
    valid += 1;
    const outcome = await seams.lookup(check.normalized);
    if (outcome.outcome === 'found') {
      candidates.push({
        text: check.normalized,
        senses_json: outcome.senses,
        phonetics_json: outcome.phonetics,
        data_source: 'dictionary',
        data_status: 'complete',
      });
    } else {
      // Capture keeps everything: not-found and unavailable alike land as
      // dataless words the learner can re-fetch or AI-enrich from Word detail.
      candidates.push({ text: check.normalized, data_status: 'missing' });
    }
  }

  const inserted = await insertWords(db, systemTopic.id, candidates);
  await remove(batch);

  const withData = inserted.filter(word => word.data_status === 'complete').length;
  return {
    captured: batch.length,
    valid,
    added: inserted.length,
    withData,
    withoutData: inserted.length - withData,
    duplicates: valid - inserted.length,
    rejected,
  };
}
