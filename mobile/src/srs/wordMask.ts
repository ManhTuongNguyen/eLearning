/**
 * Word masking for the recall practice card (WORD_BANK_V1 §2.3, TASK-WB-005).
 *
 * The recall card shows a word's meanings and examples as retrieval context;
 * any visible occurrence of the target word would give the answer away, so it
 * is masked before display: first letter + underscores, preserving
 * capitalisation (`Bank` → `B___`) and leaving surrounding punctuation alone.
 *
 * A token is masked when it equals the target word case-insensitively, or is
 * one of the documented regular inflections of it:
 *
 * - `-s`      (bank → banks)
 * - `-es`     (match → matches)
 * - `-ed`     (match → matched)
 * - `-d`      (bank → banked)
 * - `-ing`    (bank → banking)
 * - doubled final consonant + `-ed`/`-ing` (plan → planned/planning,
 *   run → running)
 * - `-ies`/`-ied` for `y`-final stems (carry → carries/carried)
 *
 * Word boundaries only: a substring inside another word is never masked, so
 * `cat` does not mask `category`. Masking is presentation-only — nothing
 * stored is rewritten — and irregular inflections (`ran` for `run`) are a
 * known, accepted v1 limitation: they stay visible.
 *
 * Deterministic and pure: no React, no storage, no randomness.
 */

/** One renderable piece of masked text. */
export interface MaskedSegment {
  kind: 'plain' | 'masked';
  text: string;
}

const WORD_TOKEN = /[A-Za-z]+/g;

/**
 * True when `token` (already lowercased) is the target word or a documented
 * inflection of it. `word` must be lowercased too.
 */
function isInflectionOf(token: string, word: string): boolean {
  if (token === word) {
    return true;
  }
  if (
    token === `${word}s` ||
    token === `${word}es` ||
    token === `${word}ed` ||
    token === `${word}d` ||
    token === `${word}ing`
  ) {
    return true;
  }
  const last = word[word.length - 1];
  if (last && !'aeiouy'.includes(last)) {
    // Doubled final consonant: plan → planned/planning, run → running.
    if (token === `${word}${last}ed` || token === `${word}${last}ing`) {
      return true;
    }
  }
  if (word.endsWith('y') && word.length >= 2 && !'aeiouy'.includes(word[word.length - 2])) {
    // Consonant + y: carry → carries/carried.
    const stem = word.slice(0, -1);
    if (token === `${stem}ies` || token === `${stem}ied`) {
      return true;
    }
  }
  return false;
}

/** The masked rendering of one matched surface form: first letter + underscores. */
function maskedForm(token: string): string {
  return `${token[0]}${'_'.repeat(Math.max(0, token.length - 1))}`;
}

/**
 * Split `text` into ordered segments, masking every whole-word occurrence of
 * `word` or one of its documented inflections. Text with no occurrence comes
 * back as a single plain segment.
 */
export function maskWordInText(text: string, word: string): MaskedSegment[] {
  const target = word.trim().toLowerCase();
  if (!target) {
    return [{ kind: 'plain', text }];
  }

  const segments: MaskedSegment[] = [];
  let cursor = 0;
  WORD_TOKEN.lastIndex = 0;
  let match = WORD_TOKEN.exec(text);
  while (match !== null) {
    const token = match[0];
    if (isInflectionOf(token.toLowerCase(), target)) {
      if (match.index > cursor) {
        segments.push({ kind: 'plain', text: text.slice(cursor, match.index) });
      }
      segments.push({ kind: 'masked', text: maskedForm(token) });
      cursor = match.index + token.length;
    }
    match = WORD_TOKEN.exec(text);
  }
  if (cursor < text.length) {
    segments.push({ kind: 'plain', text: text.slice(cursor) });
  }
  if (segments.length === 0) {
    segments.push({ kind: 'plain', text });
  }
  return segments;
}

/**
 * Join the segments for rendering. Masked segments already carry their
 * first-letter + underscores form, so the join is the display string; the
 * screen owns the styling (e.g. highlighting masked spans).
 */
export function displayMaskedText(segments: readonly MaskedSegment[]): string {
  return segments.map(segment => segment.text).join('');
}
