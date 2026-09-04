/**
 * Tests for serverless message improvement (SPEC TASK-089).
 */

import {generateImprovement} from '../improvement';
import type {EnglishLevel} from '../../../src/api/profile';
import type {CompletionResult, OpenRouterClient} from '../types';
import {OpenRouterAvailabilityError, OpenRouterResponseError} from '../errors';

describe('generateImprovement', () => {
  const VALID_JSON = JSON.stringify({
    improved: 'I went to the store yesterday.',
    explanation: 'Use the past tense "went".',
    severity: 'critical',
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

  it('returns original, improved, explanation and severity from a valid completion', async () => {
    const client = mockClient(VALID_JSON);

    const result = await generateImprovement(client, {
      level: 'B1',
      originalMessage: 'I go to store yesterday.',
    });

    expect(result).toEqual({
      original: 'I go to store yesterday.',
      improved: 'I went to the store yesterday.',
      explanation: 'Use the past tense "went".',
      severity: 'critical',
    });
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['none', 'none'],
    ['minor', 'minor'],
    ['critical', 'critical'],
    ['Minor', 'minor'],
    ['  CRITICAL  ', 'critical'],
  ])('round-trips the %s severity (case-insensitive)', async (severity, expected) => {
    const client = mockClient(
      JSON.stringify({
        improved: 'Fixed.',
        explanation: 'why',
        severity,
      }),
    );

    const result = await generateImprovement(client, {
      level: 'B1',
      originalMessage: 'Hello!',
    });

    expect(result.severity).toBe(expected);
  });

  it('trims the echoed original but never alters the stored wording', async () => {
    const client = mockClient(VALID_JSON);

    const result = await generateImprovement(client, {
      level: 'A2',
      originalMessage: "  She don't like it.  ",
    });

    expect(result.original).toBe("She don't like it.");
  });

  it('asks for corrections when the message is already correct', async () => {
    const client = mockClient(
      JSON.stringify({
        improved: 'This looks fine to me.',
        explanation: 'The message is already correct; no changes were needed.',
        severity: 'none',
      }),
    );

    const result = await generateImprovement(client, {
      level: 'C1',
      originalMessage: 'This looks fine to me.',
    });

    expect(result.improved).toBe('This looks fine to me.');
    expect(result.explanation).toContain('already correct');
    expect(result.severity).toBe('none');
  });

  it('sends a system prompt and a user prompt built from level and message', async () => {
    const client = mockClient(VALID_JSON);

    await generateImprovement(client, {
      level: 'B2',
      originalMessage: 'I go to store yesterday.',
    });

    const request = (client.complete as jest.Mock).mock.calls[0][0];
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain('"improved"');
    expect(request.messages[0].content).toContain('"explanation"');
    expect(request.messages[0].content).toContain('"severity"');
    expect(request.messages[0].content).toContain('none');
    expect(request.messages[0].content).toContain('minor');
    expect(request.messages[0].content).toContain('critical');
    // The system prompt describes both behaviours: extend when the level is
    // known, correct only when it is unknown.
    expect(request.messages[0].content).toContain('extend the message');
    expect(request.messages[0].content).toContain('slightly above their level');
    expect(request.messages[0].content).toContain('only correct it');

    const userPrompt = request.messages[1].content;
    expect(userPrompt).toContain("The learner's English level is B2 (CEFR)");
    expect(userPrompt).toContain('I go to store yesterday.');
  });

  it('asks a known-level learner for an extension pitched one sub-level above', async () => {
    const client = mockClient(VALID_JSON);

    await generateImprovement(client, {
      level: 'A2',
      originalMessage: 'I go to store yesterday.',
    });

    const userPrompt = (client.complete as jest.Mock).mock.calls[0][0]
      .messages[1].content;
    expect(userPrompt).toContain('Extend the message as well');
    expect(userPrompt).toContain('guides the learner to say more');
    // A2 learners are stretched toward B1: slightly above, not a leap.
    expect(userPrompt).toContain('around B1 rather than A2');
  });

  it('advances the extension target across the CEFR ladder', async () => {
    expect.assertions(5);
    const ladder: Array<[EnglishLevel, string]> = [
      ['A1', 'A2'],
      ['A2', 'B1'],
      ['B1', 'B2'],
      ['B2', 'C1'],
      ['C1', 'C2'],
    ];
    for (const [level, target] of ladder) {
      const client = mockClient(VALID_JSON);
      await generateImprovement(client, {level, originalMessage: 'Hello!'});
      const userPrompt = (client.complete as jest.Mock).mock.calls[0][0]
        .messages[1].content;
      expect(userPrompt).toContain(`around ${target} rather than ${level}`);
    }
  });

  it('caps the extension target at C2', async () => {
    const client = mockClient(VALID_JSON);

    await generateImprovement(client, {level: 'C2', originalMessage: 'Hello!'});

    const userPrompt = (client.complete as jest.Mock).mock.calls[0][0]
      .messages[1].content;
    expect(userPrompt).toContain('top of the CEFR scale (C2)');
    expect(userPrompt).toContain('extend the message');
    expect(userPrompt).not.toContain('rather than C2');
  });

  it('lets the model infer an appropriate level for AUTO learners', async () => {
    const client = mockClient(VALID_JSON);

    await generateImprovement(client, {
      level: 'AUTO',
      originalMessage: 'Hello!',
    });

    const userPrompt = (client.complete as jest.Mock).mock.calls[0][0]
      .messages[1].content;
    expect(userPrompt).toContain('level is unknown');
    // AUTO keeps the historic behaviour: corrections only, no extension.
    expect(userPrompt).toContain('Correct the message only');
    expect(userPrompt).not.toContain('Extend the message as well');
  });

  it('extracts the JSON object when the completion includes surrounding prose', async () => {
    const wrapped = `Sure! Here is the correction:\n${VALID_JSON}\nHope this helps.`;
    const client = mockClient(wrapped);

    const result = await generateImprovement(client, {
      level: 'A2',
      originalMessage: 'I go to store yesterday.',
    });

    expect(result.improved).toBe('I went to the store yesterday.');
    expect(result.explanation).toBe('Use the past tense "went".');
    expect(result.severity).toBe('critical');
  });

  it('rejects a blank original message before calling the provider', async () => {
    const client = mockClient(VALID_JSON);

    await expect(
      generateImprovement(client, {level: 'A1', originalMessage: '   '}),
    ).rejects.toThrow('originalMessage must be a non-empty string.');
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('rejects an unknown learning level before calling the provider', async () => {
    const client = mockClient(VALID_JSON);

    await expect(
      generateImprovement(client, {
        level: 'Z9' as never,
        originalMessage: 'Hello!',
      }),
    ).rejects.toThrow('Unknown learning level');
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('normalizes provider failures by rethrowing them untouched', async () => {
    const client: OpenRouterClient = {
      complete: jest
        .fn()
        .mockRejectedValue(new OpenRouterAvailabilityError('overloaded')),
      streamCompletion: jest.fn(),
      listModels: jest.fn(),
    };

    await expect(
      generateImprovement(client, {level: 'A1', originalMessage: 'Hi!'}),
    ).rejects.toBeInstanceOf(OpenRouterAvailabilityError);
  });

  it.each([
    ['non-JSON text', 'Your sentence has a tense problem.'],
    ['a non-object payload', '"improved"'],
    ['a missing improved field', '{"explanation": "why", "severity": "none"}'],
    ['a missing explanation field', '{"improved": "Fixed.", "severity": "none"}'],
    [
      'a blank improved field',
      JSON.stringify({improved: '   ', explanation: 'why', severity: 'none'}),
    ],
    [
      'a non-string explanation',
      JSON.stringify({improved: 'Fixed.', explanation: 3, severity: 'none'}),
    ],
    ['a missing severity field', '{"improved": "Fixed.", "explanation": "why"}'],
    [
      'a blank severity field',
      JSON.stringify({improved: 'Fixed.', explanation: 'why', severity: '   '}),
    ],
    [
      'an unknown severity value',
      JSON.stringify({improved: 'Fixed.', explanation: 'why', severity: 'major'}),
    ],
    [
      'a non-string severity value',
      JSON.stringify({improved: 'Fixed.', explanation: 'why', severity: 3}),
    ],
  ])('rejects %s with OpenRouterResponseError', async (_label, responseText) => {
    const client = mockClient(responseText);

    await expect(
      generateImprovement(client, {level: 'B1', originalMessage: 'Hello!'}),
    ).rejects.toBeInstanceOf(OpenRouterResponseError);
  });
});
