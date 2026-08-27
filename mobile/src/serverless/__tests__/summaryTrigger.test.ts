/**
 * Tests for summary trigger logic (SPEC TASK-087).
 */

import {archiveRange} from '../summaryTrigger';

describe('archiveRange', () => {
  it('returns null when threshold not crossed', () => {
    // total=50, boundary=0, window=20, threshold=40
    // end = 50 - 20 = 30
    // pending = 30 - 0 = 30 < 40 (threshold)
    const result = archiveRange(50, 0, {window: 20, threshold: 40});
    expect(result).toBeNull();
  });

  it('returns range when threshold crossed', () => {
    // total=60, boundary=0, window=20, threshold=40
    // end = 60 - 20 = 40
    // pending = 40 - 0 = 40 >= 40 (threshold)
    const result = archiveRange(60, 0, {window: 20, threshold: 40});
    expect(result).toEqual({start: 1, end: 40});
  });

  it('returns null after first compaction when threshold not reached again', () => {
    // total=80, boundary=40, window=20, threshold=40
    // end = 80 - 20 = 60
    // pending = 60 - 40 = 20 < 40 (threshold)
    const result = archiveRange(80, 40, {window: 20, threshold: 40});
    expect(result).toBeNull();
  });

  it('triggers second compaction when threshold crossed again', () => {
    // total=100, boundary=40, window=20, threshold=40
    // end = 100 - 20 = 80
    // pending = 80 - 40 = 40 >= 40 (threshold)
    const result = archiveRange(100, 40, {window: 20, threshold: 40});
    expect(result).toEqual({start: 41, end: 80});
  });

  it('uses configured defaults when options omitted', () => {
    // Should use RECENT_MESSAGE_WINDOW=20 and SUMMARY_TRIGGER_THRESHOLD=40
    const result = archiveRange(60, 0);
    expect(result).toEqual({start: 1, end: 40});
  });

  it('handles zero boundary', () => {
    const result = archiveRange(60, 0, {window: 20, threshold: 40});
    expect(result).toEqual({start: 1, end: 40});
  });

  it('handles small window', () => {
    // total=50, boundary=0, window=5, threshold=40
    // end = 50 - 5 = 45
    // pending = 45 - 0 = 45 >= 40
    const result = archiveRange(50, 0, {window: 5, threshold: 40});
    expect(result).toEqual({start: 1, end: 45});
  });

  it('handles small threshold', () => {
    // total=30, boundary=0, window=20, threshold=5
    // end = 30 - 20 = 10
    // pending = 10 - 0 = 10 >= 5
    const result = archiveRange(30, 0, {window: 20, threshold: 5});
    expect(result).toEqual({start: 1, end: 10});
  });

  it('throws when boundary exceeds total', () => {
    expect(() => archiveRange(50, 60, {window: 20, threshold: 40})).toThrow(
      'boundary (60) cannot exceed totalMessages (50)',
    );
  });

  it('throws on negative totalMessages', () => {
    expect(() => archiveRange(-10, 0, {window: 20, threshold: 40})).toThrow(
      'totalMessages must be a non-negative integer',
    );
  });

  it('throws on negative boundary', () => {
    expect(() => archiveRange(60, -5, {window: 20, threshold: 40})).toThrow(
      'boundary must be a non-negative integer',
    );
  });

  it('throws on invalid window', () => {
    expect(() => archiveRange(60, 0, {window: 0, threshold: 40})).toThrow(
      'window must be a positive integer',
    );
    expect(() => archiveRange(60, 0, {window: -5, threshold: 40})).toThrow(
      'window must be a positive integer',
    );
  });

  it('throws on invalid threshold', () => {
    expect(() => archiveRange(60, 0, {window: 20, threshold: 0})).toThrow(
      'threshold must be a positive integer',
    );
    expect(() => archiveRange(60, 0, {window: 20, threshold: -10})).toThrow(
      'threshold must be a positive integer',
    );
  });

  it('matches backend example: 60 messages, first compaction', () => {
    // ROADMAP example: at 60 messages, summarize 1-40, boundary becomes 40
    const result = archiveRange(60, 0, {window: 20, threshold: 40});
    expect(result).toEqual({start: 1, end: 40});
  });

  it('matches backend example: 100 messages, second compaction', () => {
    // ROADMAP example: at 100 messages, summarize 41-80, boundary becomes 80
    const result = archiveRange(100, 40, {window: 20, threshold: 40});
    expect(result).toEqual({start: 41, end: 80});
  });

  it('handles exact threshold boundary', () => {
    // Exactly at threshold should trigger
    const result = archiveRange(60, 0, {window: 20, threshold: 40});
    expect(result).not.toBeNull();
  });

  it('returns null one message before threshold', () => {
    // One short of threshold should not trigger
    const result = archiveRange(59, 0, {window: 20, threshold: 40});
    expect(result).toBeNull();
  });
});
