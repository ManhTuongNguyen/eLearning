/**
 * Tests for serverless conversation context building (SPEC TASK-087).
 */

import {buildContext} from '../contextBuilder';
import type {ContextInput} from '../contextBuilder';
import type {LocalMessage} from '../../db/types';

describe('buildContext', () => {
  const baseTopic = {
    title: 'Travel Plans',
    description: 'Discussing vacation destinations and travel tips',
  };

  const baseInput: ContextInput = {
    level: 'B1',
    topic: baseTopic,
    currentMessage: 'What are your recommendations?',
  };

  it('builds context with system prompt and current message', () => {
    const request = buildContext(baseInput);

    expect(request.messages).toHaveLength(2);
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain('AI English tutor');
    expect(request.messages[0].content).toContain('B1 (CEFR)');
    expect(request.messages[0].content).toContain('Travel Plans');
    expect(request.messages[1].role).toBe('user');
    expect(request.messages[1].content).toBe('What are your recommendations?');
  });

  it('includes summary when provided', () => {
    const request = buildContext({
      ...baseInput,
      summary: 'The learner is planning a trip to Japan.',
    });

    const systemPrompt = request.messages[0].content;
    expect(systemPrompt).toContain('Summary of the earlier conversation:');
    expect(systemPrompt).toContain('planning a trip to Japan');
  });

  it('omits summary section when blank', () => {
    const request = buildContext({...baseInput, summary: ''});
    expect(request.messages[0].content).not.toContain('Summary of');
  });

  it('includes recent messages between system and current', () => {
    const recentMessages: LocalMessage[] = [
      {
        id: 1,
        session_id: 1,
        role: 'user',
        status: 'complete',
        content: 'I want to visit Japan.',
        sequence: 1,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 2,
        session_id: 1,
        role: 'assistant',
        status: 'complete',
        content: 'Great choice! When are you planning to go?',
        sequence: 2,
        created_at: '2026-01-01T00:00:01Z',
      },
    ];

    const request = buildContext({...baseInput, recentMessages});

    expect(request.messages).toHaveLength(4);
    expect(request.messages[1].role).toBe('user');
    expect(request.messages[1].content).toBe('I want to visit Japan.');
    expect(request.messages[2].role).toBe('assistant');
    expect(request.messages[2].content).toContain('Great choice!');
    expect(request.messages[3].role).toBe('user');
  });

  it('filters out pending messages from history', () => {
    const recentMessages: LocalMessage[] = [
      {
        id: 1,
        session_id: 1,
        role: 'user',
        status: 'complete',
        content: 'Hello',
        sequence: 1,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 2,
        session_id: 1,
        role: 'assistant',
        status: 'pending',
        content: '',
        sequence: 2,
        created_at: '2026-01-01T00:00:01Z',
      },
    ];

    const request = buildContext({...baseInput, recentMessages});

    expect(request.messages).toHaveLength(3); // system + 1 complete user + current
    expect(request.messages[1].content).toBe('Hello');
  });

  it('filters out failed messages from history', () => {
    const recentMessages: LocalMessage[] = [
      {
        id: 1,
        session_id: 1,
        role: 'assistant',
        status: 'failed',
        content: '',
        sequence: 1,
        created_at: '2026-01-01T00:00:00Z',
      },
    ];

    const request = buildContext({...baseInput, recentMessages});

    expect(request.messages).toHaveLength(2); // system + current only
  });

  it('rejects blank current message', () => {
    expect(() =>
      buildContext({...baseInput, currentMessage: '   '}),
    ).toThrow('currentMessage must not be empty');
  });

  it('rejects unknown learning level', () => {
    expect(() =>
      buildContext({...baseInput, level: 'X9' as any}),
    ).toThrow('Unknown learning level');
  });

  it('handles AUTO level', () => {
    const request = buildContext({...baseInput, level: 'AUTO'});
    expect(request.messages[0].content).toContain('level is unknown');
    expect(request.messages[0].content).toContain('infer an appropriate level');
  });

  it('handles all CEFR levels', () => {
    const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
    for (const level of levels) {
      const request = buildContext({...baseInput, level});
      expect(request.messages[0].content).toContain(`${level} (CEFR)`);
    }
  });

  it('trims whitespace from current message', () => {
    const request = buildContext({
      ...baseInput,
      currentMessage: '  Hello!  ',
    });
    expect(request.messages[request.messages.length - 1].content).toBe('Hello!');
  });

  it('is deterministic with identical inputs', () => {
    const input: ContextInput = {
      level: 'B2',
      topic: baseTopic,
      summary: 'Previous discussion summary.',
      recentMessages: [
        {
          id: 1,
          session_id: 1,
          role: 'user',
          status: 'complete',
          content: 'Test',
          sequence: 1,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      currentMessage: 'What next?',
    };

    const request1 = buildContext(input);
    const request2 = buildContext(input);

    expect(request1).toEqual(request2);
  });
});
