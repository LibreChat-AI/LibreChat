/** Backing store so `get` reflects prior `set`/`delete` — addTitle reads the cache
 *  back to avoid clobbering a replacement stream's title on abort. */
const mockCacheStore = new Map();
const mockCache = {
  get: jest.fn((key) => mockCacheStore.get(key)),
  set: jest.fn((key, value) => mockCacheStore.set(key, value)),
  delete: jest.fn((key) => mockCacheStore.delete(key)),
};
const mockSaveConvo = jest.fn();
const mockGetConvo = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: (val) => val === true || val === 'true',
  sanitizeTitle: (title) => title,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('~/cache/getLogStores', () => jest.fn(() => mockCache));

jest.mock('~/models', () => ({
  saveConvo: (...args) => mockSaveConvo(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

const addTitle = require('./title');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const makeClient = (title = 'Generated Title') => ({
  options: { titleConvo: true },
  titleConvo: jest.fn().mockResolvedValue(title),
});

const makeReq = () => ({ user: { id: 'user-1' }, body: {}, config: {} });

describe('agents addTitle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheStore.clear();
    mockCache.get.mockReset().mockImplementation((key) => mockCacheStore.get(key));
    mockCache.set.mockReset().mockImplementation((key, value) => mockCacheStore.set(key, value));
    mockCache.delete.mockReset().mockImplementation((key) => mockCacheStore.delete(key));
    mockSaveConvo.mockReset().mockImplementation(async (_ctx, data) => data);
    mockGetConvo.mockReset().mockResolvedValue(null);
  });

  it('uses the explicit conversationId for the cache key and saveConvo (immediate mode)', async () => {
    const client = makeClient('My Title');

    await addTitle(makeReq(), {
      text: 'hello',
      client,
      conversationId: 'cid-immediate',
      immediate: true,
      convoReady: Promise.resolve(),
    });

    expect(mockCache.set).toHaveBeenCalledWith(
      'user-1-cid-immediate',
      'My Title',
      expect.any(Number),
    );
    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'cid-immediate', title: 'My Title' }),
      expect.objectContaining({ noUpsert: true }),
    );
  });

  it('passes immediate:true through to client.titleConvo', async () => {
    const client = makeClient();

    await addTitle(makeReq(), {
      text: 'hello',
      client,
      conversationId: 'cid',
      immediate: true,
      convoReady: Promise.resolve(),
    });

    expect(client.titleConvo).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
  });

  it('falls back to response.conversationId in legacy (final) mode', async () => {
    const client = makeClient('Legacy Title');

    await addTitle(makeReq(), {
      text: 'hi',
      client,
      response: { conversationId: 'resp-cid' },
    });

    expect(mockCache.set).toHaveBeenCalledWith(
      'user-1-resp-cid',
      'Legacy Title',
      expect.any(Number),
    );
    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'resp-cid', title: 'Legacy Title' }),
      expect.objectContaining({ noUpsert: true }),
    );
    expect(client.titleConvo).toHaveBeenCalledWith(expect.objectContaining({ immediate: false }));
  });

  it('caches eagerly but waits for readiness before persisting', async () => {
    const client = makeClient('Deferred Title');
    let resolveConvo;
    const convoReady = new Promise((resolve) => {
      resolveConvo = resolve;
    });

    mockSaveConvo.mockImplementationOnce(async (_ctx, data) => {
      await convoReady;
      return data;
    });
    const pending = addTitle(makeReq(), {
      text: 'hello',
      client,
      conversationId: 'cid-defer',
      immediate: true,
      convoReady,
    });

    await flush();

    expect(mockCacheStore.get('user-1-cid-defer')).toBe('Deferred Title');
    expect(mockSaveConvo).not.toHaveBeenCalled();

    resolveConvo();
    await pending;

    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'cid-defer', title: 'Deferred Title' }),
      expect.objectContaining({ noUpsert: true }),
    );
  });

  it('emits eagerly but waits for readiness before committing', async () => {
    const order = [];
    const client = makeClient('Streamed Title');
    const onTitleGenerated = jest.fn(async () => {
      order.push('title-event');
    });
    let resolveConvo;
    const convoReady = new Promise((resolve) => {
      resolveConvo = resolve;
    });

    mockCache.set.mockImplementationOnce((key, value) => {
      order.push('cache');
      mockCacheStore.set(key, value);
    });
    mockSaveConvo.mockImplementationOnce(async (_ctx, data) => {
      await convoReady;
      order.push('save');
      return data;
    });

    const pending = addTitle(makeReq(), {
      text: 'hello',
      client,
      conversationId: 'cid-stream',
      immediate: true,
      convoReady,
      onTitleGenerated,
    });

    await flush();

    expect(onTitleGenerated).toHaveBeenCalledWith({
      conversationId: 'cid-stream',
      title: 'Streamed Title',
    });
    expect(order).toEqual(['cache', 'title-event']);
    expect(mockSaveConvo).not.toHaveBeenCalled();

    resolveConvo();
    await pending;

    expect(order).toEqual(['cache', 'title-event', 'save']);
  });

  it('replaces a blocked generated title before caching, emitting, or saving it', async () => {
    const client = makeClient('BLOCKED-TITLE');
    const req = makeReq();
    req.config.filters = {
      conversationTitles: {
        pii: {
          starterPatterns: [],
          customPatterns: [{ id: 'blocked', label: 'blocked', regex: 'BLOCKED' }],
        },
      },
    };
    const onTitleGenerated = jest.fn();
    await addTitle(req, {
      text: 'hello',
      client,
      conversationId: 'cid-filtered',
      immediate: true,
      convoReady: Promise.resolve(),
      onTitleGenerated,
    });

    expect(mockCache.set).toHaveBeenCalledWith('user-1-cid-filtered', 'New Chat', 120000);
    expect(onTitleGenerated).toHaveBeenCalledWith({
      conversationId: 'cid-filtered',
      title: 'New Chat',
    });
    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'cid-filtered', title: 'New Chat' }),
      expect.objectContaining({ noUpsert: true }),
    );
  });

  it('skips generation when the endpoint disables titleConvo', async () => {
    const client = makeClient();
    client.options.titleConvo = false;

    await addTitle(makeReq(), { text: 'hi', client, conversationId: 'cid', immediate: true });

    expect(client.titleConvo).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
  });

  it('skips generation for temporary conversations', async () => {
    const client = makeClient();
    const req = makeReq();
    req.body.isTemporary = true;

    await addTitle(req, { text: 'hi', client, conversationId: 'cid', immediate: true });

    expect(client.titleConvo).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
  });

  it('skips generation when neither conversationId nor response is provided', async () => {
    const client = makeClient();

    await addTitle(makeReq(), { text: 'hi', client });

    expect(client.titleConvo).not.toHaveBeenCalled();
    expect(mockCache.set).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
  });

  it('propagates the abort signal to the title model call', async () => {
    const client = makeClient();
    const ac = new AbortController();
    ac.abort();

    await addTitle(makeReq(), {
      text: 'hi',
      client,
      conversationId: 'cid',
      immediate: true,
      convoReady: Promise.resolve(),
      signal: ac.signal,
    });

    const { abortController } = client.titleConvo.mock.calls[0][0];
    expect(abortController.signal.aborted).toBe(true);
  });

  it('discards the title without persisting when the stream is superseded', async () => {
    const client = makeClient();
    const ac = new AbortController();
    const onTitleGenerated = jest.fn();
    ac.abort();

    await addTitle(makeReq(), {
      text: 'hi',
      client,
      conversationId: 'cid',
      immediate: true,
      convoReady: Promise.resolve(),
      signal: ac.signal,
      discardSignal: ac.signal,
      onTitleGenerated,
    });

    expect(onTitleGenerated).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it("does not delete a replacement stream's cached title when superseded", async () => {
    const client = makeClient('Stale Title');
    const ac = new AbortController();
    let resolveConvo;
    const convoReady = new Promise((resolve) => {
      resolveConvo = resolve;
    });
    const pending = addTitle(makeReq(), {
      text: 'hi',
      client,
      conversationId: 'cid',
      immediate: true,
      convoReady,
      discardSignal: ac.signal,
    });
    await flush();
    mockCacheStore.set('user-1-cid', 'Newer Title');
    ac.abort();
    resolveConvo();
    await pending;
    expect(mockCacheStore.get('user-1-cid')).toBe('Newer Title');
    expect(mockCache.delete).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
  });

  it('persists a title generated before a user Stop (signal aborted, not superseded)', async () => {
    const client = makeClient('Kept Title');
    // `signal` represents a user Stop; no `discardSignal` since the stream is not
    // superseded. The title finishes generating and is emitted before the Stop.
    const ac = new AbortController();
    const onTitleGenerated = jest.fn();
    let resolveConvo;
    const convoReady = new Promise((resolve) => {
      resolveConvo = resolve;
    });

    mockSaveConvo.mockImplementationOnce(async (_ctx, data) => {
      await convoReady;
      return data;
    });
    const pending = addTitle(makeReq(), {
      text: 'hi',
      client,
      conversationId: 'cid',
      immediate: true,
      convoReady,
      signal: ac.signal,
      onTitleGenerated,
    });

    await flush();
    expect(onTitleGenerated).toHaveBeenCalledTimes(1);

    // User stops mid-response, then the conversation row is persisted.
    ac.abort();
    resolveConvo();
    await pending;

    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'cid', title: 'Kept Title' }),
      expect.objectContaining({ noUpsert: true }),
    );
    expect(mockCache.set).toHaveBeenCalledWith('user-1-cid', 'Kept Title', 120000);
    expect(onTitleGenerated).toHaveBeenCalledTimes(1);
  });

  /** An immediate-mode title saves while the turn is still running, so its write can
   *  overlap the response's. Rebuilding `messages` from a pre-response snapshot would
   *  erase the response's own appended id for good, so the title asks for the
   *  metadata-only path: an empty append writes the title and touches nothing else. */
  it('saves the title without rewriting the conversation message array', async () => {
    const client = makeClient('Metadata Only');

    await addTitle(makeReq(), {
      text: 'hello',
      client,
      conversationId: 'cid-metadata',
      immediate: true,
      convoReady: Promise.resolve(),
    });

    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'cid-metadata', title: 'Metadata Only' }),
      expect.objectContaining({ noUpsert: true, appendMessageIds: [] }),
    );
  });
  it('caches the committed manual title instead of a rejected automatic title', async () => {
    mockSaveConvo.mockResolvedValueOnce(null);
    mockGetConvo.mockResolvedValueOnce({ conversationId: 'cid', title: 'Renamed' });
    const onTitleGenerated = jest.fn();
    await addTitle(makeReq(), {
      text: 'hi',
      client: makeClient(),
      conversationId: 'cid',
      onTitleGenerated,
    });
    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ titleSource: 'generated' }),
    );
    expect(mockCache.set).toHaveBeenCalledWith('user-1-cid', 'Renamed', 120000);
    expect(onTitleGenerated).not.toHaveBeenCalled();
  });
  it('publishes eagerly while a new row is still absent, then fences persistence', async () => {
    let resolveConvo;
    const convoReady = new Promise((resolve) => {
      resolveConvo = resolve;
    });
    const onTitleGenerated = jest.fn();
    const pending = addTitle(makeReq(), {
      text: 'hello',
      client: makeClient('Eager Title'),
      conversationId: 'new-row',
      immediate: true,
      convoReady,
      onTitleGenerated,
    });
    await flush();
    expect(onTitleGenerated).toHaveBeenCalledWith({
      conversationId: 'new-row',
      title: 'Eager Title',
    });
    mockSaveConvo.mockResolvedValueOnce(null);
    mockGetConvo.mockResolvedValueOnce({ conversationId: 'new-row', title: 'Renamed' });
    resolveConvo();
    await pending;
    expect(mockCacheStore.get('user-1-new-row')).toBe('Renamed');
    expect(onTitleGenerated).toHaveBeenCalledTimes(1);
  });
  it('retries a missed immediate write when the following read sees the new row', async () => {
    mockSaveConvo.mockResolvedValueOnce(null);
    mockGetConvo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ conversationId: 'insert-race', title: 'New Chat' });
    const onTitleGenerated = jest.fn();
    await addTitle(makeReq(), {
      text: 'hello',
      client: makeClient('Generated title'),
      conversationId: 'insert-race',
      immediate: true,
      convoReady: Promise.resolve(),
      onTitleGenerated,
    });
    expect(mockSaveConvo).toHaveBeenCalledTimes(2);
    expect(mockCacheStore.get('user-1-insert-race')).toBe('Generated title');
    expect(onTitleGenerated).toHaveBeenCalledWith({
      conversationId: 'insert-race',
      title: 'Generated title',
    });
  });
  it('discards an eager title for a seeded chat before its message is ready', async () => {
    let resolveConvo;
    const convoReady = new Promise((resolve) => {
      resolveConvo = resolve;
    });
    const discard = new AbortController();
    mockGetConvo.mockResolvedValueOnce({ conversationId: 'seeded-chat', title: 'New Chat' });
    const pending = addTitle(makeReq(), {
      text: 'attachment',
      client: makeClient('Seeded title'),
      conversationId: 'seeded-chat',
      immediate: true,
      convoReady,
      discardSignal: discard.signal,
    });
    await flush();
    expect(mockCacheStore.get('user-1-seeded-chat')).toBe('Seeded title');
    expect(mockSaveConvo).not.toHaveBeenCalled();
    discard.abort();
    resolveConvo();
    await pending;
    expect(mockSaveConvo).not.toHaveBeenCalled();
    expect(mockCacheStore.has('user-1-seeded-chat')).toBe(false);
  });
});
