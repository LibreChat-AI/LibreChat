const { fetch } = require('undici');
const TavilySearchResults = require('../TavilySearchResults');
const { getEnvProxyDispatcher } = require('@librechat/api');

jest.mock('undici');
jest.mock('@librechat/api', () => ({
  getEnvProxyDispatcher: jest.fn(),
}));

describe('TavilySearchResults', () => {
  let originalEnv;
  const mockApiKey = 'mock_api_key';

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: mockApiKey,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw an error if TAVILY_API_KEY is missing', () => {
    delete process.env.TAVILY_API_KEY;
    expect(() => new TavilySearchResults()).toThrow('Missing TAVILY_API_KEY environment variable.');
  });

  it('should use mockApiKey when TAVILY_API_KEY is not set in the environment', () => {
    const instance = new TavilySearchResults({
      TAVILY_API_KEY: mockApiKey,
    });
    expect(instance.apiKey).toBe(mockApiKey);
  });

  describe('proxy support', () => {
    const mockResponse = {
      ok: true,
      json: jest.fn().mockResolvedValue({ results: [] }),
    };

    beforeEach(() => {
      fetch.mockResolvedValue(mockResponse);
    });

    it('should use a shared proxy dispatcher when configured', async () => {
      const mockProxyDispatcher = { type: 'proxy-dispatcher' };
      getEnvProxyDispatcher.mockReturnValue(mockProxyDispatcher);

      const instance = new TavilySearchResults({ TAVILY_API_KEY: mockApiKey });
      await instance._call({ query: 'test query' });

      expect(getEnvProxyDispatcher).toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith(
        'https://api.tavily.com/search',
        expect.objectContaining({
          dispatcher: mockProxyDispatcher,
        }),
      );
    });

    it('should not attach a dispatcher when no proxy is configured', async () => {
      getEnvProxyDispatcher.mockReturnValue(undefined);

      const instance = new TavilySearchResults({ TAVILY_API_KEY: mockApiKey });
      await instance._call({ query: 'test query' });

      expect(getEnvProxyDispatcher).toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith(
        'https://api.tavily.com/search',
        expect.not.objectContaining({
          dispatcher: expect.anything(),
        }),
      );
    });
  });
});
