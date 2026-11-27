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
const { generateTitle } = addTitle;

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

  it('does not start title generation when assistant output protection is required', async () => {
    const client = makeClient();
    const req = makeReq();
    req.config = {
      config: { outputProtection: { version: 1, assistantText: { timeoutMs: 5_000 } } },
    };

    await addTitle(req, { text: 'hello', client, conversationId: 'cid-protected' });

    expect(client.titleConvo).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
  });

  it('does not discard a healthy title after an arbitrary 45 second window', async () => {
    jest.useFakeTimers();
    try {
      let resolveTitle;
      const client = {
        options: { titleConvo: true },
        titleConvo: jest.fn(
          () =>
            new Promise((resolve) => {
              resolveTitle = resolve;
            }),
        ),
      };
      const pending = addTitle(makeReq(), {
        text: 'hello',
        client,
        conversationId: 'cid-slow-provider',
      });

      await jest.advanceTimersByTimeAsync(45_000);
      expect(mockSaveConvo).not.toHaveBeenCalled();

      resolveTitle('Late Title');
      await pending;

      expect(mockCacheStore.get('user-1-cid-slow-provider')).toBe('Late Title');
      expect(mockSaveConvo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ conversationId: 'cid-slow-provider', title: 'Late Title' }),
        expect.objectContaining({ noUpsert: true }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  describe('generateTitle', () => {
    it('returns the title without saving or caching it', async () => {
      const client = makeClient('Task Title');

      await expect(generateTitle(makeReq(), { text: 'hello', client })).resolves.toBe('Task Title');

      expect(mockSaveConvo).not.toHaveBeenCalled();
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it('passes immediate:true through to client.titleConvo', async () => {
      const client = makeClient();

      await generateTitle(makeReq(), { text: 'hello', client, immediate: true });

      expect(client.titleConvo).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'hello', immediate: true }),
      );
    });

    it('replaces a blocked generated title before handing it back', async () => {
      const req = makeReq();
      req.config.filters = {
        conversationTitles: {
          pii: {
            starterPatterns: [],
            customPatterns: [{ id: 'blocked', label: 'blocked', regex: 'BLOCKED' }],
          },
        },
      };

      await expect(
        generateTitle(req, { text: 'hello', client: makeClient('BLOCKED-TITLE') }),
      ).resolves.toBe('New Chat');
    });

    it('skips generation when the endpoint disables titleConvo', async () => {
      const client = makeClient();
      client.options.titleConvo = false;

      await expect(generateTitle(makeReq(), { text: 'hi', client })).resolves.toBeUndefined();
      expect(client.titleConvo).not.toHaveBeenCalled();
    });

    it('skips generation for temporary conversations', async () => {
      const client = makeClient();
      const req = makeReq();
      req.body.isTemporary = true;

      await expect(generateTitle(req, { text: 'hi', client })).resolves.toBeUndefined();
      expect(client.titleConvo).not.toHaveBeenCalled();
    });

    it('cancels the title model call when its signal aborts', async () => {
      let modelSignal;
      const client = {
        options: { titleConvo: true },
        titleConvo: jest.fn(
          ({ abortController }) =>
            new Promise((resolve) => {
              modelSignal = abortController.signal;
              modelSignal.addEventListener('abort', () => resolve(undefined), { once: true });
            }),
        ),
      };
      const controller = new AbortController();

      const pending = generateTitle(makeReq(), { text: 'hi', client, signal: controller.signal });
      await flush();
      controller.abort();

      await expect(pending).resolves.toBeUndefined();
      expect(modelSignal.aborted).toBe(true);
    });

    it('reports a failed title call as no title', async () => {
      const client = makeClient();
      client.titleConvo.mockRejectedValueOnce(new Error('provider down'));

      await expect(generateTitle(makeReq(), { text: 'hi', client })).resolves.toBeUndefined();
    });
  });

  describe('addTitle (resumed approval turns)', () => {
    it('saves through the generated-title contract without rewriting messages', async () => {
      const onTitleGenerated = jest.fn();

      await addTitle(makeReq(), {
        text: 'hello',
        client: makeClient('Resumed Title'),
        conversationId: 'cid-resumed',
        onTitleGenerated,
      });

      expect(mockSaveConvo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ conversationId: 'cid-resumed', title: 'Resumed Title' }),
        expect.objectContaining({
          noUpsert: true,
          appendMessageIds: [],
          titleSource: 'generated',
        }),
      );
      expect(mockCache.set).toHaveBeenCalledWith('user-1-cid-resumed', 'Resumed Title', 120000);
      expect(onTitleGenerated).toHaveBeenCalledWith({
        conversationId: 'cid-resumed',
        title: 'Resumed Title',
      });
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

      expect(mockCache.set).toHaveBeenCalledWith('user-1-cid', 'Renamed', 120000);
      expect(onTitleGenerated).not.toHaveBeenCalled();
    });

    it('skips generation without a conversationId', async () => {
      const client = makeClient();

      await addTitle(makeReq(), { text: 'hi', client });

      expect(client.titleConvo).not.toHaveBeenCalled();
      expect(mockSaveConvo).not.toHaveBeenCalled();
    });
  });
});
