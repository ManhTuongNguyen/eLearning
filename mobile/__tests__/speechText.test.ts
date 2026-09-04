/**
 * Speech-text sanitizer tests (SPEC TASK-078 follow-up): the spoken form
 * of a chat message keeps the meaningful words and drops everything that
 * is decoration for the TTS engine — inline markdown delimiters, heading /
 * blockquote / bullet prefixes, emoji and other pictographic icons, and
 * the leftover whitespace such removal produces.
 */
import { toSpeechText } from '../src/tts/speechText';

describe('toSpeechText', () => {
  it('leaves plain prose untouched', () => {
    expect(toSpeechText('Nice! What did you buy?')).toBe('Nice! What did you buy?');
    expect(toSpeechText('I went to the store yesterday.')).toBe(
      'I went to the store yesterday.',
    );
  });

  it('strips markdown emphasis delimiters while keeping the words', () => {
    expect(toSpeechText('**Great** *progress*!')).toBe('Great progress!');
    expect(toSpeechText("***wow*** was ~~wrong~~")).toBe('wow was wrong');
  });

  it('keeps inline code content and drops the backticks', () => {
    expect(toSpeechText('run `npm install` now')).toBe('run npm install now');
  });

  it('removes emoji and pictographic icons', () => {
    expect(toSpeechText('Well done! 🎉👍🏻 Next → ⏹ step')).toBe('Well done! Next step');
    expect(toSpeechText('⭐ ✅ ★ ❌')).toBe('');
  });

  it('removes composite emoji built from joiners', () => {
    expect(toSpeechText('family 👨‍👩‍👧 time')).toBe('family time');
    expect(toSpeechText('key 1️⃣ done')).toBe('key 1 done');
  });

  it('drops structural line prefixes (headings, quotes, bullets)', () => {
    expect(toSpeechText('# Title\n> quoted\n- item\n* bullet')).toBe(
      'Title quoted item bullet',
    );
  });

  it('keeps intraword punctuation meaningful', () => {
    expect(toSpeechText('a well-known 1990-2000 fact')).toBe('a well-known 1990-2000 fact');
    expect(toSpeechText('read snake_case_name here')).toBe('read snake case name here');
  });

  it('collapses the whitespace left behind', () => {
    expect(toSpeechText('Great  🎉  job **now** ')).toBe('Great job now');
    expect(toSpeechText('Hello **world**.')).toBe('Hello world.');
  });

  it('returns an empty string when nothing speakable remains', () => {
    expect(toSpeechText('🎉👍')).toBe('');
    expect(toSpeechText('😊')).toBe('');
    expect(toSpeechText('   ')).toBe('');
    expect(toSpeechText('')).toBe('');
  });
});
