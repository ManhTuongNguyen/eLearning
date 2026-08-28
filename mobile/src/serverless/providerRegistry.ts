/**
 * Serverless provider registry (TASK-AUDIT-013).
 *
 * The mobile analogue of the backend llm/registry.py: this module is the
 * single place that maps a provider id to its concrete `LLMClient`
 * factory, so conversation features never depend on a specific vendor.
 * Selecting a provider is a configuration change (`config.provider`,
 * persisted in the local settings table), never a code change.
 *
 * Two shapes of integrations exist:
 * - OpenAI-compatible providers (OpenRouter, OpenAI, 9Router) share one
 *   implementation in ./openAICompatibleClient because their wire contract
 *   is genuinely the same.
 * - Providers with genuinely different API surfaces (Gemini) implement
 *   `LLMClient` directly in ./geminiClient.
 */
import {createGeminiClient, DEFAULT_GEMINI_BASE_URL, listGeminiModels} from './geminiClient';
import {createOpenAIClient, DEFAULT_OPENAI_BASE_URL, listOpenAIModels} from './openAIClient';
import {
  createNineRouterClient,
  DEFAULT_NINE_ROUTER_BASE_URL,
  listNineRouterModels,
} from './nineRouterClient';
import {createOpenRouterClient, DEFAULT_BASE_URL, listOpenRouterModels} from './openrouterClient';
import type {LLMClient, LLMClientConfig, ModelInfo, ProviderId} from './types';

/** Human-facing metadata for one supported provider. */
export interface ProviderDescriptor {
  id: ProviderId;
  /** Name shown in the settings UI. */
  label: string;
  /** Default API root when the user configuration has no explicit baseUrl. */
  defaultBaseUrl: string;
  /** Placeholder for the settings-screen key input. */
  keyPlaceholder: string;
  /** Where the user can obtain an API key (shown in the settings UI). */
  keyHint: string;
  /** Whether model discovery needs the user's API key. */
  modelDiscoveryRequiresAuth: boolean;
}

export const PROVIDER_DESCRIPTORS: Record<ProviderId, ProviderDescriptor> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: DEFAULT_BASE_URL,
    keyPlaceholder: 'sk-or-v1-…',
    keyHint:
      'Get a key at openrouter.ai. It is stored securely on this device and sent only to OpenRouter.',
    modelDiscoveryRequiresAuth: false,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultBaseUrl: DEFAULT_GEMINI_BASE_URL,
    keyPlaceholder: 'AIza…',
    keyHint:
      'Get a key at aistudio.google.com. It is stored securely on this device and sent only to Google.',
    modelDiscoveryRequiresAuth: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    keyPlaceholder: 'sk-…',
    keyHint:
      'Get a key at platform.openai.com. It is stored securely on this device and sent only to OpenAI.',
    modelDiscoveryRequiresAuth: true,
  },
  ninerouter: {
    id: 'ninerouter',
    label: '9Router',
    defaultBaseUrl: DEFAULT_NINE_ROUTER_BASE_URL,
    keyPlaceholder: '9router key…',
    keyHint:
      'Point the app at your 9Router endpoint (default: localhost:20128). The key stays on this device.',
    modelDiscoveryRequiresAuth: false,
  },
};

/** Provider ids exposed by the settings UI, in display order. */
export const SUPPORTED_PROVIDER_IDS: readonly ProviderId[] = [
  'openrouter',
  'gemini',
  'openai',
  'ninerouter',
];

/** True when `value` is one of the supported provider ids. */
export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDER_DESCRIPTORS, value)
  );
}

/**
 * Resolve a persisted provider value onto a supported id. Blank/absent
 * values fall back to `openrouter` (the historic default); unknown values
 * are programmer errors and throw.
 */
export function resolveProviderId(value: string | null | undefined): ProviderId {
  if (value === null || value === undefined || value.trim() === '') {
    return 'openrouter';
  }
  const normalized = value.trim().toLowerCase();
  if (!isProviderId(normalized)) {
    throw new Error(`Unknown serverless provider: ${value}`);
  }
  return normalized;
}

/** Create the provider client selected by `config.provider` (default openrouter). */
export function createProviderClient(config: LLMClientConfig): LLMClient {
  const provider = resolveProviderId(config.provider ?? 'openrouter');
  switch (provider) {
    case 'openrouter':
      return createOpenRouterClient(config);
    case 'gemini':
      return createGeminiClient(config);
    case 'openai':
      return createOpenAIClient(config);
    case 'ninerouter':
      return createNineRouterClient(config);
  }
}

/**
 * Fetch the model catalog for one provider without building a full client.
 * Keyless for providers with public catalogs (OpenRouter, 9Router);
 * requires a key for providers whose discovery endpoint is authenticated
 * (Gemini, OpenAI).
 */
export async function listProviderModels(
  provider: ProviderId,
  options: {apiKey?: string; baseUrl?: string; timeoutMs?: number} = {},
): Promise<ModelInfo[]> {
  switch (provider) {
    case 'openrouter':
      return listOpenRouterModels(options);
    case 'gemini':
      return listGeminiModels(options);
    case 'openai':
      return listOpenAIModels(options);
    case 'ninerouter':
      return listNineRouterModels(options);
  }
}
