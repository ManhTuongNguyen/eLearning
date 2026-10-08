/**
 * Pure karaoke-scroll helper tests: the offset advances with speed × dt,
 * clamps to the scrollable range, marks the end reached, and the elapsed
 * timer formats as MM:SS.
 */
import {
  countWords,
  formatElapsed,
  scrollDurationMs,
  stepOffset,
} from '../src/practice/karaokeScroll';

describe('stepOffset', () => {
  it('advances the offset by speed × elapsed time', () => {
    expect(stepOffset(0, 30, 1000, 1000)).toEqual({offset: 30, done: false});
    // Sub-tick deltas accumulate fractionally.
    expect(stepOffset(0, 30, 50, 1000).offset).toBeCloseTo(1.5);
  });

  it('clamps at the scrollable range and reports done', () => {
    expect(stepOffset(999, 30, 100, 1000)).toEqual({offset: 1000, done: true});
    expect(stepOffset(1000, 30, 100, 1000)).toEqual({offset: 1000, done: true});
  });

  it('never moves at zero speed and never completes from a zero tick', () => {
    expect(stepOffset(0, 0, 100, 1000)).toEqual({offset: 0, done: false});
    expect(stepOffset(0, 30, 0, 1000)).toEqual({offset: 0, done: false});
  });

  it('treats a text that fits the viewport as never done', () => {
    expect(stepOffset(0, 30, 60_000, 0)).toEqual({offset: 0, done: false});
  });
});

describe('scrollDurationMs', () => {
  it('scales inversely with speed', () => {
    expect(scrollDurationMs(300, 30)).toBe(10_000);
    expect(scrollDurationMs(300, 150)).toBe(2_000);
  });

  it('is zero without scrollable content or speed', () => {
    expect(scrollDurationMs(0, 30)).toBe(0);
    expect(scrollDurationMs(300, 0)).toBe(0);
  });
});

describe('formatElapsed', () => {
  it('formats minutes and seconds as MM:SS', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(59_000)).toBe('00:59');
    expect(formatElapsed(60_000)).toBe('01:00');
    expect(formatElapsed(3_600_000)).toBe('60:00');
  });

  it('clamps negative durations to zero', () => {
    expect(formatElapsed(-1)).toBe('00:00');
  });
});

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('  spaced \n out  ')).toBe(2);
    expect(countWords('')).toBe(0);
  });
});
