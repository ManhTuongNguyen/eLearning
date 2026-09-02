import {
  createSession,
  deleteSession,
  getMessageSuggestions,
  getSession,
  improveMessage,
  listMessages,
  listSessions,
  renameSession,
} from '../src/api/sessions';
import {apiRequest} from '../src/api/client';
import {API_BASE_URL} from '../src/config';
import type {AuthedRequester} from '../src/auth/authedRequest';
import {setRuntimeApplicationMode} from '../src/mode/runtime';

// Server-transport tests: pin the runtime holder because fresh installs now
// default to serverless.
beforeEach(() => {
  setRuntimeApplicationMode('server');
});

/** Fixed-token requester standing in for the provider-built authed requester. */
const requester: AuthedRequester = (path, options) => apiRequest(path, {...options, token: 'tok'});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('sessions api bindings', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists sessions with pagination envelope and optional page query', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        count: 25,
        next: `${API_BASE_URL}/api/v1/sessions/?page=2`,
        previous: null,
        results: [
          {
            id: 7,
            title: 'Small talk',
            topic: 'Everyday greetings',
            topic_hint: '',
            learning_level: 'B2',
            created_at: '2026-08-26T10:00:00Z',
          },
        ],
      }),
    );

    const page = await listSessions(requester);
    expect(page.count).toBe(25);
    expect(page.results[0]?.id).toBe(7);
    expect(page.results[0]?.learning_level).toBe('B2');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/api/v1/sessions/`);

    await listSessions(requester, 3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${API_BASE_URL}/api/v1/sessions/?page=3`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {Authorization: 'Bearer tok'},
    });
  });

  it('creates a session with an empty body when no topic hint is given', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse(201, {id: 1, title: 'Travel', topic_hint: '', learning_level: 'AUTO'}),
      );

    await createSession(requester);

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/sessions/`,
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({Authorization: 'Bearer tok'}),
      }),
    );
  });

  it('sends the topic hint on creation when provided', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(201, {id: 2}));

    await createSession(requester, 'Traveling');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/sessions/`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({topic_hint: 'Traveling'}),
      }),
    );
  });

  it('surfaces the generated sample conversation from the creation response', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, {
        id: 12,
        title: 'Travel',
        topic: 'Talking about trips',
        topic_hint: '',
        learning_level: 'B1',
        created_at: '2026-08-26T10:00:00Z',
        sample_conversation: {
          turns: [
            {role: 'assistant', content: 'Where would you like to go?'},
            {role: 'user', content: 'Somewhere sunny.'},
          ],
        },
      }),
    );

    const created = await createSession(requester);

    // TASK-053 depends on this envelope surviving the typed binding.
    expect(created.sample_conversation?.turns).toHaveLength(2);
    expect(created.sample_conversation?.turns[0]).toMatchObject({
      role: 'assistant',
      content: 'Where would you like to go?',
    });
  });

  it('fetches a single session by id', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, {id: 42, title: 'Interview prep'}));

    const session = await getSession(requester, 42);
    expect(session.title).toBe('Interview prep');
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/sessions/42/`,
      expect.objectContaining({method: 'GET'}),
    );
  });

  it('renames a session through PATCH with only the title', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, {id: 42, title: 'Renamed'}));

    await renameSession(requester, 42, 'Renamed');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/sessions/42/`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({title: 'Renamed'}),
      }),
    );
  });

  it('deletes a session and resolves void', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(204, null));

    await expect(deleteSession(requester, 42)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/sessions/42/`,
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({Authorization: 'Bearer tok'}),
      }),
    );
  });

  it('lists messages for a session in sequence order', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        count: 2,
        next: null,
        previous: null,
        results: [
          {id: 1, role: 'user', status: 'complete', content: 'Hi', sequence: 1, created_at: 'x'},
          {
            id: 2,
            role: 'assistant',
            status: 'failed',
            content: '',
            sequence: 2,
            created_at: 'y',
          },
        ],
      }),
    );

    const page = await listMessages(requester, 9);
    expect(page.results.map(m => m.sequence)).toEqual([1, 2]);
    expect(page.results[1]).toMatchObject({role: 'assistant', status: 'failed'});
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/sessions/9/messages/`,
      expect.objectContaining({method: 'GET'}),
    );
  });

  it('requests suggestions for a message with an empty POST body (TASK-061)', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {replies: ['First reply', 'Second reply', 'Third reply']}),
    );

    const result = await getMessageSuggestions(requester, 9, 44);

    expect(result.replies).toEqual(['First reply', 'Second reply', 'Third reply']);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/sessions/9/messages/44/suggestions/`,
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({Authorization: 'Bearer tok'}),
      }),
    );
  });

  it('normalizes suggestion endpoint failures into ApiError with the DRF detail', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(409, {detail: 'Suggestions require a completed, non-empty message.'}),
    );

    await expect(getMessageSuggestions(requester, 9, 44)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Suggestions require a completed, non-empty message.',
    });
  });

  it('requests an improvement for a message with an empty POST body (TASK-063)', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        original: 'I go to store yesterday.',
        improved: 'I went to the store yesterday.',
        explanation: 'Use the past tense "went" and add the article "the".',
      }),
    );

    const result = await improveMessage(requester, 9, 44);

    expect(result).toEqual({
      original: 'I go to store yesterday.',
      improved: 'I went to the store yesterday.',
      explanation: 'Use the past tense "went" and add the article "the".',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/sessions/9/messages/44/improve/`,
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({Authorization: 'Bearer tok'}),
      }),
    );
  });

  it('normalizes improvement endpoint failures into ApiError with the DRF detail', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(409, {detail: 'Improvement requires a non-empty user message.'}),
    );

    await expect(improveMessage(requester, 9, 44)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Improvement requires a non-empty user message.',
    });
  });
});
