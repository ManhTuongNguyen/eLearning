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
 * - The alignment key is contraction-aware: each word is expanded the same way
 *   (`weather's` and `weather is` both compare as `weather is`) while still
 *   pointing back at the surface token the learner typed or read. That keeps
 *   equivalent answers from showing a false word-level correction.
 *
 * Grading is deliberately conservative: a clean answer or a single typo is
 * suggested as Good, everything else as Again. Easy is never suggested — it
 * stays an explicit learner choice.
 */
import type { ReviewGrade } from '../db/types';
import type { FollowingWord } from './normalize';
import { expandTokenForComparison, normalizeSentenceText } from './normalize';

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

/**
 * One spoken word after contraction expansion, still pointing at the surface
 * token it came from. `weather's` produces two of these (weather + is) that
 * both carry the same `tokenIndex`, which lets the renderer collapse the
 * expansion back into one displayed token.
 */
interface ExpandedToken extends ComparableToken {
  tokenIndex: number;
}

/** A diff segment with the surface-token indices used for coalescing. */
interface IndexedDiffSegment extends DiffSegment {
  expectedTokenIndex: number;
  actualTokenIndex: number;
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

/** A surface token plus whether punctuation followed it in the source text. */
interface SurfaceToken extends ComparableToken {
  followedByPunctuation: boolean;
}

/** Split a sentence into tokens while remembering clause punctuation. */
function tokenizeSurfaceSentence(text: string): SurfaceToken[] {
  const pattern = new RegExp(WORD_PATTERN.source, 'g');
  const tokens: SurfaceToken[] = [];
  let previousEnd = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (tokens.length > 0) {
      const gap = text.slice(previousEnd, match.index);
      tokens[tokens.length - 1].followedByPunctuation = /\S/.test(gap);
    }
    const raw = match[0];
    tokens.push({
      raw,
      normalized: raw.toLowerCase().replace(/[\u2018\u2019]/g, "'"),
      followedByPunctuation: false,
    });
    previousEnd = pattern.lastIndex;
    match = pattern.exec(text);
  }
  return tokens;
}

/** Split a sentence into display words with their comparison form. */
export function tokenizeSentence(text: string): ComparableToken[] {
  return tokenizeSurfaceSentence(text).map(({ raw, normalized }) => ({
    raw,
    normalized,
  }));
}

/** The comparison tokens of a sentence, in order. */
export function tokenizeForComparison(text: string): string[] {
  return tokenizeSentence(text).map(token => token.normalized);
}

/**
 * Expand every surface token into the words used for comparison. Contractions
 * become multiple words, but each expanded word keeps the index of the token it
 * came from so the renderer can collapse it back to one displayed word.
 */
function expandTokens(tokens: readonly SurfaceToken[]): ExpandedToken[] {
  const expanded: ExpandedToken[] = [];
  tokens.forEach((token, tokenIndex) => {
    const followingWords: FollowingWord[] = [];
    for (
      let offset = tokenIndex + 1;
      offset < tokens.length && followingWords.length < 8;
      offset += 1
    ) {
      followingWords.push({
        word: tokens[offset].normalized,
        precededByPunctuation: tokens[offset - 1].followedByPunctuation,
      });
    }
    const expandedText = expandTokenForComparison(token.normalized, followingWords);
    const expandedWords = expandedText.split(' ').filter(Boolean);
    const words = expandedWords.length > 0 ? expandedWords : [token.normalized];
    for (const word of words) {
      expanded.push({ raw: token.raw, normalized: word, tokenIndex });
    }
  });
  return expanded;
}

/** Contraction-expanded comparison words for grading and typo detection. */
function comparisonWords(text: string): string[] {
  return expandTokens(tokenizeSurfaceSentence(text)).map(token => token.normalized);
}

/** Levenshtein distance, used only to recognise a single-token typo. */
export function levenshtein(first: string, second: string): number {
  if (first === second) {
    return 0;
  }
  const rows = first.length + 1;
  const columns = second.length + 1;
  let previous = Array.from({ length: columns }, (_, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = new Array<number>(columns);
    current[0] = row;
    for (let column = 1; column < columns; column += 1) {
      const substitution = previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[columns - 1];
}

type AlignmentOp = {
  type: 'match' | 'missing' | 'extra';
  expectedIndex: number;
  actualIndex: number;
};

/** Longest-common-subsequence alignment of two token lists. */
function alignTokens(expected: readonly string[], actual: readonly string[]): AlignmentOp[] {
  const rows = expected.length + 1;
  const columns = actual.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));

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
      ops.push({ type: 'match', expectedIndex: row - 1, actualIndex: column - 1 });
      row -= 1;
      column -= 1;
    } else if (column > 0 && (row === 0 || table[row][column - 1] >= table[row - 1][column])) {
      ops.push({ type: 'extra', expectedIndex: -1, actualIndex: column - 1 });
      column -= 1;
    } else {
      ops.push({ type: 'missing', expectedIndex: row - 1, actualIndex: -1 });
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
  expectedTokens: readonly ExpandedToken[],
  actualTokens: readonly ExpandedToken[],
): IndexedDiffSegment[] {
  const segments: IndexedDiffSegment[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op.type === 'match') {
      const expected = expectedTokens[op.expectedIndex];
      const actual = actualTokens[op.actualIndex];
      segments.push({
        kind: 'correct',
        expected: expected.raw,
        actual: actual.raw,
        expectedTokenIndex: expected.tokenIndex,
        actualTokenIndex: actual.tokenIndex,
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
      const expected = expectedTokens[missing[pair]];
      const actual = actualTokens[extra[pair]];
      segments.push({
        kind: 'substituted',
        expected: expected.raw,
        actual: actual.raw,
        expectedTokenIndex: expected.tokenIndex,
        actualTokenIndex: actual.tokenIndex,
      });
    }
    for (let rest = paired; rest < missing.length; rest += 1) {
      const expected = expectedTokens[missing[rest]];
      segments.push({
        kind: 'missing',
        expected: expected.raw,
        actual: null,
        expectedTokenIndex: expected.tokenIndex,
        actualTokenIndex: -1,
      });
    }
    for (let rest = paired; rest < extra.length; rest += 1) {
      const actual = actualTokens[extra[rest]];
      segments.push({
        kind: 'extra',
        expected: null,
        actual: actual.raw,
        expectedTokenIndex: -1,
        actualTokenIndex: actual.tokenIndex,
      });
    }
  }
  return segments;
}

/**
 * Collapse the words of an expanded contraction back into one visible token.
 * Adjacent correct words merge only when they came from the same surface token
 * on either side, so genuinely repeated words ("very very") stay separate.
 */
function coalesceCorrectSegments(segments: readonly IndexedDiffSegment[]): DiffSegment[] {
  const result: DiffSegment[] = [];
  let group: {
    expected: string;
    expectedTokenIndexes: Set<number>;
    actualParts: Array<{ index: number; text: string }>;
  } | null = null;

  const flush = () => {
    if (!group) {
      return;
    }
    result.push({
      kind: 'correct',
      expected: group.expected,
      actual: group.actualParts.map(part => part.text).join(' '),
    });
    group = null;
  };

  for (const segment of segments) {
    if (segment.kind !== 'correct') {
      flush();
      result.push({
        kind: segment.kind,
        expected: segment.expected,
        actual: segment.actual,
      });
      continue;
    }

    const actualText = segment.actual ?? '';
    const sharesSurfaceToken =
      group !== null &&
      (group.expectedTokenIndexes.has(segment.expectedTokenIndex) ||
        group.actualParts.some(part => part.index === segment.actualTokenIndex));

    if (group !== null && sharesSurfaceToken) {
      group.expectedTokenIndexes.add(segment.expectedTokenIndex);
      if (!group.actualParts.some(part => part.index === segment.actualTokenIndex)) {
        group.actualParts.push({ index: segment.actualTokenIndex, text: actualText });
      }
      continue;
    }

    flush();
    group = {
      expected: segment.expected ?? '',
      expectedTokenIndexes: new Set([segment.expectedTokenIndex]),
      actualParts: [{ index: segment.actualTokenIndex, text: actualText }],
    };
  }
  flush();
  return result;
}

/**
 * Align the learner's answer against the sentence. Every expected word appears
 * exactly once, as `correct`, `missing` or `substituted`; words the learner
 * added appear as `extra`.
 */
export function diffTokens(expected: string, actual: string): DiffSegment[] {
  const expectedTokens = expandTokens(tokenizeSurfaceSentence(expected));
  const actualTokens = expandTokens(tokenizeSurfaceSentence(actual));
  const ops = alignTokens(
    expectedTokens.map(token => token.normalized),
    actualTokens.map(token => token.normalized),
  );
  return coalesceCorrectSegments(mergeSubstitutions(ops, expectedTokens, actualTokens));
}

/**
 * The grade to pre-select for the learner: Good for a clean answer or a single
 * typo-sized word, Again otherwise. Never Easy.
 */
export function suggestGrade(expected: string, actual: string): ReviewGrade {
  if (normalizeSentenceText(expected) === normalizeSentenceText(actual)) {
    return 'good';
  }

  const expectedTokens = comparisonWords(expected);
  const actualTokens = comparisonWords(actual);
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
      return { kind: segment.kind, text: segment.expected ?? '' };
    }
    const token: DisplayToken = { kind: segment.kind, text: segment.actual ?? '' };
    if (segment.kind === 'substituted' && segment.expected) {
      token.expected = segment.expected;
    }
    return token;
  });
}

// --- Character-level diff (word bank practice) -------------------------------

/** How one character (or run of characters) of the answer relates to the word. */
export type CharDiffKind = 'correct' | 'missing' | 'extra';

/**
 * One run of characters: `correct` matches the word, `missing` characters are
 * in the word but were not typed (rendered from the word, underlined), and
 * `extra` characters were typed but do not belong (rendered struck-through).
 */
export interface CharDiffSegment {
  kind: CharDiffKind;
  /** The characters to render — from the word for correct/missing, typed for extra. */
  text: string;
}

/**
 * Align the typed answer against the word character by character (Levenshtein
 * backtrace, case-insensitive, both sides trimmed). A wrong letter renders as
 * the typed character struck through immediately followed by the expected
 * character underlined — the inline equivalent of the word diff's
 * `typed → expected`. Adjacent same-kind operations coalesce into runs, so an
 * exact answer is a single `correct` segment and a missing "ca" is one
 * `missing` run, not two.
 */
export function diffCharacters(expected: string, actual: string): CharDiffSegment[] {
  const expectedChars = [...expected.trim().toLowerCase()];
  const actualChars = [...actual.trim().toLowerCase()];

  // table[row][column] = edit distance between the first `row` expected and
  // the first `column` actual characters.
  const rows = expectedChars.length + 1;
  const columns = actualChars.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
  for (let row = 1; row < rows; row += 1) {
    table[row][0] = row;
  }
  for (let column = 1; column < columns; column += 1) {
    table[0][column] = column;
  }
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution =
        table[row - 1][column - 1] + (expectedChars[row - 1] === actualChars[column - 1] ? 0 : 1);
      table[row][column] = Math.min(
        table[row - 1][column] + 1,
        table[row][column - 1] + 1,
        substitution,
      );
    }
  }

  // Walk the cheapest path backwards, emitting the ops in reverse. A
  // substitution pushes missing-then-extra so the reversed (reading) order is
  // the typed character followed by its correction.
  const reversed: CharDiffSegment[] = [];
  let row = expectedChars.length;
  let column = actualChars.length;
  while (row > 0 || column > 0) {
    if (row > 0 && column > 0 && expectedChars[row - 1] === actualChars[column - 1]) {
      reversed.push({ kind: 'correct', text: expectedChars[row - 1] });
      row -= 1;
      column -= 1;
    } else if (row > 0 && column > 0 && table[row][column] === table[row - 1][column - 1] + 1) {
      reversed.push({ kind: 'missing', text: expectedChars[row - 1] });
      reversed.push({ kind: 'extra', text: actualChars[column - 1] });
      row -= 1;
      column -= 1;
    } else if (row > 0 && table[row][column] === table[row - 1][column] + 1) {
      reversed.push({ kind: 'missing', text: expectedChars[row - 1] });
      row -= 1;
    } else {
      reversed.push({ kind: 'extra', text: actualChars[column - 1] });
      column -= 1;
    }
  }

  const segments: CharDiffSegment[] = [];
  for (const op of reversed.reverse()) {
    const last = segments[segments.length - 1];
    if (last && last.kind === op.kind) {
      last.text += op.text;
    } else {
      segments.push({ ...op });
    }
  }
  return segments;
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
