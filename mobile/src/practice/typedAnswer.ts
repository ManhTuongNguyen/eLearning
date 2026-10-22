/**
 * Typed-answer helpers for the listening-practice trainer.
 *
 * The trainer offers two ways to answer: pick one of four options or type what
 * was heard. Everything here is pure and React-free so the screen only renders
 * the result:
 *
 *  - `normalizeTypedAnswer` makes the comparison forgiving in the ways a
 *    learner typing on a phone keyboard expects: case never matters, and
 *    spaces/punctuation inside a number or phone number are ignored
 *    ("07942 153 860" and "07942153860" are the same answer).
 *  - `keyboardTypeForMode` keeps the keyboard honest: digits-only modes get
 *    the number pad, letter/mixed modes get the normal keyboard.
 *
 * The answer itself stays the ground truth from `questionBank` — this module
 * never invents or rewrites an answer, it only compares.
 */
import type { PracticeMode } from './questionBank';

/** How the learner answers the current question. */
export type AnswerInputMode = 'choose' | 'type';

/** Keyboard types the trainer needs; a subset of React Native's prop. */
export type TypedAnswerKeyboardType = 'default' | 'number-pad';

/**
 * Comparison form of a typed answer: trimmed, lowercased, and with whitespace
 * and number punctuation removed. Letters are unaffected beyond case.
 */
export function normalizeTypedAnswer(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s,.\-\u2013\u2014]/g, '');
}

/** True when a non-empty typed answer matches the expected answer. */
export function isTypedAnswerCorrect(answer: string, typed: string): boolean {
  const expected = normalizeTypedAnswer(answer);
  return expected.length > 0 && expected === normalizeTypedAnswer(typed);
}

/**
 * Numbers and phone numbers ask for digits only, so the number pad is the
 * right keyboard. Letters and mixed rounds need the normal letter keyboard.
 */
export function keyboardTypeForMode(mode: PracticeMode): TypedAnswerKeyboardType {
  return mode === 'numbers' || mode === 'phones' ? 'number-pad' : 'default';
}

/** Short placeholder that states exactly what the learner should type. */
export function typedAnswerPlaceholder(mode: PracticeMode): string {
  switch (mode) {
    case 'numbers':
      return 'Type the digits you heard';
    case 'letters':
      return 'Type the letter you heard';
    case 'phones':
      return 'Type the phone number';
    default:
      return 'Type what you heard';
  }
}
