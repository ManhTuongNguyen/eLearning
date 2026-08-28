/**
 * Mobile-side OpenRouter client for serverless mode (SPEC TASK-083,
 * TASK-AUDIT-013).
 *
 * OpenRouter exposes the standard OpenAI chat-completions contract, so this
 * module is a thin wrapper over the shared OpenAI-compatible strategy in
 * ./openAICompatibleClient, supplying only OpenRouter's identity and
 * endpoint. Model discovery remains deliberately keyless (TASK-AUDIT-004):
 * the public /models endpoint is called without any Authorization header so
 * browsing/selecting models never depends on token validation. Chat
 * requests talk to OpenRouter directly with the user's own API key — the
 * key is only ever placed in the Authorization header toward openrouter.ai
 * and never reaches the eLearning backend.
 */
import {
  createOpenAICompatibleClient,
  requestModelCatalog,
  DEFAULT_TIMEOUT_MS,
  type ModelListingOptions,
  type OpenAICompatibleProviderSpec,
} from './openAICompatibleClient';
import type {LLMClient, LLMClientConfig, ModelInfo} from './types';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** OpenRouter-specific identity for the shared OpenAI-compatible strategy. */
export const OPENROUTER_PROVIDER_SPEC: OpenAICompatibleProviderSpec = {
  id: 'openrouter',
  label: 'OpenRouter',
  defaultBaseUrl: DEFAULT_BASE_URL,
  // The public catalog needs no credentials (TASK-AUDIT-004).
  modelDiscoveryRequiresAuth: false,
};

export {
  DEFAULT_TIMEOUT_MS,
  MAX_ERROR_SNIPPET_LENGTH,
  buildModelChain,
  extractErrorMessage,
  requestModelCatalog,
} from './openAICompatibleClient';
export type {ModelListingOptions} from './openAICompatibleClient';

/**
 * Retrieve the model catalog directly from OpenRouter's public /models
 * endpoint (TASK-AUDIT-004). Discovery is fully separated from
 * authenticated provider requests: no user API key is required, none is
 * sent, and an invalid or expired key can therefore never block model
 * discovery — models can be browsed before a key is configured at all.
 * The key remains mandatory for actual LLM calls through
 * `createOpenRouterClient`. Same normalized result and error hierarchy as
 * `LLMClient.listModels()`.
 */
export async function listOpenRouterModels(
  options: OpenRouterModelListingOptions = {},
): Promise<ModelInfo[]> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('The OpenRouter base URL must be a non-empty string.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('The OpenRouter timeout must be greater than zero.');
  }
  return requestModelCatalog(baseUrl, timeoutMs);
}

export interface OpenRouterModelListingOptions extends ModelListingOptions {}

/**
 * Create an OpenRouter client bound to one user configuration. Config
 * problems are programmer errors and throw synchronously.
 */
export function createOpenRouterClient(config: LLMClientConfig): LLMClient {
  return createOpenAICompatibleClient(config, OPENROUTER_PROVIDER_SPEC);
}
