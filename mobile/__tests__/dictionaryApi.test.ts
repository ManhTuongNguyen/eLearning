/**
 * Free Dictionary API client tests (WORD_BANK_V1 TASK-WB-003).
 *
 * All lookups run through an injected `fetch` seam — no test ever performs
 * real HTTP. The cases pin the outcome contract the generation pipeline
 * depends on: found (fully mapped senses/phonetics), not-found (404, unusable
 * JSON, zero usable senses) and unavailable (429, 5xx, network, timeout).
 */
import {
  DEFAULT_DICTIONARY_TIMEOUT_MS,
  DICTIONARY_API_BASE,
  DICTIONARY_ATTRIBUTION,
  lookupDictionaryWord,
  mapDictionaryResponse,
  type FetchFn,
} from '../src/serverless/dictionaryApi';

const TWO_ENTRY_RESPONSE = [
  {
    word: 'bank',
    phonetics: [{ text: '/bæŋk/' }, { audio: 'https://example.org/bank.mp3' }, { text: '/bæŋk/' }],
    meanings: [
      {
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'An institution that holds money.', example: 'I went to the bank.' },
          { definition: 'The land alongside a river.' },
        ],
      },
    ],
  },
  {
    word: 'bank',
    meanings: [
      {
        partOfSpeech: 'verb',
        definitions: [
          { definition: 'To rely on.', example: 'You can bank on it.' },
          { definition: '' }, // empty definition dropped
          'garbage',
        ],
      },
    ],
  },
  'not-an-entry',
];

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
  test('maps a multi-entry response fully: two POS groups, examples, IPA', () => {
    const { senses, phonetics } = mapDictionaryResponse(TWO_ENTRY_RESPONSE);

    expect(senses).toEqual([
      {
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'An institution that holds money.', example: 'I went to the bank.' },
          { definition: 'The land alongside a river.' },
        ],
      },
      { partOfSpeech: 'verb', definitions: [{ definition: 'To rely on.', example: 'You can bank on it.' }] },
    ]);
    // IPA texts kept and deduplicated; audio-only phonetics ignored.
    expect(phonetics).toEqual(['/bæŋk/']);
  });

  test('merges same-POS groups from different entries in order', () => {
    const { senses } = mapDictionaryResponse([
      {
        meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'First.' }] }],
      },
      {
        meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Second.' }] }],
      },
    ]);
    expect(senses).toEqual([
      { partOfSpeech: 'noun', definitions: [{ definition: 'First.' }, { definition: 'Second.' }] },
    ]);
  });

  test('malformed responses yield empty results instead of throwing', () => {
    expect(mapDictionaryResponse(null)).toEqual({ senses: [], phonetics: [] });
    expect(mapDictionaryResponse('nope')).toEqual({ senses: [], phonetics: [] });
    expect(mapDictionaryResponse([{ meanings: 'nope' }])).toEqual({ senses: [], phonetics: [] });
    expect(mapDictionaryResponse([{ meanings: [{ partOfSpeech: 'noun', definitions: [] }] }])).toEqual(
      { senses: [], phonetics: [] },
    );
  });
});

describe('lookupDictionaryWord', () => {
  test('requests the dictionary endpoint with the encoded word', async () => {
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

  test('404, unusable JSON and zero usable senses map to not-found', async () => {
    const notFound: FetchFn = async () => jsonResponse(404, { title: 'No Definitions Found' });
    await expect(lookupDictionaryWord('xyzzy', notFound)).resolves.toEqual({ outcome: 'not-found' });

    const brokenJson: FetchFn = async () =>
      jsonResponse(200, '{not json') as unknown as Response;
    await expect(lookupDictionaryWord('xyzzy', brokenJson)).resolves.toEqual({
      outcome: 'not-found',
    });

    const emptyBody: FetchFn = async () => jsonResponse(200, '') as unknown as Response;
    await expect(lookupDictionaryWord('xyzzy', emptyBody)).resolves.toEqual({
      outcome: 'not-found',
    });

    const noSenses: FetchFn = async () => jsonResponse(200, [{ phonetics: [{ text: '/x/' }] }]);
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
    await expect(
      lookupDictionaryWord('bank', hangsUntilAbort, { timeoutMs: 5 }),
    ).resolves.toEqual({ outcome: 'unavailable' });
  });

  test('a malformed entry is skipped without failing the whole lookup', async () => {
    const partial: FetchFn = async () =>
      jsonResponse(200, [
        'garbage',
        null,
        {
          meanings: [
            { partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] },
            { partOfSpeech: 42, definitions: [{ definition: 'Wrong POS, dropped.' }] },
          ],
        },
      ]);
    await expect(lookupDictionaryWord('bank', partial)).resolves.toEqual({
      outcome: 'found',
      senses: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Usable.' }] }],
      phonetics: [],
    });
  });

  test('exposes the attribution line and the default timeout', () => {
    expect(DICTIONARY_ATTRIBUTION).toContain('Wiktionary');
    expect(DICTIONARY_ATTRIBUTION).toContain('Free Dictionary API');
    expect(DEFAULT_DICTIONARY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
