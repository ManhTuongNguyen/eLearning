/**
 * Dictation answer-checking tests (TASK-SENT-006).
 *
 * The card's honesty depends on these: the diff must mark every expected word
 * exactly once, the suggested grade must be forgiving about a typo but strict
 * about a missing word, and Easy must never be suggested.
 */
import {
  diffCharacters,
  diffDisplayTokens,
  diffTokens,
  isExactAnswer,
  levenshtein,
  suggestGrade,
  summarizeDiff,
  tokenizeForComparison,
  tokenizeSentence,
} from '../src/srs/answerCheck';

const SENTENCE = 'Nice to meet you.';

describe('tokenization', () => {
  test('keeps one display token per spoken word and strips punctuation', () => {
    expect(tokenizeSentence(SENTENCE)).toEqual([
      { raw: 'Nice', normalized: 'nice' },
      { raw: 'to', normalized: 'to' },
      { raw: 'meet', normalized: 'meet' },
      { raw: 'you', normalized: 'you' },
    ]);
  });

  test('keeps contractions as a single token and unifies curly apostrophes', () => {
    expect(tokenizeForComparison('I don\u2019t know')).toEqual(['i', "don't", 'know']);
  });

  test('ignores surrounding whitespace and punctuation runs', () => {
    expect(tokenizeForComparison('  Well,   hello!!  ')).toEqual(['well', 'hello']);
    expect(tokenizeForComparison('   ')).toEqual([]);
  });
});

describe('diffTokens', () => {
  test('marks every word correct for an exact answer', () => {
    const segments = diffTokens(SENTENCE, SENTENCE);

    expect(segments.map(segment => segment.kind)).toEqual([
      'correct',
      'correct',
      'correct',
      'correct',
    ]);
    expect(summarizeDiff(segments)).toEqual({
      correct: 4,
      missing: 0,
      extra: 0,
      substituted: 0,
    });
  });

  test('ignores case and punctuation differences', () => {
    const segments = diffTokens(SENTENCE, 'nice to meet you');

    expect(segments.every(segment => segment.kind === 'correct')).toBe(true);
  });

  test('marks a missing word once', () => {
    const segments = diffTokens(SENTENCE, 'nice to you');
    const summary = summarizeDiff(segments);

    expect(summary).toMatchObject({ correct: 3, missing: 1, extra: 0, substituted: 0 });
    expect(segments.find(segment => segment.kind === 'missing')?.expected).toBe('meet');
  });

  test('marks an added word once', () => {
    const segments = diffTokens(SENTENCE, 'nice to meet you all');
    const summary = summarizeDiff(segments);

    expect(summary).toMatchObject({ correct: 4, missing: 0, extra: 1, substituted: 0 });
    expect(segments.find(segment => segment.kind === 'extra')?.actual).toBe('all');
  });

  test('pairs a wrong word as one substitution', () => {
    const segments = diffTokens(SENTENCE, 'nice to see you');
    const summary = summarizeDiff(segments);

    expect(summary).toMatchObject({ correct: 3, missing: 0, extra: 0, substituted: 1 });
    expect(segments.find(segment => segment.kind === 'substituted')).toMatchObject({
      expected: 'meet',
      actual: 'see',
    });
  });

  test('handles a substitution beside missing and extra words', () => {
    const segments = diffTokens('I would like a coffee please', 'I want a large coffee now');
    const summary = summarizeDiff(segments);

    // would→want and like→large pair up; "please" is missing and "now" is extra.
    expect(summary.correct).toBe(3);
    expect(summary.substituted).toBe(2);
    expect(summary.missing).toBe(1);
    expect(summary.extra).toBe(1);
  });

  test('marks every expected word exactly once', () => {
    const segments = diffTokens(SENTENCE, 'see you');
    const expectedSeen = segments
      .filter(segment => segment.kind !== 'extra')
      .map(segment => segment.expected);

    expect(expectedSeen).toEqual(['Nice', 'to', 'meet', 'you']);
    expect(new Set(expectedSeen).size).toBe(expectedSeen.length);
  });

  test('treats a contraction and its expansion as the same words', () => {
    expect(isExactAnswer("I don't know", 'I do not know')).toBe(true);
    expect(suggestGrade("I don't know", 'I do not know')).toBe('good');
    expect(diffTokens("I don't know", 'I do not know').map(segment => segment.kind)).toEqual([
      'correct',
      'correct',
      'correct',
    ]);
  });

  test('does not flag the expanded words of a contraction as corrections', () => {
    const expected = "The weather's perfect for hiking, right?";
    const actual = 'The weather is perfect for hiking, right?';
    const segments = diffTokens(expected, actual);

    expect(isExactAnswer(expected, actual)).toBe(true);
    expect(isExactAnswer(expected, 'The weather perfect for hiking, right?')).toBe(false);
    expect(segments.every(segment => segment.kind === 'correct')).toBe(true);
    expect(summarizeDiff(segments)).toMatchObject({
      correct: 6,
      missing: 0,
      extra: 0,
      substituted: 0,
    });
    expect(diffDisplayTokens(segments).map(token => token.text)).toEqual([
      'The',
      'weather is',
      'perfect',
      'for',
      'hiking',
      'right',
    ]);
  });

  test("does not treat a possessive 's as an expanded is", () => {
    expect(isExactAnswer("John's pen", 'John is pen')).toBe(false);
    expect(suggestGrade("John's pen", 'John is pen')).toBe('again');
    expect(
      diffTokens("John's pen", 'John is pen').every(segment => segment.kind === 'correct'),
    ).toBe(false);
    expect(isExactAnswer("John's new pen", 'John is new pen')).toBe(false);
  });

  test("accepts a predicate adjective after a noun's contraction", () => {
    expect(isExactAnswer("John's happy", 'John is happy')).toBe(true);
    expect(
      diffTokens("John's happy", 'John is happy').every(segment => segment.kind === 'correct'),
    ).toBe(true);
  });

  test('still counts genuinely repeated words separately', () => {
    const segments = diffTokens('It is very very good', 'It is very very good');

    expect(segments.filter(segment => segment.kind === 'correct')).toHaveLength(5);
    expect(diffDisplayTokens(segments).map(token => token.text)).toEqual([
      'It',
      'is',
      'very',
      'very',
      'good',
    ]);
  });
});

describe('diffCharacters', () => {
  test('an exact answer is one correct run (case-insensitive, trimmed)', () => {
    expect(diffCharacters('bank', 'bank')).toEqual([{ kind: 'correct', text: 'bank' }]);
    expect(diffCharacters('bank', '  Bank ')).toEqual([{ kind: 'correct', text: 'bank' }]);
  });

  test('a wrong letter renders as the typed character then the expected one', () => {
    expect(diffCharacters('bank', 'bonk')).toEqual([
      { kind: 'correct', text: 'b' },
      { kind: 'extra', text: 'o' },
      { kind: 'missing', text: 'a' },
      { kind: 'correct', text: 'nk' },
    ]);
  });

  test('a missing letter snaps neighbouring matches to the typed spelling', () => {
    // "repliction" keeps the typed c and misses only the a — the cheapest path.
    expect(diffCharacters('replication', 'repliction')).toEqual([
      { kind: 'correct', text: 'replic' },
      { kind: 'missing', text: 'a' },
      { kind: 'correct', text: 'tion' },
    ]);
  });

  test('missing letters coalesce into one underlined run', () => {
    expect(diffCharacters('friendship', 'friship')).toEqual([
      { kind: 'correct', text: 'fri' },
      { kind: 'missing', text: 'end' },
      { kind: 'correct', text: 'ship' },
    ]);
  });

  test('extra typed letters coalesce into one struck run', () => {
    expect(diffCharacters('word', 'words')).toEqual([
      { kind: 'correct', text: 'word' },
      { kind: 'extra', text: 's' },
    ]);
  });
});

describe('suggestGrade', () => {
  test('suggests Good for an exact answer, whatever the punctuation', () => {
    expect(suggestGrade(SENTENCE, SENTENCE)).toBe('good');
    expect(suggestGrade(SENTENCE, 'nice to meet you')).toBe('good');
    expect(suggestGrade("I don't know", 'I do not know')).toBe('good');
  });

  test('suggests Good for a single typo-sized word', () => {
    expect(suggestGrade(SENTENCE, 'nice to met you')).toBe('good');
    expect(suggestGrade('Can I get a coffee?', 'can i get a cofee')).toBe('good');
  });

  test('suggests Good for a typo beside an expanded contraction', () => {
    expect(
      suggestGrade(
        "The weather's perfect for hiking, right?",
        'The weather is perfect for hking, right?',
      ),
    ).toBe('good');
  });

  test('suggests Again when a word is missing or added', () => {
    expect(suggestGrade(SENTENCE, 'nice to you')).toBe('again');
    expect(suggestGrade(SENTENCE, 'nice to meet you all')).toBe('again');
  });

  test('suggests Again when two words are wrong', () => {
    expect(suggestGrade(SENTENCE, 'nice too met you')).toBe('again');
  });

  test('suggests Again for an empty answer', () => {
    expect(suggestGrade(SENTENCE, '')).toBe('again');
    expect(suggestGrade(SENTENCE, '   ')).toBe('again');
  });

  test('never suggests Easy', () => {
    const answers = ['', 'nice', SENTENCE, 'nice to meet you all', 'totally different words here'];
    for (const answer of answers) {
      expect(suggestGrade(SENTENCE, answer)).not.toBe('easy');
    }
  });
});

describe('levenshtein', () => {
  test('measures single-character edits', () => {
    expect(levenshtein('meet', 'met')).toBe(1);
    expect(levenshtein('coffee', 'cofee')).toBe(1);
    expect(levenshtein('meet', 'meet')).toBe(0);
    expect(levenshtein('meet', 'you')).toBe(4);
  });
});

describe('diffDisplayTokens', () => {
  test('renders plain text plus kind, with the expected word when it differs', () => {
    const tokens = diffDisplayTokens(diffTokens(SENTENCE, 'nice to see you all'));

    expect(tokens).toEqual([
      { kind: 'correct', text: 'nice' },
      { kind: 'correct', text: 'to' },
      { kind: 'substituted', text: 'see', expected: 'meet' },
      { kind: 'correct', text: 'you' },
      { kind: 'extra', text: 'all' },
    ]);
    // No markup ever leaks into the rendered text.
    for (const token of tokens) {
      expect(token.text).not.toMatch(/[<>[\]]/);
    }
  });

  test('shows the missing word as text', () => {
    const tokens = diffDisplayTokens(diffTokens(SENTENCE, 'nice to you'));

    expect(tokens).toContainEqual({ kind: 'missing', text: 'meet' });
  });
});
