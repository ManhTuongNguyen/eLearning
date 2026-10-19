/**
 * Dictation answer checking (SENTENCE_LIVE_V1 §2.6, TASK-SENT-006).
 *
 * When the learner types what they heard, the card has to answer three
 * questions without any ambiguity: which words were right, which were wrong,
 * and what grade that deserves. This module answers all three from the two
 * strings — purely, with no React and no storage — so the card only renders
 * the result.
 *
 * Two normal forms are used on purpose:
 *
 * - `normalizeSentenceText` (srs/normalize) is the *equality* key: it folds
 *   contractions, so "I do not know" and "I don't know" count as the same
 *   answer for grading.
 * - `tokenizeForComparison` is the *alignment* key: it lowercases and strips
 *   punctuation but keeps one token per spoken word, so the diff and the
 *   display stay faithful to what the learner actually typed.
 *
 * Grading is deliberately conservative: a clean answer or a single typo is
 * suggested as Good, everything else as Again. Easy is never suggested — it
 * stays an explicit learner choice.
 */
import type {ReviewGrade} from '../db/types';
import {normalizeSentenceText} from './normalize';

/** How one position of the answer relates to the sentence. */
export type DiffKind = 'correct' | 'missing' | 'extra' | 'substituted';

/** One aligned position: `expected` is the sentence's word, `actual` the learner's. */
export interface DiffSegment {
  kind: DiffKind;
  /** Word from the target sentence; null for an `extra` word. */
  expected: string | null;
  /** Word the learner typed; null for a `missing` word. */
  actual: string | null;
}

/** A token paired with its comparison form. */
export interface ComparableToken {
  /** The word as written, punctuation stripped (what the UI shows). */
  raw: string;
  /** Lowercased comparison form. */
  normalized: string;
}

/** One token ready for rendering, plus the expected word when it differs. */
export interface DisplayToken {
  kind: DiffKind;
  /** Text to render — the learner's word when there is one. */
  text: string;
  /** The sentence's word, present whenever it differs from `text`. */
  expected?: string;
}

const WORD_PATTERN = /[A-Za-z0-9]+(?:['\u2018\u2019][A-Za-z]+)*/g;

/** Split a sentence into display words with their comparison form. */
export function tokenizeSentence(text: string): ComparableToken[] {
  const words = text.match(WORD_PATTERN) ?? [];
  return words.map(raw => ({
    raw,
    normalized: raw.toLowerCase().replace(/[\u2018\u2019]/g, "'"),
  }));
}

/** The comparison tokens of a sentence, in order. */
export function tokenizeForComparison(text: string): string[] {
  return tokenizeSentence(text).map(token => token.normalized);
}

/** Levenshtein distance, used only to recognise a single-token typo. */
export function levenshtein(first: string, second: string): number {
  if (first === second) {
    return 0;
  }
  const rows = first.length + 1;
  const columns = second.length + 1;
  let previous = Array.from({length: columns}, (_, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = new Array<number>(columns);
    current[0] = row;
    for (let column = 1; column < columns; column += 1) {
      const substitution = previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1);
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[columns - 1];
}

type AlignmentOp = {type: 'match' | 'missing' | 'extra'; expectedIndex: number; actualIndex: number};

/** Longest-common-subsequence alignment of two token lists. */
function alignTokens(expected: readonly string[], actual: readonly string[]): AlignmentOp[] {
  const rows = expected.length + 1;
  const columns = actual.length + 1;
  const table: number[][] = Array.from({length: rows}, () => new Array<number>(columns).fill(0));

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      table[row][column] =
        expected[row - 1] === actual[column - 1]
          ? table[row - 1][column - 1] + 1
          : Math.max(table[row - 1][column], table[row][column - 1]);
    }
  }

  const ops: AlignmentOp[] = [];
  let row = expected.length;
  let column = actual.length;
  while (row > 0 || column > 0) {
    if (row > 0 && column > 0 && expected[row - 1] === actual[column - 1]) {
      ops.push({type: 'match', expectedIndex: row - 1, actualIndex: column - 1});
      row -= 1;
      column -= 1;
    } else if (column > 0 && (row === 0 || table[row][column - 1] >= table[row - 1][column])) {
      ops.push({type: 'extra', expectedIndex: -1, actualIndex: column - 1});
      column -= 1;
    } else {
      ops.push({type: 'missing', expectedIndex: row - 1, actualIndex: -1});
      row -= 1;
    }
  }
  return ops.reverse();
}

/**
 * Pair a run of missing words with the run of extra words next to it, so a
 * wrong word reads as one substitution instead of a deletion plus an addition.
 */
function mergeSubstitutions(
  ops: readonly AlignmentOp[],
  expectedTokens: readonly ComparableToken[],
  actualTokens: readonly ComparableToken[],
): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op.type === 'match') {
      segments.push({
        kind: 'correct',
        expected: expectedTokens[op.expectedIndex].raw,
        actual: actualTokens[op.actualIndex].raw,
      });
      index += 1;
      continue;
    }
    // Collect the whole run of missing and/or extra words.
    const missing: number[] = [];
    const extra: number[] = [];
    while (index < ops.length && ops[index].type !== 'match') {
      if (ops[index].type === 'missing') {
        missing.push(ops[index].expectedIndex);
      } else {
        extra.push(ops[index].actualIndex);
      }
      index += 1;
    }
    const paired = Math.min(missing.length, extra.length);
    for (let pair = 0; pair < paired; pair += 1) {
      segments.push({
        kind: 'substituted',
        expected: expectedTokens[missing[pair]].raw,
        actual: actualTokens[extra[pair]].raw,
      });
    }
    for (let rest = paired; rest < missing.length; rest += 1) {
      segments.push({kind: 'missing', expected: expectedTokens[missing[rest]].raw, actual: null});
    }
    for (let rest = paired; rest < extra.length; rest += 1) {
      segments.push({kind: 'extra', expected: null, actual: actualTokens[extra[rest]].raw});
    }
  }
  return segments;
}

/**
 * Align the learner's answer against the sentence. Every expected word appears
 * exactly once, as `correct`, `missing` or `substituted`; words the learner
 * added appear as `extra`.
 */
export function diffTokens(expected: string, actual: string): DiffSegment[] {
  const expectedTokens = tokenizeSentence(expected);
  const actualTokens = tokenizeSentence(actual);
  const ops = alignTokens(
    expectedTokens.map(token => token.normalized),
    actualTokens.map(token => token.normalized),
  );
  return mergeSubstitutions(ops, expectedTokens, actualTokens);
}

/**
 * The grade to pre-select for the learner: Good for a clean answer or a single
 * typo-sized word, Again otherwise. Never Easy.
 */
export function suggestGrade(expected: string, actual: string): ReviewGrade {
  if (normalizeSentenceText(expected) === normalizeSentenceText(actual)) {
    return 'good';
  }

  const expectedTokens = tokenizeForComparison(expected);
  const actualTokens = tokenizeForComparison(actual);
  if (expectedTokens.length !== actualTokens.length) {
    return 'again';
  }

  const mismatches: number[] = [];
  for (let index = 0; index < expectedTokens.length; index += 1) {
    if (expectedTokens[index] !== actualTokens[index]) {
      mismatches.push(index);
    }
  }
  if (
    mismatches.length === 1 &&
    levenshtein(expectedTokens[mismatches[0]], actualTokens[mismatches[0]]) === 1
  ) {
    return 'good';
  }
  return 'again';
}

/**
 * Turn the diff into tokens the card can render: plain text plus its kind, so
 * the screen owns the styling and no markup ever reaches stored content.
 */
export function diffDisplayTokens(segments: readonly DiffSegment[]): DisplayToken[] {
  return segments.map(segment => {
    if (segment.kind === 'missing') {
      return {kind: segment.kind, text: segment.expected ?? ''};
    }
    const token: DisplayToken = {kind: segment.kind, text: segment.actual ?? ''};
    if (segment.kind === 'substituted' && segment.expected) {
      token.expected = segment.expected;
    }
    return token;
  });
}

/** Counts per kind, for the one-line result summary on the card. */
export function summarizeDiff(segments: readonly DiffSegment[]): Record<DiffKind, number> {
  const summary: Record<DiffKind, number> = {
    correct: 0,
    missing: 0,
    extra: 0,
    substituted: 0,
  };
  for (const segment of segments) {
    summary[segment.kind] += 1;
  }
  return summary;
}

/** True when nothing is wrong with the answer. */
export function isExactAnswer(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeSentenceText(expected);
  return normalizedExpected.length > 0 && normalizedExpected === normalizeSentenceText(actual);
}