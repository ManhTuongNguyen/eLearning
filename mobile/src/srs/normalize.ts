/**
 * Sentence normalisation (SENTENCE_LIVE_V1 §2.4, TASK-SENT-004/005).
 *
 * Two sentences are "the same" when they normalise to the same string. The
 * normal form is deliberately blunt — case, punctuation, whitespace and the
 * common contractions are folded away — and it is the duplicate key stored on
 * every sentence row (unique per topic), so generation can never add the same
 * sentence twice no matter how the model punctuates it.
 *
 * The contraction map is a comparison aid only: it never rewrites the sentence
 * the learner reads, and it is applied on the lowercased, apostrophe-normalised
 * text so both `don't` and `don’t` collapse to `do not`.
 */

/**
 * Contractions expanded for comparison. Words whose expansion is ambiguous
 * (`he's`, `she's`) resolve to the `is` reading — a documented simplification
 * that only affects duplicate detection, never displayed text.
 */
export const CONTRACTION_EXPANSIONS: Readonly<Record<string, string>> = {
  "aren't": 'are not',
  "can't": 'cannot',
  "couldn't": 'could not',
  "didn't": 'did not',
  "doesn't": 'does not',
  "don't": 'do not',
  "hadn't": 'had not',
  "hasn't": 'has not',
  "haven't": 'have not',
  "he's": 'he is',
  "how's": 'how is',
  "i'd": 'i would',
  "i'll": 'i will',
  "i'm": 'i am',
  "i've": 'i have',
  "isn't": 'is not',
  "it's": 'it is',
  "let's": 'let us',
  "she's": 'she is',
  "shouldn't": 'should not',
  "that's": 'that is',
  "there's": 'there is',
  "they're": 'they are',
  "they've": 'they have',
  "wasn't": 'was not',
  "we're": 'we are',
  "we've": 'we have',
  "weren't": 'were not',
  "what's": 'what is',
  "where's": 'where is',
  "who's": 'who is',
  "won't": 'will not',
  "wouldn't": 'would not',
  "you're": 'you are',
  "you've": 'you have',
};

/**
 * Normalise a sentence into its duplicate-comparison form: lowercase, curly
 * apostrophes unified, contractions expanded, then everything that is not a
 * letter or digit replaced by a space and the whitespace collapsed.
 */
export function normalizeSentenceText(text: string): string {
  const lowered = text.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const expanded = lowered.replace(/[a-z]+(?:'[a-z]+)?/g, word => {
    return CONTRACTION_EXPANSIONS[word] ?? word;
  });
  return expanded.replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * True when two sentences are duplicates for storage purposes. Word order is
 * significant: `nice to meet you` and `meet you nice to` are different.
 */
export function isDuplicateSentence(first: string, second: string): boolean {
  const left = normalizeSentenceText(first);
  return left.length > 0 && left === normalizeSentenceText(second);
}