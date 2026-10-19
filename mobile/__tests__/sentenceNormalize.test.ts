/**
 * Sentence normalisation tests (SENTENCE_LIVE_V1 §2.4).
 *
 * The normal form is the duplicate key used by generation and stored on every
 * row, so it must fold case, punctuation, whitespace and the common
 * contractions while keeping word order significant.
 */
import {isDuplicateSentence, normalizeSentenceText} from '../src/srs/normalize';

describe('normalizeSentenceText', () => {
  test('folds case and punctuation', () => {
    expect(normalizeSentenceText('Nice to meet you!')).toBe('nice to meet you');
    expect(normalizeSentenceText('Nice to meet you.')).toBe('nice to meet you');
    expect(normalizeSentenceText('Nice to meet you')).toBe('nice to meet you');
  });

  test('collapses whitespace and trims', () => {
    expect(normalizeSentenceText('  Hello,   there  ')).toBe('hello there');
    expect(normalizeSentenceText('Hello\nthere')).toBe('hello there');
  });

  test('expands contractions, including curly apostrophes', () => {
    expect(normalizeSentenceText("I don't know")).toBe('i do not know');
    expect(normalizeSentenceText('I don’t know')).toBe('i do not know');
    expect(normalizeSentenceText("It's fine.")).toBe('it is fine');
    expect(normalizeSentenceText("We're leaving now")).toBe('we are leaving now');
    expect(normalizeSentenceText("Can't wait")).toBe('cannot wait');
  });

  test('keeps digits', () => {
    expect(normalizeSentenceText('I have 2 cats.')).toBe('i have 2 cats');
  });

  test('treats word order as significant', () => {
    expect(normalizeSentenceText('nice to meet you')).not.toBe(
      normalizeSentenceText('meet you nice to'),
    );
  });

  test('returns an empty string for blank input', () => {
    expect(normalizeSentenceText('')).toBe('');
    expect(normalizeSentenceText('   ...  ')).toBe('');
  });
});

describe('isDuplicateSentence', () => {
  test('detects punctuation and contraction variants of the same sentence', () => {
    expect(isDuplicateSentence('Nice to meet you!', 'nice to meet you.')).toBe(true);
    expect(isDuplicateSentence("I don't know", 'I do not know')).toBe(true);
  });

  test('keeps genuinely different sentences apart', () => {
    expect(isDuplicateSentence('Nice to meet you.', 'Nice to see you.')).toBe(false);
    expect(isDuplicateSentence('Can I get a coffee?', 'Can I get a tea?')).toBe(false);
  });

  test('never treats blank text as a duplicate', () => {
    expect(isDuplicateSentence('', '')).toBe(false);
    expect(isDuplicateSentence('   ', '!!')).toBe(false);
  });
});