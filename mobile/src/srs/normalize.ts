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
 * (`he's`, `she's`, and noun + `'s`) are resolved from the following words by
 * `expandTokenForComparison`; that context is what lets `The weather's perfect`
 * and `The weather is perfect` match while keeping `John's pen` distinct from
 * `John is pen`.
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

/** One word after a token plus whether punctuation separated the two. */
export interface FollowingWord {
  word: string;
  precededByPunctuation: boolean;
}

/** How many following words the `'s` heuristic may inspect. */
const EXPANSION_LOOKAHEAD = 8;

/**
 * Words that can start an "is" complement and cannot start a possessive noun
 * phrase. A determiner or preposition immediately after `'s` therefore settles
 * the reading (`John's a teacher`, `John's in the garden`).
 */
const IS_COMPLEMENT_STARTERS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'another',
  'any',
  'at',
  'back',
  'behind',
  'beside',
  'between',
  'by',
  'down',
  'during',
  'each',
  'every',
  'for',
  'from',
  'her',
  'here',
  'his',
  'home',
  'in',
  'inside',
  'into',
  'its',
  'my',
  'near',
  'no',
  'of',
  'off',
  'on',
  'onto',
  'our',
  'out',
  'outside',
  'over',
  'some',
  'that',
  'the',
  'their',
  'these',
  'this',
  'those',
  'through',
  'to',
  'under',
  'up',
  'with',
  'without',
  'your',
]);

/** Adverbs that can sit between `'s` and its adjective (`John's very happy`). */
const COMPARISON_ADVERBS: ReadonlySet<string> = new Set([
  'almost',
  'already',
  'also',
  'always',
  'certainly',
  'definitely',
  'even',
  'far',
  'just',
  'later',
  'less',
  'more',
  'most',
  'much',
  'never',
  'not',
  'now',
  'only',
  'probably',
  'quite',
  'rather',
  'really',
  'so',
  'soon',
  'still',
  'today',
  'tomorrow',
  'tonight',
  'too',
  'very',
  'yesterday',
]);

/**
 * Common predicate adjectives and participles. This is deliberately a list,
 * not a suffix rule: treating every `-ing` or `-able` word as an adjective
 * would turn possessives like `John's running shoes` or `John's table` into
 * false "is" readings.
 */
const PREDICATE_WORDS: ReadonlySet<string> = new Set([
  'able',
  'afraid',
  'alive',
  'amazing',
  'angry',
  'available',
  'awesome',
  'awful',
  'bad',
  'beautiful',
  'better',
  'big',
  'boring',
  'born',
  'brave',
  'broken',
  'busy',
  'careful',
  'careless',
  'certain',
  'clean',
  'clever',
  'closed',
  'cloudy',
  'cold',
  'comfortable',
  'cool',
  'correct',
  'crazy',
  'dangerous',
  'dark',
  'dead',
  'delicious',
  'different',
  'difficult',
  'dirty',
  'done',
  'dry',
  'early',
  'easy',
  'empty',
  'enough',
  'excellent',
  'excited',
  'exciting',
  'expensive',
  'false',
  'famous',
  'fantastic',
  'fast',
  'fine',
  'finished',
  'foggy',
  'free',
  'friendly',
  'full',
  'funny',
  'glad',
  'gone',
  'good',
  'great',
  'happy',
  'hard',
  'healthy',
  'heavy',
  'helpful',
  'high',
  'honest',
  'horrible',
  'hot',
  'hungry',
  'ill',
  'impossible',
  'important',
  'interested',
  'interesting',
  'kind',
  'known',
  'large',
  'late',
  'lazy',
  'light',
  'little',
  'lonely',
  'long',
  'lost',
  'loud',
  'lovely',
  'low',
  'married',
  'mean',
  'missing',
  'modern',
  'nervous',
  'new',
  'nice',
  'noisy',
  'normal',
  'old',
  'open',
  'perfect',
  'polite',
  'popular',
  'possible',
  'poor',
  'pretty',
  'proud',
  'quiet',
  'rainy',
  'ready',
  'real',
  'rich',
  'right',
  'rude',
  'sad',
  'safe',
  'same',
  'scared',
  'serious',
  'short',
  'sick',
  'similar',
  'simple',
  'single',
  'slow',
  'small',
  'smart',
  'snowy',
  'sorry',
  'special',
  'strange',
  'strong',
  'stupid',
  'sunny',
  'sure',
  'terrible',
  'thirsty',
  'tired',
  'true',
  'ugly',
  'unable',
  'useful',
  'useless',
  'warm',
  'weak',
  'weird',
  'wet',
  'windy',
  'wonderful',
  'worse',
  'worst',
  'wrong',
  'young',
]);

/**
 * Words that commonly follow a predicate adjective and show that it ended the
 * predicate (`perfect for hiking`, `happy today`, `good enough`). If a noun
 * follows instead, the word before it is usually a possessive modifier
 * (`John's new pen`).
 */
const CLAUSE_DELIMITERS: ReadonlySet<string> = new Set([
  'about',
  'after',
  'also',
  'although',
  'and',
  'anyway',
  'as',
  'at',
  'because',
  'before',
  'but',
  'by',
  'during',
  'either',
  'enough',
  'for',
  'from',
  'her',
  'him',
  'if',
  'in',
  'instead',
  'it',
  'me',
  'near',
  'now',
  'of',
  'on',
  'or',
  'since',
  'so',
  'soon',
  'than',
  'that',
  'them',
  'then',
  'though',
  'through',
  'to',
  'today',
  'tomorrow',
  'tonight',
  'too',
  'unless',
  'until',
  'us',
  'when',
  'whether',
  'while',
  'with',
  'without',
  'yesterday',
  'you',
]);

/** Find the next few words after an offset, keeping clause punctuation. */
function followingWordsAfter(
  text: string,
  from: number,
  limit = EXPANSION_LOOKAHEAD,
): FollowingWord[] {
  const pattern = /[a-z0-9]+(?:'[a-z]+)?/g;
  pattern.lastIndex = from;
  const words: FollowingWord[] = [];
  let previousEnd = from;
  let match = pattern.exec(text);
  while (words.length < limit && match !== null) {
    const gap = text.slice(previousEnd, match.index);
    words.push({ word: match[0], precededByPunctuation: /\S/.test(gap) });
    previousEnd = pattern.lastIndex;
    match = pattern.exec(text);
  }
  return words;
}

/**
 * Decide whether a word, especially one ending in `'s`, reads as "is" for
 * comparison. The plain contraction map handles pronouns and irregular forms;
 * the context check handles nouns such as `weather's` without turning
 * possessives such as `John's pen` into `John is pen`.
 */
export function expandTokenForComparison(
  word: string,
  followingWords: readonly FollowingWord[],
): string {
  const mapped = CONTRACTION_EXPANSIONS[word];
  if (mapped) {
    return mapped;
  }
  if (!word.endsWith("'s")) {
    return word;
  }

  const contraction = `${word.slice(0, -2)} is`;
  const first = followingWords[0];
  if (!first || first.precededByPunctuation) {
    return contraction;
  }
  if (IS_COMPLEMENT_STARTERS.has(first.word)) {
    return contraction;
  }

  let index = 0;
  while (index < followingWords.length && COMPARISON_ADVERBS.has(followingWords[index].word)) {
    index += 1;
  }
  if (index >= followingWords.length) {
    return contraction;
  }

  const significant = followingWords[index];
  if (significant.precededByPunctuation) {
    return contraction;
  }
  if (IS_COMPLEMENT_STARTERS.has(significant.word)) {
    return contraction;
  }
  if (!PREDICATE_WORDS.has(significant.word)) {
    return word;
  }

  const after = followingWords[index + 1];
  if (!after || after.precededByPunctuation || CLAUSE_DELIMITERS.has(after.word)) {
    return contraction;
  }
  return word;
}

/**
 * Normalise a sentence into its duplicate-comparison form: lowercase, curly
 * apostrophes unified, contractions expanded, then everything that is not a
 * letter or digit replaced by a space and the whitespace collapsed.
 */
export function normalizeSentenceText(text: string): string {
  const lowered = text.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const expanded = lowered.replace(
    /[a-z]+(?:'[a-z]+)?/g,
    (word: string, offset: number, full: string) =>
      expandTokenForComparison(word, followingWordsAfter(full, offset + word.length)),
  );
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
