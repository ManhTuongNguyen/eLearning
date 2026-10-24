/**
 * Free Dictionary API client tests (WORD_BANK_V1 TASK-WB-003).
 *
 * All lookups run through an injected `fetch` seam — no test ever performs
 * real HTTP. The fixtures mirror the v1 response of freedictionaryapi.com
 * (a single object with `entries`, tagged IPA pronunciations, senses with
 * examples/tags/synonyms/antonyms and nested subsenses). The cases pin the
 * outcome contract the generation pipeline depends on: found (fully mapped),
 * not-found (404, HTTP 200 with empty entries, unusable JSON, zero usable
 * senses) and unavailable (429, 5xx, network, timeout).
 */
import {
  DEFAULT_DICTIONARY_TIMEOUT_MS,
  DICTIONARY_API_BASE,
  DICTIONARY_ATTRIBUTION,
  type FetchFn,
  lookupDictionaryWord,
  mapDictionaryResponse,
} from '../src/serverless/dictionaryApi';

/** A realistic slice of the v1 response for "hello". */
const TWO_ENTRY_RESPONSE = {
  word: 'hello',
  entries: [
    {
      language: { code: 'en', name: 'English' },
      partOfSpeech: 'interjection',
      pronunciations: [
        { type: 'ipa', text: '/hɛˈloʊ/', tags: ['General American'] },
        { type: 'audio', src: 'https://example.org/hello.mp3' }, // ignored: TTS-only policy
        { type: 'ipa', text: '/həˈloʊ/', tags: ['General American'] },
        { type: 'ipa', text: '/həˈləʊ/', tags: ['Received Pronunciation'] },
        { type: 'ipa', text: '/hɛˈloʊ/', tags: ['Canada'] }, // duplicate text, dropped
      ],
      forms: [{ word: 'hallo', tags: ['alternative'] }], // not stored
      senses: [
        {
          definition: 'A greeting said when meeting someone.',
          tags: [],
          examples: ['Hello, everyone.', 'Hello again!'],
          quotes: [{ text: '…', reference: '1913, …' }], // not stored
          synonyms: [],
          antonyms: [],
          subsenses: [],
        },
        {
          definition: 'A call for response if no one is present.',
          tags: [],
          examples: ['Hello? Is anyone there?'],
          synonyms: [],
          antonyms: [],
          subsenses: [
            { definition: 'A flatted greeting.', examples: ['Hello there, flat friend.'] },
          ],
        },
      ],
      synonyms: ['g’d8ay', 'hey', 'hi', 'howdy', 'yo', 'sup', 'salutations', 'shalom', 'cheerio'],
      antonyms: ['bye', 'goodbye'],
    },
    {
      language: { code: 'en', name: 'English' },
      partOfSpeech: 'noun',
      pronunciations: [{ type: 'ipa', text: '/ˈhɛloʊ/' }],
      senses: [
        {
          definition: '"Hello!" or an equivalent greeting.',
          tags: [],
          examples: ['They gave each other a quick hello.'],
          synonyms: ['greeting'],
          antonyms: [],
        },
        'garbage', // non-object sense dropped
        { definition: '' }, // empty definition dropped
      ],
      synonyms: [],
      antonyms: [],
    },
    'not-an-entry', // non-object entry dropped
  ],
  source: { url: 'https://en.wiktionary.org', license: { name: 'CC BY-SA 4.0' } },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof body === 'string') {
        return JSON.parse(body) as unknown;
      }
      return body;
    },
  } as unknown as Response;
}

describe('mapDictionaryResponse', () => {
  test('maps the v1 object shape fully: senses, examples, relations, IPA', () => {
    const { senses, phonetics } = mapDictionaryResponse(TWO_ENTRY_RESPONSE);

    expect(senses).toEqual([
      {
        partOfSpeech: 'interjection',
        definitions: [
          {
            definition: 'A greeting said when meeting someone.',
            example: 'Hello, everyone.',
            extraExamples: ['Hello again!'],
          },
          {
            definition: 'A call for response if no one is present.',
            example: 'Hello? Is anyone there?',
          },
          // Subsenses flatten into the parent sense's definition list.
          { definition: 'A flatted greeting.', example: 'Hello there, flat friend.' },
        ],
        // Entry-level synonyms are capped at 8; audio-only pronunciations are
        // ignored and duplicate IPA texts are dropped.
        synonyms: ['g’d8ay', 'hey', 'hi', 'howdy', 'yo', 'sup', 'salutations', 'shalom'],
        antonyms: ['bye', 'goodbye'],
      },
      {
        partOfSpeech: 'noun',
        definitions: [
          {
            definition: '"Hello!" or an equivalent greeting.',
            example: 'They gave each other a quick hello.',
            synonyms: ['greeting'],
          },
        ],
      },
    ]);
    expect(phonetics).toEqual(['/hɛˈloʊ/', '/həˈloʊ/', '/həˈləʊ/', '/ˈhɛloʊ/']);
  });

  test('maps usage tags and caps the extra data', () => {
    const { senses } = mapDictionaryResponse({
      entries: [
        {
          partOfSpeech: 'adjective',
          senses: [
            {
              definition: 'Of great size.',
              tags: ['informal', 'UK', 'archaic', 'one-too-many'],
              examples: ['A big house.', 'Big deal.', 'Big one.', 'Fourth dropped.'],
              synonyms: ['large', 'huge', 'ample', 's1', 's2', 's3', 's4', 's5', 's9'],
              antonyms: ['little', 'small', 'tiny', 'a1', 'a2', 'a3', 'a4', 'a5', 'a9'],
            },
          ],
        },
      ],
    });

    expect(senses).toHaveLength(1);
    const [definition] = senses[0].definitions;
    expect(definition.tags).toEqual(['informal', 'UK', 'archaic']); // capped at 3
    expect(definition.example).toBe('A big house.');
    expect(definition.extraExamples).toEqual(['Big deal.', 'Big one.', 'Fourth dropped.']); // capped at 3
    expect(definition.synonyms).toHaveLength(8); // capped at 8
    expect(definition.antonyms).toHaveLength(8);
  });

  test('merges same-POS groups from different entries in order', () => {
    const { senses } = mapDictionaryResponse({
      entries: [
        { partOfSpeech: 'noun', senses: [{ definition: 'First.' }] },
        { partOfSpeech: 'noun', senses: [{ definition: 'Second.' }] },
      ],
    });
    expect(senses).toEqual([
      { partOfSpeech: 'noun', definitions: [{ definition: 'First.' }, { definition: 'Second.' }] },
    ]);
  });

  test('malformed responses yield empty results instead of throwing', () => {
    expect(mapDictionaryResponse(null)).toEqual({ senses: [], phonetics: [] });
    expect(mapDictionaryResponse('nope')).toEqual({ senses: [], phonetics: [] });
    expect(mapDictionaryResponse({})).toEqual({ senses: [], phonetics: [] });
    expect(mapDictionaryResponse({ entries: 'nope' })).toEqual({ senses: [], phonetics: [] });
    expect(mapDictionaryResponse([{ senses: 'nope' }])).toEqual({ senses: [], phonetics: [] });
    expect(mapDictionaryResponse({ entries: [{ partOfSpeech: 'noun', senses: [] }] })).toEqual({
      senses: [],
      phonetics: [],
    });
  });
});

describe('lookupDictionaryWord', () => {
  test('requests the v1 endpoint with the encoded word', async () => {
    const requested: string[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      requested.push(url);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(200, TWO_ENTRY_RESPONSE);
    };

    const result = await lookupDictionaryWord('flat white', fetchFn);
    expect(requested).toEqual([`${DICTIONARY_API_BASE}/flat%20white`]);
    expect(result).toEqual({
      outcome: 'found',
      senses: expect.any(Array),
      phonetics: expect.any(Array),
    });
  });

  test('404, HTTP 200 with empty entries, unusable JSON and zero senses map to not-found', async () => {
    const notFound: FetchFn = async () => jsonResponse(404, { title: 'No Definitions Found' });
    await expect(lookupDictionaryWord('xyzzy', notFound)).resolves.toEqual({
      outcome: 'not-found',
    });

    // The v1 API reports a missing word with HTTP 200 and an empty entry list.
    const emptyEntries: FetchFn = async () =>
      jsonResponse(200, { word: 'xyzzy', entries: [], source: {} });
    await expect(lookupDictionaryWord('xyzzy', emptyEntries)).resolves.toEqual({
      outcome: 'not-found',
    });

    const brokenJson: FetchFn = async () => jsonResponse(200, '{not json') as unknown as Response;
    await expect(lookupDictionaryWord('xyzzy', brokenJson)).resolves.toEqual({
      outcome: 'not-found',
    });

    const emptyBody: FetchFn = async () => jsonResponse(200, '') as unknown as Response;
    await expect(lookupDictionaryWord('xyzzy', emptyBody)).resolves.toEqual({
      outcome: 'not-found',
    });

    const noSenses: FetchFn = async () =>
      jsonResponse(200, {
        entries: [{ partOfSpeech: 'noun', pronunciations: [{ type: 'ipa', text: '/x/' }] }],
      });
    await expect(lookupDictionaryWord('xyzzy', noSenses)).resolves.toEqual({
      outcome: 'not-found',
    });
  });

  test('429, 5xx, network errors and timeouts map to unavailable', async () => {
    const rateLimited: FetchFn = async () => jsonResponse(429, {});
    await expect(lookupDictionaryWord('bank', rateLimited)).resolves.toEqual({
      outcome: 'unavailable',
    });

    const serverError: FetchFn = async () => jsonResponse(503, {});
    await expect(lookupDictionaryWord('bank', serverError)).resolves.toEqual({
      outcome: 'unavailable',
    });

    const networkDown: FetchFn = async () => {
      throw new Error('network down');
    };
    await expect(lookupDictionaryWord('bank', networkDown)).resolves.toEqual({
      outcome: 'unavailable',
    });

    const hangsUntilAbort: FetchFn = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(lookupDictionaryWord('bank', hangsUntilAbort, { timeoutMs: 5 })).resolves.toEqual({
      outcome: 'unavailable',
    });
  });

  test('a malformed entry is skipped without failing the whole lookup', async () => {
    const partial: FetchFn = async () =>
      jsonResponse(200, {
        entries: [
          'garbage',
          null,
          {
            partOfSpeech: 'noun',
            senses: [{ definition: 'Usable.' }],
          },
        ],
      });
    await expect(lookupDictionaryWord('bank', partial)).resolves.toEqual({
      outcome: 'found',
      senses: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] }],
      phonetics: [],
    });
  });

  test('exposes the attribution line and the default timeout', () => {
    expect(DICTIONARY_ATTRIBUTION).toContain('Wiktionary');
    expect(DICTIONARY_ATTRIBUTION).toContain('CC BY-SA 4.0');
    expect(DICTIONARY_ATTRIBUTION).toContain('Free Dictionary API');
    expect(DEFAULT_DICTIONARY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DICTIONARY_API_BASE).toContain('freedictionaryapi.com');
  });
});
