/**
 * Streaming UX unit tests (SPEC TASK-050): the DeltaBuffer coalescing
 * transitions that bound render frequency during SSE bursts, and the
 * isNearBottom decision matrix that gates auto-scroll.
 */
import {
  DeltaBuffer,
  isNearBottom,
  STICK_TO_BOTTOM_THRESHOLD_PX,
  STREAM_FLUSH_INTERVAL_MS,
} from '../src/screens/streamingUx';

interface BufferHarness {
  buffer: DeltaBuffer;
  flushed: string[];
}

function makeBuffer(intervalMs = STREAM_FLUSH_INTERVAL_MS): BufferHarness {
  const flushed: string[] = [];
  return {buffer: new DeltaBuffer(text => flushed.push(text), intervalMs), flushed};
}

describe('isNearBottom', () => {
  const contentHeight = 2400;
  const viewportHeight = 400;
  const bottomOffset = contentHeight - viewportHeight; // 2000

  it('treats content shorter than the viewport as at-bottom', () => {
    expect(
      isNearBottom({offsetY: 0, contentHeight: 300, viewportHeight: 400}, 120),
    ).toBe(true);
  });

  it('is true resting exactly on the last pixel', () => {
    expect(
      isNearBottom(
        {offsetY: bottomOffset, contentHeight, viewportHeight},
        STICK_TO_BOTTOM_THRESHOLD_PX,
      ),
    ).toBe(true);
  });

  it('stays true within the threshold window above the bottom', () => {
    expect(
      isNearBottom(
        {offsetY: bottomOffset - (STICK_TO_BOTTOM_THRESHOLD_PX - 1), contentHeight, viewportHeight},
        STICK_TO_BOTTOM_THRESHOLD_PX,
      ),
    ).toBe(true);
  });

  it('is inclusive at exactly the threshold distance', () => {
    expect(
      isNearBottom(
        {offsetY: bottomOffset - STICK_TO_BOTTOM_THRESHOLD_PX, contentHeight, viewportHeight},
        STICK_TO_BOTTOM_THRESHOLD_PX,
      ),
    ).toBe(true);
  });

  it('breaks loose just beyond the threshold distance', () => {
    expect(
      isNearBottom(
        {offsetY: bottomOffset - (STICK_TO_BOTTOM_THRESHOLD_PX + 1), contentHeight, viewportHeight},
        STICK_TO_BOTTOM_THRESHOLD_PX,
      ),
    ).toBe(false);
  });

  it('is false far above the bottom regardless of threshold size', () => {
    expect(
      isNearBottom({offsetY: 100, contentHeight, viewportHeight}, 120),
    ).toBe(false);
  });
});

describe('DeltaBuffer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('delivers one concatenated chunk per tick despite a burst of pushes', () => {
    const {buffer, flushed} = makeBuffer();

    buffer.push('Hel');
    buffer.push('lo ');
    buffer.push('world');

    expect(buffer.buffered).toBe('Hello world');
    expect(buffer.scheduled).toBe(true);
    expect(flushed).toEqual([]);

    jest.advanceTimersByTime(STREAM_FLUSH_INTERVAL_MS);

    expect(flushed).toEqual(['Hello world']);
    expect(buffer.buffered).toBe('');
    expect(buffer.scheduled).toBe(false);
  });

  it('does not schedule extra timers while a tick is already pending', () => {
    const {buffer, flushed} = makeBuffer();

    buffer.push('a');
    buffer.push('b');
    buffer.push('c');

    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(STREAM_FLUSH_INTERVAL_MS);
    expect(flushed).toEqual(['abc']);
  });

  it('flushNow applies immediately and cancels the pending tick', () => {
    const {buffer, flushed} = makeBuffer();

    buffer.push('now-text');
    buffer.flushNow();

    expect(flushed).toEqual(['now-text']);
    expect(buffer.scheduled).toBe(false);
    expect(buffer.buffered).toBe('');

    jest.advanceTimersByTime(STREAM_FLUSH_INTERVAL_MS * 4);
    // The cancelled tick must not deliver a second time.
    expect(flushed).toEqual(['now-text']);
  });

  it('flushNow with nothing buffered never calls back', () => {
    const {buffer, flushed} = makeBuffer();

    buffer.flushNow();

    expect(flushed).toEqual([]);
  });

  it('discard drops buffered text and cancels the tick without flushing', () => {
    const {buffer, flushed} = makeBuffer();

    buffer.push('doomed');
    buffer.discard();

    expect(buffer.buffered).toBe('');
    expect(buffer.scheduled).toBe(false);

    jest.advanceTimersByTime(STREAM_FLUSH_INTERVAL_MS * 4);
    buffer.flushNow();
    expect(flushed).toEqual([]);
  });

  it('ignores empty-string pushes without scheduling anything', () => {
    const {buffer, flushed} = makeBuffer();

    buffer.push('');

    expect(buffer.scheduled).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    expect(flushed).toEqual([]);
  });

  it('keeps working across consecutive cycles in order', () => {
    const {buffer, flushed} = makeBuffer();

    buffer.push('one');
    jest.advanceTimersByTime(STREAM_FLUSH_INTERVAL_MS);
    buffer.push('two');
    buffer.push('-three');
    jest.advanceTimersByTime(STREAM_FLUSH_INTERVAL_MS);

    expect(flushed).toEqual(['one', 'two-three']);
  });
});
