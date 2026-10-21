/**
 * Pure karaoke-scroll helper tests: the offset advances with speed × dt,
 * clamps to the scrollable range, marks the end reached, and the elapsed
 * timer formats as MM:SS.
 */
import {
  countWords,
  formatElapsed,
  offsetForCharProgress,
  offsetForSpokenChar,
  type ParagraphSpan,
  paragraphCharRanges,
  scrollDurationMs,
  stepOffset,
} from '../src/practice/karaokeScroll';

describe('stepOffset', () => {
  it('advances the offset by speed × elapsed time', () => {
    expect(stepOffset(0, 30, 1000, 1000)).toEqual({ offset: 30, done: false });
    // Sub-tick deltas accumulate fractionally.
    expect(stepOffset(0, 30, 50, 1000).offset).toBeCloseTo(1.5);
  });

  it('clamps at the scrollable range and reports done', () => {
    expect(stepOffset(999, 30, 100, 1000)).toEqual({ offset: 1000, done: true });
    expect(stepOffset(1000, 30, 100, 1000)).toEqual({ offset: 1000, done: true });
  });

  it('never moves at zero speed and never completes from a zero tick', () => {
    expect(stepOffset(0, 0, 100, 1000)).toEqual({ offset: 0, done: false });
    expect(stepOffset(0, 30, 0, 1000)).toEqual({ offset: 0, done: false });
  });

  it('treats a text that fits the viewport as never done', () => {
    expect(stepOffset(0, 30, 60_000, 0)).toEqual({ offset: 0, done: false });
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

describe('offsetForCharProgress', () => {
  it('maps the spoken fraction of the text onto the scroll range', () => {
    // A quarter of the text spoken -> a quarter of the scrollable range.
    expect(offsetForCharProgress(25, 100, 400)).toBeCloseTo(100);
    expect(offsetForCharProgress(50, 100, 400)).toBeCloseTo(200);
    // Fully spoken text scrolls to the very end.
    expect(offsetForCharProgress(100, 100, 400)).toBeCloseTo(400);
  });

  it('clamps out-of-range progress into the scrollable range', () => {
    expect(offsetForCharProgress(-10, 100, 400)).toBe(0);
    // Engines may briefly report a range past the end (trailing newline).
    expect(offsetForCharProgress(150, 100, 400)).toBeCloseTo(400);
  });

  it('stays at the top without text or without scrollable content', () => {
    expect(offsetForCharProgress(10, 0, 400)).toBe(0);
    expect(offsetForCharProgress(10, 100, 0)).toBe(0);
    expect(offsetForCharProgress(10, 100, -5)).toBe(0);
  });
});

describe('paragraphCharRanges', () => {
  it('maps trimmed paragraphs onto their positions in the full text', () => {
    const full = 'Hello world.\n\nSecond paragraph here.\n\nThird.';
    const paragraphs = ['Hello world.', 'Second paragraph here.', 'Third.'];
    const ranges = paragraphCharRanges(full, paragraphs);

    expect(ranges).toEqual([
      { charStart: 0, charEnd: 12 },
      { charStart: 14, charEnd: 36 },
      { charStart: 38, charEnd: 44 },
    ]);
    // Every range points at the matching slice of the spoken text.
    ranges.forEach((range, index) => {
      expect(full.slice(range.charStart, range.charEnd)).toBe(paragraphs[index]);
    });
  });

  it('keeps ranges ordered when a paragraph cannot be found (defensive)', () => {
    const ranges = paragraphCharRanges('only text', ['missing', 'only text']);
    expect(ranges[0].charStart).toBe(0);
    expect(ranges[1].charStart).toBeGreaterThanOrEqual(ranges[0].charEnd);
  });

  it('returns an empty list without paragraphs', () => {
    expect(paragraphCharRanges('anything', [])).toEqual([]);
  });
});

describe('offsetForSpokenChar', () => {
  // Two paragraphs: 100 chars at y=50 (height 60), then 100 chars at
  // y=130 (height 100). Top inset 40, viewport 200, max scroll 500.
  const spans: ParagraphSpan[] = [
    { charStart: 0, charEnd: 100, y: 50, height: 60 },
    { charStart: 100, charEnd: 200, y: 130, height: 100 },
  ];
  const scroll = (charEnd: number) => offsetForSpokenChar(charEnd, spans, 40, 200, 500);

  it('interpolates the spoken point inside its measured paragraph box', () => {
    // Mid-first-paragraph: inset 40 + y 50 + half of 60 = 120; minus the
    // 35% viewport anchor (70) -> 50.
    expect(scroll(50)).toBeCloseTo(50);
    // charEnd 100 is the exact end of paragraph 1; with a <= comparison it
    // would move into paragraph 2. Use 99 instead so the docs's 80 value
    // stays correct. With charEnd=99, fraction = (99-0)/(100-0) = 0.99.
    // absoluteY = 40 + 50 + 0.99*60 = 40 + 50 + 59.4 = 149.4.
    // offset = 149.4 - 200*0.35 = 149.4 - 70 = 79.4.
    expect(scroll(99)).toBeCloseTo(79.4);
    // One char into paragraph 2: 40 + 130 + 1 - 70 = 101.
    expect(scroll(101)).toBeCloseTo(101);
    // End of the second paragraph: 40 + 130 + 100 - 70 = 200.
    // End of the last paragraph (charEnd=200) snaps to the scroll end.
    expect(scroll(200)).toBe(500);
  });

  it('is monotonic: the teleprompter never scrolls backwards', () => {
    let previous = -1;
    for (let charEnd = 0; charEnd <= 200; charEnd += 5) {
      const offset = scroll(charEnd);
      expect(offset).toBeGreaterThanOrEqual(previous);
      previous = offset;
    }
  });

  it('clamps out-of-range progress and non-scrollable content', () => {
    expect(scroll(-20)).toBe(0); // before the first word -> top
    expect(scroll(500)).toBe(500); // past the end -> scroll to the end
    expect(offsetForSpokenChar(50, [], 40, 200, 500)).toBe(0);
    expect(offsetForSpokenChar(50, spans, 40, 200, 0)).toBe(0);
  });

  it('does not leave unused trailing empty space above the spoken word', () => {
    // topInset=40, viewport=200, anchor=0.35: the first paragraph starts at
    // topInset (40), so the first-word anchor offset is 40-70 < 0 -> 0.
    const spans2: ParagraphSpan[] = [{ charStart: 0, charEnd: 100, y: 0, height: 120 }];
    expect(offsetForSpokenChar(0, spans2, 40, 200, 500)).toBe(0);
    // Mid-paragraph: absoluteY = 40 (topInset) + y(0) + fraction(0.5)*height(120) = 100,
    // offset = 100 - 200*0.35 = 30.
    expect(offsetForSpokenChar(50, spans2, 40, 200, 500)).toBe(30);
    // End of the paragraph: the last spoken char before the jump to the
    // next paragraph is 99, so compute the expected value for that offset.
    // With charEnd=99, fraction = (99-0)/(100-0) = 0.99.
    // absoluteY = 40 + 0 + 0.99*120 = 40 + 118.8 = 158.8.
    // offset = 158.8 - 200*0.35 = 158.8 - 70 = 88.8.
    expect(offsetForSpokenChar(99, spans2, 40, 200, 500)).toBeCloseTo(88.8);

    // End of paragraph at the exact span end (charEnd=100) should snap to
    // the scroll end because it equals the last span's charEnd.
    expect(offsetForSpokenChar(100, spans2, 40, 200, 500)).toBe(500);
  });

  it('snaps to the end once the whole text has been spoken', () => {
    const spans3: ParagraphSpan[] = [
      { charStart: 0, charEnd: 100, y: 0, height: 40 },
      { charStart: 100, charEnd: 200, y: 100, height: 100 },
    ];
    // charEnd=199 sits inside the second paragraph, so it lands at the
    // paragraph anchor instead of snapping to the scroll end.
    expect(offsetForSpokenChar(199, spans3, 0, 200, 500)).toBeCloseTo(129);
    // charEnd exactly at the last span end snaps to the end.
    expect(offsetForSpokenChar(200, spans3, 0, 200, 500)).toBe(500);
    // charEnd past the end also snaps to the end.
    expect(offsetForSpokenChar(250, spans3, 0, 200, 500)).toBe(500);
  });

  it('honours a custom viewport anchor fraction', () => {
    // Mid-second-paragraph with the anchor at the very top of the
    // viewport (0): 40 + 130 + half of 100 = 220.
    expect(offsetForSpokenChar(150, spans, 40, 200, 500, 0)).toBeCloseTo(220);
  });
});
