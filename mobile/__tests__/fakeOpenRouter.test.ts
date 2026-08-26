/**
 * Tests for the FakeOpenRouterClient mock adapter (SPEC TASK-083): default
 * flows, scripted outcomes in call order, and request recording.
 */
import {FakeOpenRouterClient} from '../testing/fakeOpenRouter';
import {OpenRouterAvailabilityError} from '../src/serverless/errors';

const REQUEST = {messages: [{role: 'user' as const, content: 'Hi'}]};

function stream(fake: FakeOpenRouterClient): unknown[] {
  const events: unknown[] = [];
  fake.streamCompletion({request: REQUEST, onEvent: event => events.push(event)});
  return events;
}

describe('FakeOpenRouterClient', () => {
  it('answers complete/stream/models with sensible defaults and records calls', async () => {
    const fake = new FakeOpenRouterClient();

    await expect(fake.complete(REQUEST)).resolves.toMatchObject({
      text: 'Fake completion.',
      model: 'fake/model',
      finishReason: 'stop',
      requestId: 'fake-request-id',
    });

    const events = stream(fake);
    expect(events).toEqual([
      {type: 'start', model: 'fake/model'},
      {type: 'delta', text: 'Hello from the fake.'},
      {
        type: 'completed',
        text: 'Hello from the fake.',
        model: 'fake/model',
        deltaCount: 1,
      },
    ]);

    await expect(fake.listModels()).resolves.toEqual([
      expect.objectContaining({id: 'vendor/model-a'}),
      expect.objectContaining({id: 'vendor/model-b'}),
    ]);

    expect(fake.completeRequests).toHaveLength(1);
    expect(fake.streamRequests).toEqual([REQUEST]);
  });

  it('delivers scripted outcomes strictly in call order', async () => {
    const fake = new FakeOpenRouterClient();
    fake
      .enqueueComplete(
        {text: 'First.', model: 'm1', finishReason: 'stop', requestId: null},
        new OpenRouterAvailabilityError('overloaded'),
        {text: 'Third.', model: 'm3', finishReason: 'stop', requestId: null},
      )
      .enqueueModels(new OpenRouterAvailabilityError('catalog down'), [
        {id: 'only-model', name: 'Only', description: null, contextLength: 128, created: null},
      ]);

    await expect(fake.complete(REQUEST)).resolves.toMatchObject({text: 'First.'});
    await expect(fake.complete(REQUEST)).rejects.toThrow('overloaded');
    await expect(fake.complete(REQUEST)).resolves.toMatchObject({text: 'Third.'});
    // Script exhausted: defaults resume.
    await expect(fake.complete(REQUEST)).resolves.toMatchObject({model: 'fake/model'});

    await expect(fake.listModels()).rejects.toThrow('catalog down');
    await expect(fake.listModels()).resolves.toEqual([
      expect.objectContaining({id: 'only-model'}),
    ]);
  });

  it('scripts streaming successes with joined text and failure terminals', () => {
    const fake = new FakeOpenRouterClient();

    fake.enqueueStream({type: 'success', model: 'vendor/m', deltas: ['A', 'B']});
    expect(stream(fake)).toEqual([
      {type: 'start', model: 'vendor/m'},
      {type: 'delta', text: 'A'},
      {type: 'delta', text: 'B'},
      {type: 'completed', text: 'AB', model: 'vendor/m', deltaCount: 2},
    ]);

    fake.enqueueStream({
      type: 'failure',
      message: 'capacity',
      retryable: true,
      partialText: 'part',
      startModel: 'vendor/x',
    });
    expect(stream(fake)).toEqual([
      {type: 'start', model: 'vendor/x'},
      {type: 'failed', message: 'capacity', retryable: true, text: 'part'},
    ]);
  });

  it('clearScripts restores pure default behavior', async () => {
    const fake = new FakeOpenRouterClient();
    fake.enqueueComplete({text: 'Scripted.', model: 'm', finishReason: null, requestId: null});
    await expect(fake.complete(REQUEST)).resolves.toMatchObject({text: 'Scripted.'});

    fake.clearScripts();
    await expect(fake.complete(REQUEST)).resolves.toMatchObject({text: 'Fake completion.'});
    expect(fake.completeRequests).toHaveLength(2);
  });
});
