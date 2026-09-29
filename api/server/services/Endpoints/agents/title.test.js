/** Backing store so `get` reflects prior `set`/`delete` — addTitle reads the cache
 *  back to avoid clobbering a replacement stream's title on abort. */
const mockCacheStore = new Map();
const mockCache = {
  get: jest.fn((key) => mockCacheStore.get(key)),
  set: jest.fn((key, value) => mockCacheStore.set(key, value)),
  delete: jest.fn((key) => mockCacheStore.delete(key)),
};
const mockSaveConvo = jest.fn();

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

  it('caches the title immediately but defers saveConvo until convoReady resolves', async () => {
    const client = makeClient('Deferred Title');
    let resolveConvo;
    const convoReady = new Promise((resolve) => {
      resolveConvo = resolve;
    });

    const pending = addTitle(makeReq(), {
      text: 'hello',
      client,
      conversationId: 'cid-defer',
      immediate: true,
      convoReady,
    });

    await flush();

    // Title is cached for the live UI, but persistence waits for the row to exist.
    expect(mockCache.set).toHaveBeenCalledWith(
      'user-1-cid-defer',
      'Deferred Title',
      expect.any(Number),
    );
    expect(mockSaveConvo).not.toHaveBeenCalled();

    resolveConvo();
    await pending;

    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'cid-defer', title: 'Deferred Title' }),
      expect.objectContaining({ noUpsert: true }),
    );
  });

  it('notifies when the title is cached before waiting for convoReady', async () => {
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
    mockSaveConvo.mockImplementationOnce(async () => {
      order.push('save');
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
    expect(mockCache.delete).toHaveBeenCalledWith('user-1-cid');
  });

  it("does not delete a replacement stream's cached title when superseded", async () => {
    const client = makeClient('Stale Title');
    const ac = new AbortController();
    ac.abort();
    // Simulate a replacement stream having cached its own (newer) title under the
    // shared `userId-conversationId` key by the time this stale task re-reads it.
    mockCache.get.mockImplementationOnce(() => 'Newer Title');

    await addTitle(makeReq(), {
      text: 'hi',
      client,
      conversationId: 'cid',
      immediate: true,
      convoReady: Promise.resolve(),
      signal: ac.signal,
      discardSignal: ac.signal,
    });

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
    expect(onTitleGenerated).toHaveBeenCalledWith({ conversationId: 'cid', title: 'Kept Title' });

    // User stops mid-response, then the conversation row is persisted.
    ac.abort();
    resolveConvo();
    await pending;

    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'cid', title: 'Kept Title' }),
      expect.objectContaining({ noUpsert: true }),
    );
    expect(mockCache.delete).not.toHaveBeenCalled();
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
});
