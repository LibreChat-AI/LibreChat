import { SafeSearchTypes, SearchProviders, ScraperProviders } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import { loadWebSearchConfig, webSearchAuth, getWebSearchKeys } from './web';

describe('loadWebSearchConfig', () => {
  describe('firecrawlVersion', () => {
    it('should use provided firecrawlVersion when specified', () => {
      const config: TCustomConfig['webSearch'] = {
        firecrawlVersion: 'v2',
      };

      const result = loadWebSearchConfig(config);

      expect(result?.firecrawlVersion).toBe('v2');
    });

    it('should default to ${FIRECRAWL_VERSION} when not provided', () => {
      const config: TCustomConfig['webSearch'] = {};

      const result = loadWebSearchConfig(config);

      expect(result?.firecrawlVersion).toBe('${FIRECRAWL_VERSION}');
    });

    it('should default to ${FIRECRAWL_VERSION} when config is undefined', () => {
      const result = loadWebSearchConfig(undefined);

      expect(result?.firecrawlVersion).toBe('${FIRECRAWL_VERSION}');
    });

    it('should preserve custom firecrawlVersion value', () => {
      const config: TCustomConfig['webSearch'] = {
        firecrawlVersion: 'v1',
      };

      const result = loadWebSearchConfig(config);

      expect(result?.firecrawlVersion).toBe('v1');
    });
  });

  describe('all config fields', () => {
    it('should apply defaults for all fields when config is empty', () => {
      const config: TCustomConfig['webSearch'] = {};

      const result = loadWebSearchConfig(config);

      expect(result).toEqual({
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        firecrawlVersion: '${FIRECRAWL_VERSION}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        cohereApiUrl: '${COHERE_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        rerankerType: undefined,
        tavilyApiKey: '${TAVILY_API_KEY}',
        tavilySearchUrl: '${TAVILY_SEARCH_URL}',
        tavilyExtractUrl: '${TAVILY_EXTRACT_URL}',
        keenableApiKey: '${KEENABLE_API_KEY}',
        keenableApiUrl: '${KEENABLE_API_URL}',
      });
    });

    it('should preserve provided config values and merge with defaults', () => {
      const config: TCustomConfig['webSearch'] = {
        serperApiKey: 'custom-serper-key',
        firecrawlApiKey: 'custom-firecrawl-key',
        firecrawlVersion: 'v2',
        safeSearch: SafeSearchTypes.STRICT,
      };

      const result = loadWebSearchConfig(config);

      expect(result?.serperApiKey).toBe('custom-serper-key');
      expect(result?.firecrawlApiKey).toBe('custom-firecrawl-key');
      expect(result?.firecrawlVersion).toBe('v2');
      expect(result?.safeSearch).toBe(SafeSearchTypes.STRICT);
      expect(result?.jinaApiKey).toBe('${JINA_API_KEY}');
    });

    it('should preserve additional fields from input config', () => {
      const config: TCustomConfig['webSearch'] = {
        serperApiKey: 'test-key',
        scraperProvider: ScraperProviders.SERPER,
        searchProvider: SearchProviders.SERPER,
      };

      const result = loadWebSearchConfig(config);

      expect(result?.scraperProvider).toBe('serper');
      expect(result?.searchProvider).toBe('serper');
      expect(result?.serperApiKey).toBe('test-key');
    });

    it('should preserve searxngSearchOptions', () => {
      const config: TCustomConfig['webSearch'] = {
        searchProvider: SearchProviders.SEARXNG,
        searxngSearchOptions: {
          engines: 'google,bing,startpage,qwant',
          language: 'en',
        },
      };

      const result = loadWebSearchConfig(config);

      expect(result?.searxngSearchOptions).toEqual({
        engines: 'google,bing,startpage,qwant',
        language: 'en',
      });
    });

    it('should normalize a YAML engine list, which reaches this loader unparsed', () => {
      const result = loadWebSearchConfig({
        searchProvider: SearchProviders.SEARXNG,
        searxngSearchOptions: {
          engines: ['google', 'bing', 'startpage'],
          language: 'en',
        },
      });

      expect(result?.searxngSearchOptions?.engines).toBe('google,bing,startpage');
    });

    it('should trim whitespace and empty entries from a raw engines string', () => {
      const result = loadWebSearchConfig({
        searchProvider: SearchProviders.SEARXNG,
        searxngSearchOptions: { engines: 'google, bing , , startpage' },
      });

      expect(result?.searxngSearchOptions?.engines).toBe('google,bing,startpage');
    });

    it('should treat an all-blank engines value as unset', () => {
      const result = loadWebSearchConfig({
        searchProvider: SearchProviders.SEARXNG,
        searxngSearchOptions: { engines: '  ,  ' },
      });

      expect(result?.searxngSearchOptions?.engines).toBeUndefined();
    });

    it('should leave searxngSearchOptions undefined when the block is absent', () => {
      const result = loadWebSearchConfig({ searchProvider: SearchProviders.SEARXNG });

      expect(result?.searxngSearchOptions).toBeUndefined();
    });
  });

  describe('safeSearch', () => {
    it('should default to MODERATE when not provided', () => {
      const config: TCustomConfig['webSearch'] = {};

      const result = loadWebSearchConfig(config);

      expect(result?.safeSearch).toBe(SafeSearchTypes.MODERATE);
    });

    it('should preserve OFF value', () => {
      const config: TCustomConfig['webSearch'] = {
        safeSearch: SafeSearchTypes.OFF,
      };

      const result = loadWebSearchConfig(config);

      expect(result?.safeSearch).toBe(SafeSearchTypes.OFF);
    });

    it('should preserve STRICT value', () => {
      const config: TCustomConfig['webSearch'] = {
        safeSearch: SafeSearchTypes.STRICT,
      };

      const result = loadWebSearchConfig(config);

      expect(result?.safeSearch).toBe(SafeSearchTypes.STRICT);
    });
  });

  describe('API keys', () => {
    it('should apply default placeholders for all API keys', () => {
      const result = loadWebSearchConfig({});

      expect(result?.serperApiKey).toBe('${SERPER_API_KEY}');
      expect(result?.searxngApiKey).toBe('${SEARXNG_API_KEY}');
      expect(result?.firecrawlApiKey).toBe('${FIRECRAWL_API_KEY}');
      expect(result?.jinaApiKey).toBe('${JINA_API_KEY}');
      expect(result?.cohereApiKey).toBe('${COHERE_API_KEY}');
      expect(result?.keenableApiKey).toBe('${KEENABLE_API_KEY}');
      expect(result?.keenableApiUrl).toBe('${KEENABLE_API_URL}');
    });

    it('should preserve custom API keys', () => {
      const config: TCustomConfig['webSearch'] = {
        serperApiKey: 'actual-serper-key',
        jinaApiKey: 'actual-jina-key',
        cohereApiKey: 'actual-cohere-key',
      };

      const result = loadWebSearchConfig(config);

      expect(result?.serperApiKey).toBe('actual-serper-key');
      expect(result?.jinaApiKey).toBe('actual-jina-key');
      expect(result?.cohereApiKey).toBe('actual-cohere-key');
    });
  });

  describe('URLs', () => {
    it('should apply default placeholders for URLs', () => {
      const result = loadWebSearchConfig({});

      expect(result?.searxngInstanceUrl).toBe('${SEARXNG_INSTANCE_URL}');
      expect(result?.firecrawlApiUrl).toBe('${FIRECRAWL_API_URL}');
      expect(result?.jinaApiUrl).toBe('${JINA_API_URL}');
      expect(result?.cohereApiUrl).toBe('${COHERE_API_URL}');
    });

    it('should preserve custom URLs', () => {
      const config: TCustomConfig['webSearch'] = {
        searxngInstanceUrl: 'https://custom-searxng.com',
        firecrawlApiUrl: 'https://custom-firecrawl.com',
        jinaApiUrl: 'https://custom-jina.com',
        cohereApiUrl: 'https://litellm.internal/v2/rerank',
      };

      const result = loadWebSearchConfig(config);

      expect(result?.searxngInstanceUrl).toBe('https://custom-searxng.com');
      expect(result?.firecrawlApiUrl).toBe('https://custom-firecrawl.com');
      expect(result?.jinaApiUrl).toBe('https://custom-jina.com');
      expect(result?.cohereApiUrl).toBe('https://litellm.internal/v2/rerank');
    });
  });
});

describe('webSearchAuth', () => {
  it('registers Keenable in both the provider and the scraper category', () => {
    expect(webSearchAuth.providers).toHaveProperty(SearchProviders.KEENABLE);
    expect(webSearchAuth.scrapers).toHaveProperty(ScraperProviders.KEENABLE);
  });

  it('marks every Keenable auth field optional (keyless by default)', () => {
    // A required field (1) would make Keenable unusable without a key, and the
    // keyless carve-out in `loadWebSearchAuth` depends on there being none.
    expect(Object.values(webSearchAuth.providers.keenable)).toEqual([0, 0]);
    expect(Object.values(webSearchAuth.scrapers.keenable)).toEqual([0]);
  });

  it('exposes the Keenable keys once across categories', () => {
    const keys = getWebSearchKeys();

    expect(keys.filter((key) => key === 'keenableApiKey')).toHaveLength(1);
    expect(keys).toContain('keenableApiUrl');
  });
});
