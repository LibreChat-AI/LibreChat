const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { logger, loadWebSearchConfig } = require('@librechat/data-schemas');
const {
  Tools,
  AuthType,
  RerankerTypes,
  SearchProviders,
  ScraperProviders,
} = require('librechat-data-provider');
const { verifyToolAuth } = require('../tools');
require('~/db/models');

const ENV_NAMES = [
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_API_URL',
  'FIRECRAWL_VERSION',
  'SEARXNG_API_KEY',
];

/**
 * The web search badge check resolves credentials through the real loader and credential store,
 * so its debug line must tell a key the user never saved from one the store cannot read.
 */
describe('web search badge check diagnostics', () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const webSearch = loadWebSearchConfig({
    searchProvider: SearchProviders.SEARXNG,
    searxngInstanceUrl: 'http://searxng:8080/search',
    scraperProvider: ScraperProviders.FIRECRAWL,
    rerankerType: RerankerTypes.NONE,
  });
  let mongoServer;
  let originalEnv;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.FIRECRAWL_API_KEY = AuthType.USER_PROVIDED;
  });

  afterEach(async () => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    await mongoose.models.PluginAuth.deleteMany({});
  });

  /** Runs the badge check and returns its response and the web search diagnostics it logged. */
  async function checkBadge() {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await verifyToolAuth(
      { params: { toolId: Tools.web_search }, user: { id: userId }, config: { webSearch } },
      res,
    );
    const lines = debug.mock.calls
      .map(([message]) => message)
      .filter(
        (message) => typeof message === 'string' && message.startsWith('[loadWebSearchAuth]'),
      );
    return { res, lines };
  }

  it('names a key the user never saved as not set', async () => {
    const { res, lines } = await checkBadge();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false }));
    expect(lines).toEqual([
      '[loadWebSearchAuth] Web search is not authenticated for scrapers (firecrawl): firecrawlApiKey (FIRECRAWL_API_KEY) is not set',
    ]);
  });

  it('reports a saved key the credential store cannot read as unreadable, not as not set', async () => {
    /** A truncated record: its one-byte IV makes decryption throw. */
    await mongoose.models.PluginAuth.create({
      userId,
      authField: 'FIRECRAWL_API_KEY',
      pluginKey: Tools.web_search,
      value: 'v3:00:00',
    });

    const { res, lines } = await checkBadge();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false }));
    expect(lines).toEqual([
      '[loadWebSearchAuth] Web search is not authenticated for scrapers (firecrawl): saved settings could not be read',
    ]);
  });

  describe('Firecrawl at its own URL while FIRECRAWL_API_KEY is unset', () => {
    beforeEach(() => {
      delete process.env.FIRECRAWL_API_KEY;
      process.env.FIRECRAWL_API_URL = 'http://firecrawl:3002';
    });

    it('authenticates without a key', async () => {
      const { res, lines } = await checkBadge();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticated: true,
          scraperProvider: ScraperProviders.FIRECRAWL,
        }),
      );
      expect(lines).toEqual([]);
    });

    it('reports a saved key the credential store cannot read as unreadable, not as no key', async () => {
      await mongoose.models.PluginAuth.create({
        userId,
        authField: 'FIRECRAWL_API_KEY',
        pluginKey: Tools.web_search,
        value: 'v3:00:00',
      });

      const { res, lines } = await checkBadge();

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false }));
      expect(lines).toEqual([
        '[loadWebSearchAuth] Web search is not authenticated for scrapers (firecrawl): saved settings could not be read',
      ]);
    });
  });
});
