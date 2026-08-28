/**
 * Vocabulary API binding tests (SPEC TASK-066/070/074): saving is immediate
 * and never waits for enrichment, and the CSV export returns raw text while
 * normalizing failures through the shared ApiError contract.
 */

import {ApiError, apiRequest} from '../src/api/client';
import {API_BASE_URL} from '../src/config';
import {exportVocabulary, saveVocabulary} from '../src/api/vocabulary';
import type {AuthedRequester} from '../src/auth/authedRequest';

/** Fixed-token requester standing in for the provider-built authed requester. */
const requester: AuthedRequester = (path, options) =>
  apiRequest(path, {...options, token: 'tok'});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

const SAVED_ITEM = {
  id: 3,
  expression: 'the early bird',
  normalized_expression: 'the early bird',
  definition: '',
  translation: '',
  pronunciation: '',
  part_of_speech: '',
  example: '',
  status: 'pending',
  source_message: 810,
  source_session: 5,
  created_at: '2026-08-26T10:00:00Z',
};

describe('vocabulary api bindings', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts the expression and source message with auth headers', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(201, SAVED_ITEM));

    const item = await saveVocabulary(requester, 'the early bird', 810);

    expect(item.id).toBe(3);
    expect(item.status).toBe('pending');
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/vocabulary/`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({expression: 'the early bird', source_message_id: 810}),
        headers: expect.objectContaining({Authorization: 'Bearer tok'}),
      }),
    );
  });

  it('omits the source message field when none is given', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(201, {...SAVED_ITEM, source_message: null}));

    await saveVocabulary(requester, 'catch the worm');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      expression: 'catch the worm',
    });
  });

  it('treats the duplicate 200 response as a successful save', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, SAVED_ITEM));

    const item = await saveVocabulary(requester, 'The Early Bird', 810);

    expect(item.id).toBe(3);
    expect(item.expression).toBe('the early bird');
  });
});

describe('exportVocabulary (TASK-074 binding)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches the export endpoint and returns the raw CSV text untouched', async () => {
    const csv = 'Front,Back,Example,Pronunciation\n"set off","phrasal verb",,\n';
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(textResponse(200, csv));

    await expect(exportVocabulary('tok')).resolves.toBe(csv);

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/vocabulary/export/`,
      {
        method: 'GET',
        headers: {Accept: 'text/csv', Authorization: 'Bearer tok'},
      },
    );
  });

  it('normalizes DRF JSON error bodies through the shared ApiError contract', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        textResponse(401, JSON.stringify({detail: 'Invalid token.'})),
      );

    const error = await exportVocabulary('expired').catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('Invalid token.');
  });

  it('falls back to a generic message when an error body is not JSON', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(textResponse(503, '<html>gateway down</html>'));

    const error = await exportVocabulary('tok').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).message).toBe('Request failed (503).');
  });

  it('maps network failures to the offline ApiError', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));

    const error = await exportVocabulary('tok').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });
});
