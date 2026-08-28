/**
 * Mobile-side 9Router client for serverless mode (TASK-AUDIT-013).
 *
 * 9Router is an OpenAI-compatible gateway, so this is a thin wrapper over
 * the shared strategy supplying only the 9Router identity and default
 * endpoint (a local router install; remote deployments override baseUrl).
 * Model discovery is treated as keyless, mirroring a default local router.
 */
import {
  createOpenAICompatibleClient,
  requestModelCatalog,
  DEFAULT_TIMEOUT_MS,
  type OpenAICompatibleProviderSpec,
} from './openAICompatibleClient';
import type {LLMClient, LLMClientConfig, ModelInfo} from './types';

export const DEFAULT_NINE_ROUTER_BASE_URL = 'http://localhost:20128/v1';

/** 9Router-specific identity for the shared OpenAI-compatible strategy. */
export const NINE_ROUTER_PROVIDER_SPEC: OpenAICompatibleProviderSpec = {
  id: 'ninerouter',
  label: '9Router',
  defaultBaseUrl: DEFAULT_NINE_ROUTER_BASE_URL,
  modelDiscoveryRequiresAuth: false,
};

/**
 * Create a 9Router client bound to one user configuration. Config problems
 * are programmer errors and throw synchronously.
 */
export function createNineRouterClient(config: LLMClientConfig): LLMClient {
  return createOpenAICompatibleClient(config, NINE_ROUTER_PROVIDER_SPEC);
}

/** Retrieve the 9Router model catalog (keyless by default). */
export async function listNineRouterModels(
  options: {baseUrl?: string; timeoutMs?: number; apiKey?: string} = {},
): Promise<ModelInfo[]> {
  const baseUrl = (options.baseUrl ?? DEFAULT_NINE_ROUTER_BASE_URL).trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('The 9Router base URL must be a non-empty string.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('The 9Router timeout must be greater than zero.');
  }
  return requestModelCatalog(baseUrl, timeoutMs, options.apiKey);
}
