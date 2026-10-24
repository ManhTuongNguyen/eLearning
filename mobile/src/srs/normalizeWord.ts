/**
 * Word normalisation for the word bank (WORD_BANK_V1 §2.1, TASK-WB-002).
 *
 * Two words are "the same" when they normalise to the same string: lowercase,
 * trimmed, internal whitespace collapsed and surrounding punctuation stripped.
 * The form is deliberately simpler than `normalizeSentenceText` — no
 * contraction expansion, because that is sentence comparison logic, not word
 * identity — and it is the duplicate key stored on every word row (unique per
 * topic), so generation, manual input and the search box all agree on what
 * makes two words equal.
 */

/**
 * Normalise a word into its duplicate-comparison form. Internal apostrophes
 * survive (`don't` stays `don't`); quotes, commas and periods around a word do
 * not. Returns '' when the text holds no letters or digits at all.
 */
export function normalizeWordText(text: string): string {
  const collapsed = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return collapsed.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}
