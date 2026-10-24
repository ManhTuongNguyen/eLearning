/**
 * Free Dictionary API client for the word bank (WORD_BANK_V1 §2.4,
 * TASK-WB-003).
 *
 * One HTTP call per word against `dictionaryapi.dev` — no key, no auth, no
 * backend — fills the verified dictionary facts the AI deliberately does not
 * write. The `fetch` implementation is injected so tests never hit the
 * network; each lookup runs under its own timeout.
 *
 * Outcomes:
 * - `'found'`: rows to store (`phonetics` IPA strings, `senses` in the API's
 *   own shape so enrichment can replace them wholesale);
 * - `'not-found'`: 404, an empty body or unusable JSON — the word is dropped;
 * - `'unavailable'`: 429, 5xx, network or timeout — transient, so the word can
 *   be kept without data and fetched later from Word detail.
 *
 * Audio policy: the API's recordings (Wiktionary community files with patchy
 * coverage) are deliberately ignored — word audio is device TTS only.
 *
 * Attribution: definitions originate from Wiktionary (CC BY-SA) via the Free
 * Dictionary API.
 */
import type { WordSense } from '../db/types';

export const DICTIONARY_API_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en';

/** Credits line shown in the Settings screen's serverless section. */
export const DICTIONARY_ATTRIBUTION =
  'Word definitions come from Wiktionary (CC BY-SA) via the Free Dictionary API.';

/** The injected network seam: the standard `fetch` signature. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Default per-word timeout for one dictionary lookup. */
export const DEFAULT_DICTIONARY_TIMEOUT_MS = 10_000;

/** The result of one dictionary lookup. */
export type DictionaryLookupResult =
  | { outcome: 'found'; senses: WordSense[]; phonetics: string[] }
  | { outcome: 'not-found' }
  | { outcome: 'unavailable' };

interface ApiDefinition {
  definition?: unknown;
  example?: unknown;
}

interface ApiMeaning {
  partOfSpeech?: unknown;
  definitions?: unknown;
}

interface ApiEntry {
  meanings?: unknown;
  phonetics?: unknown;
}

/**
 * Map the API JSON to the stored shape. Pure: entries with no usable meanings
 * are skipped, same-POS groups are merged in first-appearance order, phonetic
 * texts are deduplicated, and audio URLs are ignored. An empty result means
 * the lookup is treated as not-found.
 */
export function mapDictionaryResponse(json: unknown): {
  senses: WordSense[];
  phonetics: string[];
} {
  const senses: WordSense[] = [];
  const phonetics: string[] = [];
  const seenPhonetics = new Set<string>();
  const senseIndex = new Map<string, number>();

  if (!Array.isArray(json)) {
    return { senses, phonetics };
  }
  for (const rawEntry of json) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      continue;
    }
    const entry = rawEntry as ApiEntry;

    if (Array.isArray(entry.phonetics)) {
      for (const rawPhonetic of entry.phonetics) {
        if (typeof rawPhonetic !== 'object' || rawPhonetic === null) {
          continue;
        }
        const text = (rawPhonetic as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim() && !seenPhonetics.has(text.trim())) {
          seenPhonetics.add(text.trim());
          phonetics.push(text.trim());
        }
      }
    }

    if (!Array.isArray(entry.meanings)) {
      continue;
    }
    for (const rawMeaning of entry.meanings) {
      if (typeof rawMeaning !== 'object' || rawMeaning === null) {
        continue;
      }
      const meaning = rawMeaning as ApiMeaning;
      if (typeof meaning.partOfSpeech !== 'string' || !meaning.partOfSpeech.trim()) {
        continue;
      }
      const partOfSpeech = meaning.partOfSpeech.trim();
      if (!Array.isArray(meaning.definitions)) {
        continue;
      }
      const definitions: WordSense['definitions'] = [];
      for (const rawDefinition of meaning.definitions) {
        if (typeof rawDefinition !== 'object' || rawDefinition === null) {
          continue;
        }
        const candidate = rawDefinition as ApiDefinition;
        if (typeof candidate.definition !== 'string' || !candidate.definition.trim()) {
          continue;
        }
        const example =
          typeof candidate.example === 'string' && candidate.example.trim()
            ? candidate.example.trim()
            : undefined;
        definitions.push(
          example === undefined
            ? { definition: candidate.definition.trim() }
            : { definition: candidate.definition.trim(), example },
        );
      }
      if (definitions.length === 0) {
        continue;
      }
      const existingIndex = senseIndex.get(partOfSpeech);
      if (existingIndex === undefined) {
        senseIndex.set(partOfSpeech, senses.length);
        senses.push({ partOfSpeech, definitions });
      } else {
        senses[existingIndex].definitions.push(...definitions);
      }
    }
  }
  return { senses, phonetics };
}

/**
 * Look one word up. Never throws: every transport-level failure collapses
 * into `'unavailable'`, every data-level failure into `'not-found'`.
 */
export async function lookupDictionaryWord(
  word: string,
  fetchFn: FetchFn,
  options: { timeoutMs?: number } = {},
): Promise<DictionaryLookupResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DICTIONARY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(`${DICTIONARY_API_BASE}/${encodeURIComponent(word)}`, {
      signal: controller.signal,
    });
  } catch {
    return { outcome: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    return { outcome: 'not-found' };
  }
  if (!response.ok) {
    // 429, 5xx and anything unexpected are transient, not proof of absence.
    return { outcome: 'unavailable' };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { outcome: 'not-found' };
  }
  const { senses, phonetics } = mapDictionaryResponse(json);
  if (senses.length === 0) {
    return { outcome: 'not-found' };
  }
  return { outcome: 'found', senses, phonetics };
}
