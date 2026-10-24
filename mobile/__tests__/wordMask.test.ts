/**
 * Word masking tests (WORD_BANK_V1 TASK-WB-005).
 *
 * These pin the recall-card contract: only the target word and its documented
 * inflections are masked, only at word boundaries, and the masked rendering is
 * exactly the first letter + underscores of the matched surface form with
 * capitalisation and punctuation preserved.
 */
import { displayMaskedText, maskWordInText } from '../src/srs/wordMask';

/** Join helper: what the screen renders. */
function render(text: string, word: string): string {
  return displayMaskedText(maskWordInText(text, word));
}

describe('maskWordInText', () => {
  test('masks an exact case-insensitive match', () => {
    expect(maskWordInText('I went to the bank.', 'bank')).toEqual([
      { kind: 'plain', text: 'I went to the ' },
      { kind: 'masked', text: 'b___' },
      { kind: 'plain', text: '.' },
    ]);
    expect(render('I went to the BANK.', 'bank')).toBe('I went to the B___.');
  });

  test('masks the -s, -es, -ed, -d and -ing inflections', () => {
    expect(render('The banks closed.', 'bank')).toBe('The b____ closed.');
    expect(render('Go banked funds.', 'bank')).toBe('Go b_____ funds.');
    expect(render('He banked on it.', 'bank')).toBe('He b_____ on it.');
    expect(render('It matches nothing.', 'match')).toBe('It m______ nothing.');
    expect(render('He matched it.', 'match')).toBe('He m______ it.');
    expect(render('She is banking on you.', 'bank')).toBe('She is b______ on you.');
  });

  test('masks the doubled final consonant inflections', () => {
    expect(render('They planned it.', 'plan')).toBe('They p______ it.');
    expect(render('He is planning.', 'plan')).toBe('He is p_______.');
    expect(render('Keep running.', 'run')).toBe('Keep r______.');
  });

  test('masks the -ies and -ied inflections of y-final stems', () => {
    expect(render('She carries the box.', 'carry')).toBe('She c______ the box.');
    expect(render('He carried it.', 'carry')).toBe('He c______ it.');
  });

  test('preserves capitalization of the matched surface form', () => {
    expect(render('Bank the money.', 'bank')).toBe('B___ the money.');
    expect(render('Banks opened.', 'bank')).toBe('B____ opened.');
  });

  test('preserves surrounding punctuation outside the mask', () => {
    expect(render('Bank, and bank.', 'bank')).toBe('B___, and b___.');
    expect(render('(bank)', 'bank')).toBe('(b___)');
    expect(render("the bank's vault", 'bank')).toBe("the b___'s vault");
  });

  test('never masks a substring of another word', () => {
    expect(render('The category is empty.', 'cat')).toBe('The category is empty.');
    expect(render('Handing over.', 'and')).toBe('Handing over.');
  });

  test('text with no occurrence returns one plain segment', () => {
    expect(maskWordInText('Nothing to see.', 'bank')).toEqual([
      { kind: 'plain', text: 'Nothing to see.' },
    ]);
    expect(maskWordInText('', 'bank')).toEqual([{ kind: 'plain', text: '' }]);
  });

  test('multiple occurrences are each masked', () => {
    expect(render('Bank the money at the bank.', 'bank')).toBe('B___ the money at the b___.');
    expect(render('banks and banking', 'bank')).toBe('b____ and b______');
  });

  test('an empty target word masks nothing', () => {
    expect(maskWordInText('Some text.', '  ')).toEqual([{ kind: 'plain', text: 'Some text.' }]);
  });
});

describe('displayMaskedText', () => {
  test('joins segments in order', () => {
    expect(
      displayMaskedText([
        { kind: 'plain', text: 'Go to the ' },
        { kind: 'masked', text: 'b___' },
        { kind: 'plain', text: '.' },
      ]),
    ).toBe('Go to the b___.');
  });

  test('renders exactly the first letter plus underscores of the surface form', () => {
    // 'banks' has 5 letters → 1 + 4 underscores; 'planned' 7 → 1 + 6.
    expect(render('banks planned', 'bank')).toBe('b____ planned');
    expect(render('planned', 'plan')).toBe('p______');
  });
});
