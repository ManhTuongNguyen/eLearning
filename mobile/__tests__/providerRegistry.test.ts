/**
 * Serverless provider registry tests (TASK-AUDIT-013). Covers provider id
 * resolution (blank → openrouter, case-insensitive matching, unknown ids
 * degrade to the default so stale persisted settings never crash
 * startup), registry completeness for every supported provider, client
 * factory dispatch with per-provider validation, and model catalog
 * dispatch — including the keyless contract for public catalogs
 * (TASK-AUDIT-004: no Authorization header is ever sent) and
 * authenticated discovery for Gemini/OpenAI. All HTTP calls are mocked.
 */
import {DEFAULT_GEMINI_BASE_URL} from '../src/serverless/geminiClient';
import {DEFAULT_OPENAI_BASE_URL} from '../src/serverless/openAIClient';
import {
  createProviderClient,
  listProviderModels,
  PROVIDER_DESCRIPTORS,
  resolveProviderId,
  SUPPORTED_PROVIDER_IDS,
} from '../src/serverless/providerRegistry';
import {DEFAULT_BASE_URL} from '../src/serverless/openrouterClient';
import {LLMError, LLMAuthenticationError} from '../src/serverless/errors';
import type {LLMClientConfig, ModelInfo} from '../src/serverless/types';

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: {get: () => null},
  } as unknown as Response;
}

function catalogBody(): unknown {
  return {
    data: [
      {id: 'vendor/model-a', name: 'Alpha Model'},
      'not-an-object',
      {id: 'vendor/model-b'},
    ],
  };
}

function geminiCatalogBody(): unknown {
  return {
    models: [
      {
        name: 'models/gemini-2.0-flash',
        displayName: 'Gemini 2.0 Flash',
        supportedGenerationMethods: ['generateContent'],
      },
    ],
  };
}

function config(provider: LLMClientConfig['provider'], apiKey = 'user-key'): LLMClientConfig {
  return {provider, apiKey, primaryModel: 'vendor/primary'};
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('provider id resolution', () => {
  test('blank and absent values fall back to the historic default provider', () => {
    expect(resolveProviderId(null)).toBe('openrouter');
    expect(resolveProviderId(undefined)).toBe('openrouter');
    expect(resolveProviderId('')).toBe('openrouter');
    expect(resolveProviderId('   ')).toBe('openrouter');
  });

  test('values are matched case-insensitively and trimmed', () => {
    expect(resolveProviderId('Gemini')).toBe('gemini');
    expect(resolveProviderId('  OpenAI ')).toBe('openai');
  });

  test('unrecognized values degrade to the default instead of crashing startup', () => {
    // A provider removed from the registry in an app update (e.g.
    // 'ninerouter' persisted by an older build) must resolve to the
    // historic default, never throw.
    expect(resolveProviderId('ninerouter')).toBe('openrouter');
    expect(resolveProviderId('anthropic')).toBe('openrouter');
  });
});

describe('registry descriptors', () => {
  test('every supported provider id has a complete descriptor', () => {
    expect(SUPPORTED_PROVIDER_IDS).toEqual(['openrouter', 'gemini', 'openai']);
    for (const id of SUPPORTED_PROVIDER_IDS) {
      const descriptor = PROVIDER_DESCRIPTORS[id];
      expect(descriptor.id).toBe(id);
      expect(descriptor.label.trim()).not.toBe('');
      expect(descriptor.defaultBaseUrl.trim()).not.toBe('');
      expect(descriptor.keyPlaceholder.trim()).not.toBe('');
      expect(descriptor.keyHint.trim()).not.toBe('');
      expect(typeof descriptor.modelDiscoveryRequiresAuth).toBe('boolean');
    }
  });

  test('default base URLs match each provider integration', () => {
    expect(PROVIDER_DESCRIPTORS.openrouter.defaultBaseUrl).toBe(DEFAULT_BASE_URL);
    expect(PROVIDER_DESCRIPTORS.gemini.defaultBaseUrl).toBe(DEFAULT_GEMINI_BASE_URL);
    expect(PROVIDER_DESCRIPTORS.openai.defaultBaseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
  });

  test('only authenticated-catalog providers declare key-gated discovery', () => {
    expect(PROVIDER_DESCRIPTORS.openrouter.modelDiscoveryRequiresAuth).toBe(false);
    expect(PROVIDER_DESCRIPTORS.gemini.modelDiscoveryRequiresAuth).toBe(true);
    expect(PROVIDER_DESCRIPTORS.openai.modelDiscoveryRequiresAuth).toBe(true);
  });
});

describe('createProviderClient dispatch', () => {
  test('every supported provider produces the full LLMClient contract', () => {
    for (const provider of SUPPORTED_PROVIDER_IDS) {
      const client = createProviderClient(config(provider));
      expect(typeof client.complete).toBe('function');
      expect(typeof client.streamCompletion).toBe('function');
      expect(typeof client.listModels).toBe('function');
    }
  });

  test('clients without an explicit provider default to openrouter', () => {
    const client = createProviderClient({apiKey: 'user-key', primaryModel: 'vendor/primary'});
    expect(typeof client.complete).toBe('function');
  });

  test('missing configuration is rejected synchronously per provider', () => {
    expect(() => createProviderClient(config('openrouter', '   '))).toThrow(
      /OpenRouter API key is required/,
    );
    expect(() => createProviderClient(config('gemini', ''))).toThrow(
      /Gemini API key is required/,
    );
    expect(() => createProviderClient(config('openai', ''))).toThrow(
      /OpenAI API key is required/,
    );
    expect(() =>
      createProviderClient({provider: 'gemini', apiKey: 'k', primaryModel: '  '}),
    ).toThrow(/primary Gemini model is required/);
  });
});

describe('listProviderModels dispatch', () => {
  test('OpenRouter hits the public catalog with no headers at all', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, catalogBody()));

    const models = await listProviderModels('openrouter');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/models');
    expect(init?.headers).toBeUndefined();
    expect(models.map(model => model.id)).toEqual(['vendor/model-a', 'vendor/model-b']);
  });

  test('OpenAI discovery is authenticated with the supplied key', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, catalogBody()));

    await listProviderModels('openai', {apiKey: 'sk-openai-key'});

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init?.headers).toEqual({Authorization: 'Bearer sk-openai-key'});
  });

  test('Gemini discovery hits the Google endpoint with the key header', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, geminiCatalogBody()));

    const models = await listProviderModels('gemini', {apiKey: 'AIza-key'});

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${DEFAULT_GEMINI_BASE_URL}/models`);
    expect(init?.headers).toEqual({'x-goog-api-key': 'AIza-key'});
    expect(models).toEqual([
      expect.objectContaining({id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash'}),
    ]);
  });

  test('HTTP failures are normalized into the shared error hierarchy', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, {error: {message: 'bad key'}}));

    const error = (await listProviderModels('openai', {apiKey: 'sk'}).catch(caught => caught)) as LLMError;

    expect(error).toBeInstanceOf(LLMAuthenticationError);
    expect(error.message).toBe('bad key');
    expect(error.retryable).toBe(false);
  });

  test('auth-only providers without a key refuse to discover', async () => {
    await expect(listProviderModels('gemini')).rejects.toThrow(
      /Gemini API key is required for model discovery/,
    );
    await expect(listProviderModels('openai', {apiKey: '  '})).rejects.toThrow(
      /OpenAI API key is required|key/,
    );
    expect(globalThis.fetch).toBeDefined();
  });
});

describe('per-provider model ids stay normalized', () => {
  test('catalog entries share the ModelInfo shape across providers', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, catalogBody()));

    const models: ModelInfo[] = await listProviderModels('openrouter');

    for (const model of models) {
      expect(typeof model.id).toBe('string');
      expect(model.canonicalSlug).toBeNull();
      expect(model.supportedParameters).toEqual([]);
    }
  });
});
