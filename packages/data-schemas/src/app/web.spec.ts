import { SafeSearchTypes, SearchProviders, ScraperProviders } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import {
  webSearchAuth,
  getWebSearchKeys,
  loadWebSearchConfig,
  webSearchUrlApiKeys,
  unbindWebSearchKeys,
  webSearchPairedFields,
  isStoredWebSearchValue,
  getRebindingWebSearchKeys,
} from './web';

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
    });

    it('should preserve custom URLs', () => {
      const config: TCustomConfig['webSearch'] = {
        searxngInstanceUrl: 'https://custom-searxng.com',
        firecrawlApiUrl: 'https://custom-firecrawl.com',
        jinaApiUrl: 'https://custom-jina.com',
      };

      const result = loadWebSearchConfig(config);

      expect(result?.searxngInstanceUrl).toBe('https://custom-searxng.com');
      expect(result?.firecrawlApiUrl).toBe('https://custom-firecrawl.com');
      expect(result?.jinaApiUrl).toBe('https://custom-jina.com');
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

  it('pairs every service URL with the API key of a service that reads both', () => {
    const services = Object.values(webSearchAuth).flatMap((category) => Object.values(category));
    const urlKeys = getWebSearchKeys().filter((key) => key.endsWith('Url'));

    expect([...webSearchUrlApiKeys.keys()].sort()).toEqual([...urlKeys].sort());
    for (const [urlKey, apiKey] of webSearchUrlApiKeys) {
      expect(services.some((service) => urlKey in service && apiKey in service)).toBe(true);
    }
  });
});

describe('isStoredWebSearchValue', () => {
  it.each(['https://searx.example.com', 'sk-literal-0001', 'v3:00:ff'])(
    'counts %s as stored in config',
    (value) => {
      expect(isStoredWebSearchValue(value)).toBe(true);
    },
  );

  it.each(['', '   ', 'user_provided', ' user_provided ', '${SEARXNG_API_KEY}', undefined, 5])(
    'does not count %p as stored in config',
    (value) => {
      expect(isStoredWebSearchValue(value)).toBe(false);
    },
  );
});

describe('unbindWebSearchKeys', () => {
  /** Merge positions by field; an unlisted field comes from the base config. */
  const layers = (byField: Partial<Record<string, number>>) => (field: string) => byField[field];

  it('lists every paired URL and key once', () => {
    expect(new Set(webSearchPairedFields).size).toBe(webSearchPairedFields.length);
    expect([...webSearchPairedFields].sort()).toEqual(
      [...new Set([...webSearchUrlApiKeys.keys(), ...webSearchUrlApiKeys.values()])].sort(),
    );
  });

  it('drops a stored key whose stored URL a later layer set', () => {
    const webSearch = {
      searxngInstanceUrl: 'https://attacker.example.com',
      searxngApiKey: 'sx-base-secret-0001',
      serperApiKey: 'serper-literal-0001',
    };

    const result = unbindWebSearchKeys(webSearch, layers({ searxngInstanceUrl: 1 }));

    expect(result.webSearch).toEqual({
      searxngInstanceUrl: 'https://attacker.example.com',
      serperApiKey: 'serper-literal-0001',
    });
    expect(result.unbound).toEqual([{ url: 'searxngInstanceUrl', apiKey: 'searxngApiKey' }]);
    expect(webSearch.searxngApiKey).toBe('sx-base-secret-0001');
  });

  it('drops a key a layer stores for a stored URL it inherits', () => {
    const webSearch = { keenableApiUrl: 'https://k.example.com', keenableApiKey: 'kn-0001' };

    const result = unbindWebSearchKeys(webSearch, layers({ keenableApiKey: 2 }));

    expect(result.webSearch).toEqual({ keenableApiUrl: 'https://k.example.com' });
    expect(result.unbound).toEqual([{ url: 'keenableApiUrl', apiKey: 'keenableApiKey' }]);
  });

  it('keeps a stored key the layer that set its URL also stored', () => {
    const webSearch = { keenableApiUrl: 'https://k.example.com', keenableApiKey: 'kn-0001' };

    const result = unbindWebSearchKeys(webSearch, layers({ keenableApiUrl: 1, keenableApiKey: 1 }));

    expect(result.webSearch).toBe(webSearch);
    expect(result.unbound).toEqual([]);
  });

  it.each([
    { name: 'points it at an environment reference', url: '${OTHER_SERVICE_URL}' },
    { name: 'blanks it', url: '' },
    { name: 'sets it to null', url: null },
    { name: 'leaves it to users', url: 'user_provided' },
    { name: 'removes it', url: undefined },
  ])('drops a stored key when a later layer $name', ({ url }) => {
    const webSearch = { firecrawlApiUrl: url, firecrawlApiKey: 'fc-literal-0001' };

    const result = unbindWebSearchKeys(
      webSearch,
      layers({ firecrawlApiKey: 0, firecrawlApiUrl: 1 }),
    );

    expect(result.webSearch).not.toHaveProperty('firecrawlApiKey');
    expect(result.unbound).toEqual([{ url: 'firecrawlApiUrl', apiKey: 'firecrawlApiKey' }]);
  });

  it('keeps a stored key written over an inherited environment URL', () => {
    const webSearch = {
      firecrawlApiUrl: '${FIRECRAWL_API_URL}',
      firecrawlApiKey: 'fc-literal-0001',
      jinaApiUrl: '${JINA_API_URL}',
      jinaApiKey: 'jina-literal-0001',
    };

    const result = unbindWebSearchKeys(
      webSearch,
      layers({ firecrawlApiKey: 1, jinaApiUrl: 0, jinaApiKey: 2 }),
    );

    expect(result.webSearch).toBe(webSearch);
    expect(result.unbound).toEqual([]);
  });

  it('leaves environment and user keys to the runtime rules', () => {
    const webSearch = {
      searxngInstanceUrl: 'https://searx.example.com',
      searxngApiKey: '${SEARXNG_API_KEY}',
      jinaApiUrl: 'https://jina.example.com',
      jinaApiKey: 'user_provided',
    };

    const result = unbindWebSearchKeys(webSearch, layers({ searxngInstanceUrl: 1, jinaApiUrl: 1 }));

    expect(result.webSearch).toBe(webSearch);
    expect(result.unbound).toEqual([]);
  });

  it('drops a shared key when either of its URLs comes from another layer', () => {
    const webSearch = {
      tavilySearchUrl: 'https://tavily.example.com/search',
      tavilyExtractUrl: 'https://elsewhere.example.com/extract',
      tavilyApiKey: 'tvly-0001',
    };

    const result = unbindWebSearchKeys(
      webSearch,
      layers({ tavilySearchUrl: 0, tavilyApiKey: 0, tavilyExtractUrl: 1 }),
    );

    expect(result.webSearch).toEqual({
      tavilySearchUrl: 'https://tavily.example.com/search',
      tavilyExtractUrl: 'https://elsewhere.example.com/extract',
    });
    expect(result.unbound).toEqual([{ url: 'tavilyExtractUrl', apiKey: 'tavilyApiKey' }]);
  });
});

describe('getRebindingWebSearchKeys', () => {
  const STORED_KEY = 'v3:00112233445566778899aabbccddeeff:abcdef';
  const stored = {
    searxngInstanceUrl: 'https://searx.example.com',
    searxngApiKey: STORED_KEY,
    serperApiKey: STORED_KEY,
  };
  const SEARXNG = [{ url: 'searxngInstanceUrl', apiKey: 'searxngApiKey' }];

  it.each([
    { name: 'changes it', url: 'https://attacker.example.com' },
    { name: 'points it at an environment reference', url: '${SEARXNG_INSTANCE_URL}' },
    { name: 'blanks it', url: '' },
    { name: 'tombstones it', url: null },
    { name: 'leaves it to users', url: 'user_provided' },
  ])('lists a stored key the write kept when it $name', ({ url }) => {
    const next = { ...stored, searxngInstanceUrl: url };

    expect(getRebindingWebSearchKeys(stored, next, new Set(['searxngInstanceUrl']))).toEqual(
      SEARXNG,
    );
  });

  it('lists a stored key whose URL the write removes', () => {
    const next = { searxngApiKey: STORED_KEY, serperApiKey: STORED_KEY };

    expect(getRebindingWebSearchKeys(stored, next, new Set())).toEqual(SEARXNG);
  });

  it('lists a URL a write adds beside a key the document already stores', () => {
    const keyOnly = { firecrawlApiKey: STORED_KEY };
    const next = { ...keyOnly, firecrawlApiUrl: '${FIRECRAWL_API_URL}' };

    expect(getRebindingWebSearchKeys(keyOnly, next, new Set(['firecrawlApiUrl']))).toEqual([
      { url: 'firecrawlApiUrl', apiKey: 'firecrawlApiKey' },
    ]);
  });

  it.each([
    { name: 'a literal URL replaces it', url: 'https://keenable.example.com' },
    { name: 'it names another variable', url: '${OTHER_SERVICE_URL}' },
  ])('lists a key beside an environment URL when $name', ({ url }) => {
    const fromEnv = { keenableApiUrl: '${KEENABLE_API_URL}', keenableApiKey: STORED_KEY };
    const next = { ...fromEnv, keenableApiUrl: url };

    expect(getRebindingWebSearchKeys(fromEnv, next, new Set(['keenableApiUrl']))).toEqual([
      { url: 'keenableApiUrl', apiKey: 'keenableApiKey' },
    ]);
  });

  it('lists the shared Tavily key once per changed URL', () => {
    const tavily = {
      tavilySearchUrl: 'https://tavily.example.com/search',
      tavilyExtractUrl: 'https://tavily.example.com/extract',
      tavilyApiKey: STORED_KEY,
    };
    const next = { ...tavily, tavilyExtractUrl: 'https://elsewhere.example.com/extract' };

    expect(getRebindingWebSearchKeys(tavily, next, new Set())).toEqual([
      { url: 'tavilyExtractUrl', apiKey: 'tavilyApiKey' },
    ]);
  });

  const moved = { ...stored, searxngInstanceUrl: 'https://attacker.example.com' };
  it.each([
    {
      name: 'the write enters the key again beside the new URL',
      before: stored,
      next: { ...moved, searxngApiKey: 'sx-new-key' },
      written: ['searxngInstanceUrl', 'searxngApiKey'],
    },
    {
      name: 'the write clears the key',
      before: stored,
      next: { ...moved, searxngApiKey: '' },
      written: ['searxngInstanceUrl', 'searxngApiKey'],
    },
    {
      name: 'the key becomes an environment reference',
      before: stored,
      next: { ...moved, searxngApiKey: '${SEARXNG_API_KEY}' },
      written: ['searxngInstanceUrl', 'searxngApiKey'],
    },
    {
      name: 'the URL is spelled differently',
      before: stored,
      next: { ...stored, searxngInstanceUrl: ' HTTPS://Searx.Example.com ' },
      written: ['searxngInstanceUrl'],
    },
    {
      name: 'the same environment reference is written again',
      before: { ...stored, searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}' },
      next: { ...stored, searxngInstanceUrl: ' ${SEARXNG_INSTANCE_URL}' },
      written: ['searxngInstanceUrl'],
    },
    {
      name: 'a tombstoned URL is blanked instead',
      before: { ...stored, searxngInstanceUrl: null },
      next: { ...stored, searxngInstanceUrl: '  ' },
      written: ['searxngInstanceUrl'],
    },
    {
      name: 'only another field changes',
      before: stored,
      next: { ...stored, safeSearch: 2 },
      written: ['safeSearch'],
    },
  ])('lists nothing when $name', ({ before, next, written }) => {
    expect(getRebindingWebSearchKeys(before, next, new Set(written))).toEqual([]);
  });

  it('lists nothing when no web search section remains', () => {
    expect(getRebindingWebSearchKeys(stored, undefined, new Set())).toEqual([]);
  });
});
