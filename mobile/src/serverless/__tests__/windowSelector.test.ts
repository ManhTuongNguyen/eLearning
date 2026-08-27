/**
 * Tests for window selection logic (SPEC TASK-087).
 */

import {selectRecentMessages} from '../windowSelector';
import type {LocalMessage} from '../../db/types';

describe('selectRecentMessages', () => {
  const createMessage = (id: number, sequence: number): LocalMessage => ({
    id,
    session_id: 1,
    role: id % 2 === 0 ? 'assistant' : 'user',
    status: 'complete',
    content: `Message ${id}`,
    sequence,
    created_at: `2026-01-01T00:${String(id).padStart(2, '0')}:00Z`,
  });

  it('returns all messages when fewer than limit', () => {
    const messages = [createMessage(1, 1), createMessage(2, 2)];
    const result = selectRecentMessages(messages, 5);
    expect(result).toEqual(messages);
  });

  it('returns last N messages when total exceeds limit', () => {
    const messages = [
      createMessage(1, 1),
      createMessage(2, 2),
      createMessage(3, 3),
      createMessage(4, 4),
      createMessage(5, 5),
    ];
    const result = selectRecentMessages(messages, 3);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe(3);
    expect(result[1].id).toBe(4);
    expect(result[2].id).toBe(5);
  });

  it('preserves chronological order', () => {
    const messages = [
      createMessage(1, 1),
      createMessage(2, 2),
      createMessage(3, 3),
    ];
    const result = selectRecentMessages(messages, 2);
    expect(result[0].sequence).toBe(2);
    expect(result[1].sequence).toBe(3);
  });

  it('uses configured default limit', () => {
    const messages = Array.from({length: 30}, (_, i) =>
      createMessage(i + 1, i + 1),
    );
    const result = selectRecentMessages(messages);
    expect(result).toHaveLength(20); // RECENT_MESSAGE_WINDOW default
  });

  it('handles empty array', () => {
    const result = selectRecentMessages([], 5);
    expect(result).toEqual([]);
  });

  it('returns exact limit when length equals limit', () => {
    const messages = [createMessage(1, 1), createMessage(2, 2)];
    const result = selectRecentMessages(messages, 2);
    expect(result).toEqual(messages);
  });

  it('throws on invalid limit', () => {
    const messages = [createMessage(1, 1)];
    expect(() => selectRecentMessages(messages, 0)).toThrow(
      'limit must be a positive integer',
    );
    expect(() => selectRecentMessages(messages, -5)).toThrow(
      'limit must be a positive integer',
    );
    expect(() => selectRecentMessages(messages, 1.5)).toThrow(
      'limit must be a positive integer',
    );
  });
});
