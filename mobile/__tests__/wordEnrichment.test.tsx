/**
 * Word enrichment tests (WORD_BANK_V1 TASK-WB-014).
 *
 * Service level: prompt building (word, topic title, verbatim learner context,
 * additional prompt, current senses as context), tolerant parsing of the JSON
 * proposal, and the no-write contract of `enrichWord`. Screen level: the
 * change-review modal renders old vs new, Apply persists exactly the proposed
 * senses plus the two metadata fields with the schedule untouched, Cancel
 * leaves the row byte-identical, and invalid AI output writes nothing.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  applyWordEnrichment,
  createWordTopic,
  getWordById,
  insertWords,
} from '../src/db/wordRepository';
import { ModeProvider } from '../src/mode/ModeContext';
import { saveApplicationMode } from '../src/mode/modeStorage';
import type { WordDetailScreenProps } from '../src/navigation/types';
import { WordDetailScreen } from '../src/screens/WordDetailScreen';
import { OpenRouterResponseError } from '../src/serverless/errors';
import type { CompletionRequest, CompletionResult } from '../src/serverless/types';
import {
  buildEnrichUserPrompt,
  enrichWord,
  parseEnrichedSenses,
  WORD_ENRICHMENT_SYSTEM_PROMPT,
} from '../src/serverless/wordEnrichment';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

// --- Service level -----------------------------------------------------------

const OLD_SENSES = [
  { partOfSpeech: 'noun', definitions: [{ definition: 'An institution that holds money.' }] },
];
const NEW_SENSES = [
  {
    partOfSpeech: 'noun',
    definitions: [
      { definition: 'A bank is a financial institution.', example: 'She works at a bank.' },
      { definition: 'The land alongside a river.' },
    ],
  },
  { partOfSpeech: 'verb', definitions: [{ definition: 'To rely on.', example: 'Bank on me.' }] },
];

describe('word enrichment prompts', () => {
  const topic = {
    title: 'Cooking',
    description: "I'm a chef, I often read cooking blogs",
    extra_prompt: 'focus on kitchen verbs',
  };
  const word = { text: 'simmer', senses_json: OLD_SENSES };

  test('the user prompt contains word, title, verbatim context, extra prompt and senses', () => {
    const prompt = buildEnrichUserPrompt(word, topic);
    expect(prompt).toContain('"simmer"');
    expect(prompt).toContain('Cooking');
    expect(prompt).toContain("I'm a chef, I often read cooking blogs");
    expect(prompt).toContain('focus on kitchen verbs');
    expect(prompt).toContain(JSON.stringify(OLD_SENSES, null, 2));
  });

  test('a dataless word asks the AI to draft the full entry', () => {
    const prompt = buildEnrichUserPrompt(
      { text: 'blurble', senses_json: [] },
      { title: 'Cooking', description: 'chefs', extra_prompt: '' },
    );
    expect(prompt).toContain('NO stored data');
    expect(prompt).toContain('Draft the full entry yourself');
    expect(prompt).not.toContain('current data (context only');
  });

  test('the system prompt demands the stored JSON shape and context-only learner data', () => {
    expect(WORD_ENRICHMENT_SYSTEM_PROMPT).toContain('ONE sense object per part of speech');
    expect(WORD_ENRICHMENT_SYSTEM_PROMPT).toContain('"senses"');
    expect(WORD_ENRICHMENT_SYSTEM_PROMPT).toContain('"extraExamples"');
    expect(WORD_ENRICHMENT_SYSTEM_PROMPT).toContain('"synonyms"');
    expect(WORD_ENRICHMENT_SYSTEM_PROMPT).toContain('"tags"');
    expect(WORD_ENRICHMENT_SYSTEM_PROMPT).toContain('untrusted learner context');
  });
});

describe('parseEnrichedSenses', () => {
  test('parses a bare object, a fenced object and prose-wrapped JSON', () => {
    const bare = JSON.stringify({ senses: NEW_SENSES });
    expect(parseEnrichedSenses(bare)).toEqual(NEW_SENSES);
    expect(parseEnrichedSenses(`\`\`\`json\n${bare}\n\`\`\``)).toEqual(NEW_SENSES);
    expect(parseEnrichedSenses(`Here you go: ${bare} — enjoy!`)).toEqual(NEW_SENSES);
  });

  test('drops unusable entries and empty definitions', () => {
    const raw = JSON.stringify({
      senses: [
        'garbage',
        { partOfSpeech: '', definitions: [{ definition: 'No POS.' }] },
        { partOfSpeech: 'verb', definitions: [] },
        { partOfSpeech: 'noun', definitions: [{ definition: '   ' }, { definition: 'Valid.' }] },
      ],
    });
    expect(parseEnrichedSenses(raw)).toEqual([
      { partOfSpeech: 'noun', definitions: [{ definition: 'Valid.' }] },
    ]);
  });

  test('preserves tags, extra examples and relations from the proposal', () => {
    const raw = JSON.stringify({
      senses: [
        {
          partOfSpeech: 'adjective',
          synonyms: ['large', 'huge'],
          antonyms: ['little'],
          definitions: [
            {
              definition: 'Of great size.',
              example: 'A big house.',
              extraExamples: ['Big deal.', 'Big one.', 'Big time.', 'Too many.'],
              tags: ['informal', 'UK'],
              synonyms: ['ample'],
              antonyms: ['tiny'],
            },
          ],
        },
      ],
    });
    expect(parseEnrichedSenses(raw)).toEqual([
      {
        partOfSpeech: 'adjective',
        synonyms: ['large', 'huge'],
        antonyms: ['little'],
        definitions: [
          {
            definition: 'Of great size.',
            example: 'A big house.',
            extraExamples: ['Big deal.', 'Big one.', 'Big time.'], // capped at 3
            tags: ['informal', 'UK'],
            synonyms: ['ample'],
            antonyms: ['tiny'],
          },
        ],
      },
    ]);
  });

  test('consolidates repeated part-of-speech blocks into one group', () => {
    // Models often emit one block per definition; the parser must merge every
    // block that shares a part of speech so the proposal mirrors the
    // dictionary's structure (one block per POS).
    const raw = JSON.stringify({
      senses: [
        { partOfSpeech: 'noun', definitions: [{ definition: 'First noun sense.' }] },
        {
          partOfSpeech: 'verb',
          definitions: [{ definition: 'To rely on.', example: 'Bank on me.' }],
          synonyms: ['trust'],
        },
        { partOfSpeech: 'noun', definitions: [{ definition: 'Second noun sense.' }] },
        { partOfSpeech: 'noun', synonyms: ['ledger'], definitions: [{ definition: 'Third.' }] },
      ],
    });
    expect(parseEnrichedSenses(raw)).toEqual([
      {
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'First noun sense.' },
          { definition: 'Second noun sense.' },
          { definition: 'Third.' },
        ],
        synonyms: ['ledger'],
      },
      {
        partOfSpeech: 'verb',
        definitions: [{ definition: 'To rely on.', example: 'Bank on me.' }],
        synonyms: ['trust'],
      },
    ]);
  });

  test('empty or malformed senses are fatal', () => {
    expect(() => parseEnrichedSenses('{"senses": []}')).toThrow(OpenRouterResponseError);
    expect(() => parseEnrichedSenses('no object here')).toThrow(OpenRouterResponseError);
    expect(() => parseEnrichedSenses('{"senses": [1, 2]}')).toThrow(OpenRouterResponseError);
  });
});

describe('enrichWord', () => {
  test('returns the proposal without writing', async () => {
    const db = await openSqlJsDriver();
    await migrateDatabase(db);
    const complete = jest.fn(
      async (_request: CompletionRequest): Promise<CompletionResult> => ({
        text: JSON.stringify({ senses: NEW_SENSES }),
        model: 'test-model',
        finishReason: 'stop',
        requestId: null,
      }),
    );

    const proposal = await enrichWord(db, complete, {
      word: { text: 'simmer', senses_json: OLD_SENSES },
      topic: { title: 'Cooking', description: '', extra_prompt: '' },
    });
    expect(proposal).toEqual(NEW_SENSES);
    expect(complete).toHaveBeenCalledTimes(1);
    await db.close();
  });
});

// --- Screen level ------------------------------------------------------------

jest.mock('../src/db/database', () => {
  const actualMigrations = jest.requireActual('../src/db/migrations').migrateDatabase;
  const handle: { db: SqlDriver } = { db: undefined as never };
  return {
    getLocalDatabase: jest.fn(async () => {
      await actualMigrations(handle.db);
      return handle.db;
    }),
    resetLocalDatabase: jest.fn(),
    __setDriver: (driver: SqlDriver) => {
      handle.db = driver;
    },
  };
});

jest.mock('../src/serverless/settings', () => ({
  loadServerlessConfig: jest.fn(),
}));

jest.mock('../src/serverless/providerRegistry', () => ({
  createProviderClient: jest.fn(),
}));

jest.mock('../src/serverless/dictionaryApi', () => ({
  ...jest.requireActual('../src/serverless/dictionaryApi'),
  lookupDictionaryWord: jest.fn(),
}));

const database = jest.mocked(require('../src/db/database'));
const settings = jest.mocked(require('../src/serverless/settings'));
const registry = jest.mocked(require('../src/serverless/providerRegistry'));

const CONFIG = {
  provider: 'openrouter' as const,
  apiKey: 'test-key',
  primaryModel: 'test-model',
  fallbackModels: [],
};

const goBack = jest.fn();

function screenProps(wordId: number): WordDetailScreenProps {
  return {
    navigation: {
      navigate: jest.fn(),
      goBack,
      popToTop: jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    },
    route: { key: 'word-detail-enrich-test', name: 'WordDetail', params: { wordId } },
  } as unknown as WordDetailScreenProps;
}

let db: SqlDriver;
let complete: jest.Mock;

async function renderDetail(wordId: number) {
  await saveApplicationMode('serverless');
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <WordDetailScreen {...screenProps(wordId)} />
      </ThemeProvider>
    </ModeProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('word-detail-loading')).toBeFalsy();
  });
  return view;
}

beforeEach(async () => {
  jest.clearAllMocks();
  goBack.mockReset();
  db = await openSqlJsDriver();
  await migrateDatabase(db);
  database.__setDriver(db);
  settings.loadServerlessConfig.mockResolvedValue(CONFIG);
  complete = jest.fn();
  registry.createProviderClient.mockReturnValue({ complete } as never);
});

afterEach(async () => {
  db?.close?.();
});

describe('WordDetailScreen — change-review modal', () => {
  test('apply persists exactly the proposed senses and metadata; schedule untouched', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking', description: 'chefs' });
    const [word] = await insertWords(db, topic.id, [
      { text: 'simmer', senses_json: OLD_SENSES, phonetics_json: ['/ˈsɪmər/'] },
    ]);
    complete.mockResolvedValue({
      text: JSON.stringify({ senses: NEW_SENSES }),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderDetail(word.id);
    await fireEvent.press(view.getByTestId('word-detail-enrich'));

    await waitFor(() => {
      expect(view.queryByTestId('word-enrich-modal')).toBeTruthy();
    });
    // Current and proposed are paired row by row: row 0 holds the first
    // sense group of each side, aligned side by side.
    expect(screen.getByTestId('word-enrich-old-0')).toHaveTextContent(/An institution/);
    expect(screen.getByTestId('word-enrich-new-0')).toHaveTextContent(/financial institution/);
    // The proposed list has a second group where the current has none.
    expect(screen.getByTestId('word-enrich-old-1')).toHaveTextContent(/No data\./);
    expect(screen.getByTestId('word-enrich-new-1')).toHaveTextContent(/To rely on\./);
    // The paired list scrolls; the actions stay outside it.
    expect(screen.getByTestId('word-enrich-list-scroll').props.nestedScrollEnabled).toBe(true);
    expect(screen.getByTestId('word-enrich-apply')).toBeTruthy();
    expect(screen.getByTestId('word-enrich-cancel')).toBeTruthy();

    await fireEvent.press(view.getByTestId('word-enrich-apply'));
    await waitFor(() => {
      expect(view.queryByTestId('word-enrich-modal')).toBeFalsy();
    });

    const updated = await getWordById(db, word.id);
    expect(updated?.senses_json).toEqual(NEW_SENSES);
    expect(updated?.data_source).toBe('enriched');
    expect(updated?.enriched_at).toBeTruthy();
    // Phonetics and the FSRS state are untouched.
    expect(updated?.phonetics_json).toEqual(['/ˈsɪmər/']);
    expect(updated?.state).toBe('new');
    expect(updated?.reps).toBe(0);
    expect(updated?.due_at).toBe(word.due_at);
  });

  test('cancel leaves the row byte-identical', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [
      { text: 'simmer', senses_json: OLD_SENSES, phonetics_json: ['/ˈsɪmər/'] },
    ]);
    complete.mockResolvedValue({
      text: JSON.stringify({ senses: NEW_SENSES }),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderDetail(word.id);
    await fireEvent.press(view.getByTestId('word-detail-enrich'));
    await waitFor(() => {
      expect(view.queryByTestId('word-enrich-modal')).toBeTruthy();
    });

    await fireEvent.press(view.getByTestId('word-enrich-cancel'));
    await waitFor(() => {
      expect(view.queryByTestId('word-enrich-modal')).toBeFalsy();
    });

    const row = await getWordById(db, word.id);
    expect(row?.senses_json).toEqual(OLD_SENSES);
    expect(row?.data_source).toBe('dictionary');
    expect(row?.enriched_at).toBeNull();
  });

  test('invalid AI output surfaces an error and writes nothing', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [
      { text: 'simmer', senses_json: OLD_SENSES, phonetics_json: ['/ˈsɪmər/'] },
    ]);
    complete.mockResolvedValue({
      text: 'I cannot help with that.',
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderDetail(word.id);
    await fireEvent.press(view.getByTestId('word-detail-enrich'));

    await waitFor(() => {
      expect(view.getByTestId('word-detail-enrich-error')).toBeTruthy();
    });
    expect(view.queryByTestId('word-enrich-modal')).toBeFalsy();
    const row = await getWordById(db, word.id);
    expect(row?.senses_json).toEqual(OLD_SENSES);
    expect(row?.data_source).toBe('dictionary');
  });
});

describe('WordDetailScreen — AI enrichment of a dataless word', () => {
  test('enrich → apply completes a word the dictionary could not fill', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [missing] = await insertWords(db, topic.id, [{ text: 'blurble', data_status: 'missing' }]);
    complete.mockResolvedValue({
      text: JSON.stringify({ senses: NEW_SENSES }),
      model: 'test-model',
      finishReason: 'stop',
      requestId: null,
    });

    const view = await renderDetail(missing.id);
    // The fetch action is still there (dictionary first), but enrich is live.
    expect(view.getByTestId('word-detail-fetch')).toBeTruthy();
    await fireEvent.press(view.getByTestId('word-detail-enrich'));

    await waitFor(() => {
      expect(view.queryByTestId('word-enrich-modal')).toBeTruthy();
    });
    // The "current" column shows no data.
    expect(screen.getByTestId('word-enrich-old-0')).toHaveTextContent(/No data\./);

    await fireEvent.press(view.getByTestId('word-enrich-apply'));
    await waitFor(() => {
      expect(view.queryByTestId('word-enrich-modal')).toBeFalsy();
    });

    const updated = await getWordById(db, missing.id);
    expect(updated).toMatchObject({
      data_status: 'complete',
      data_source: 'enriched',
      state: 'new',
    });
    expect(updated?.senses_json).toEqual(NEW_SENSES);
    // The fetch action is gone now that the word has data.
    expect(view.queryByTestId('word-detail-fetch')).toBeNull();
  });
});

describe('applyWordEnrichment (repository)', () => {
  test('replaces senses wholesale and keeps phonetics', async () => {
    const topic = await createWordTopic(db, { title: 'Cooking' });
    const [word] = await insertWords(db, topic.id, [
      { text: 'simmer', senses_json: OLD_SENSES, phonetics_json: ['/ˈsɪmər/'] },
    ]);
    const enrichedAt = new Date().toISOString();
    const updated = await applyWordEnrichment(db, word.id, NEW_SENSES, enrichedAt);
    expect(updated).toMatchObject({
      data_source: 'enriched',
      enriched_at: enrichedAt,
      state: 'new',
    });
    expect(updated?.senses_json).toEqual(NEW_SENSES);
    expect(updated?.phonetics_json).toEqual(['/ˈsɪmər/']);

    // A word the dictionary could not fill becomes complete when its approved
    // AI proposal is applied — the only path that completes it.
    const [missing] = await insertWords(db, topic.id, [{ text: 'blurble', data_status: 'missing' }]);
    const completed = await applyWordEnrichment(db, missing.id, NEW_SENSES, enrichedAt);
    expect(completed).toMatchObject({
      data_status: 'complete',
      data_source: 'enriched',
      enriched_at: enrichedAt,
    });
    expect(completed?.senses_json).toEqual(NEW_SENSES);
    expect(completed?.phonetics_json).toEqual([]);

    expect(await applyWordEnrichment(db, 999, NEW_SENSES, enrichedAt)).toBeNull();
  });
});
