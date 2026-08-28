/**
 * Mobile-side OpenAI client for serverless mode (TASK-AUDIT-013).
 *
 * OpenAI's own API follows the same chat-completions contract as every
 * other OpenAI-compatible vendor, so this is a thin wrapper over the shared
 * strategy supplying only OpenAI's identity and endpoint. Unlike
 * OpenRouter, the /models catalog requires the user's key, so model
 * discovery sends Authorization (still only toward api.openai.com).
 */
import {
  createOpenAICompatibleClient,
  requestModelCatalog,
  DEFAULT_TIMEOUT_MS,
  type OpenAICompatibleProviderSpec,
} from './openAICompatibleClient';
import type {LLMClient, LLMClientConfig, ModelInfo} from './types';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** OpenAI-specific identity for the shared OpenAI-compatible strategy. */
export const OPENAI_PROVIDER_SPEC: OpenAICompatibleProviderSpec = {
  id: 'openai',
  label: 'OpenAI',
  defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
  modelDiscoveryRequiresAuth: true,
};

/**
 * Create an OpenAI client bound to one user configuration. Config problems
 * are programmer errors and throw synchronously.
 */
export function createOpenAIClient(config: LLMClientConfig): LLMClient {
  return createOpenAICompatibleClient(config, OPENAI_PROVIDER_SPEC);
}

/**
 * Retrieve the OpenAI model catalog. Discovery requires the user's API key
 * (it is sent only toward api.openai.com and never logged).
 */
export async function listOpenAIModels(
  options: {baseUrl?: string; timeoutMs?: number; apiKey?: string} = {},
): Promise<ModelInfo[]> {
  const baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('The OpenAI base URL must be a non-empty string.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('The OpenAI timeout must be greater than zero.');
  }
  return requestModelCatalog(baseUrl, timeoutMs, options.apiKey);
}
