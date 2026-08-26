import {
  createSession,
  deleteSession,
  getMessageSuggestions,
  getSession,
  listMessages,
  listSessions,
  renameSession,
} from '../src/api/sessions';

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
        next: 'http://10.0.2.2:8000/api/v1/sessions/?page=2',
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

    const page = await listSessions('tok');
    expect(page.count).toBe(25);
    expect(page.results[0]?.id).toBe(7);
    expect(page.results[0]?.learning_level).toBe('B2');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://10.0.2.2:8000/api/v1/sessions/');

    await listSessions('tok', 3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://10.0.2.2:8000/api/v1/sessions/?page=3');
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

    await createSession('tok');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://10.0.2.2:8000/api/v1/sessions/',
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

    await createSession('tok', 'Traveling');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://10.0.2.2:8000/api/v1/sessions/',
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

    const created = await createSession('tok');

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

    const session = await getSession('tok', 42);
    expect(session.title).toBe('Interview prep');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://10.0.2.2:8000/api/v1/sessions/42/',
      expect.objectContaining({method: 'GET'}),
    );
  });

  it('renames a session through PATCH with only the title', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, {id: 42, title: 'Renamed'}));

    await renameSession('tok', 42, 'Renamed');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://10.0.2.2:8000/api/v1/sessions/42/',
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

    await expect(deleteSession('tok', 42)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://10.0.2.2:8000/api/v1/sessions/42/',
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

    const page = await listMessages('tok', 9);
    expect(page.results.map(m => m.sequence)).toEqual([1, 2]);
    expect(page.results[1]).toMatchObject({role: 'assistant', status: 'failed'});
    expect(fetchMock).toHaveBeenCalledWith(
      'http://10.0.2.2:8000/api/v1/sessions/9/messages/',
      expect.objectContaining({method: 'GET'}),
    );
  });

  it('requests suggestions for a message with an empty POST body (TASK-061)', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {replies: ['First reply', 'Second reply', 'Third reply']}),
    );

    const result = await getMessageSuggestions('tok', 9, 44);

    expect(result.replies).toEqual(['First reply', 'Second reply', 'Third reply']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://10.0.2.2:8000/api/v1/sessions/9/messages/44/suggestions/',
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

    await expect(getMessageSuggestions('tok', 9, 44)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Suggestions require a completed, non-empty message.',
    });
  });
});
