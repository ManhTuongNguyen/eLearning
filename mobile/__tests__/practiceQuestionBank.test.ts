/**
 * Question-bank tests: the generator must be pure (same seed → same
 * questions), always place the answer among exactly four unique options,
 * produce native word forms for numbers and years, keep every distractor
 * engineered (a digit/pair permutation or a near neighbor — never a random
 * filler), keep letter options inside one confusable family, and never
 * repeat an answer within the recent-answer window.
 */
import {
  CONFUSABLE_LETTER_GROUPS,
  createPracticeQuestion,
  mulberry32,
  numberDistractors,
  numberToWords,
  PRACTICE_RECENT_ANSWER_LIMIT,
  yearDistractors,
  yearToWords,
  type PracticeMode,
  type PracticeQuestion,
} from '../src/practice/questionBank';

/** Same digits, any order ("1997" ↔ "9719"). */
function sameDigits(a: string, b: string): boolean {
  return [...a].sort().join('') === [...b].sort().join('');
}

/** Every distractor must be one of these deliberate near-misses. */
function isEngineeredDistractor(answer: string, distractor: string): boolean {
  const value = Number(distractor);
  const base = Number(answer);
  if (sameDigits(answer, distractor)) {
    return true; // digit-pair swap: 1997 ↔ 9719
  }
  const distance = Math.abs(value - base);
  return distance <= 110 || distance === 1000; // near neighbor / pair shift
}

describe('numberToWords', () => {
  it('reads teens, tens and hyphenated compounds natively', () => {
    expect(numberToWords(13)).toBe('thirteen');
    expect(numberToWords(30)).toBe('thirty');
    expect(numberToWords(42)).toBe('forty-two');
    expect(numberToWords(90)).toBe('ninety');
  });

  it('reads hundreds and thousands the way people say them', () => {
    expect(numberToWords(305)).toBe('three hundred and five');
    expect(numberToWords(1000)).toBe('one thousand');
    expect(numberToWords(1997)).toBe(
      'one thousand nine hundred and ninety-seven',
    );
  });
});

describe('yearToWords', () => {
  it('reads years as spoken digit pairs — the case the trainer exists for', () => {
    expect(yearToWords(1997)).toBe('nineteen ninety-seven');
    expect(yearToWords(2015)).toBe('twenty fifteen');
  });

  it('reads round and early-2000s years natively', () => {
    expect(yearToWords(1900)).toBe('nineteen hundred');
    expect(yearToWords(2000)).toBe('two thousand');
    expect(yearToWords(2005)).toBe('two thousand five');
  });

  it('keeps single-digit endings unambiguous with the spoken "oh"', () => {
    // "sixteen eight" could be heard as 168; nobody says the year that way.
    expect(yearToWords(1608)).toBe('sixteen oh eight');
    expect(yearToWords(1105)).toBe('eleven oh five');
    expect(yearToWords(1909)).toBe('nineteen oh nine');
  });
});

describe('createPracticeQuestion invariants', () => {
  const modes: PracticeMode[] = ['numbers', 'letters', 'mixed'];

  it('always shows four unique options containing the answer exactly once', () => {
    const random = mulberry32(42);
    for (let i = 0; i < 300; i += 1) {
      const mode = modes[i % modes.length];
      const question = createPracticeQuestion(mode, random);
      expect(new Set(question.options).size).toBe(4);
      expect(question.options).toContain(question.answer);
      expect(question.options.filter(o => o === question.answer)).toHaveLength(
        1,
      );
    }
  });

  it('never repeats an answer within the recent-answer window', () => {
    const random = mulberry32(7);
    const recent: string[] = [];
    const answers: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const mode = modes[i % modes.length];
      const question = createPracticeQuestion(mode, random, recent);
      answers.push(question.answer);
      recent.push(question.answer);
      if (recent.length > PRACTICE_RECENT_ANSWER_LIMIT) {
        recent.shift();
      }
    }
    // Any LIMIT+1 consecutive answers must be distinct.
    for (
      let i = 0;
      i + PRACTICE_RECENT_ANSWER_LIMIT < answers.length;
      i += 1
    ) {
      const window = answers.slice(i, i + PRACTICE_RECENT_ANSWER_LIMIT + 1);
      expect(new Set(window).size).toBe(window.length);
    }
  });

  it('keeps handed-in recent answers out of the following questions', () => {
    const random = mulberry32(99);
    // Build a realistic recent window first.
    const recent: string[] = [];
    for (let i = 0; i < PRACTICE_RECENT_ANSWER_LIMIT; i += 1) {
      recent.push(createPracticeQuestion('mixed', random, recent).answer);
    }
    // While that window is still fresh, none of its answers may come back.
    for (let i = 0; i < PRACTICE_RECENT_ANSWER_LIMIT; i += 1) {
      const question = createPracticeQuestion('mixed', random, recent);
      expect(recent).not.toContain(question.answer);
      recent.push(question.answer);
      if (recent.length > PRACTICE_RECENT_ANSWER_LIMIT) {
        recent.shift();
      }
    }
  });

  it('produces plenty of distinct answers instead of a dominant few', () => {
    const random = mulberry32(1234);
    const answers = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const mode = modes[i % modes.length];
      answers.add(createPracticeQuestion(mode, random).answer);
    }
    expect(answers.size).toBeGreaterThan(80);
  });

  it('keeps every number distractor engineered, never random', () => {
    const random = mulberry32(5);
    for (let i = 0; i < 300; i += 1) {
      const question = createPracticeQuestion('numbers', random);
      const distractors = question.options.filter(
        option => option !== question.answer,
      );
      expect(distractors).toHaveLength(3);
      for (const distractor of distractors) {
        expect(isEngineeredDistractor(question.answer, distractor)).toBe(true);
      }
    }
  });

  it('builds the classic confusions deliberately', () => {
    // 13 ↔ 30: the teen/tens transposition in both directions.
    expect(numberDistractors(13)).toContain('30');
    expect(numberDistractors(30)).toContain('13');
    // Digit swap inside the number: 132 ↔ 123.
    expect(numberDistractors(132)).toContain('123');
    // Digit-pair swap on a 4-digit number: 1997 ↔ 9719.
    expect(numberDistractors(1997)).toContain('9719');
  });

  it('keeps year distractors to plausible near-miss years', () => {
    const distractors = yearDistractors(1997);
    expect(distractors).toHaveLength(3);
    for (const distractor of distractors) {
      expect(distractor).toMatch(/^\d{4}$/);
      expect(distractor).not.toBe('1997');
      expect(isEngineeredDistractor('1997', distractor)).toBe(true);
    }
  });

  it('keeps letter options inside one confusable family', () => {
    const random = mulberry32(21);
    for (let i = 0; i < 200; i += 1) {
      const question = createPracticeQuestion('letters', random);
      expect(question.kind).toBe('letter');
      expect(question.spoken).toBe(question.answer.toLowerCase());
      const family = CONFUSABLE_LETTER_GROUPS.find(group =>
        question.options.every(option =>
          (group as readonly string[]).includes(option),
        ),
      );
      expect(family).toBeDefined();
    }
  });

  it('generates both kinds in mixed mode', () => {
    const random = mulberry32(77);
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      kinds.add(createPracticeQuestion('mixed', random).kind);
    }
    expect(kinds.has('number')).toBe(true);
    expect(kinds.has('letter')).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    const run = (): PracticeQuestion[] => {
      const random = mulberry32(2026);
      return Array.from({length: 50}, () =>
        createPracticeQuestion('mixed', random),
      );
    };
    expect(run()).toEqual(run());
  });
});
