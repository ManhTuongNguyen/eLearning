/**
 * Tests for serverless suggested-reply generation (SPEC TASK-088).
 */

import {generateSuggestions, SUGGESTION_COUNT} from '../suggestions';
import type {LocalMessage} from '../../db/types';
import type {OpenRouterClient, CompletionResult} from '../types';
import {OpenRouterAvailabilityError, OpenRouterResponseError} from '../errors';

describe('generateSuggestions', () => {
  const baseTopic = {
    title: 'Travel Plans',
    description: 'Discussing vacation destinations and travel tips',
  };

  const VALID_JSON = JSON.stringify({
    replies: ['Where should I stay?', 'Have you been there before?', 'What is the best season?'],
  });

  const createMessage = (
    role: 'user' | 'assistant',
    content: string,
    sequence: number,
    status: LocalMessage['status'] = 'complete',
  ): LocalMessage => ({
    id: sequence,
    session_id: 1,
    role,
    status,
    content,
    sequence,
    created_at: `2026-01-01T00:${String(sequence).padStart(2, '0')}:00Z`,
  });

  const mockClient = (responseText: string): OpenRouterClient => ({
    complete: jest.fn().mockResolvedValue({
      text: responseText,
      model: 'test-model',
      finishReason: 'stop',
      requestId: 'test-id',
    } as CompletionResult),
    streamCompletion: jest.fn(),
    listModels: jest.fn(),
  });

  it('returns exactly three replies from a valid completion', async () => {
    const client = mockClient(VALID_JSON);

    const result = await generateSuggestions(client, {
      level: 'B1',
      topic: baseTopic,
      selectedMessage: 'Great choice! When are you planning to go?',
    });

    expect(result.replies).toHaveLength(SUGGESTION_COUNT);
    expect(result.replies).toEqual([
      'Where should I stay?',
      'Have you been there before?',
      'What is the best season?',
    ]);
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it('sends a system prompt and a user prompt built from local context', async () => {
    const client = mockClient(VALID_JSON);

    await generateSuggestions(client, {
      level: 'B2',
      topic: baseTopic,
      selectedMessage: 'What about hotels?',
      history: [
        createMessage('user', 'I want to visit Japan', 1),
        createMessage('assistant', 'Great idea!', 2),
      ],
    });

    const request = (client.complete as jest.Mock).mock.calls[0][0];
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain('exactly three');

    const userPrompt = request.messages[1].content;
    expect(userPrompt).toContain("The learner's English level is B2 (CEFR)");
    expect(userPrompt).toContain('Topic title: "Travel Plans"');
    expect(userPrompt).toContain(baseTopic.description);
    expect(userPrompt).toContain('Conversation so far:');
    expect(userPrompt).toContain('Learner: I want to visit Japan');
    expect(userPrompt).toContain('Tutor: Great idea!');
    expect(userPrompt).toContain('The learner long-pressed this message: "What about hotels?"');
  });

  it('asks the model to keep replies accessible for AUTO level', async () => {
    const client = mockClient(VALID_JSON);

    await generateSuggestions(client, {
      level: 'AUTO',
      topic: baseTopic,
      selectedMessage: 'Hello!',
    });

    const userPrompt = (client.complete as jest.Mock).mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain('level is unknown');
  });

  it('falls back to an empty transcript line without history', async () => {
    const client = mockClient(VALID_JSON);

    await generateSuggestions(client, {
      level: 'A1',
      topic: baseTopic,
      selectedMessage: 'Hi!',
    });

    const userPrompt = (client.complete as jest.Mock).mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain(
      'The conversation has just started; there are no earlier messages.',
    );
  });

  it('filters incomplete or blank messages out of the history', async () => {
    const client = mockClient(VALID_JSON);

    await generateSuggestions(client, {
      level: 'A1',
      topic: baseTopic,
      selectedMessage: 'Hi!',
      history: [
        createMessage('user', 'Visible message', 1),
        createMessage('assistant', '', 2),
        createMessage('assistant', 'Partial reply', 3, 'failed'),
      ],
    });

    const userPrompt = (client.complete as jest.Mock).mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain('Learner: Visible message');
    expect(userPrompt).not.toContain('Partial reply');
  });

  it('extracts the JSON object when the completion includes surrounding prose', async () => {
    const wrapped = `Sure! Here are some suggestions:\n${VALID_JSON}\nLet me know if these help.`;
    const client = mockClient(wrapped);

    const result = await generateSuggestions(client, {
      level: 'A2',
      topic: baseTopic,
      selectedMessage: 'Hello!',
    });

    expect(result.replies).toHaveLength(SUGGESTION_COUNT);
  });

  it('rejects a blank selected message before calling the provider', async () => {
    const client = mockClient(VALID_JSON);

    await expect(
      generateSuggestions(client, {level: 'A1', topic: baseTopic, selectedMessage: '   '}),
    ).rejects.toThrow('selectedMessage must be a non-empty string.');
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('normalizes provider failures by rethrowing them untouched', async () => {
    const client: OpenRouterClient = {
      complete: jest.fn().mockRejectedValue(new OpenRouterAvailabilityError('overloaded')),
      streamCompletion: jest.fn(),
      listModels: jest.fn(),
    };

    await expect(
      generateSuggestions(client, {level: 'A1', topic: baseTopic, selectedMessage: 'Hi!'}),
    ).rejects.toBeInstanceOf(OpenRouterAvailabilityError);
  });

  it.each([
    ['non-JSON text', 'I would suggest asking follow-up questions instead.'],
    ['a non-object payload', '"replies"'],
    ['a missing replies list', '{"answer": ["a", "b", "c"]}'],
    ['too few replies', JSON.stringify({replies: ['Only one here.']})],
    ['too many replies', JSON.stringify({replies: ['one', 'two', 'three', 'four']})],
    ['a blank reply', JSON.stringify({replies: ['one', '   ', 'three']})],
    ['a non-string reply', JSON.stringify({replies: ['one', 2, 'three']})],
    [
      'duplicate replies',
      JSON.stringify({replies: ['Sounds good', 'sounds GOOD', 'Tell me more']}),
    ],
  ])('rejects %s with OpenRouterResponseError', async (_label, responseText) => {
    const client = mockClient(responseText);

    await expect(
      generateSuggestions(client, {level: 'B1', topic: baseTopic, selectedMessage: 'Hi!'}),
    ).rejects.toBeInstanceOf(OpenRouterResponseError);
  });
});
