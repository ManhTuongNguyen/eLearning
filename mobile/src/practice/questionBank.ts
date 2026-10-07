/**
 * Question generator for the listening-practice trainer (no backend, no AI).
 *
 * The trainer's core problem is reflex, not knowledge: a learner hears
 * "nineteen ninety-seven" and needs seconds to map it to 1997 — by which
 * time a real conversation has moved on. So the question bank builds
 * hand-crafted, acoustically confusable answer sets (13 vs 30, 1997 vs
 * 9719, B/D/P/T…) and the screen speaks the `spoken` word form through the
 * app's normal TTS engine.
 *
 * Two hard guarantees drive the design:
 *  - Answers never repeat within a short window: callers hand back the
 *    recent answers (PRACTICE_RECENT_ANSWER_LIMIT) and the generator
 *    rejects anything already in that set.
 *  - Distractors are never random fillers. Every option comes from an
 *    ordered list of engineered near-misses (digit-pair swaps, teen↔tens
 *    transposition, off-by-one, adjacent hundred, same confusable letter
 *    family), with deterministic near-neighbors only as a bounded reserve.
 *
 * Pure and deterministic: every random choice is routed through an
 * injectable `random` function (Math.random by default) so tests can pin
 * the output with the exported mulberry32 PRNG. Nothing here touches the
 * engine, storage or React.
 */

/** Practice focus picked on the screen. */
export type PracticeMode = 'numbers' | 'letters' | 'mixed';

/** One generated question: what to speak and what to choose from. */
export interface PracticeQuestion {
  /** Kind of item, so the screen can label the reveal after an answer. */
  kind: 'number' | 'letter';
  /** Digits/letters shown as answer options (the ground truth). */
  answer: string;
  /** Word form handed to the TTS engine, e.g. "nineteen ninety-seven". */
  spoken: string;
  /** Four options, always containing `answer` exactly once. */
  options: string[];
}

/**
 * How many of the most recent answers stay excluded from new questions —
 * long enough that an item cannot come back while still fresh, short
 * enough that the rejection loop stays cheap.
 */
export const PRACTICE_RECENT_ANSWER_LIMIT = 8;

/** Options are shuffled with a seeded PRNG (mulberry32) in tests. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

/**
 * Reduces an ordered candidate list to exactly three distractors: skips
 * answers and duplicates, keeps the first (strongest) engineered options,
 * and tops up with deterministic near-neighbors — never randomness — if the
 * strong candidates collided. The near-neighbor reserve guarantees three
 * distractors for every input the generator can produce.
 */
function toDistractors(
  answer: number,
  candidates: readonly number[],
  bounds: {min: number; max: number},
): string[] {
  const picked: string[] = [];
  const push = (value: number): void => {
    if (
      picked.length < 3 &&
      value >= bounds.min &&
      value <= bounds.max &&
      value !== answer &&
      !picked.includes(String(value))
    ) {
      picked.push(String(value));
    }
  };
  for (const candidate of candidates) {
    push(candidate);
  }
  for (let distance = 1; picked.length < 3; distance += 1) {
    push(answer + distance);
    push(answer - distance);
  }
  return picked;
}

/* ------------------------------------------------------------------ *
 * Numbers
 * ------------------------------------------------------------------ */

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;

const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;

/** Native TTS reading of 1–99 ("forty-two", not "four two"). */
function spokenUnder100(n: number): string {
  if (n < 20) {
    return ONES[n];
  }
  const tens = TENS[Math.floor(n / 10)];
  const ones = n % 10;
  return ones === 0 ? tens : `${tens}-${ONES[ones]}`;
}

/** Reads any non-negative integer below one million the way people say it. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`numberToWords expects a non-negative integer, got ${n}`);
  }
  if (n < 100) {
    return spokenUnder100(n);
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    return rest === 0
      ? `${ONES[hundreds]} hundred`
      : `${ONES[hundreds]} hundred and ${spokenUnder100(rest)}`;
  }
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head =
    thousands < 100 ? spokenUnder100(thousands) : numberToWords(thousands);
  return rest === 0
    ? `${head} thousand`
    : `${head} thousand ${numberToWords(rest)}`;
}

/** Confusable pairs the trainer is meant to drill. */
const TEEN_NUMBERS = [13, 14, 15, 16, 17, 18, 19] as const;
const TENS_NUMBERS = [30, 40, 50, 60, 70, 80, 90] as const;
/** Years spoken as two digit pairs ("nineteen ninety-seven"). */
const YEAR_MIN = 1100;
const YEAR_MAX = 2099;

/**
 * Reads a calendar year the way people actually say it — the exact case
 * the trainer exists for:
 *  - 1997 → "nineteen ninety-seven" (two spoken digit pairs)
 *  - 1900 → "nineteen hundred", 2000 → "two thousand"
 *  - 2005 → "two thousand five", 2015 → "twenty fifteen"
 *
 * Single-digit endings keep the spoken "oh" (1608 → "sixteen oh eight"):
 * dropping it to "sixteen eight" is ambiguous — it can be heard as 168 —
 * and no native speaker reads the year that way.
 */
export function yearToWords(year: number): string {
  const first = Math.floor(year / 100);
  const last = year % 100;
  if (year >= 2000) {
    if (last === 0) {
      // In range (1100–2099) this is exactly 2000: "two thousand".
      return `${ONES[Math.floor(first / 10)]} thousand`;
    }
    if (last < 10) {
      return `two thousand ${ONES[last]}`; // 2005: "two thousand five"
    }
    return `${spokenUnder100(first)} ${spokenUnder100(last)}`; // 2015
  }
  const head = numberToWords(first);
  if (last === 0) {
    return `${head} hundred`; // 1900: "nineteen hundred"
  }
  if (last < 10) {
    // 1608: "sixteen oh eight" — never "sixteen eight" (heard as 168).
    return `${head} oh ${ONES[last]}`;
  }
  return `${head} ${spokenUnder100(last)}`; // 1997: "nineteen ninety-seven"
}

/**
 * Engineered year distractors, strongest first: swapped digit pairs
 * (1997 → 9719), off-by-one on the last pair (1998, 1996), a shifted
 * century (1897), and adjacent years as reserve. 2000-style years fall
 * through the pair swap to the pair-shift candidates.
 */
export function yearDistractors(year: number): string[] {
  const first = Math.floor(year / 100);
  const last = year % 100;
  const candidates: number[] = [];
  const pairSwap = Number(`${last}${first}`); // 1997 → 9719
  if (pairSwap >= 1000) {
    candidates.push(pairSwap);
  }
  candidates.push(year + 1, year - 1);
  candidates.push((first + 1) * 100 + last); // 19xx → 20xx
  if (first - 1 >= 10) {
    candidates.push((first - 1) * 100 + last); // 1997 → 1897
  }
  candidates.push(year + 100, year - 100);
  return toDistractors(year, candidates, {min: 1000, max: 9999});
}

/**
 * Engineered number distractors per magnitude:
 *  - teens (13–19): transposed to the round ten (13 → 30, the classic)
 *    plus near neighbors,
 *  - round tens (20–90): the reverse transposition (30 → 13) and doubled
 *    ending (30 → 33),
 *  - two digits: digit swap (23 → 32) and ±10,
 *  - three digits: last-two digit swap (132 → 123) and ±100,
 *  - four digits: pair swap (1997 → 9719) and ±100.
 */
export function numberDistractors(answer: number): string[] {
  const digits = String(answer);
  const candidates: number[] = [];
  if (answer >= 13 && answer <= 19) {
    candidates.push((answer - 10) * 10); // 13 → 30
    candidates.push(answer + 10, answer + 2);
  } else if (answer >= 20 && answer <= 90 && answer % 10 === 0) {
    candidates.push(answer / 10 + 10); // 30 → 13
    candidates.push(answer + answer / 10); // 30 → 33
    candidates.push(answer + 10);
  } else if (answer < 100) {
    const swap = Number(digits[1] + digits[0]); // 23 → 32
    candidates.push(swap >= 10 ? swap : answer + 1);
    candidates.push(answer + 10);
    candidates.push(answer - 10 >= 10 ? answer - 10 : answer + 20);
  } else if (answer < 1000) {
    const lastTwoSwap = Number(digits[0] + digits[2] + digits[1]); // 132 → 123
    if (lastTwoSwap >= 100) {
      candidates.push(lastTwoSwap);
    }
    candidates.push(answer + 1, answer - 1);
    candidates.push(answer + 100);
    candidates.push(answer - 100 >= 100 ? answer - 100 : answer + 200);
  } else {
    const pairSwap = Number(digits.slice(2) + digits.slice(0, 2)); // 1997 → 9719
    if (pairSwap >= 1000) {
      candidates.push(pairSwap);
    }
    candidates.push(answer + 1, answer - 1);
    candidates.push(answer + 100);
    candidates.push(answer - 100 >= 1000 ? answer - 100 : answer + 100);
    candidates.push(answer + 1000, answer - 1000);
  }
  return toDistractors(answer, candidates, {min: 1, max: 99999});
}

/** Builds one number question; `yearChance` biases toward pair-read years. */
function buildNumberQuestion(
  random: () => number,
  yearChance: number,
): PracticeQuestion {
  if (random() < yearChance) {
    const year = YEAR_MIN + Math.floor(random() * (YEAR_MAX - YEAR_MIN + 1));
    return {
      kind: 'number',
      answer: String(year),
      spoken: yearToWords(year),
      options: shuffled([String(year), ...yearDistractors(year)], random),
    };
  }
  const roll = random();
  let answer: number;
  if (roll < 0.45) {
    // Teens vs tens: 13/30, 15/50, 17/70…
    answer =
      random() < 0.5 ? pick(TEEN_NUMBERS, random) : pick(TENS_NUMBERS, random);
  } else if (roll < 0.75) {
    answer = 10 + Math.floor(random() * 90); // 10–99
  } else if (roll < 0.9) {
    answer = 100 + Math.floor(random() * 900); // 100–999
  } else {
    answer = 1000 + Math.floor(random() * 9000); // 1000–9999
  }
  return {
    kind: 'number',
    answer: String(answer),
    spoken: numberToWords(answer),
    options: shuffled([String(answer), ...numberDistractors(answer)], random),
  };
}

/* ------------------------------------------------------------------ *
 * Letters
 * ------------------------------------------------------------------ */

/**
 * Groups of letters that sound alike and are classically confused. Every
 * group holds at least four letters, so all four options of a letter
 * question always come from one confusable family — no filler letters.
 */
export const CONFUSABLE_LETTER_GROUPS = [
  ['B', 'D', 'P', 'T', 'E', 'G', 'V'],
  ['C', 'Z', 'S', 'X'],
  ['A', 'J', 'K', 'H'],
  ['F', 'M', 'N', 'S'],
  ['I', 'Y', 'R', 'E'],
  ['Q', 'U', 'O', 'C'],
  ['G', 'J', 'D', 'P'],
  ['M', 'W', 'N', 'F'],
] as const;

function buildLetterQuestion(random: () => number): PracticeQuestion {
  const group = pick(CONFUSABLE_LETTER_GROUPS, random);
  const answer = pick(group, random);
  const distractors = shuffled(
    group.filter(letter => letter !== answer),
    random,
  ).slice(0, 3);
  return {
    kind: 'letter',
    answer,
    spoken: answer.toLowerCase(),
    options: shuffled([answer, ...distractors], random),
  };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Builds one fresh question for the given practice mode. `recentAnswers`
 * (the caller's sliding window of recent answers) are rejected so the same
 * item never comes up twice in a row; after a bounded number of attempts
 * the first generated question is kept — the answer pools are large enough
 * that a rejection streak of that length is practically impossible.
 */
export function createPracticeQuestion(
  mode: PracticeMode,
  random: () => number = Math.random,
  recentAnswers: readonly string[] = [],
): PracticeQuestion {
  const recent = new Set(
    recentAnswers.slice(-PRACTICE_RECENT_ANSWER_LIMIT),
  );
  const kind =
    mode === 'numbers'
      ? 'number'
      : mode === 'letters'
        ? 'letter'
        : random() < 0.5
          ? 'number'
          : 'letter';
  const build = (): PracticeQuestion =>
    kind === 'number'
      ? buildNumberQuestion(random, 0.5)
      : buildLetterQuestion(random);
  const first = build();
  if (!recent.has(first.answer)) {
    return first;
  }
  const MAX_ATTEMPTS = 12;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = build();
    if (!recent.has(candidate.answer)) {
      return candidate;
    }
  }
  return first;
}
