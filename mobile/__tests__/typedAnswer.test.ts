/**
 * Typed-answer helpers: the comparison must ignore phone/space punctuation and
 * letter case, reject empty input, and pick the keyboard that matches the
 * practice mode (digits for numbers/phones, letters for letters/mixed).
 */
import {
  isTypedAnswerCorrect,
  keyboardTypeForMode,
  normalizeTypedAnswer,
  typedAnswerPlaceholder,
} from '../src/practice/typedAnswer';

describe('normalizeTypedAnswer', () => {
  it('ignores case, surrounding whitespace and number punctuation', () => {
    expect(normalizeTypedAnswer('  B  ')).toBe('b');
    expect(normalizeTypedAnswer('1,997')).toBe('1997');
    expect(normalizeTypedAnswer('07942 153 860')).toBe('07942153860');
    expect(normalizeTypedAnswer('07942-153-860')).toBe('07942153860');
  });
});

describe('isTypedAnswerCorrect', () => {
  it('accepts the answer with or without grouping spaces', () => {
    expect(isTypedAnswerCorrect('07942 153 860', '07942153860')).toBe(true);
    expect(isTypedAnswerCorrect('1997', ' 1 997 ')).toBe(true);
  });

  it('matches letters case-insensitively', () => {
    expect(isTypedAnswerCorrect('B', 'b')).toBe(true);
  });

  it('rejects a different or empty answer', () => {
    expect(isTypedAnswerCorrect('1997', '199')).toBe(false);
    expect(isTypedAnswerCorrect('1997', '   ')).toBe(false);
    expect(isTypedAnswerCorrect('', '')).toBe(false);
  });
});

describe('keyboardTypeForMode', () => {
  it('asks for digits only in number and phone modes', () => {
    expect(keyboardTypeForMode('numbers')).toBe('number-pad');
    expect(keyboardTypeForMode('phones')).toBe('number-pad');
  });

  it('keeps the normal keyboard for letters and mixed rounds', () => {
    expect(keyboardTypeForMode('letters')).toBe('default');
    expect(keyboardTypeForMode('mixed')).toBe('default');
  });
});

describe('typedAnswerPlaceholder', () => {
  it('names exactly what the learner should type', () => {
    expect(typedAnswerPlaceholder('numbers')).toMatch(/digits/);
    expect(typedAnswerPlaceholder('letters')).toMatch(/letter/);
    expect(typedAnswerPlaceholder('phones')).toMatch(/phone/);
    expect(typedAnswerPlaceholder('mixed')).toMatch(/what you heard/);
  });
});
