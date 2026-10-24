/**
 * Free Dictionary API client for the word bank (WORD_BANK_V1 §2.4,
 * TASK-WB-003).
 *
 * One HTTP call per word against `freedictionaryapi.com/api/v1` — no key, no
 * auth, no backend — fills the verified dictionary facts the AI deliberately
 * does not write. The `fetch` implementation is injected so tests never hit
 * the network; each lookup runs under its own timeout.
 *
 * The API returns `{ word, entries: [...] }` where each entry carries a part
 * of speech, tagged IPA pronunciations, inflection forms and senses with
 * multiple examples, usage tags, quotes and synonyms/antonyms. The mapper
 * keeps what the app displays — every sense (subsenses flattened), up to
 * three examples per sense, usage tags, and up to eight synonyms/antonyms at
 * sense and definition level — and skips quotes and inflection forms (not
 * stored in v1).
 *
 * Outcomes:
 * - `'found'`: rows to store (`phonetics` IPA strings, `senses` in the stored
 *   shape so enrichment can replace them wholesale);
 * - `'not-found'`: 404, HTTP 200 with empty `entries`, an empty body or
 *   unusable JSON — the word is dropped;
 * - `'unavailable'`: 429, 5xx, network or timeout — transient, so the word can
 *   be kept without data and fetched later from Word detail.
 *
 * Audio policy: any recordings the API may expose (Wiktionary community files
 * with patchy coverage) are deliberately ignored — word audio is device TTS
 * only.
 *
 * Attribution: definitions originate from Wiktionary (CC BY-SA 4.0) via the
 * Free Dictionary API.
 */
import type { WordSense, WordSenseDefinition } from '../db/types';

export const DICTIONARY_API_BASE = 'https://freedictionaryapi.com/api/v1/entries/en';

/** Credits line shown in the Settings screen's serverless section. */
export const DICTIONARY_ATTRIBUTION =
  'Word definitions come from Wiktionary (CC BY-SA 4.0) via the Free Dictionary API.';

/** The injected network seam: the standard `fetch` signature. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Default per-word timeout for one dictionary lookup. */
export const DEFAULT_DICTIONARY_TIMEOUT_MS = 10_000;

/** The result of one dictionary lookup. */
export type DictionaryLookupResult =
  | { outcome: 'found'; senses: WordSense[]; phonetics: string[] }
  | { outcome: 'not-found' }
  | { outcome: 'unavailable' };

interface ApiPronunciation {
  type?: unknown;
  text?: unknown;
}

interface ApiSense {
  definition?: unknown;
  tags?: unknown;
  examples?: unknown;
  synonyms?: unknown;
  antonyms?: unknown;
  subsenses?: unknown;
}

interface ApiEntry {
  partOfSpeech?: unknown;
  pronunciations?: unknown;
  senses?: unknown;
  synonyms?: unknown;
  antonyms?: unknown;
}

interface ApiResponse {
  entries?: unknown;
}

/** Display caps: the UI shows a few of each; the rest is noise for a learner. */
const MAX_IPA = 6;
const MAX_EXTRA_EXAMPLES = 3;
const MAX_TAGS = 3;
const MAX_SYNONYMS = 8;

/** Non-empty trimmed strings from an optional array (safe defaults). */
function stringList(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map(item => item.trim())
    .slice(0, limit);
}

/** Map one sense (and flatten its subsenses after it) into definitions. */
function mapSenseDefinitions(raw: ApiSense): WordSense['definitions'] {
  const definitions: WordSense['definitions'] = [];
  const queue: ApiSense[] = [raw];
  while (queue.length > 0) {
    const sense = queue.shift() as ApiSense;
    if (typeof sense.definition !== 'string' || !sense.definition.trim()) {
      continue;
    }
    const examples = stringList(sense.examples, 1 + MAX_EXTRA_EXAMPLES);
    const parsed: WordSenseDefinition = { definition: sense.definition.trim() };
    if (examples.length > 0) {
      parsed.example = examples[0];
    }
    if (examples.length > 1) {
      parsed.extraExamples = examples.slice(1, 1 + MAX_EXTRA_EXAMPLES);
    }
    const tags = stringList(sense.tags, MAX_TAGS);
    if (tags.length > 0) {
      parsed.tags = tags;
    }
    const synonyms = stringList(sense.synonyms, MAX_SYNONYMS);
    if (synonyms.length > 0) {
      parsed.synonyms = synonyms;
    }
    const antonyms = stringList(sense.antonyms, MAX_SYNONYMS);
    if (antonyms.length > 0) {
      parsed.antonyms = antonyms;
    }
    definitions.push(parsed);
    if (Array.isArray(sense.subsenses)) {
      for (const subsense of sense.subsenses) {
        if (typeof subsense === 'object' && subsense !== null) {
          queue.push(subsense as ApiSense);
        }
      }
    }
  }
  return definitions;
}

/**
 * Map the API JSON to the stored shape. Pure: entries with no usable senses
 * are skipped, same-POS groups are merged in first-appearance order, phonetic
 * texts are deduplicated and capped, audio URLs are ignored, and subsenses
 * flatten into their parent sense. An empty result means the lookup is
 * treated as not-found.
 */
export function mapDictionaryResponse(json: unknown): {
  senses: WordSense[];
  phonetics: string[];
} {
  const senses: WordSense[] = [];
  const phonetics: string[] = [];
  const seenPhonetics = new Set<string>();
  const senseIndex = new Map<string, number>();

  // The v1 API returns a single object with an `entries` array; tolerate a
  // bare array (older clients cached that shape) for robustness.
  let entries: unknown[] = [];
  if (Array.isArray(json)) {
    entries = json;
  } else if (typeof json === 'object' && json !== null) {
    const response = json as ApiResponse;
    if (Array.isArray(response.entries)) {
      entries = response.entries;
    }
  }

  for (const rawEntry of entries) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      continue;
    }
    const entry = rawEntry as ApiEntry;

    if (Array.isArray(entry.pronunciations)) {
      for (const rawPronunciation of entry.pronunciations) {
        if (typeof rawPronunciation !== 'object' || rawPronunciation === null) {
          continue;
        }
        const pronunciation = rawPronunciation as ApiPronunciation;
        if (pronunciation.type !== 'ipa') {
          // Audio URLs are deliberately ignored: word audio is device TTS.
          continue;
        }
        if (typeof pronunciation.text !== 'string' || !pronunciation.text.trim()) {
          continue;
        }
        const text = pronunciation.text.trim();
        if (!seenPhonetics.has(text) && phonetics.length < MAX_IPA) {
          seenPhonetics.add(text);
          phonetics.push(text);
        }
      }
    }

    if (typeof entry.partOfSpeech !== 'string' || !entry.partOfSpeech.trim()) {
      continue;
    }
    const partOfSpeech = entry.partOfSpeech.trim();
    if (!Array.isArray(entry.senses)) {
      continue;
    }
    const definitions: WordSense['definitions'] = [];
    for (const rawSense of entry.senses) {
      if (typeof rawSense !== 'object' || rawSense === null) {
        continue;
      }
      definitions.push(...mapSenseDefinitions(rawSense as ApiSense));
    }
    if (definitions.length === 0) {
      continue;
    }
    const sense: WordSense = { partOfSpeech, definitions };
    const synonyms = stringList(entry.synonyms, MAX_SYNONYMS);
    if (synonyms.length > 0) {
      sense.synonyms = synonyms;
    }
    const antonyms = stringList(entry.antonyms, MAX_SYNONYMS);
    if (antonyms.length > 0) {
      sense.antonyms = antonyms;
    }
    const existingIndex = senseIndex.get(partOfSpeech);
    if (existingIndex === undefined) {
      senseIndex.set(partOfSpeech, senses.length);
      senses.push(sense);
    } else {
      senses[existingIndex].definitions.push(...definitions);
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
