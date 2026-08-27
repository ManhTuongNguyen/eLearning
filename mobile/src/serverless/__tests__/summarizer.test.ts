/**
 * Tests for rolling conversation summarizer (SPEC TASK-087).
 */

import {generateSummary} from '../summarizer';
import type {LocalMessage} from '../../db/types';
import type {OpenRouterClient, CompletionResult} from '../types';

describe('generateSummary', () => {
  const createMessage = (
    role: 'user' | 'assistant',
    content: string,
    sequence: number,
  ): LocalMessage => ({
    id: sequence,
    session_id: 1,
    role,
    status: 'complete',
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

  it('generates summary from archived messages', async () => {
    const client = mockClient('The learner discussed travel plans to Japan.');
    const messages = [
      createMessage('user', 'I want to visit Japan', 1),
      createMessage('assistant', 'Great choice!', 2),
    ];

    const result = await generateSummary(client, {archivedMessages: messages});

    expect(result).toBe('The learner discussed travel plans to Japan.');
    expect(client.complete).toHaveBeenCalledWith({
      messages: expect.arrayContaining([
        expect.objectContaining({role: 'system'}),
        expect.objectContaining({role: 'user'}),
      ]),
    });
  });

  it('includes previous summary in request', async () => {
    const client = mockClient('Updated summary with new messages.');
    const messages = [createMessage('user', 'What about hotels?', 3)];

    await generateSummary(client, {
      previousSummary: 'The learner is planning a trip to Japan.',
      archivedMessages: messages,
    });

    const call = (client.complete as jest.Mock).mock.calls[0][0];
    expect(call.messages[1].content).toContain('Summary of the conversation so far:');
    expect(call.messages[1].content).toContain('planning a trip to Japan');
  });

  it('formats archived messages as role: content', async () => {
    const client = mockClient('Summary text');
    const messages = [
      createMessage('user', 'Hello', 1),
      createMessage('assistant', 'Hi there', 2),
    ];

    await generateSummary(client, {archivedMessages: messages});

    const userPrompt = (client.complete as jest.Mock).mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain('user: Hello');
    expect(userPrompt).toContain('assistant: Hi there');
  });

  it('strips code fence from response', async () => {
    const client = mockClient('```\nSummary inside fence\n```');
    const messages = [createMessage('user', 'Test', 1)];

    const result = await generateSummary(client, {archivedMessages: messages});

    expect(result).toBe('Summary inside fence');
  });

  it('strips code fence with language tag', async () => {
    const client = mockClient('```text\nSummary with language\n```');
    const messages = [createMessage('user', 'Test', 1)];

    const result = await generateSummary(client, {archivedMessages: messages});

    expect(result).toBe('Summary with language');
  });

  it('handles response without code fence', async () => {
    const client = mockClient('Plain summary text');
    const messages = [createMessage('user', 'Test', 1)];

    const result = await generateSummary(client, {archivedMessages: messages});

    expect(result).toBe('Plain summary text');
  });

  it('throws on empty response', async () => {
    const client = mockClient('   ');
    const messages = [createMessage('user', 'Test', 1)];

    await expect(
      generateSummary(client, {archivedMessages: messages}),
    ).rejects.toThrow('Summary response was empty');
  });

  it('throws on empty archived messages', async () => {
    const client = mockClient('Summary');

    await expect(
      generateSummary(client, {archivedMessages: []}),
    ).rejects.toThrow('archivedMessages must not be empty');
  });

  it('throws on invalid role in archived messages', async () => {
    const client = mockClient('Summary');
    const invalidMessage = {
      ...createMessage('user', 'Test', 1),
      role: 'system' as any,
    };

    await expect(
      generateSummary(client, {archivedMessages: [invalidMessage]}),
    ).rejects.toThrow('invalid role');
  });

  it('throws on empty content in archived messages', async () => {
    const client = mockClient('Summary');
    const messages = [createMessage('user', '   ', 1)];

    await expect(
      generateSummary(client, {archivedMessages: messages}),
    ).rejects.toThrow('content must not be empty');
  });

  it('handles missing previous summary', async () => {
    const client = mockClient('First summary');
    const messages = [createMessage('user', 'Hello', 1)];

    const result = await generateSummary(client, {archivedMessages: messages});

    expect(result).toBe('First summary');
    const userPrompt = (client.complete as jest.Mock).mock.calls[0][0].messages[1].content;
    expect(userPrompt).not.toContain('Summary of the conversation so far:');
  });

  it('trims whitespace from response', async () => {
    const client = mockClient('  Summary with whitespace  \n');
    const messages = [createMessage('user', 'Test', 1)];

    const result = await generateSummary(client, {archivedMessages: messages});

    expect(result).toBe('Summary with whitespace');
  });

  it('propagates provider errors', async () => {
    const client: OpenRouterClient = {
      complete: jest.fn().mockRejectedValue(new Error('Provider error')),
      streamCompletion: jest.fn(),
      listModels: jest.fn(),
    };
    const messages = [createMessage('user', 'Test', 1)];

    await expect(
      generateSummary(client, {archivedMessages: messages}),
    ).rejects.toThrow('Provider error');
  });
});
