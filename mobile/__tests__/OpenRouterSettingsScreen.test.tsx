/**
 * Serverless provider settings editor tests (SPEC TASK-092,
 * TASK-AUDIT-013): the screen renders the stored configuration without
 * ever revealing the API key, the provider can be switched between the
 * registry-supported ids, models are chosen from the discovered catalog —
 * refreshed keylessly for public-catalog providers (TASK-AUDIT-004) and
 * with the user's key otherwise —, fallback order is edited in place and
 * persisted through the settings store, and validation keeps an
 * incomplete configuration from being saved. Storage/catalog/HTTP seams
 * are module mocks — no SQLite or network participates here. The catalog
 * card is cache-driven (TASK-AUDIT-017): only the explicit refresh hits
 * the network, loading/empty states stay distinct and aged snapshots are
 * labelled without losing usability.
 *
 * TASK-AUDIT-016: the editor is serverless-only, so every mount runs under
 * a ModeProvider with serverless persisted; a server-mode mount renders the
 * mode notice without reading any serverless configuration.
 *
 * TASK-IMPROVEMENT-005: a successful save navigates back to Settings with
 * a one-shot `configSaved` flag only after persistence resolved — a failed
 * save stays on the editor with the inline error and never navigates.
 */
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {act, render, screen, userEvent, waitFor, within} from '@testing-library/react-native';

import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import {setRuntimeApplicationMode} from '../src/mode/runtime';
import {DEFAULT_APPLICATION_MODE} from '../src/mode/types';
import type {OpenRouterSettingsScreenProps} from '../src/navigation/types';
import {createStyles, OpenRouterSettingsScreen} from '../src/screens/OpenRouterSettingsScreen';
import * as modelCatalog from '../src/serverless/modelCatalog';
import * as providerRegistry from '../src/serverless/providerRegistry';
import * as serverlessSettings from '../src/serverless/settings';
import type {ModelInfo} from '../src/serverless/types';import {lightColors} from '../src/theme/colors';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/db/database');
jest.mock('../src/serverless/settings');
// Only the two network/persistence seams are mocked; the staleness helpers
// stay real so the catalog card's TASK-AUDIT-017 states run genuine logic.
jest.mock('../src/serverless/modelCatalog', () => ({
  ...jest.requireActual('../src/serverless/modelCatalog'),
  getCachedModelCatalog: jest.fn(),
  refreshModelCatalog: jest.fn(),
}));
jest.mock('../src/serverless/providerRegistry', () => ({
  ...jest.requireActual('../src/serverless/providerRegistry'),
  listProviderModels: jest.fn(),
}));

const mockedLoadProvider = jest.mocked(serverlessSettings.loadServerlessProvider);
const mockedLoadProviderState = jest.mocked(serverlessSettings.loadServerlessProviderState);
const mockedSaveConfig = jest.mocked(serverlessSettings.saveServerlessOpenRouterConfig);
const mockedGetCached = jest.mocked(modelCatalog.getCachedModelCatalog);
const mockedRefresh = jest.mocked(modelCatalog.refreshModelCatalog);
const mockedListProviderModels = jest.mocked(providerRegistry.listProviderModels);
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

// One configured userEvent instance; its internal act handling drives
// deterministic commits across every interaction below.
const user = userEvent.setup();

const STORED_KEY = 'sk-or-v1-stored-secret-value';
const NEW_KEY = 'sk-or-v1-new-key';

/** Full normalized ModelInfo with the optional catalog fields defaulted. */
function catalogModel(id: string, name: string): ModelInfo {
  return {
    id,
    name,
    canonicalSlug: null,
    description: null,
    contextLength: null,
    created: null,
    architecture: null,
    pricing: null,
    topProvider: null,
    supportedParameters: [],
  };
}

const CATALOG: ModelInfo[] = [
  catalogModel('vendor/model-a', 'Alpha Model'),
  catalogModel('vendor/model-b', 'Beta Model'),
  catalogModel('vendor/claude-x', 'Claude X'),
];

function catalogSnapshot(models = CATALOG, fetchedAt = '2026-08-27T00:00:00.000Z') {
  return {models, fetchedAt};
}

function checkedStateOf(testID: string): boolean | undefined {
  const state = screen.getByTestId(testID).props.accessibilityState;
  return state ? state.checked : undefined;
}

/** Screen style factory bound to the light palette for style assertions. */
function createScreenStyles() {
  return createStyles(lightColors);
}

async function renderScreen(): Promise<OpenRouterSettingsScreenProps> {
  const props = {
    navigation: {navigate: jest.fn(), goBack: jest.fn()},
    route: {key: 'openrouter-settings-test', name: 'OpenRouterSettings', params: undefined},
  } as unknown as OpenRouterSettingsScreenProps;

  // @testing-library/react-native v14 render() is asynchronous; awaiting it
  // binds the shared `screen` handle before any query runs. ModeProvider is
  // part of the real application tree, so the screen mounts under it here.
  await render(
    <ModeProvider>
      <ThemeProvider>
        <OpenRouterSettingsScreen {...props} />
      </ThemeProvider>
    </ModeProvider>,
  );
  return props;
}

/**
 * Deterministic two-stage setup used by most tests: first let the shared
 * screen bind, then wait until the always-present save button proves the
 * mount-time configuration/catalog effects have fully settled.
 */
async function renderSettledScreen(): Promise<OpenRouterSettingsScreenProps> {
  const props = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('openrouter-save')).toBeOnTheScreen());
  return props;
}

beforeEach(async () => {
  asyncStorage.__resetAsyncStorageStore();
  jest.clearAllMocks();
  // Defaults describe a fresh unconfigured device on the historic default
  // provider with no cached catalog; tests override through the seams. The
  // editor only operates in serverless mode (TASK-AUDIT-016), so the shared
  // harness persists it the way a real serverless launch would.
  await saveApplicationMode('serverless');
  setRuntimeApplicationMode('serverless');
  mockedLoadProvider.mockResolvedValue('openrouter');
  mockedLoadProviderState.mockResolvedValue({
    apiKey: null,
    primaryModel: null,
    fallbackModels: [],
  });
  mockedSaveConfig.mockResolvedValue(undefined);
  mockedGetCached.mockResolvedValue(null);
});

afterEach(() => {
  setRuntimeApplicationMode(DEFAULT_APPLICATION_MODE);
});

describe('rendering stored configuration (TASK-092)', () => {
  it('shows the saved primary/fallback setup without revealing the key', async () => {
    mockedLoadProviderState.mockResolvedValue({
      apiKey: STORED_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
    });
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();

    await waitFor(() =>
      expect(checkedStateOf('openrouter-model-primary-vendor/model-a')).toBe(true),
    );
    expect(checkedStateOf('openrouter-model-primary-vendor/model-b')).toBe(false);
    expect(screen.getByTestId('openrouter-fallback-chain')).toBeOnTheScreen();
    // The entry appears once in the catalog row and once in the ordered chip.
    expect(screen.getAllByText('vendor/model-b').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText('vendor/model-b').some(node => Boolean(node.props.testID)),
    ).toBe(false);

    // The key is masked and its real value never appears anywhere.
    const input = screen.getByTestId('openrouter-api-key-input');
    expect(input.props.secureTextEntry).toBe(true);
    expect(input.props.value).toBe('');
    expect(String(input.props.placeholder)).toContain('saved');
    expect(screen.queryByText(STORED_KEY)).toBeNull();
  });

  it('prompts for a first key when nothing is stored yet', async () => {
    await renderSettledScreen();

    expect(await screen.findByTestId('openrouter-models-empty')).toBeOnTheScreen();
    const input = screen.getByTestId('openrouter-api-key-input');
    expect(String(input.props.placeholder)).not.toContain('saved');
    expect(screen.queryByTestId('openrouter-fallback-chain')).toBeNull();
  });
});

describe('model selection from the discovered catalog', () => {
  it('saves the typed key, chosen primary and ordered fallbacks', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();
    await user.type(screen.getByTestId('openrouter-api-key-input'), NEW_KEY);

    // Choose primary, queue two fallbacks, then reorder by moving the
    // first entry one position down.
    await user.press(screen.getByTestId('openrouter-model-primary-vendor/model-b'));
    await waitFor(() =>
      expect(checkedStateOf('openrouter-model-primary-vendor/model-b')).toBe(true),
    );
    await user.press(screen.getByTestId('openrouter-model-fallback-vendor/model-a'));
    await waitFor(() =>
      expect(screen.queryByTestId('openrouter-fallback-chip-0')).toBeOnTheScreen(),
    );
    await user.press(screen.getByTestId('openrouter-model-fallback-vendor/claude-x'));
    await waitFor(() =>
      expect(screen.queryByTestId('openrouter-fallback-chip-1')).toBeOnTheScreen(),
    );
    await user.press(screen.getByTestId('openrouter-fallback-down-0'));

    await user.press(screen.getByTestId('openrouter-save'));

    await waitFor(() => expect(mockedSaveConfig).toHaveBeenCalledTimes(1));
    expect(mockedSaveConfig).toHaveBeenCalledWith({
      provider: 'openrouter',
      apiKey: NEW_KEY,
      primaryModel: 'vendor/model-b',
      fallbackModels: ['vendor/claude-x', 'vendor/model-a'],
    });
    // Saving promotes the draft key to storage and clears it from the
    // input so the secret does not linger on screen.
    await waitFor(() => expect(screen.getByTestId('openrouter-api-key-input').props.value).toBe(''));
  });

  it('keeps the stored key working when the field is left untouched', async () => {
    mockedLoadProviderState.mockResolvedValue({
      apiKey: STORED_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
    });

    await renderSettledScreen();

    await user.press(screen.getByTestId('openrouter-save'));
    await waitFor(() => expect(mockedSaveConfig).toHaveBeenCalledTimes(1));
    expect(mockedSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({apiKey: STORED_KEY}),
    );
  });

  it('demotes a promoted primary out of the fallback queue', async () => {
    mockedLoadProviderState.mockResolvedValue({
      apiKey: STORED_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
    });
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();
    await waitFor(() =>
      expect(screen.queryByTestId('openrouter-fallback-chain')).toBeOnTheScreen(),
    );

    await user.press(screen.getByTestId('openrouter-model-primary-vendor/model-b'));

    await waitFor(() =>
      expect(screen.queryByTestId('openrouter-fallback-chain')).toBeNull(),
    );

    await user.press(screen.getByTestId('openrouter-save'));
    await waitFor(() => expect(mockedSaveConfig).toHaveBeenCalledTimes(1));
    expect(mockedSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryModel: 'vendor/model-b',
        fallbackModels: [],
      }),
    );
  });

  it('removes a single entry from the ordered chain before saving', async () => {
    mockedLoadProviderState.mockResolvedValue({
      apiKey: STORED_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: ['vendor/model-b', 'vendor/claude-x'],
    });

    await renderSettledScreen();
    await waitFor(() => expect(screen.getByText('vendor/claude-x')).toBeOnTheScreen());

    await user.press(screen.getByTestId('openrouter-fallback-remove-1'));
    await user.press(screen.getByTestId('openrouter-save'));

    await waitFor(() => expect(mockedSaveConfig).toHaveBeenCalledTimes(1));
    expect(mockedSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({fallbackModels: ['vendor/model-b']}),
    );
  });
});

// TASK-IMPROVEMENT-005: a successful save hands the user back to Settings
// together with a one-shot `configSaved` flag (the toast renders there), and
// only after persistence actually resolved. Failed saves never navigate.
describe('save completion flow (TASK-IMPROVEMENT-005)', () => {
  it('navigates back to Settings with the saved flag once persistence resolves', async () => {
    mockedLoadProviderState.mockResolvedValue({
      apiKey: STORED_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
    });
    let resolveSave!: () => void;
    mockedSaveConfig.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveSave = resolve;
        }),
    );

    const props = await renderSettledScreen();

    await user.press(screen.getByTestId('openrouter-save'));
    await waitFor(() => expect(mockedSaveConfig).toHaveBeenCalledTimes(1));

    // No optimistic navigation: the save must complete first.
    expect(props.navigation.navigate).not.toHaveBeenCalled();
    expect(props.navigation.goBack).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave();
    });

    await waitFor(() =>
      expect(props.navigation.navigate).toHaveBeenCalledWith('Settings', {
        configSaved: true,
      }),
    );
    // The back hop rides the single navigate call to the existing Settings
    // entry — no goBack, no duplicate stack rows.
    expect(props.navigation.goBack).not.toHaveBeenCalled();
  });

  it('keeps the editor open with the error and without navigation when the save fails', async () => {
    mockedLoadProviderState.mockResolvedValue({
      apiKey: STORED_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
    });
    mockedGetCached.mockResolvedValue(catalogSnapshot());
    mockedSaveConfig.mockRejectedValue(new Error('Secure storage is unavailable.'));

    const props = await renderSettledScreen();

    await user.press(screen.getByTestId('openrouter-save'));

    const error = await screen.findByTestId('openrouter-form-error');
    expect(error).toHaveTextContent(/Secure storage is unavailable/);
    // Stay on the editor, no success navigation and therefore no saved
    // flag for Settings to turn into a success toast.
    expect(props.navigation.navigate).not.toHaveBeenCalled();
    expect(props.navigation.goBack).not.toHaveBeenCalled();
    expect(screen.getByTestId('openrouter-save')).toBeOnTheScreen();
    // The entered configuration is preserved for a retry.
    expect(checkedStateOf('openrouter-model-primary-vendor/model-a')).toBe(true);
  });
});

describe('validation guards', () => {
  it('refuses to save without any API key at all', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();

    await user.press(screen.getByTestId('openrouter-save'));

    const error = await screen.findByTestId('openrouter-form-error');
    expect(error).toHaveTextContent(/api key/i);
    expect(mockedSaveConfig).not.toHaveBeenCalled();
  });

  it('refuses to save before a primary model has been selected', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();

    await user.type(screen.getByTestId('openrouter-api-key-input'), NEW_KEY);
    await user.press(screen.getByTestId('openrouter-save'));

    const error = await screen.findByTestId('openrouter-form-error');
    expect(error).toHaveTextContent(/primary model/i);
    expect(mockedSaveConfig).not.toHaveBeenCalled();
  });
});

describe('model catalog refresh', () => {
  it('downloads models without any API key and persists them via the cache layer', async () => {
    mockedGetCached.mockResolvedValue(null);
    const refreshed: ModelInfo[] = [catalogModel('fresh/new-model', 'Fresh Model')];
    mockedListProviderModels.mockResolvedValue(refreshed);
    mockedRefresh.mockImplementation(async (_db, fetchModels) => ({
      models: await fetchModels(),
      fetchedAt: '2026-08-27T01:00:00.000Z',
    }));

    await renderSettledScreen();

    await user.press(screen.getByTestId('openrouter-models-refresh'));

    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-primary-fresh/new-model')).toBeOnTheScreen(),
    );
    // Discovery is keyless (TASK-AUDIT-004): no key configured or sent.
    expect(mockedListProviderModels).toHaveBeenCalledTimes(1);
    expect(mockedListProviderModels).toHaveBeenCalledWith('openrouter', {apiKey: undefined});
    expect(mockedRefresh).toHaveBeenCalledWith(
      undefined,
      expect.any(Function),
      'openrouter',
    );
    // Catalog source labels stay intact after refresh.
    expect(screen.queryByTestId('openrouter-models-empty')).toBeNull();
  });

  it('keeps showing the cached catalog when a refresh fails', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot([CATALOG[0]]));
    mockedRefresh.mockRejectedValue(new Error('OpenRouter is unreachable.'));

    await renderSettledScreen();
    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen(),
    );

    await user.press(screen.getByTestId('openrouter-models-refresh'));

    const error = await screen.findByTestId('openrouter-form-error');
    expect(error).toHaveTextContent(/OpenRouter is unreachable/);
    expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen();
  });

  it('refreshes the catalog before any API key has been configured', async () => {
    mockedGetCached.mockResolvedValue(null);
    mockedListProviderModels.mockResolvedValue([catalogModel('vendor/model-a', 'Alpha Model')]);
    mockedRefresh.mockImplementation(async (_db, fetchModels) => ({
      models: await fetchModels(),
      fetchedAt: '2026-08-27T01:00:00.000Z',
    }));

    await renderSettledScreen();
    expect(await screen.findByTestId('openrouter-models-empty')).toBeOnTheScreen();

    await user.press(screen.getByTestId('openrouter-models-refresh'));

    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen(),
    );
    // Discovery is keyless: it succeeds with no key stored and none typed.
    expect(mockedListProviderModels).toHaveBeenCalledTimes(1);
    expect(mockedListProviderModels).toHaveBeenCalledWith('openrouter', {apiKey: undefined});
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('openrouter-form-error')).toBeNull();
  });

  it('requires the provider key before discovery for auth-only catalogs', async () => {
    mockedLoadProviderState.mockResolvedValue({
      apiKey: null,
      primaryModel: null,
      fallbackModels: [],
    });

    await renderSettledScreen();
    await user.press(screen.getByTestId('provider-chip-gemini'));
    await waitFor(() =>
      expect(String(screen.getByTestId('openrouter-api-key-input').props.placeholder)).toBe(
        'AIza…',
      ),
    );

    await user.press(screen.getByTestId('openrouter-models-refresh'));

    const error = await screen.findByTestId('openrouter-form-error');
    expect(error).toHaveTextContent(/Enter your Google Gemini API key/);
    // No discovery call went out without credentials.
    expect(mockedListProviderModels).not.toHaveBeenCalled();
  });
});

describe('provider switching (TASK-AUDIT-013)', () => {
  it('renders every registry-supported provider as a selectable chip', async () => {
    await renderSettledScreen();

    for (const id of ['openrouter', 'gemini', 'openai']) {
      expect(screen.getByTestId(`provider-chip-${id}`)).toBeOnTheScreen();
    }
    expect(
      screen.getByTestId('provider-chip-openrouter').props.accessibilityState,
    ).toMatchObject({selected: true});
  });

  it('switches the editor onto the selected provider namespace', async () => {
    // The cache layer is provider-namespaced: only OpenRouter has a
    // snapshot in this scenario.
    mockedGetCached.mockImplementation(async (_db, provider = 'openrouter') =>
      provider === 'openrouter' ? catalogSnapshot() : null,
    );

    await renderSettledScreen();
    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen(),
    );

    mockedListProviderModels.mockClear();
    await user.press(screen.getByTestId('provider-chip-gemini'));

    // The Gemini namespace state is loaded: no key, no models, fresh hint.
    await waitFor(() =>
      expect(mockedLoadProviderState).toHaveBeenLastCalledWith('gemini'),
    );
    await waitFor(() =>
      expect(String(screen.getByTestId('openrouter-api-key-input').props.placeholder)).toBe(
        'AIza…',
      ),
    );
    expect(await screen.findByTestId('openrouter-models-empty')).toBeOnTheScreen();
    expect(screen.queryByTestId('openrouter-fallback-chain')).toBeNull();
  });

  it('saves the edited provider selection with the configuration', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();
    await user.press(screen.getByTestId('provider-chip-gemini'));
    await waitFor(() =>
      expect(String(screen.getByTestId('openrouter-api-key-input').props.placeholder)).toBe(
        'AIza…',
      ),
    );

    await user.type(screen.getByTestId('openrouter-api-key-input'), 'AIza-new-gemini-key');
    await user.press(screen.getByTestId('openrouter-model-primary-vendor/model-b'));

    await user.press(screen.getByTestId('openrouter-save'));

    await waitFor(() => expect(mockedSaveConfig).toHaveBeenCalledTimes(1));
    expect(mockedSaveConfig).toHaveBeenCalledWith({
      provider: 'gemini',
      apiKey: 'AIza-new-gemini-key',
      primaryModel: 'vendor/model-b',
      fallbackModels: [],
    });
  });

  it('rejects a save for a provider whose key was never entered', async () => {
    await renderSettledScreen();

    await user.press(screen.getByTestId('provider-chip-openai'));
    await waitFor(() =>
      expect(mockedLoadProviderState).toHaveBeenLastCalledWith('openai'),
    );

    await user.press(screen.getByTestId('openrouter-save'));

    const error = await screen.findByTestId('openrouter-form-error');
    expect(error).toHaveTextContent(/API key is required/);
    expect(mockedSaveConfig).not.toHaveBeenCalled();
  });

  it('restores the edited models when switching back to the original provider', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();
    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen(),
    );

    await user.press(screen.getByTestId('provider-chip-gemini'));
    await waitFor(() =>
      expect(mockedLoadProviderState).toHaveBeenLastCalledWith('gemini'),
    );

    await user.press(screen.getByTestId('provider-chip-openrouter'));

    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen(),
    );
  });
});

describe('catalog usability', () => {
  it('narrows visible rows as the filter query changes', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();
    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-filter')).toBeOnTheScreen(),
    );

    expect(screen.getByTestId('openrouter-model-primary-vendor/claude-x')).toBeOnTheScreen();
    await user.type(screen.getByTestId('openrouter-model-filter'), 'claude');

    expect(screen.getByTestId('openrouter-model-primary-vendor/claude-x')).toBeOnTheScreen();
    expect(screen.queryByTestId('openrouter-model-primary-vendor/model-a')).toBeNull();
    expect(screen.queryByTestId('openrouter-model-primary-vendor/model-b')).toBeNull();

    await user.type(screen.getByTestId('openrouter-model-filter'), 'zzz-nothing');
    expect(screen.getByText('No models match your filter.')).toBeOnTheScreen();
  });

  it('reports the trimmed catalog size while every row fits on screen', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();

    expect(await screen.findByTestId('openrouter-model-count')).toHaveTextContent(
      /3 model\(s\)/,
    );
  });
});

// TASK-AUDIT-017: the catalog card is purely cache-driven — mounting,
// re-rendering and provider switching only read the local snapshot, the
// explicit Refresh control is the single network path, loading/empty/cached
// states stay distinct, and aged snapshots are labelled while remaining
// fully usable offline.
describe('model catalog caching (TASK-AUDIT-017)', () => {
  it('never requests the catalog on mount, re-render or provider switch — only Refresh does', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();
    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen(),
    );

    // A re-render driven by local UI state must not touch discovery.
    await user.type(screen.getByTestId('openrouter-model-filter'), 'claude');

    // Switching providers only reads the other namespace's local cache.
    // OpenAI is used because its discovery requires a key: the refresh
    // below proves the explicit control is the single network path (the
    // key guard is satisfied by typing the key first).
    await user.press(screen.getByTestId('provider-chip-openai'));
    await waitFor(() =>
      expect(mockedLoadProviderState).toHaveBeenLastCalledWith('openai'),
    );

    expect(mockedRefresh).not.toHaveBeenCalled();
    expect(mockedListProviderModels).not.toHaveBeenCalled();

    // The explicit refresh is the single path to the network.
    mockedListProviderModels.mockResolvedValue([catalogModel('vendor/model-a', 'Alpha Model')]);
    mockedRefresh.mockImplementation(async (_db, fetchModels) => ({
      models: await fetchModels(),
      fetchedAt: '2026-08-27T01:00:00.000Z',
    }));
    await user.type(screen.getByTestId('openrouter-api-key-input'), 'sk-openai-key');
    await user.press(screen.getByTestId('openrouter-models-refresh'));

    await waitFor(() => expect(mockedRefresh).toHaveBeenCalledTimes(1));
    expect(mockedListProviderModels).toHaveBeenCalledTimes(1);
    expect(mockedListProviderModels).toHaveBeenCalledWith('openai', {apiKey: 'sk-openai-key'});
  });

  it('shows a distinct loading state until the cached catalog has loaded', async () => {
    let resolveCached!: (snapshot: modelCatalog.CachedModelCatalog | null) => void;
    mockedGetCached.mockImplementation(
      () =>
        new Promise<modelCatalog.CachedModelCatalog | null>(resolve => {
          resolveCached = resolve;
        }),
    );

    await renderScreen();

    // While the local snapshot is being read the card neither shows the
    // empty message nor any model rows.
    expect(await screen.findByTestId('openrouter-models-catalog-loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('openrouter-models-empty')).toBeNull();

    resolveCached(catalogSnapshot());
    await waitFor(() =>
      expect(screen.queryByTestId('openrouter-models-catalog-loading')).toBeNull(),
    );
    expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen();
  });

  it('labels an aged snapshot as stale while its models remain fully usable', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot(CATALOG, '2020-01-01T00:00:00.000Z'));

    await renderSettledScreen();
    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen(),
    );

    expect(screen.getByTestId('openrouter-models-stale')).toHaveTextContent(/May be outdated/);

    // Staleness never removes functionality: rows stay selectable.
    await user.press(screen.getByTestId('openrouter-model-primary-vendor/model-b'));
    await waitFor(() =>
      expect(checkedStateOf('openrouter-model-primary-vendor/model-b')).toBe(true),
    );
  });

  it('does not label a freshly fetched snapshot as stale', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot(CATALOG, new Date().toISOString()));

    await renderSettledScreen();
    await waitFor(() =>
      expect(screen.getByTestId('openrouter-model-primary-vendor/model-a')).toBeOnTheScreen(),
    );

    expect(screen.queryByTestId('openrouter-models-stale')).toBeNull();
    expect(screen.getByTestId('openrouter-model-count')).toBeOnTheScreen();
  });
});

// TASK-AUDIT-016: the editor is serverless-only. A server-mode mount must
// show the mode notice and never touch serverless configuration storage.
describe('OpenRouterSettingsScreen in server mode (TASK-AUDIT-016)', () => {
  it('renders the serverless-only notice instead of the editor', async () => {
    await saveApplicationMode('server');
    setRuntimeApplicationMode('server');

    await renderScreen();

    await waitFor(() =>
      expect(screen.getByTestId('openrouter-mode-notice')).toBeOnTheScreen(),
    );
    expect(screen.getByText(/serverless feature/)).toBeOnTheScreen();
    expect(screen.queryByTestId('openrouter-api-key-input')).toBeNull();
    expect(screen.queryByTestId('openrouter-save')).toBeNull();
    expect(screen.queryByTestId('openrouter-models-refresh')).toBeNull();
  });

  it('reads no serverless configuration in server mode', async () => {
    await saveApplicationMode('server');
    setRuntimeApplicationMode('server');

    await renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('openrouter-mode-notice')).toBeOnTheScreen(),
    );

    expect(mockedLoadProvider).not.toHaveBeenCalled();
    expect(mockedLoadProviderState).not.toHaveBeenCalled();
    expect(mockedGetCached).not.toHaveBeenCalled();
    expect(mockedListProviderModels).not.toHaveBeenCalled();
  });
});

describe('long-press model tooltip', () => {
  it('reveals the full untruncated name and id and closes on tap', async () => {
    const longName = 'An Extremely Long Display Name That Cannot Fit The Truncated Row';
    mockedGetCached.mockResolvedValue(
      catalogSnapshot([catalogModel('vendor/very-long-model-identifier', longName)]),
    );
    await renderSettledScreen();

    expect(screen.queryByTestId('openrouter-model-tooltip')).toBeNull();

    await user.longPress(
      screen.getByTestId('openrouter-model-primary-vendor/very-long-model-identifier'),
    );

    const tooltip = screen.getByTestId('openrouter-model-tooltip');
    expect(tooltip).toBeOnTheScreen();
    expect(within(tooltip).getByText(longName)).toBeOnTheScreen();
    expect(within(tooltip).getByText('vendor/very-long-model-identifier')).toBeOnTheScreen();

    // A long press must not select the model as primary.
    expect(checkedStateOf('openrouter-model-primary-vendor/very-long-model-identifier')).toBe(
      false,
    );

    await user.press(tooltip);
    expect(screen.queryByTestId('openrouter-model-tooltip')).toBeNull();
  });

  it('shows the full id of a truncated fallback chain entry', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());
    mockedLoadProviderState.mockResolvedValue({
      apiKey: STORED_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: ['vendor/claude-x'],
    });
    await renderSettledScreen();

    await user.longPress(screen.getByTestId('openrouter-fallback-chip-0'));

    const tooltip = screen.getByTestId('openrouter-model-tooltip');
    expect(within(tooltip).getByText('vendor/claude-x')).toBeOnTheScreen();

    await user.press(tooltip);
    expect(screen.queryByTestId('openrouter-model-tooltip')).toBeNull();
  });
});

// TASK-IMPROVEMENT-004: the primary/fallback relationship must be
// understandable on the screen itself — a concise guide, a highlighted and
// badged primary row and an ordered chain with its semantics stated —
// without external documentation.
describe('primary/fallback configuration guide (TASK-IMPROVEMENT-004)', () => {
  it('shows the concise primary-vs-fallback guide inside the models card', async () => {
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();

    const guide = await screen.findByTestId('openrouter-model-guide');
    expect(guide).toBeOnTheScreen();
    expect(
      within(guide).getByText(/model you want to use first/i),
    ).toBeOnTheScreen();
    expect(
      within(guide).getByText(/default for conversations/i),
    ).toBeOnTheScreen();
    expect(
      within(guide).getByText(/alternative models used when the primary model fails/i),
    ).toBeOnTheScreen();
    expect(
      within(guide).getByText(/choose a reliable model as your primary model/i),
    ).toBeOnTheScreen();
  });

  it('does not render the guide before a catalog exists', async () => {
    await renderSettledScreen();

    expect(await screen.findByTestId('openrouter-models-empty')).toBeOnTheScreen();
    expect(screen.queryByTestId('openrouter-model-guide')).toBeNull();
  });

  it('highlights the selected primary row with a Primary badge', async () => {
    mockedLoadProviderState.mockResolvedValue({
      apiKey: STORED_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: [],
    });
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();

    const row = await screen.findByTestId('openrouter-model-primary-vendor/model-a');
    expect(row.props.accessibilityState).toMatchObject({checked: true});
    expect(
      screen.getByTestId('openrouter-model-primary-badge-vendor/model-a'),
    ).toBeOnTheScreen();

    // Switching the primary moves the highlight and badge to the new row.
    await user.press(screen.getByTestId('openrouter-model-primary-vendor/model-b'));
    await waitFor(() =>
      expect(
        screen.getByTestId('openrouter-model-primary-badge-vendor/model-b'),
      ).toBeOnTheScreen(),
    );
    expect(
      screen.queryByTestId('openrouter-model-primary-badge-vendor/model-a'),
    ).toBeNull();
  });

  it('styles the selected primary row with the accent wash and unselected rows without it', () => {
    const styles = createScreenStyles();

    expect(styles.modelRowSelected.backgroundColor).toBe(lightColors.accentSoft);
    expect('backgroundColor' in styles.modelRow).toBe(false);
  });

  it('explains that fallbacks are attempted in the displayed order', async () => {
    mockedLoadProviderState.mockResolvedValue({
      apiKey: STORED_KEY,
      primaryModel: 'vendor/model-a',
      fallbackModels: ['vendor/model-b', 'vendor/claude-x'],
    });
    mockedGetCached.mockResolvedValue(catalogSnapshot());

    await renderSettledScreen();

    expect(
      await screen.findByTestId('openrouter-fallback-order-note'),
    ).toHaveTextContent(/one after another, in this order/i);
    expect(screen.getByTestId('openrouter-fallback-chip-0')).toBeOnTheScreen();
    expect(screen.getByTestId('openrouter-fallback-chip-1')).toBeOnTheScreen();
  });
});
