/**
 * Shared data structures for the serverless LLM integration (SPEC TASK-083,
 * TASK-AUDIT-013). These mirror the backend llm contract (llm/types.py) so
 * application services can treat both modes uniformly: in serverless mode
 * the mobile app talks to the configured provider directly, with the user's
 * own API key — it is never sent to the eLearning backend.
 *
 * Conversation code depends only on the `LLMClient` interface and the
 * normalized data structures below; the concrete provider (OpenRouter,
 * Gemini, OpenAI, 9Router, …) is selected via `createProviderClient`.
 */
import type {LLMError} from './errors';

/** Chat roles accepted by the OpenRouter chat API. */
export type ChatRole = 'system' | 'user' | 'assistant';

/** One message of a completion request payload. */
export interface CompletionMessage {
  role: ChatRole;
  content: string;
}

/** One completion request; `model` pins a specific model for this call. */
export interface CompletionRequest {
  messages: readonly CompletionMessage[];
  /** Explicit per-request model pin; bypasses the configured chain. */
  model?: string | null;
  temperature?: number | null;
}

/** Normalized non-streaming completion outcome. */
export interface CompletionResult {
  text: string;
  model: string;
  finishReason: string | null;
  requestId: string | null;
}

/** Normalized architecture block of a model-catalog entry (may be absent). */
export interface OpenRouterModelArchitecture {
  modality: string | null;
  inputModalities: string[];
  outputModalities: string[];
  tokenizer: string | null;
}

/** Normalized per-token pricing block (decimal strings, may be absent). */
export interface OpenRouterModelPricing {
  prompt: string | null;
  completion: string | null;
  inputCacheRead: string | null;
}

/** Normalized top_provider block of a model-catalog entry (may be absent). */
export interface OpenRouterModelTopProvider {
  contextLength: number | null;
  maxCompletionTokens: number | null;
}

/** One model-catalog entry from GET /models, in normalized form. */
export interface ModelInfo {
  id: string;
  name: string;
  canonicalSlug: string | null;
  description: string | null;
  contextLength: number | null;
  created: number | null;
  architecture: OpenRouterModelArchitecture | null;
  pricing: OpenRouterModelPricing | null;
  topProvider: OpenRouterModelTopProvider | null;
  supportedParameters: string[];
}

const toIntOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;
const toStringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;
const toStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
const toBlockOrNull = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/**
 * Coerce an already-normalized ModelInfo-shaped value — e.g. one read back
 * from the local model-catalog cache — onto the full normalized shape.
 * Extended fields missing from snapshots written by older app versions are
 * backfilled with their null/empty defaults; entries without a usable id
 * resolve to null.
 */
export function normalizeModelInfo(value: unknown): ModelInfo | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || !id.trim()) {
    return null;
  }
  const architecture = toBlockOrNull(record.architecture);
  const pricing = toBlockOrNull(record.pricing);
  const topProvider = toBlockOrNull(record.topProvider);
  return {
    id: id.trim(),
    name: typeof record.name === 'string' ? record.name : '',
    canonicalSlug: toStringOrNull(record.canonicalSlug),
    description: typeof record.description === 'string' ? record.description : null,
    contextLength: toIntOrNull(record.contextLength),
    created: toIntOrNull(record.created),
    architecture: architecture
      ? {
          modality: toStringOrNull(architecture.modality),
          inputModalities: toStringList(architecture.inputModalities),
          outputModalities: toStringList(architecture.outputModalities),
          tokenizer: toStringOrNull(architecture.tokenizer),
        }
      : null,
    pricing: pricing
      ? {
          prompt: toStringOrNull(pricing.prompt),
          completion: toStringOrNull(pricing.completion),
          inputCacheRead: toStringOrNull(pricing.inputCacheRead),
        }
      : null,
    topProvider: topProvider
      ? {
          contextLength: toIntOrNull(topProvider.contextLength),
          maxCompletionTokens: toIntOrNull(topProvider.maxCompletionTokens),
        }
      : null,
    supportedParameters: toStringList(record.supportedParameters),
  };
}

/**
 * Normalize one raw OpenRouter GET /models entry into ModelInfo. Entries
 * without a usable id are skipped (null). Every optional wire field
 * (canonical_slug, architecture, pricing, top_provider,
 * supported_parameters, description, context_length, …) is tolerated and
 * mapped onto its null/empty default, so partially populated payloads
 * normalize safely (TASK-AUDIT-004).
 */
export function normalizeModelEntry(entry: unknown): ModelInfo | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || !id.trim()) {
    return null;
  }

  let architecture: OpenRouterModelArchitecture | null = null;
  const rawArchitecture = record.architecture;
  if (typeof rawArchitecture === 'object' && rawArchitecture !== null) {
    const arch = rawArchitecture as Record<string, unknown>;
    architecture = {
      modality: toStringOrNull(arch.modality),
      inputModalities: toStringList(arch.input_modalities),
      outputModalities: toStringList(arch.output_modalities),
      tokenizer: toStringOrNull(arch.tokenizer),
    };
  }

  let pricing: OpenRouterModelPricing | null = null;
  const rawPricing = record.pricing;
  if (typeof rawPricing === 'object' && rawPricing !== null) {
    const prices = rawPricing as Record<string, unknown>;
    pricing = {
      prompt: toStringOrNull(prices.prompt),
      completion: toStringOrNull(prices.completion),
      inputCacheRead: toStringOrNull(prices.input_cache_read),
    };
  }

  let topProvider: OpenRouterModelTopProvider | null = null;
  const rawTopProvider = record.top_provider;
  if (typeof rawTopProvider === 'object' && rawTopProvider !== null) {
    const provider = rawTopProvider as Record<string, unknown>;
    topProvider = {
      contextLength: toIntOrNull(provider.context_length),
      maxCompletionTokens: toIntOrNull(provider.max_completion_tokens),
    };
  }

  return {
    id: id.trim(),
    name: typeof record.name === 'string' ? record.name : '',
    canonicalSlug: toStringOrNull(record.canonical_slug),
    description: typeof record.description === 'string' ? record.description : null,
    contextLength: toIntOrNull(record.context_length),
    created: toIntOrNull(record.created),
    architecture,
    pricing,
    topProvider,
    supportedParameters: toStringList(record.supported_parameters),
  };
}

/** Serverless LLM configuration supplied by the user (TASK-093 storage). */
export interface LLMClientConfig {
  /** The user's personal provider API key. Stays on-device. */
  apiKey: string;
  /** Model tried first. */
  primaryModel: string;
  /** Models tried in order when retryable failures hit earlier entries. */
  fallbackModels?: readonly string[];
  baseUrl?: string;
  /** Total timeout in ms for non-streaming requests (default 60000). */
  timeoutMs?: number;
  /** Which provider integration to use (default `openrouter`). */
  provider?: ProviderId;
}

/** Historic OpenRouter-branded alias of the client configuration. */
export type OpenRouterClientConfig = LLMClientConfig;

/**
 * Events emitted by streamCompletion, terminating in exactly one terminal
 * event (`completed` or `failed`). Mirrors the backend streaming protocol:
 * `start` announces the resolved model, `delta` carries incremental text,
 * and `failed` reports the normalized error plus any partial text received.
 */
export type ServerlessStreamEvent =
  | {type: 'start'; model: string}
  | {type: 'delta'; text: string}
  | {type: 'completed'; text: string; model: string; deltaCount: number}
  | {type: 'failed'; message: string; retryable: boolean; text: string};

export interface StreamCompletionOptions {
  request: CompletionRequest;
  /** Application events as they arrive, in wire order. */
  onEvent: (event: ServerlessStreamEvent) => void;
}

/** Handle returned by streamCompletion; abort suppresses all callbacks. */
export interface StreamHandle {
  abort(): void;
}

/** Contract shared by every provider client and the test mock adapter. */
export interface LLMClient {
  /** Run one non-streaming chat completion across the model chain. */
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /**
   * Start one streaming chat completion across the model chain. Exactly one
   * terminal outcome occurs per stream: a `completed` or `failed` event.
   */
  streamCompletion(options: StreamCompletionOptions): StreamHandle;
  /** Retrieve the available model catalog in normalized form. */
  listModels(): Promise<ModelInfo[]>;
}

/** Historic OpenRouter-branded alias of the client contract. */
export type OpenRouterClient = LLMClient;

/**
 * Canonical provider ids supported by the serverless provider registry.
 * Adding a provider means implementing `LLMClient` (reusing the shared
 * OpenAI-compatible strategy when the wire contract matches) and
 * registering it in `providerRegistry.ts`.
 */
export type ProviderId = 'openrouter' | 'gemini' | 'openai' | 'ninerouter';

/** Build the terminal `failed` event for one normalized provider error. */
export function failedEvent(error: LLMError, partialText: string): ServerlessStreamEvent {
  return {
    type: 'failed',
    message: error.message,
    retryable: error.retryable,
    text: partialText,
  };
}
