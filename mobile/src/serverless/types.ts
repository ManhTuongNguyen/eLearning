/**
 * Shared data structures for the serverless OpenRouter integration
 * (SPEC TASK-083). These mirror the backend llm contract (llm/types.py)
 * so application services can treat both modes uniformly: the mobile app
 * talks to OpenRouter directly here, with the user's own API key — it is
 * never sent to the eLearning backend.
 */
import type {OpenRouterError} from './errors';

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

/** One model-catalog entry from GET /models, in normalized form. */
export interface ModelInfo {
  id: string;
  name: string;
  description: string | null;
  contextLength: number | null;
  created: number | null;
}

/** Serverless LLM configuration supplied by the user (TASK-093 storage). */
export interface OpenRouterClientConfig {
  /** The user's personal OpenRouter API key. Stays on-device. */
  apiKey: string;
  /** Model tried first. */
  primaryModel: string;
  /** Models tried in order when retryable failures hit earlier entries. */
  fallbackModels?: readonly string[];
  baseUrl?: string;
  /** Total timeout in ms for non-streaming requests (default 60000). */
  timeoutMs?: number;
}

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

/** Contract shared by the real client and the test mock adapter. */
export interface OpenRouterClient {
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

/** Build the terminal `failed` event for one normalized provider error. */
export function failedEvent(
  error: OpenRouterError,
  partialText: string,
): ServerlessStreamEvent {
  return {
    type: 'failed',
    message: error.message,
    retryable: error.retryable,
    text: partialText,
  };
}
