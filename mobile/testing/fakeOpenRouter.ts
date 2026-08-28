/**
 * Scriptable OpenRouterClient double for tests (SPEC TASK-083 acceptance
 * criterion "tests/mock adapter exists"). Lives outside src/ like
 * testing/sqlJsDriver.ts so it never ships in the Metro bundle.
 *
 * The fake stands in for the whole client interface, i.e. fallback-chain
 * resolution has already happened by the time an outcome is returned:
 * script one outcome per call in the order calls arrive.
 */
import {OpenRouterError} from '../src/serverless/errors';
import type {
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  OpenRouterClient,
  ServerlessStreamEvent,
  StreamCompletionOptions,
  StreamHandle,
} from '../src/serverless/types';

/** One scripted streaming outcome. */
export type StreamScript =
  /** start → one delta per entry → completed with the joined text. */
  | {type: 'success'; model?: string; deltas: readonly string[]}
  /** Optional start, then a single terminal failed event. */
  | {
      type: 'failure';
      message: string;
      retryable?: boolean;
      partialText?: string;
      startModel?: string;
    }
  /** Verbatim event sequence; caller guarantees exactly one terminal. */
  | {type: 'raw'; events: readonly ServerlessStreamEvent[]};

const FAKE_MODEL = 'fake/model';

function defaultModels(): ModelInfo[] {
  return [
    {
      id: 'vendor/model-a',
      name: 'Model A',
      canonicalSlug: null,
      description: null,
      contextLength: null,
      created: null,
      architecture: null,
      pricing: null,
      topProvider: null,
      supportedParameters: [],
    },
    {
      id: 'vendor/model-b',
      name: 'Model B',
      canonicalSlug: null,
      description: null,
      contextLength: null,
      created: null,
      architecture: null,
      pricing: null,
      topProvider: null,
      supportedParameters: [],
    },
  ];
}

export class FakeOpenRouterClient implements OpenRouterClient {
  /** Every completion request, in call order. */
  readonly completeRequests: CompletionRequest[] = [];
  /** Every streaming request, in call order. */
  readonly streamRequests: CompletionRequest[] = [];
  /** Number of listModels() invocations, in call order. */
  private modelsCallCount = 0;

  private completeOutcomes: Array<CompletionResult | OpenRouterError> = [];
  private streamOutcomes: StreamScript[] = [];
  private modelsOutcomes: Array<ModelInfo[] | OpenRouterError> = [];

  /** Total listModels() calls recorded so far. */
  get modelsCalls(): number {
    return this.modelsCallCount;
  }

  /** Script the next complete() results/errors; empty tail uses defaults. */
  enqueueComplete(...outcomes: ReadonlyArray<CompletionResult | OpenRouterError>): this {
    this.completeOutcomes.push(...outcomes);
    return this;
  }

  /** Script the next streamCompletion() outcomes; empty tail succeeds. */
  enqueueStream(...outcomes: ReadonlyArray<StreamScript>): this {
    this.streamOutcomes.push(...outcomes);
    return this;
  }

  /** Script the next listModels() results/errors; empty tail uses defaults. */
  enqueueModels(...outcomes: ReadonlyArray<ModelInfo[] | OpenRouterError>): this {
    this.modelsOutcomes.push(...outcomes);
    return this;
  }

  clearScripts(): void {
    this.completeOutcomes = [];
    this.streamOutcomes = [];
    this.modelsOutcomes = [];
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.completeRequests.push(request);
    const outcome = this.completeOutcomes.shift();
    if (outcome instanceof OpenRouterError) {
      throw outcome;
    }
    if (outcome) {
      return outcome;
    }
    return {
      text: 'Fake completion.',
      model: typeof request.model === 'string' ? request.model : FAKE_MODEL,
      finishReason: 'stop',
      requestId: 'fake-request-id',
    };
  }

  streamCompletion(options: StreamCompletionOptions): StreamHandle {
    this.streamRequests.push(options.request);
    const script = this.streamOutcomes.shift() ?? {
      type: 'success' as const,
      deltas: ['Hello from the fake.'],
    };
    const events = materialize(script, options.request);
    // The fake completes synchronously: every scripted event fires before
    // streamCompletion returns, which keeps consumer tests deterministic.
    for (const event of events) {
      options.onEvent(event);
    }
    return {
      abort() {
        // All outcomes are already delivered; aborting is a no-op.
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    this.modelsCallCount += 1;
    const outcome = this.modelsOutcomes.shift();
    if (outcome instanceof OpenRouterError) {
      throw outcome;
    }
    return outcome ?? defaultModels();
  }
}

function materialize(script: StreamScript, request: CompletionRequest): ServerlessStreamEvent[] {
  if (script.type === 'raw') {
    return [...script.events];
  }
  if (script.type === 'failure') {
    const events: ServerlessStreamEvent[] = [];
    if (script.startModel || script.partialText) {
      events.push({type: 'start', model: script.startModel ?? FAKE_MODEL});
    }
    events.push({
      type: 'failed',
      message: script.message,
      retryable: script.retryable ?? false,
      text: script.partialText ?? '',
    });
    return events;
  }
  const model = script.model ?? (typeof request.model === 'string' ? request.model : FAKE_MODEL);
  const text = script.deltas.join('');
  return [
    {type: 'start', model},
    ...script.deltas.map((delta): ServerlessStreamEvent => ({type: 'delta', text: delta})),
    {type: 'completed', text, model, deltaCount: script.deltas.length},
  ];
}
