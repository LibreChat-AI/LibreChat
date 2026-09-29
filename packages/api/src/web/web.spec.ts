import { webSearchAuth, webSearchSelectionFields } from '@librechat/data-schemas';
import {
  AuthType,
  RerankerTypes,
  SafeSearchTypes,
  SearchCategories,
  SearchProviders,
  ScraperProviders,
} from 'librechat-data-provider';
import type { TWebSearchConfig, TCustomConfig } from 'librechat-data-provider';
import {
  loadWebSearchAuth,
  extractWebSearchEnvVars,
  getWebSearchInstallEntries,
  getWebSearchUninstallFields,
} from './web';

// Mock the extractVariableName function
jest.mock('../utils', () => ({
  extractVariableName: (value: string) => {
    if (!value || typeof value !== 'string') return null;
    const match = value.match(/^\${(.+)}$/);
    return match ? match[1] : null;
  },
}));

const mockIsSSRFTarget = jest.fn().mockReturnValue(false);
const mockResolveHostnameSSRF = jest.fn().mockResolvedValue(false);

jest.mock('../auth', () => ({
  isSSRFTarget: (...args: unknown[]) => mockIsSSRFTarget(...args),
  resolveHostnameSSRF: (...args: unknown[]) => mockResolveHostnameSSRF(...args),
  getEffectivePort: (protocol: string, port?: string) => {
    if (port) {
      return port;
    }
    return protocol === 'https:' ? '443' : '80';
  },
}));

describe('web.ts', () => {
  describe('extractWebSearchEnvVars', () => {
    it('should return empty array if config is undefined', () => {
      const result = extractWebSearchEnvVars({
        keys: ['serperApiKey', 'jinaApiKey'],
        config: undefined,
      });

      expect(result).toEqual([]);
    });

    it('should extract environment variable names from config values', () => {
      const config: Partial<TWebSearchConfig> = {
        serperApiKey: '${SERPER_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
        cohereApiKey: 'actual-api-key', // Not in env var format
        safeSearch: SafeSearchTypes.MODERATE,
      };

      const result = extractWebSearchEnvVars({
        keys: ['serperApiKey', 'jinaApiKey', 'cohereApiKey'],
        config: config as TWebSearchConfig,
      });

      expect(result).toEqual(['SERPER_API_KEY', 'JINA_API_KEY']);
    });

    it('should only extract variables for keys that exist in the config', () => {
      const config: Partial<TWebSearchConfig> = {
        serperApiKey: '${SERPER_API_KEY}',
        // firecrawlApiKey is missing
        safeSearch: SafeSearchTypes.MODERATE,
      };

      const result = extractWebSearchEnvVars({
        keys: ['serperApiKey', 'firecrawlApiKey'],
        config: config as TWebSearchConfig,
      });

      expect(result).toEqual(['SERPER_API_KEY']);
    });
  });

  describe('web search plugin auth mapping', () => {
    it('keeps credential values paired with fields after unsupported keys are filtered', () => {
      const config = {
        keenableApiKey: '${KEENABLE_API_KEY}',
      } as TWebSearchConfig;

      const entries = getWebSearchInstallEntries({
        auth: {
          selectedProvider: 'keenable',
          serperApiKey: 'serper-key',
          keenableApiKey: 'keenable-key',
        },
        config,
      });

      expect(entries).toEqual([
        ['KEENABLE_API_KEY', 'keenable-key'],
        [webSearchSelectionFields.selectedProvider, 'keenable'],
      ]);
    });

    it('rejects reranker selections that have no runtime service', () => {
      const entries = getWebSearchInstallEntries({
        auth: {
          selectedReranker: 'infinity',
        },
        config: {} as TWebSearchConfig,
      });

      expect(entries).toEqual([]);
    });

    it('preserves explicit empty credential values as clear operations', () => {
      const entries = getWebSearchInstallEntries({
        auth: {
          keenableApiUrl: '',
        },
        config: {
          keenableApiUrl: '${KEENABLE_API_URL}',
        } as TWebSearchConfig,
      });

      expect(entries).toEqual([['KEENABLE_API_URL', '']]);
    });

    it('clears persisted provider choices with web-search credentials', () => {
      const fields = getWebSearchUninstallFields({
        keenableApiKey: '${KEENABLE_API_KEY}',
      } as TWebSearchConfig);

      expect(fields).toEqual([
        'KEENABLE_API_KEY',
        webSearchSelectionFields.selectedProvider,
        webSearchSelectionFields.selectedScraper,
        webSearchSelectionFields.selectedReranker,
      ]);
    });
  });

  describe('loadWebSearchAuth', () => {
    // Common test variables
    const userId = 'test-user-id';
    let mockLoadAuthValues: jest.Mock;
    let webSearchConfig: TCustomConfig['webSearch'];

    beforeEach(() => {
      // Reset mocks before each test
      jest.clearAllMocks();

      // Initialize the mock function
      mockLoadAuthValues = jest.fn();

      // Initialize a basic webSearchConfig
      webSearchConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
      };
    });

    it('should return authenticated=true when all required categories are authenticated', async () => {
      // Mock successful authentication for all services
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authTypes).toHaveLength(3); // providers, scrapers, rerankers
      expect(result.authResult).toHaveProperty('serperApiKey', 'test-api-key');
      expect(result.authResult).toHaveProperty('firecrawlApiKey', 'test-api-key');

      // The implementation only includes one reranker in the result
      // It will be either jina or cohere, but not both
      if (result.authResult.rerankerType === 'jina') {
        expect(result.authResult).toHaveProperty('jinaApiKey', 'test-api-key');
      } else {
        expect(result.authResult).toHaveProperty('cohereApiKey', 'test-api-key');
      }

      expect(result.authResult).toHaveProperty('searchProvider', 'serper');
      expect(result.authResult).toHaveProperty('scraperProvider', 'firecrawl');
      expect(['jina', 'cohere']).toContain(result.authResult.rerankerType as string);
      expect(result.authResult.safeSearch).toBe(SafeSearchTypes.MODERATE);
    });

    it('should return authenticated=false when a required category is not authenticated', async () => {
      // Mock authentication failure for the providers category
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          // Only provide values for scrapers and rerankers, not for providers
          if (field !== 'SERPER_API_KEY' && field !== 'SEARXNG_INSTANCE_URL') {
            result[field] =
              field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(false);
      // We should still have authTypes for the categories we checked
      expect(result.authTypes.some(([category]) => category === 'providers')).toBe(true);
    });

    it('should handle exceptions from loadAuthValues', async () => {
      // Mock loadAuthValues to throw an error
      mockLoadAuthValues.mockImplementation(() => {
        throw new Error('Authentication failed');
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
        throwError: false, // Don't throw errors
      });

      expect(result.authenticated).toBe(false);
    });

    it('should correctly identify user-provided vs system-defined auth', async () => {
      // Mock environment variables
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        SERPER_API_KEY: 'system-api-key',
        FIRECRAWL_API_KEY: 'system-api-key',
        JINA_API_KEY: 'system-api-key',
      };

      // Mock loadAuthValues to return different values for some keys
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'SERPER_API_KEY') {
            // This matches the system env var
            result[field] = 'system-api-key';
          } else if (field === 'FIRECRAWL_API_KEY') {
            // This is different from the system env var (user provided)
            result[field] = 'user-api-key';
          } else if (field === 'FIRECRAWL_API_URL') {
            result[field] = 'https://api.firecrawl.dev';
          } else if (field === 'JINA_API_KEY') {
            // This matches the system env var
            result[field] = 'system-api-key';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      // Check for providers (system-defined) and scrapers (user-provided)
      const providersAuthType = result.authTypes.find(
        ([category]) => category === 'providers',
      )?.[1];
      const scrapersAuthType = result.authTypes.find(([category]) => category === 'scrapers')?.[1];

      expect(providersAuthType).toBe(AuthType.SYSTEM_DEFINED);
      expect(scrapersAuthType).toBe(AuthType.USER_PROVIDED);

      // Restore original env
      process.env = originalEnv;
    });

    it('should handle optional fields correctly', async () => {
      // Create a config without the optional firecrawlApiUrl
      const configWithoutOptional = { ...webSearchConfig } as Partial<TWebSearchConfig>;
      delete configWithoutOptional.firecrawlApiUrl;

      mockLoadAuthValues.mockImplementation(({ authFields, optional }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          // Don't provide values for optional fields
          if (!optional?.has(field)) {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: configWithoutOptional as TWebSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult).toHaveProperty('firecrawlApiKey', 'test-api-key');
      // Optional URL should not be in the result
      expect(result.authResult.firecrawlApiUrl).toBeUndefined();
    });

    it('should ignore user-provided Tavily custom URLs unless explicitly enabled', async () => {
      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          TAVILY_API_KEY: 'system-tavily-api-key',
          TAVILY_SEARCH_URL: 'https://api.tavily.com/search',
          TAVILY_EXTRACT_URL: 'https://api.tavily.com/extract',
        };

        const tavilyConfig = {
          tavilyApiKey: '${TAVILY_API_KEY}',
          tavilySearchUrl: '${TAVILY_SEARCH_URL}',
          tavilyExtractUrl: '${TAVILY_EXTRACT_URL}',
          searchProvider: 'tavily' as SearchProviders,
          scraperProvider: 'tavily' as ScraperProviders,
          rerankerType: 'none' as RerankerTypes,
        } as TWebSearchConfig;

        mockLoadAuthValues.mockImplementation(({ authFields }) => {
          const result: Record<string, string> = {};
          authFields.forEach((field: string) => {
            if (field === 'TAVILY_API_KEY') {
              result[field] = 'system-tavily-api-key';
            } else if (field === 'TAVILY_SEARCH_URL') {
              result[field] = 'https://attacker.example/search';
            } else if (field === 'TAVILY_EXTRACT_URL') {
              result[field] = 'https://attacker.example/extract';
            }
          });
          return Promise.resolve(result);
        });

        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig: tavilyConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authenticated).toBe(true);
        expect(result.authResult.searchProvider).toBe('tavily');
        expect(result.authResult.scraperProvider).toBe('tavily');
        expect(result.authResult.tavilyApiKey).toBe('system-tavily-api-key');
        expect(result.authResult.tavilySearchUrl).toBeUndefined();
        expect(result.authResult.tavilyExtractUrl).toBeUndefined();
        expect(result.authTypes).toEqual([
          ['providers', AuthType.SYSTEM_DEFINED],
          ['scrapers', AuthType.SYSTEM_DEFINED],
          ['rerankers', AuthType.SYSTEM_DEFINED],
        ]);
      } finally {
        process.env = originalEnv;
      }
    });

    it('should allow user-provided Tavily custom URLs when explicitly enabled', async () => {
      mockIsSSRFTarget.mockReturnValue(false);
      mockResolveHostnameSSRF.mockResolvedValue(false);

      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          TAVILY_API_KEY: 'system-tavily-api-key',
          TAVILY_SEARCH_URL: AuthType.USER_PROVIDED,
          TAVILY_EXTRACT_URL: AuthType.USER_PROVIDED,
        };

        const tavilyConfig = {
          tavilyApiKey: '${TAVILY_API_KEY}',
          tavilySearchUrl: '${TAVILY_SEARCH_URL}',
          tavilyExtractUrl: '${TAVILY_EXTRACT_URL}',
          searchProvider: 'tavily' as SearchProviders,
          scraperProvider: 'tavily' as ScraperProviders,
          rerankerType: 'none' as RerankerTypes,
        } as TWebSearchConfig;

        mockLoadAuthValues.mockImplementation(({ authFields }) => {
          const result: Record<string, string> = {};
          authFields.forEach((field: string) => {
            if (field === 'TAVILY_API_KEY') {
              result[field] = 'system-tavily-api-key';
            } else if (field === 'TAVILY_SEARCH_URL') {
              result[field] = 'https://tenant-search.example/search';
            } else if (field === 'TAVILY_EXTRACT_URL') {
              result[field] = 'https://tenant-extract.example/extract';
            }
          });
          return Promise.resolve(result);
        });

        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig: tavilyConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authenticated).toBe(true);
        expect(result.authResult.tavilySearchUrl).toBe('https://tenant-search.example/search');
        expect(result.authResult.tavilyExtractUrl).toBe('https://tenant-extract.example/extract');
        expect(mockResolveHostnameSSRF).toHaveBeenCalledWith(
          'tenant-search.example',
          undefined,
          '443',
        );
        expect(mockResolveHostnameSSRF).toHaveBeenCalledWith(
          'tenant-extract.example',
          undefined,
          '443',
        );
        expect(result.authTypes).toEqual([
          ['providers', AuthType.USER_PROVIDED],
          ['scrapers', AuthType.USER_PROVIDED],
          ['rerankers', AuthType.SYSTEM_DEFINED],
        ]);
      } finally {
        process.env = originalEnv;
      }
    });

    it('threads allowedAddresses and the effective port into the SSRF preflight for user-provided URLs', async () => {
      mockIsSSRFTarget.mockClear();
      mockResolveHostnameSSRF.mockClear();
      mockIsSSRFTarget.mockReturnValue(false);
      mockResolveHostnameSSRF.mockResolvedValue(false);

      const originalEnv = process.env;
      try {
        process.env = { ...originalEnv };
        delete process.env.SEARXNG_INSTANCE_URL;

        const searxngConfig = {
          searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
          searchProvider: 'searxng' as SearchProviders,
          rerankerType: 'none' as RerankerTypes,
          allowedAddresses: ['localhost:8888'],
        } as TWebSearchConfig;

        mockLoadAuthValues.mockImplementation(({ authFields }) => {
          const result: Record<string, string> = {};
          authFields.forEach((field: string) => {
            if (field === 'SEARXNG_INSTANCE_URL') {
              result[field] = 'http://localhost:8888';
            }
          });
          return Promise.resolve(result);
        });

        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig: searxngConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(mockIsSSRFTarget).toHaveBeenCalledWith('localhost', ['localhost:8888'], '8888');
        expect(mockResolveHostnameSSRF).toHaveBeenCalledWith(
          'localhost',
          ['localhost:8888'],
          '8888',
        );
        expect(result.authResult.searxngInstanceUrl).toBe('http://localhost:8888');
      } finally {
        process.env = originalEnv;
      }
    });

    it('should preserve safeSearch setting from webSearchConfig', async () => {
      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] = 'test-api-key';
        });
        return Promise.resolve(result);
      });

      // Test with safeSearch: OFF
      const configWithSafeSearchOff = {
        ...webSearchConfig,
        safeSearch: SafeSearchTypes.OFF,
      } as TWebSearchConfig;

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: configWithSafeSearchOff,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult).toHaveProperty('safeSearch', SafeSearchTypes.OFF);
    });

    it('should authenticate Keenable keyless (no API key configured)', async () => {
      // Keenable works against the public endpoint with no key. Return nothing for
      // the KEENABLE_* fields; other categories still authenticate normally.
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field.startsWith('KEENABLE_')) {
            return;
          }
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const keenableConfig = {
        ...webSearchConfig,
        keenableApiKey: '${KEENABLE_API_KEY}',
        keenableApiUrl: '${KEENABLE_API_URL}',
        searchProvider: 'keenable' as SearchProviders,
        keenableSearchOptions: { maxResults: 7 },
      } as TWebSearchConfig;

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: keenableConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.searchProvider).toBe('keenable' as SearchProviders);
      // No key was resolved, so it should not be set on the result.
      expect(result.authResult.keenableApiKey).toBeUndefined();
      // Provider-specific options are passed through untouched.
      expect(result.authResult.keenableSearchOptions).toEqual({ maxResults: 7 });
    });

    it('should pick up a configured Keenable API key', async () => {
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'KEENABLE_API_KEY') {
            result[field] = 'user-keenable-key';
          } else if (field === 'KEENABLE_API_URL') {
            return;
          } else {
            result[field] =
              field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const keenableConfig = {
        ...webSearchConfig,
        keenableApiKey: '${KEENABLE_API_KEY}',
        keenableApiUrl: '${KEENABLE_API_URL}',
        searchProvider: 'keenable' as SearchProviders,
      } as TWebSearchConfig;

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: keenableConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.searchProvider).toBe('keenable' as SearchProviders);
      expect(result.authResult.keenableApiKey).toBe('user-keenable-key');
    });

    it('should keep Keenable editable when the URL is user-provided but not saved yet', async () => {
      const originalApiKey = process.env.KEENABLE_API_KEY;
      const originalApiUrl = process.env.KEENABLE_API_URL;
      process.env.KEENABLE_API_KEY = 'system-keenable-key';
      process.env.KEENABLE_API_URL = AuthType.USER_PROVIDED;
      mockLoadAuthValues.mockResolvedValue({
        KEENABLE_API_KEY: 'system-keenable-key',
      });

      try {
        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig: {
            keenableApiKey: '${KEENABLE_API_KEY}',
            keenableApiUrl: '${KEENABLE_API_URL}',
            searchProvider: SearchProviders.KEENABLE,
            scraperProvider: ScraperProviders.KEENABLE,
            rerankerType: RerankerTypes.NONE,
            safeSearch: SafeSearchTypes.MODERATE,
          } as TWebSearchConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authTypes).toEqual([
          [SearchCategories.PROVIDERS, AuthType.USER_PROVIDED],
          [SearchCategories.SCRAPERS, AuthType.USER_PROVIDED],
          [SearchCategories.RERANKERS, AuthType.SYSTEM_DEFINED],
        ]);
      } finally {
        if (originalApiKey == null) {
          delete process.env.KEENABLE_API_KEY;
        } else {
          process.env.KEENABLE_API_KEY = originalApiKey;
        }
        if (originalApiUrl == null) {
          delete process.env.KEENABLE_API_URL;
        } else {
          process.env.KEENABLE_API_URL = originalApiUrl;
        }
      }
    });

    it('should not send a system Keenable key to a user-provided API URL', async () => {
      const originalApiKey = process.env.KEENABLE_API_KEY;
      const originalApiUrl = process.env.KEENABLE_API_URL;
      process.env.KEENABLE_API_KEY = 'system-keenable-key';
      delete process.env.KEENABLE_API_URL;
      mockLoadAuthValues.mockResolvedValue({
        KEENABLE_API_KEY: 'system-keenable-key',
        KEENABLE_API_URL: 'https://user-keenable.example.com',
      });

      try {
        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig: {
            keenableApiKey: '${KEENABLE_API_KEY}',
            keenableApiUrl: '${KEENABLE_API_URL}',
            searchProvider: 'keenable' as SearchProviders,
            scraperProvider: 'keenable' as ScraperProviders,
            rerankerType: 'none' as RerankerTypes,
            safeSearch: SafeSearchTypes.MODERATE,
          } as TWebSearchConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authResult.keenableApiUrl).toBe('https://user-keenable.example.com');
        expect(result.authResult.keenableApiKey).toBeUndefined();
        expect(result.authTypes).toEqual([
          ['providers', AuthType.USER_PROVIDED],
          ['scrapers', AuthType.USER_PROVIDED],
          ['rerankers', AuthType.SYSTEM_DEFINED],
        ]);
      } finally {
        if (originalApiKey == null) {
          delete process.env.KEENABLE_API_KEY;
        } else {
          process.env.KEENABLE_API_KEY = originalApiKey;
        }
        if (originalApiUrl == null) {
          delete process.env.KEENABLE_API_URL;
        } else {
          process.env.KEENABLE_API_URL = originalApiUrl;
        }
      }
    });

    it('should not send a system Jina key to a user-provided API URL', async () => {
      const originalApiKey = process.env.JINA_API_KEY;
      const originalApiUrl = process.env.JINA_API_URL;
      process.env.JINA_API_KEY = 'system-jina-key';
      process.env.JINA_API_URL = AuthType.USER_PROVIDED;
      mockIsSSRFTarget.mockReturnValue(false);
      mockResolveHostnameSSRF.mockResolvedValue(false);
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'JINA_API_KEY') {
            result[field] = 'system-jina-key';
          } else if (field === 'JINA_API_URL') {
            result[field] = 'https://user-jina.example.com/v1/rerank';
          } else {
            result[field] =
              field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      try {
        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig: {
            ...webSearchConfig,
            rerankerType: RerankerTypes.JINA,
          },
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authResult.jinaApiKey).toBe('system-jina-key');
        expect(result.authResult.jinaApiUrl).toBe('https://api.jina.ai/v1/rerank');
        expect(result.authTypes).toContainEqual([
          SearchCategories.RERANKERS,
          AuthType.SYSTEM_DEFINED,
        ]);
        expect(mockResolveHostnameSSRF).toHaveBeenCalledWith(
          'user-jina.example.com',
          undefined,
          '443',
        );
      } finally {
        if (originalApiKey == null) {
          delete process.env.JINA_API_KEY;
        } else {
          process.env.JINA_API_KEY = originalApiKey;
        }
        if (originalApiUrl == null) {
          delete process.env.JINA_API_URL;
        } else {
          process.env.JINA_API_URL = originalApiUrl;
        }
      }
    });

    it("should keep a user-provided Jina URL with the same user's key", async () => {
      const originalApiKey = process.env.JINA_API_KEY;
      const originalApiUrl = process.env.JINA_API_URL;
      delete process.env.JINA_API_KEY;
      delete process.env.JINA_API_URL;
      mockIsSSRFTarget.mockReturnValue(false);
      mockResolveHostnameSSRF.mockResolvedValue(false);
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'JINA_API_KEY') {
            result[field] = 'user-jina-key';
          } else if (field === 'JINA_API_URL') {
            result[field] = 'https://user-jina.example.com/v1/rerank';
          } else {
            result[field] =
              field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      try {
        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig: {
            ...webSearchConfig,
            rerankerType: RerankerTypes.JINA,
          },
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authResult.jinaApiKey).toBe('user-jina-key');
        expect(result.authResult.jinaApiUrl).toBe('https://user-jina.example.com/v1/rerank');
        expect(result.authTypes).toContainEqual([
          SearchCategories.RERANKERS,
          AuthType.USER_PROVIDED,
        ]);
      } finally {
        if (originalApiKey == null) {
          delete process.env.JINA_API_KEY;
        } else {
          process.env.JINA_API_KEY = originalApiKey;
        }
        if (originalApiUrl == null) {
          delete process.env.JINA_API_URL;
        } else {
          process.env.JINA_API_URL = originalApiUrl;
        }
      }
    });

    it('should treat a whitespace-only Keenable URL env value as user-provided', async () => {
      const originalApiKey = process.env.KEENABLE_API_KEY;
      const originalApiUrl = process.env.KEENABLE_API_URL;
      process.env.KEENABLE_API_KEY = 'system-keenable-key';
      process.env.KEENABLE_API_URL = '   ';
      mockLoadAuthValues.mockResolvedValue({
        KEENABLE_API_KEY: 'system-keenable-key',
        KEENABLE_API_URL: 'https://user-keenable.example.com',
      });

      try {
        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig: {
            keenableApiKey: '${KEENABLE_API_KEY}',
            keenableApiUrl: '${KEENABLE_API_URL}',
            searchProvider: 'keenable' as SearchProviders,
            scraperProvider: 'keenable' as ScraperProviders,
            rerankerType: 'none' as RerankerTypes,
            safeSearch: SafeSearchTypes.MODERATE,
          } as TWebSearchConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authResult.keenableApiUrl).toBe('https://user-keenable.example.com');
        expect(result.authResult.keenableApiKey).toBeUndefined();
      } finally {
        if (originalApiKey == null) {
          delete process.env.KEENABLE_API_KEY;
        } else {
          process.env.KEENABLE_API_KEY = originalApiKey;
        }
        if (originalApiUrl == null) {
          delete process.env.KEENABLE_API_URL;
        } else {
          process.env.KEENABLE_API_URL = originalApiUrl;
        }
      }
    });

    it('should reject selected Keenable auth when its user API URL is blocked', async () => {
      mockIsSSRFTarget.mockReturnValueOnce(true);
      mockLoadAuthValues.mockResolvedValue({
        KEENABLE_API_KEY: 'user-keenable-key',
        KEENABLE_API_URL: 'http://127.0.0.1:8080',
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: {
          keenableApiKey: '${KEENABLE_API_KEY}',
          keenableApiUrl: '${KEENABLE_API_URL}',
          searchProvider: 'keenable' as SearchProviders,
          scraperProvider: 'keenable' as ScraperProviders,
          rerankerType: 'none' as RerankerTypes,
          safeSearch: SafeSearchTypes.MODERATE,
        } as TWebSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(false);
      expect(result.authResult.searchProvider).toBe(SearchProviders.KEENABLE);
      expect(result.authResult.scraperProvider).toBe(ScraperProviders.KEENABLE);
      expect(result.authResult.keenableApiKey).toBeUndefined();
      expect(result.authResult.keenableApiUrl).toBeUndefined();
    });

    it('should authenticate a fully keyless Keenable stack (search + scrape + no reranker)', async () => {
      // Nothing is authenticated anywhere: every field resolves empty.
      mockLoadAuthValues.mockImplementation(() => Promise.resolve({}));

      const keenableConfig = {
        keenableApiKey: '${KEENABLE_API_KEY}',
        keenableApiUrl: '${KEENABLE_API_URL}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
        searchProvider: 'keenable' as SearchProviders,
        scraperProvider: 'keenable' as ScraperProviders,
        rerankerType: 'none' as RerankerTypes,
        safeSearch: SafeSearchTypes.MODERATE,
      } as TWebSearchConfig;

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: keenableConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.searchProvider).toBe('keenable' as SearchProviders);
      expect(result.authResult.scraperProvider).toBe('keenable' as ScraperProviders);
      expect(result.authResult.rerankerType).toBe('none' as RerankerTypes);
      // Keyless: no credential ends up on the result.
      expect(result.authResult.keenableApiKey).toBeUndefined();
      expect(result.authTypes).toEqual([
        ['providers', AuthType.USER_PROVIDED],
        ['scrapers', AuthType.USER_PROVIDED],
        ['rerankers', AuthType.SYSTEM_DEFINED],
      ]);
    });

    it('should fail closed when optional Keenable credential lookup fails', async () => {
      mockLoadAuthValues.mockImplementation(({ authFields, failOnOptionalError }) => {
        if (failOnOptionalError && authFields.includes('KEENABLE_API_URL')) {
          return Promise.reject(new Error('Credential store unavailable'));
        }
        return Promise.resolve({});
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: {
          keenableApiKey: '${KEENABLE_API_KEY}',
          keenableApiUrl: '${KEENABLE_API_URL}',
          searchProvider: SearchProviders.KEENABLE,
          scraperProvider: ScraperProviders.KEENABLE,
          rerankerType: RerankerTypes.NONE,
          safeSearch: SafeSearchTypes.MODERATE,
        } as TWebSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(false);
      expect(result.authResult.keenableApiKey).toBeUndefined();
      expect(result.authResult.keenableApiUrl).toBeUndefined();
      expect(mockLoadAuthValues).toHaveBeenCalledWith(
        expect.objectContaining({
          authFields: ['KEENABLE_API_KEY', 'KEENABLE_API_URL'],
          throwError: true,
          failOnOptionalError: true,
        }),
      );
    });

    it('should restore a fully keyless Keenable stack from per-user selections', async () => {
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === webSearchSelectionFields.selectedProvider) {
            result[field] = 'keenable';
          } else if (field === webSearchSelectionFields.selectedScraper) {
            result[field] = 'keenable';
          } else if (field === webSearchSelectionFields.selectedReranker) {
            result[field] = 'none';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: {
          keenableApiKey: '${KEENABLE_API_KEY}',
          keenableApiUrl: '${KEENABLE_API_URL}',
          safeSearch: SafeSearchTypes.MODERATE,
        } as TWebSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.searchProvider).toBe('keenable');
      expect(result.authResult.scraperProvider).toBe('keenable');
      expect(result.authResult.rerankerType).toBe('none');
      expect(result.authTypes.every(([, authType]) => authType === AuthType.USER_PROVIDED)).toBe(
        true,
      );
    });

    it('should fail closed when persisted-selection lookup fails', async () => {
      mockLoadAuthValues.mockImplementation(({ authFields, failOnOptionalError }) => {
        if (failOnOptionalError && authFields.includes(webSearchSelectionFields.selectedProvider)) {
          return Promise.reject(new Error('Credential store unavailable'));
        }
        return Promise.resolve(
          Object.fromEntries(authFields.map((field: string) => [field, 'system-value'])),
        );
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: {
          serperApiKey: '${SERPER_API_KEY}',
          firecrawlApiKey: '${FIRECRAWL_API_KEY}',
          jinaApiKey: '${JINA_API_KEY}',
          safeSearch: SafeSearchTypes.MODERATE,
        } as TWebSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(false);
      expect(result.authResult.searchProvider).toBeUndefined();
      expect(result.authResult.scraperProvider).toBeUndefined();
      expect(result.authResult.rerankerType).toBeUndefined();
      expect(mockLoadAuthValues).toHaveBeenCalledWith(
        expect.objectContaining({
          authFields: [
            webSearchSelectionFields.selectedProvider,
            webSearchSelectionFields.selectedScraper,
            webSearchSelectionFields.selectedReranker,
          ],
          throwError: true,
          failOnOptionalError: true,
        }),
      );
    });

    it('should return a persisted provider selection when its credential is missing', async () => {
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        if (authFields.includes(webSearchSelectionFields.selectedProvider)) {
          return Promise.resolve({
            [webSearchSelectionFields.selectedProvider]: SearchProviders.TAVILY,
          });
        }
        return Promise.resolve({});
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: {
          tavilyApiKey: '${TAVILY_API_KEY}',
          firecrawlApiKey: '${FIRECRAWL_API_KEY}',
          safeSearch: SafeSearchTypes.MODERATE,
        } as TWebSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(false);
      expect(result.authResult.searchProvider).toBe(SearchProviders.TAVILY);
      expect(result.authTypes).toContainEqual(['providers', AuthType.USER_PROVIDED]);
    });

    it('should pass Keenable scraper options through and honor their timeout', async () => {
      mockLoadAuthValues.mockImplementation(() => Promise.resolve({}));

      const keenableConfig = {
        keenableApiKey: '${KEENABLE_API_KEY}',
        searchProvider: 'keenable' as SearchProviders,
        scraperProvider: 'keenable' as ScraperProviders,
        rerankerType: 'none' as RerankerTypes,
        keenableScraperOptions: { timeout: 12000, attributionTitle: 'LibreChat' },
        safeSearch: SafeSearchTypes.MODERATE,
      } as TWebSearchConfig;

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: keenableConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.keenableScraperOptions).toEqual({
        timeout: 12000,
        attributionTitle: 'LibreChat',
      });
      expect(result.authResult.scraperTimeout).toBe(12000);
    });

    it('should select Keenable when a key is supplied but no searchProvider is pinned', async () => {
      // The API-key dialog can submit credentials but cannot pin a provider, and
      // Keenable has no required auth field, so the generic loop would skip it.
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'KEENABLE_API_KEY') {
            result[field] = 'user-keenable-key';
          }
        });
        return Promise.resolve(result);
      });

      const unpinnedConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        keenableApiKey: '${KEENABLE_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
      } as TWebSearchConfig;

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: unpinnedConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.searchProvider).toBe('keenable' as SearchProviders);
      expect(result.authResult.keenableApiKey).toBe('user-keenable-key');
      // The scraper completes the Keenable stack, since none of the keyed
      // scrapers authenticated and no scraperProvider was pinned.
      expect(result.authResult.scraperProvider).toBe('keenable' as ScraperProviders);
      expect(result.authResult.rerankerType).toBe('none' as RerankerTypes);
    });

    it('should not select Keenable when nothing is configured for it', async () => {
      // Guard against the keyless fallback hijacking installs that configured no
      // provider at all: without a Keenable value, the category stays unauthenticated.
      mockLoadAuthValues.mockImplementation(() => Promise.resolve({}));

      const emptyConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        keenableApiKey: '${KEENABLE_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
      } as TWebSearchConfig;

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: emptyConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(false);
      expect(result.authResult.searchProvider).toBeUndefined();
      expect(result.authResult.scraperProvider).toBeUndefined();
    });

    it('should scrape with Keenable for another search provider when a key is supplied', async () => {
      // SearXNG stays the search provider while the user submits a Keenable key
      // for the scraper. The dialog cannot pin `scraperProvider`, so a supplied
      // Keenable value is the only signal that Keenable was chosen here.
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'SEARXNG_INSTANCE_URL') {
            result[field] = 'https://searx.example.com';
          }
          if (field === 'KEENABLE_API_KEY') {
            result[field] = 'user-keenable-key';
          }
        });
        return Promise.resolve(result);
      });

      const scraperOnlyConfig = {
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        keenableApiKey: '${KEENABLE_API_KEY}',
        searchProvider: 'searxng' as SearchProviders,
        rerankerType: 'none' as RerankerTypes,
        safeSearch: SafeSearchTypes.MODERATE,
      } as TWebSearchConfig;

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: scraperOnlyConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.searchProvider).toBe('searxng' as SearchProviders);
      expect(result.authResult.scraperProvider).toBe('keenable' as ScraperProviders);
      expect(result.authResult.keenableApiKey).toBe('user-keenable-key');
      expect(result.authenticated).toBe(true);
    });

    it('should ignore a saved Keenable search URL for scraper-only Keenable', async () => {
      const originalApiKey = process.env.KEENABLE_API_KEY;
      const originalSerperKey = process.env.SERPER_API_KEY;
      process.env.KEENABLE_API_KEY = 'system-keenable-key';
      process.env.SERPER_API_KEY = 'system-serper-key';
      mockIsSSRFTarget.mockReturnValue(true);
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        for (const field of authFields) {
          if (field === 'KEENABLE_API_KEY') {
            result[field] = 'system-keenable-key';
          } else if (field === 'KEENABLE_API_URL') {
            result[field] = 'http://127.0.0.1:8080';
          } else if (field === 'SERPER_API_KEY') {
            result[field] = 'system-serper-key';
          }
        }
        return Promise.resolve(result);
      });

      try {
        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig: {
            serperApiKey: '${SERPER_API_KEY}',
            keenableApiKey: '${KEENABLE_API_KEY}',
            keenableApiUrl: '${KEENABLE_API_URL}',
            searchProvider: SearchProviders.SERPER,
            scraperProvider: ScraperProviders.KEENABLE,
            rerankerType: RerankerTypes.NONE,
            safeSearch: SafeSearchTypes.MODERATE,
          } as TWebSearchConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authenticated).toBe(true);
        expect(result.authResult.searchProvider).toBe(SearchProviders.SERPER);
        expect(result.authResult.scraperProvider).toBe(ScraperProviders.KEENABLE);
        expect(result.authResult.keenableApiKey).toBe('system-keenable-key');
        expect(result.authResult.keenableApiUrl).toBeUndefined();
        expect(mockLoadAuthValues).toHaveBeenCalledWith(
          expect.objectContaining({ authFields: ['KEENABLE_API_KEY'] }),
        );
        expect(mockLoadAuthValues).not.toHaveBeenCalledWith(
          expect.objectContaining({ authFields: ['KEENABLE_API_KEY', 'KEENABLE_API_URL'] }),
        );
        expect(mockIsSSRFTarget).not.toHaveBeenCalled();
      } finally {
        mockIsSSRFTarget.mockReturnValue(false);
        if (originalApiKey == null) {
          delete process.env.KEENABLE_API_KEY;
        } else {
          process.env.KEENABLE_API_KEY = originalApiKey;
        }
        if (originalSerperKey == null) {
          delete process.env.SERPER_API_KEY;
        } else {
          process.env.SERPER_API_KEY = originalSerperKey;
        }
      }
    });

    it('should not scrape with Keenable for another search provider without a Keenable value', async () => {
      // SearXNG authenticates as the provider (it is not also a scraper); with no
      // scraper key configured and no Keenable value the scrapers category must
      // stay unauthenticated rather than fall back to Keenable.
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'SEARXNG_INSTANCE_URL') {
            result[field] = 'https://searx.example.com';
          }
        });
        return Promise.resolve(result);
      });

      const mixedConfig = {
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        keenableApiKey: '${KEENABLE_API_KEY}',
        searchProvider: 'searxng' as SearchProviders,
        rerankerType: 'none' as RerankerTypes,
        safeSearch: SafeSearchTypes.MODERATE,
      } as TWebSearchConfig;

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig: mixedConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.searchProvider).toBe('searxng' as SearchProviders);
      expect(result.authResult.scraperProvider).toBeUndefined();
      expect(result.authenticated).toBe(false);
    });

    it('should set the correct service types in authResult', async () => {
      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      // Check that the correct service types are set
      expect(result.authResult.searchProvider).toBe('serper' as SearchProviders);
      expect(result.authResult.scraperProvider).toBe('firecrawl' as ScraperProviders);
      // One of the rerankers should be set
      expect(['jina', 'cohere']).toContain(result.authResult.rerankerType as string);
    });

    it('should check all services if none are specified', async () => {
      // Initialize a webSearchConfig without specific services
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
      };

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);

      // Should have checked all categories
      expect(result.authTypes).toHaveLength(3);

      // Should have set values for all categories
      expect(result.authResult.searchProvider).toBeDefined();
      expect(result.authResult.scraperProvider).toBeDefined();
      expect(result.authResult.rerankerType).toBeDefined();
    });

    it('should correctly identify authTypes based on specific configurations', async () => {
      // Set up environment variables for system-defined auth
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        SERPER_API_KEY: 'system-serper-key',
        FIRECRAWL_API_KEY: 'system-firecrawl-key',
        FIRECRAWL_API_URL: 'https://api.firecrawl.dev',
        JINA_API_KEY: 'system-jina-key',
        COHERE_API_KEY: 'system-cohere-key',
      };

      // Initialize webSearchConfig with environment variable references
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        // Specify which services to use
        searchProvider: 'serper' as SearchProviders,
        scraperProvider: 'firecrawl' as ScraperProviders,
        rerankerType: 'jina' as RerankerTypes,
      };

      // Mock loadAuthValues to return the actual values
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'SERPER_API_KEY') {
            result[field] = 'system-serper-key';
          } else if (field === 'FIRECRAWL_API_KEY') {
            result[field] = 'system-firecrawl-key';
          } else if (field === 'FIRECRAWL_API_URL') {
            result[field] = 'https://api.firecrawl.dev';
          } else if (field === 'JINA_API_KEY') {
            result[field] = 'system-jina-key';
          } else if (field === 'COHERE_API_KEY') {
            result[field] = 'system-cohere-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      // Verify that all required fields are present in the authResult
      expect(result.authResult).toHaveProperty('serperApiKey');
      expect(result.authResult).toHaveProperty('firecrawlApiKey');
      expect(result.authResult).toHaveProperty('firecrawlApiUrl');
      expect(result.authResult).toHaveProperty('jinaApiKey');
      expect(result.authResult).toHaveProperty('searchProvider');
      expect(result.authResult).toHaveProperty('scraperProvider');
      expect(result.authResult).toHaveProperty('rerankerType');

      expect(result.authenticated).toBe(true);

      // Verify authTypes for each category
      const providersAuthType = result.authTypes.find(
        ([category]) => category === 'providers',
      )?.[1];
      const scrapersAuthType = result.authTypes.find(([category]) => category === 'scrapers')?.[1];
      const rerankersAuthType = result.authTypes.find(
        ([category]) => category === 'rerankers',
      )?.[1];

      // All should be system-defined since we're using environment variables
      expect(providersAuthType).toBe(AuthType.SYSTEM_DEFINED);
      expect(scrapersAuthType).toBe(AuthType.SYSTEM_DEFINED);
      expect(rerankersAuthType).toBe(AuthType.SYSTEM_DEFINED);

      // Verify the authResult contains the correct values
      expect(result.authResult).toHaveProperty('serperApiKey', 'system-serper-key');
      expect(result.authResult).toHaveProperty('firecrawlApiKey', 'system-firecrawl-key');
      expect(result.authResult).toHaveProperty('firecrawlApiUrl', 'https://api.firecrawl.dev');
      expect(result.authResult).toHaveProperty('jinaApiKey', 'system-jina-key');
      expect(result.authResult).toHaveProperty('searchProvider', 'serper');
      expect(result.authResult).toHaveProperty('scraperProvider', 'firecrawl');
      expect(result.authResult).toHaveProperty('rerankerType', 'jina');

      // Restore original env
      process.env = originalEnv;
    });

    it('should handle custom variable names in environment variables', async () => {
      // Set up environment variables with custom names
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        CUSTOM_SERPER_KEY: 'custom-serper-key',
        CUSTOM_FIRECRAWL_KEY: 'custom-firecrawl-key',
        CUSTOM_FIRECRAWL_URL: 'https://custom.firecrawl.dev',
        CUSTOM_JINA_KEY: 'custom-jina-key',
        CUSTOM_COHERE_KEY: 'custom-cohere-key',
        CUSTOM_JINA_URL: 'https://custom.jina.ai',
      };

      // Initialize webSearchConfig with custom variable names
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${CUSTOM_SERPER_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${CUSTOM_FIRECRAWL_KEY}',
        firecrawlApiUrl: '${CUSTOM_FIRECRAWL_URL}',
        jinaApiKey: '${CUSTOM_JINA_KEY}',
        jinaApiUrl: '${CUSTOM_JINA_URL}',
        cohereApiKey: '${CUSTOM_COHERE_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        // Specify which services to use
        searchProvider: 'serper' as SearchProviders,
        scraperProvider: 'firecrawl' as ScraperProviders,
        rerankerType: 'jina' as RerankerTypes, // Only Jina will be checked
      };

      // Mock loadAuthValues to return the actual values
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'CUSTOM_SERPER_KEY') {
            result[field] = 'custom-serper-key';
          } else if (field === 'CUSTOM_FIRECRAWL_KEY') {
            result[field] = 'custom-firecrawl-key';
          } else if (field === 'CUSTOM_FIRECRAWL_URL') {
            result[field] = 'https://custom.firecrawl.dev';
          } else if (field === 'CUSTOM_JINA_KEY') {
            result[field] = 'custom-jina-key';
          }
          // Note: CUSTOM_COHERE_KEY is not checked because we specified jina as rerankerType
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);

      // Verify the authResult contains the correct values from custom variables
      expect(result.authResult).toHaveProperty('serperApiKey', 'custom-serper-key');
      expect(result.authResult).toHaveProperty('firecrawlApiKey', 'custom-firecrawl-key');
      expect(result.authResult).toHaveProperty('firecrawlApiUrl', 'https://custom.firecrawl.dev');
      expect(result.authResult).toHaveProperty('jinaApiKey', 'custom-jina-key');
      // cohereApiKey should not be in the result since we specified jina as rerankerType
      expect(result.authResult).not.toHaveProperty('cohereApiKey');

      // Verify the service types are set correctly
      expect(result.authResult).toHaveProperty('searchProvider', 'serper');
      expect(result.authResult).toHaveProperty('scraperProvider', 'firecrawl');
      expect(result.authResult).toHaveProperty('rerankerType', 'jina');

      // Restore original env
      process.env = originalEnv;
    });

    it('should always return authTypes array with exactly 3 categories', async () => {
      // Set up environment variables
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        SERPER_API_KEY: 'test-key',
        FIRECRAWL_API_KEY: 'test-key',
        FIRECRAWL_API_URL: 'https://api.firecrawl.dev',
        JINA_API_KEY: 'test-key',
      };

      // Initialize webSearchConfig with environment variable references
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
      };

      // Mock loadAuthValues to return values
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] = field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      // Get the number of categories from webSearchAuth
      const expectedCategoryCount = Object.keys(webSearchAuth).length;

      // Verify authTypes array structure
      expect(result.authTypes).toHaveLength(expectedCategoryCount);

      // Verify each category exists exactly once
      const categories = result.authTypes.map(([category]) => category);
      Object.keys(webSearchAuth).forEach((category) => {
        expect(categories).toContain(category);
      });

      // Verify no duplicate categories
      expect(new Set(categories).size).toBe(expectedCategoryCount);

      // Verify each entry has the correct format [category, AuthType]
      result.authTypes.forEach(([category, authType]) => {
        expect(typeof category).toBe('string');
        expect([AuthType.SYSTEM_DEFINED, AuthType.USER_PROVIDED]).toContain(authType);
      });

      // Restore original env
      process.env = originalEnv;
    });

    it('should maintain authTypes array structure even when authentication fails', async () => {
      // Set up environment variables
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        JINA_API_KEY: 'test-key',
      };

      // Initialize webSearchConfig with environment variable references
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
      };

      // Mock loadAuthValues to return partial values
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'JINA_API_KEY') {
            result[field] = 'test-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      // Get the number of categories from webSearchAuth
      const expectedCategoryCount = Object.keys(webSearchAuth).length;

      // Verify authentication failed
      expect(result.authenticated).toBe(false);

      // Verify authTypes array structure is maintained
      expect(result.authTypes).toHaveLength(expectedCategoryCount);

      // Verify each category exists exactly once
      const categories = result.authTypes.map(([category]) => category);
      Object.keys(webSearchAuth).forEach((category) => {
        expect(categories).toContain(category);
      });

      // Verify no duplicate categories
      expect(new Set(categories).size).toBe(expectedCategoryCount);

      // Verify each entry has the correct format [category, AuthType]
      result.authTypes.forEach(([category, authType]) => {
        expect(typeof category).toBe('string');
        expect([AuthType.SYSTEM_DEFINED, AuthType.USER_PROVIDED]).toContain(authType);
      });

      // Restore original env
      process.env = originalEnv;
    });
  });

  describe('webSearchAuth', () => {
    it('should have the expected structure', () => {
      // Check that all expected categories exist
      expect(webSearchAuth).toHaveProperty('providers');
      expect(webSearchAuth).toHaveProperty('scrapers');
      expect(webSearchAuth).toHaveProperty('rerankers');

      // Check providers
      expect(webSearchAuth.providers).toHaveProperty('serper');
      expect(webSearchAuth.providers.serper).toHaveProperty('serperApiKey', 1);

      // Check scrapers
      expect(webSearchAuth.scrapers).toHaveProperty('firecrawl');
      expect(webSearchAuth.scrapers.firecrawl).toHaveProperty('firecrawlApiKey', 1);
      expect(webSearchAuth.scrapers.firecrawl).toHaveProperty('firecrawlApiUrl', 0);

      // Check rerankers
      expect(webSearchAuth.rerankers).toHaveProperty('jina');
      expect(webSearchAuth.rerankers.jina).toHaveProperty('jinaApiKey', 1);
      expect(webSearchAuth.rerankers).toHaveProperty('cohere');
      expect(webSearchAuth.rerankers.cohere).toHaveProperty('cohereApiKey', 1);
    });

    it('should mark required keys with value 1', () => {
      // All keys with value 1 are required
      expect(webSearchAuth.providers.serper.serperApiKey).toBe(1);
      expect(webSearchAuth.scrapers.firecrawl.firecrawlApiKey).toBe(1);
      expect(webSearchAuth.rerankers.jina.jinaApiKey).toBe(1);
      expect(webSearchAuth.rerankers.cohere.cohereApiKey).toBe(1);
    });

    it('should mark optional keys with value 0', () => {
      // Keys with value 0 are optional
      expect(webSearchAuth.scrapers.firecrawl.firecrawlApiUrl).toBe(0);
    });
  });
  describe('loadWebSearchAuth with specific services', () => {
    // Common test variables
    const userId = 'test-user-id';
    let mockLoadAuthValues: jest.Mock;

    beforeEach(() => {
      // Reset mocks before each test
      jest.clearAllMocks();

      // Initialize the mock function
      mockLoadAuthValues = jest.fn();
    });

    it('should only check the specified searchProvider', async () => {
      // Initialize a webSearchConfig with a specific searchProvider
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'serper' as SearchProviders,
      };

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.searchProvider).toBe('serper');

      // Verify that only SERPER_API_KEY was requested for the providers category
      const providerCalls = mockLoadAuthValues.mock.calls.filter((call) =>
        call[0].authFields.includes('SERPER_API_KEY'),
      );
      expect(providerCalls.length).toBe(1);
    });

    it('should authenticate Tavily as a search provider and pass options through', async () => {
      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          TAVILY_SEARCH_URL: 'https://api.tavily.com/search',
        };

        const webSearchConfig: TCustomConfig['webSearch'] = {
          tavilyApiKey: '${TAVILY_API_KEY}',
          tavilySearchUrl: '${TAVILY_SEARCH_URL}',
          firecrawlApiKey: '${FIRECRAWL_API_KEY}',
          firecrawlApiUrl: '${FIRECRAWL_API_URL}',
          safeSearch: SafeSearchTypes.MODERATE,
          searchProvider: 'tavily' as SearchProviders,
          scraperProvider: 'firecrawl' as ScraperProviders,
          rerankerType: 'none' as RerankerTypes,
          tavilySearchOptions: {
            searchDepth: 'advanced',
            maxResults: 5,
            includeRawContent: 'markdown',
          },
        };

        mockLoadAuthValues.mockImplementation(({ authFields }) => {
          const result: Record<string, string> = {};
          authFields.forEach((field: string) => {
            if (field === 'TAVILY_API_KEY') {
              result[field] = 'tavily-api-key';
            } else if (field === 'TAVILY_SEARCH_URL') {
              result[field] = 'https://api.tavily.com/search';
            } else if (field === 'FIRECRAWL_API_URL') {
              result[field] = 'https://api.firecrawl.dev';
            } else {
              result[field] = 'test-api-key';
            }
          });
          return Promise.resolve(result);
        });

        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authenticated).toBe(true);
        expect(result.authResult.searchProvider).toBe('tavily');
        expect(result.authResult.tavilyApiKey).toBe('tavily-api-key');
        expect(result.authResult.tavilySearchUrl).toBe('https://api.tavily.com/search');
        expect(result.authResult.tavilySearchOptions).toEqual(webSearchConfig.tavilySearchOptions);
        expect(result.authResult.safeSearch).toBeUndefined();
      } finally {
        process.env = originalEnv;
      }
    });

    it('should authenticate SearXNG as a search provider and pass search options through', async () => {
      const webSearchConfig: TCustomConfig['webSearch'] = {
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'searxng' as SearchProviders,
        scraperProvider: 'firecrawl' as ScraperProviders,
        rerankerType: 'none' as RerankerTypes,
        searxngSearchOptions: {
          engines: 'google,bing,startpage,qwant',
          language: 'en',
          timeRange: 'month',
          timeout: 15000,
        },
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'SEARXNG_INSTANCE_URL') {
            result[field] = 'https://search.example';
          } else if (field === 'SEARXNG_API_KEY') {
            result[field] = 'searxng-api-key';
          } else if (field === 'FIRECRAWL_API_URL') {
            result[field] = 'https://api.firecrawl.dev';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.searchProvider).toBe('searxng');
      expect(result.authResult.searxngInstanceUrl).toBe('https://search.example');
      expect(result.authResult.searxngSearchOptions).toEqual(webSearchConfig.searxngSearchOptions);
    });

    it('should leave searxngSearchOptions undefined when not configured', async () => {
      const webSearchConfig: TCustomConfig['webSearch'] = {
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'searxng' as SearchProviders,
        scraperProvider: 'firecrawl' as ScraperProviders,
        rerankerType: 'none' as RerankerTypes,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'SEARXNG_INSTANCE_URL') {
            result[field] = 'https://search.example';
          } else if (field === 'FIRECRAWL_API_URL') {
            result[field] = 'https://api.firecrawl.dev';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.searxngSearchOptions).toBeUndefined();
    });

    it('should fail authentication when Tavily search API key is missing', async () => {
      const webSearchConfig: TCustomConfig['webSearch'] = {
        tavilyApiKey: '${TAVILY_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'tavily' as SearchProviders,
        scraperProvider: 'firecrawl' as ScraperProviders,
        rerankerType: 'none' as RerankerTypes,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field !== 'TAVILY_API_KEY') {
            result[field] =
              field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(false);
      const providersAuthType = result.authTypes.find(
        ([category]) => category === 'providers',
      )?.[1];
      expect(providersAuthType).toBe(AuthType.USER_PROVIDED);
    });

    it('should authenticate Tavily as both search provider and scraper with a shared key', async () => {
      const webSearchConfig: TCustomConfig['webSearch'] = {
        tavilyApiKey: '${TAVILY_API_KEY}',
        tavilySearchUrl: '${TAVILY_SEARCH_URL}',
        tavilyExtractUrl: '${TAVILY_EXTRACT_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'tavily' as SearchProviders,
        scraperProvider: 'tavily' as ScraperProviders,
        rerankerType: 'none' as RerankerTypes,
        tavilyScraperOptions: {
          extractDepth: 'advanced',
          timeout: 20000,
        },
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'TAVILY_API_KEY') {
            result[field] = 'tavily-api-key';
          } else if (field === 'TAVILY_SEARCH_URL') {
            result[field] = 'https://api.tavily.com/search';
          } else if (field === 'TAVILY_EXTRACT_URL') {
            result[field] = 'https://api.tavily.com/extract';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.searchProvider).toBe('tavily');
      expect(result.authResult.scraperProvider).toBe('tavily');
      expect(result.authResult.tavilyApiKey).toBe('tavily-api-key');
      expect(result.authResult.tavilyScraperOptions).toEqual(webSearchConfig.tavilyScraperOptions);
      expect(result.authResult.scraperTimeout).toBe(20000);
    });

    it('should only check the specified scraperProvider', async () => {
      // Initialize a webSearchConfig with a specific scraperProvider
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        scraperProvider: 'firecrawl' as ScraperProviders,
      };

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.scraperProvider).toBe('firecrawl');

      // Verify that only FIRECRAWL_API_KEY and FIRECRAWL_API_URL were requested for the scrapers category
      const scraperCalls = mockLoadAuthValues.mock.calls.filter((call) =>
        call[0].authFields.includes('FIRECRAWL_API_KEY'),
      );
      expect(scraperCalls.length).toBe(1);
    });

    it('should only check the specified rerankerType', async () => {
      // Initialize a webSearchConfig with a specific rerankerType
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        rerankerType: 'jina' as RerankerTypes,
      };

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.rerankerType).toBe('jina');

      // Verify that only JINA_API_KEY was requested for the rerankers category
      const rerankerCalls = mockLoadAuthValues.mock.calls.filter((call) =>
        call[0].authFields.includes('JINA_API_KEY'),
      );
      expect(rerankerCalls.length).toBe(1);

      // Verify that COHERE_API_KEY was not requested
      const cohereCalls = mockLoadAuthValues.mock.calls.filter((call) =>
        call[0].authFields.includes('COHERE_API_KEY'),
      );
      expect(cohereCalls.length).toBe(0);
    });

    it('should handle a rerankerType of `none`', async () => {
      // Initialize a webSearchConfig with a specific rerankerType
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        rerankerType: 'none' as RerankerTypes,
      };

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.rerankerType).toBe('none');

      // Verify that we didn't request any reranker keys
      const cohereCalls = mockLoadAuthValues.mock.calls.filter(
        (call) =>
          call[0].authFields.includes('COHERE_API_KEY') ||
          call[0].authFields.includes('JINA_API_KEY'),
      );
      expect(cohereCalls.length).toBe(0);
    });

    it('should fallback to no reranker when rerankerType is omitted and no reranker is authenticated', async () => {
      const webSearchConfig: TCustomConfig['webSearch'] = {
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'searxng' as SearchProviders,
        scraperProvider: 'firecrawl' as ScraperProviders,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'SEARXNG_INSTANCE_URL') {
            result[field] = 'https://search.example';
          } else if (field === 'SEARXNG_API_KEY') {
            result[field] = 'searxng-api-key';
          } else if (field === 'FIRECRAWL_API_KEY') {
            result[field] = 'firecrawl-api-key';
          } else if (field === 'FIRECRAWL_API_URL') {
            result[field] = 'https://api.firecrawl.dev';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.rerankerType).toBe('none');
      expect(result.authTypes).toContainEqual(['rerankers', AuthType.SYSTEM_DEFINED]);
    });

    it('should handle invalid specified service gracefully', async () => {
      // Initialize a webSearchConfig with an invalid searchProvider
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'invalid-provider' as SearchProviders,
      };

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      // Should fail because the specified provider doesn't exist
      expect(result.authenticated).toBe(false);
    });

    it('should fail authentication when specified service is not authenticated but others are', async () => {
      // Initialize a webSearchConfig with a specific rerankerType (jina)
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        rerankerType: 'jina' as RerankerTypes,
      };

      // Mock authentication where cohere is authenticated but jina is not
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          // Authenticate all fields except JINA_API_KEY
          if (field !== 'JINA_API_KEY') {
            result[field] =
              field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      // Should fail because the specified reranker (jina) is not authenticated
      // even though another reranker (cohere) might be authenticated
      expect(result.authenticated).toBe(false);

      // Verify that JINA_API_KEY was requested
      const jinaApiKeyCalls = mockLoadAuthValues.mock.calls.filter((call) =>
        call[0].authFields.includes('JINA_API_KEY'),
      );
      expect(jinaApiKeyCalls.length).toBe(1);

      // Verify that COHERE_API_KEY was not requested since we specified jina
      const cohereApiKeyCalls = mockLoadAuthValues.mock.calls.filter((call) =>
        call[0].authFields.includes('COHERE_API_KEY'),
      );
      expect(cohereApiKeyCalls.length).toBe(0);
    });

    it('should check all services if none are specified', async () => {
      // Initialize a webSearchConfig without specific services
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
      };

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);

      // Should have checked all categories
      expect(result.authTypes).toHaveLength(3);

      // Should have set values for all categories
      expect(result.authResult.searchProvider).toBeDefined();
      expect(result.authResult.scraperProvider).toBeDefined();
      expect(result.authResult.rerankerType).toBeDefined();
    });

    it('should handle firecrawlOptions properties', async () => {
      // Initialize a webSearchConfig with comprehensive firecrawlOptions
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        cohereApiKey: '${COHERE_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        firecrawlOptions: {
          formats: ['markdown', 'html'],
          includeTags: ['img', 'p', 'h1'],
          excludeTags: ['script', 'style'],
          headers: { 'User-Agent': 'TestBot' },
          waitFor: 2000,
          timeout: 15000,
          maxAge: 3600,
          mobile: true,
          skipTlsVerification: false,
          blockAds: true,
          removeBase64Images: false,
          parsePDF: true,
          storeInCache: false,
          zeroDataRetention: true,
          location: {
            country: 'US',
            languages: ['en'],
          },
          onlyMainContent: true,
          changeTrackingOptions: {
            modes: ['diff'],
            schema: { title: 'string' },
            prompt: 'Track changes',
            tag: 'test-tag',
          },
        },
      };

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.firecrawlOptions).toEqual(webSearchConfig.firecrawlOptions);
      expect(result.authResult.scraperTimeout).toBe(15000); // Should use firecrawlOptions.timeout
    });

    it('should use scraperTimeout when both scraperTimeout and firecrawlOptions.timeout are provided', async () => {
      // Initialize a webSearchConfig with both scraperTimeout and firecrawlOptions.timeout
      const webSearchConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        scraperTimeout: 15000, // This should take priority
        firecrawlOptions: {
          timeout: 10000, // This should be ignored
          includeTags: ['p'],
          formats: ['markdown'],
        },
      } as TCustomConfig['webSearch'];

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.scraperTimeout).toBe(15000); // Should use explicit scraperTimeout
      expect(result.authResult.firecrawlOptions).toEqual({
        timeout: 10000,
        includeTags: ['p'],
        formats: ['markdown'],
      });
    });

    it('should fallback to default timeout when neither scraperTimeout nor firecrawlOptions.timeout are provided', async () => {
      // Initialize a webSearchConfig without timeout values
      const webSearchConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        firecrawlOptions: {
          includeTags: ['p'],
          formats: ['markdown'],
        },
      } as TCustomConfig['webSearch'];

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.scraperTimeout).toBe(7500); // Should use default timeout
      expect(result.authResult.firecrawlOptions).toEqual({
        includeTags: ['p'],
        formats: ['markdown'],
      });
    });

    it('should use firecrawlOptions.timeout when only firecrawlOptions.timeout is provided', async () => {
      // Initialize a webSearchConfig with only firecrawlOptions.timeout
      const webSearchConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        firecrawlOptions: {
          timeout: 12000, // Only timeout provided
        },
      } as TCustomConfig['webSearch'];

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.scraperTimeout).toBe(12000); // Should use firecrawlOptions.timeout
      expect(result.authResult.firecrawlOptions).toEqual({
        timeout: 12000,
      });
    });

    it('should not use tavilyScraperOptions.timeout for firecrawl scraper', async () => {
      const webSearchConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        tavilyApiKey: '${TAVILY_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        scraperProvider: 'firecrawl' as ScraperProviders,
        tavilyScraperOptions: {
          timeout: 22000,
        },
      } as TCustomConfig['webSearch'];

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.scraperTimeout).toBe(7500);
    });

    it('should use tavilyScraperOptions.timeout for tavily scraper', async () => {
      const webSearchConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        tavilyApiKey: '${TAVILY_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        scraperProvider: 'tavily' as ScraperProviders,
        firecrawlOptions: {
          timeout: 12000,
        },
        tavilyScraperOptions: {
          timeout: 22000,
        },
      } as TCustomConfig['webSearch'];

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.scraperTimeout).toBe(22000);
    });

    it('should handle firecrawlOptions.formats when only formats is provided', async () => {
      // Initialize a webSearchConfig with only firecrawlOptions.formats
      const webSearchConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        firecrawlOptions: {
          formats: ['html', 'markdown'], // Only formats provided
        },
      } as TCustomConfig['webSearch'];

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.scraperTimeout).toBe(7500); // Should use default timeout
      expect(result.authResult.firecrawlOptions).toEqual({
        formats: ['html', 'markdown'],
      });
    });

    it('should handle firecrawlOptions without formats property', async () => {
      // Initialize a webSearchConfig with firecrawlOptions but no formats
      const webSearchConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        firecrawlOptions: {
          timeout: 8000,
          includeTags: ['p', 'h1'],
          // formats is intentionally missing
        },
      } as TCustomConfig['webSearch'];

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.scraperTimeout).toBe(8000); // Should use firecrawlOptions.timeout
      expect(result.authResult.firecrawlOptions).toEqual({
        timeout: 8000,
        includeTags: ['p', 'h1'],
        // formats should be undefined/missing
      });
    });

    it('should handle webSearchConfig without firecrawlOptions at all', async () => {
      // Initialize a webSearchConfig without any firecrawlOptions
      const webSearchConfig = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        // firecrawlOptions is intentionally missing
      } as TCustomConfig['webSearch'];

      // Mock successful authentication
      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          result[field] =
            field === 'FIRECRAWL_API_URL' ? 'https://api.firecrawl.dev' : 'test-api-key';
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authResult.scraperTimeout).toBe(7500); // Should use default timeout
      expect(result.authResult.firecrawlOptions).toBeUndefined(); // Should be undefined
    });
  });

  describe('SSRF protection for user-provided URLs', () => {
    const userId = 'test-user-id';
    let mockLoadAuthValues: jest.Mock;

    beforeEach(() => {
      jest.clearAllMocks();
      mockLoadAuthValues = jest.fn();
      mockIsSSRFTarget.mockReturnValue(false);
      mockResolveHostnameSSRF.mockResolvedValue(false);
    });

    it('should block user-provided jinaApiUrl targeting localhost', async () => {
      mockIsSSRFTarget.mockImplementation((hostname: string) => hostname === 'localhost');

      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        rerankerType: 'jina' as RerankerTypes,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'JINA_API_URL') {
            result[field] = 'http://localhost:8080/rerank';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.jinaApiUrl).toBe('https://api.jina.ai/v1/rerank');
      expect(mockIsSSRFTarget).toHaveBeenCalledWith('localhost', undefined, '8080');
    });

    it('should block user-provided firecrawlApiUrl resolving to private IP', async () => {
      mockResolveHostnameSSRF.mockImplementation((hostname: string) =>
        Promise.resolve(hostname === 'evil.internal-service.com'),
      );

      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        scraperProvider: 'firecrawl' as ScraperProviders,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'FIRECRAWL_API_URL') {
            result[field] = 'https://evil.internal-service.com/scrape';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.firecrawlApiUrl).toBeUndefined();
      expect(result.authenticated).toBe(true);
      const scrapersAuth = result.authTypes.find(([c]) => c === 'scrapers')?.[1];
      expect(scrapersAuth).toBe(AuthType.USER_PROVIDED);
    });

    it('should ignore user-provided tavilySearchUrl without admin opt-in', async () => {
      mockIsSSRFTarget.mockImplementation((hostname: string) => hostname === 'localhost');

      const webSearchConfig: TCustomConfig['webSearch'] = {
        tavilyApiKey: '${TAVILY_API_KEY}',
        tavilySearchUrl: '${TAVILY_SEARCH_URL}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'tavily' as SearchProviders,
        rerankerType: 'none' as RerankerTypes,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'TAVILY_SEARCH_URL') {
            result[field] = 'http://localhost:8080/search';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.tavilySearchUrl).toBeUndefined();
      expect(result.authResult.searchProvider).toBe('tavily');
      expect(result.authenticated).toBe(true);
      expect(mockIsSSRFTarget).not.toHaveBeenCalled();
    });

    it('should ignore user-provided tavilyExtractUrl without admin opt-in', async () => {
      mockResolveHostnameSSRF.mockImplementation((hostname: string) =>
        Promise.resolve(hostname === 'extract.internal-service.com'),
      );

      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        tavilyApiKey: '${TAVILY_API_KEY}',
        tavilyExtractUrl: '${TAVILY_EXTRACT_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        scraperProvider: 'tavily' as ScraperProviders,
        rerankerType: 'none' as RerankerTypes,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'TAVILY_EXTRACT_URL') {
            result[field] = 'https://extract.internal-service.com/extract';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.tavilyExtractUrl).toBeUndefined();
      expect(result.authResult.scraperProvider).toBe('tavily');
      expect(result.authenticated).toBe(true);
      const scrapersAuth = result.authTypes.find(([c]) => c === 'scrapers')?.[1];
      expect(scrapersAuth).toBe(AuthType.USER_PROVIDED);
      expect(mockResolveHostnameSSRF).not.toHaveBeenCalled();
    });

    it('should block opted-in tavilySearchUrl targeting localhost', async () => {
      mockIsSSRFTarget.mockImplementation((hostname: string) => hostname === 'localhost');

      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          TAVILY_SEARCH_URL: AuthType.USER_PROVIDED,
        };

        const webSearchConfig: TCustomConfig['webSearch'] = {
          tavilyApiKey: '${TAVILY_API_KEY}',
          tavilySearchUrl: '${TAVILY_SEARCH_URL}',
          firecrawlApiKey: '${FIRECRAWL_API_KEY}',
          safeSearch: SafeSearchTypes.MODERATE,
          searchProvider: 'tavily' as SearchProviders,
          rerankerType: 'none' as RerankerTypes,
        };

        mockLoadAuthValues.mockImplementation(({ authFields }) => {
          const result: Record<string, string> = {};
          authFields.forEach((field: string) => {
            if (field === 'TAVILY_SEARCH_URL') {
              result[field] = 'http://localhost:8080/search';
            } else {
              result[field] = 'test-api-key';
            }
          });
          return Promise.resolve(result);
        });

        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authResult.tavilySearchUrl).toBeUndefined();
        expect(result.authResult.searchProvider).toBe('tavily');
        expect(result.authenticated).toBe(true);
        expect(mockIsSSRFTarget).toHaveBeenCalledWith('localhost', undefined, '8080');
      } finally {
        process.env = originalEnv;
      }
    });

    it('should block opted-in tavilyExtractUrl resolving to a private host', async () => {
      mockResolveHostnameSSRF.mockImplementation((hostname: string) =>
        Promise.resolve(hostname === 'extract.internal-service.com'),
      );

      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          TAVILY_EXTRACT_URL: AuthType.USER_PROVIDED,
        };

        const webSearchConfig: TCustomConfig['webSearch'] = {
          serperApiKey: '${SERPER_API_KEY}',
          tavilyApiKey: '${TAVILY_API_KEY}',
          tavilyExtractUrl: '${TAVILY_EXTRACT_URL}',
          safeSearch: SafeSearchTypes.MODERATE,
          scraperProvider: 'tavily' as ScraperProviders,
          rerankerType: 'none' as RerankerTypes,
        };

        mockLoadAuthValues.mockImplementation(({ authFields }) => {
          const result: Record<string, string> = {};
          authFields.forEach((field: string) => {
            if (field === 'TAVILY_EXTRACT_URL') {
              result[field] = 'https://extract.internal-service.com/extract';
            } else {
              result[field] = 'test-api-key';
            }
          });
          return Promise.resolve(result);
        });

        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authResult.tavilyExtractUrl).toBeUndefined();
        expect(result.authResult.scraperProvider).toBe('tavily');
        expect(result.authenticated).toBe(true);
        expect(mockResolveHostnameSSRF).toHaveBeenCalledWith(
          'extract.internal-service.com',
          undefined,
          '443',
        );
      } finally {
        process.env = originalEnv;
      }
    });

    it('should block user-provided searxngInstanceUrl targeting metadata endpoint', async () => {
      mockIsSSRFTarget.mockImplementation((hostname: string) => hostname === '169.254.169.254');

      const webSearchConfig: TCustomConfig['webSearch'] = {
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'searxng' as SearchProviders,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'SEARXNG_INSTANCE_URL') {
            result[field] = 'http://169.254.169.254/latest/meta-data';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.searxngInstanceUrl).toBeUndefined();
      expect(result.authenticated).toBe(false);
    });

    it('should allow system-defined URLs even if they match SSRF patterns', async () => {
      mockIsSSRFTarget.mockReturnValue(true);

      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          JINA_API_KEY: 'system-jina-key',
          JINA_API_URL: 'http://jina-internal:8080/rerank',
        };

        const webSearchConfig: TCustomConfig['webSearch'] = {
          serperApiKey: '${SERPER_API_KEY}',
          firecrawlApiKey: '${FIRECRAWL_API_KEY}',
          jinaApiKey: '${JINA_API_KEY}',
          jinaApiUrl: '${JINA_API_URL}',
          safeSearch: SafeSearchTypes.MODERATE,
          rerankerType: 'jina' as RerankerTypes,
        };

        mockLoadAuthValues.mockImplementation(({ authFields }) => {
          const result: Record<string, string> = {};
          authFields.forEach((field: string) => {
            if (field === 'JINA_API_KEY') {
              result[field] = 'system-jina-key';
            } else if (field === 'JINA_API_URL') {
              result[field] = 'http://jina-internal:8080/rerank';
            } else {
              result[field] = 'test-api-key';
            }
          });
          return Promise.resolve(result);
        });

        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authResult.jinaApiUrl).toBe('http://jina-internal:8080/rerank');
        expect(result.authenticated).toBe(true);
      } finally {
        process.env = originalEnv;
      }
    });

    it('should reject URLs with invalid format', async () => {
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        scraperProvider: 'firecrawl' as ScraperProviders,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'FIRECRAWL_API_URL') {
            result[field] = 'not-a-valid-url';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.firecrawlApiUrl).toBeUndefined();
      expect(result.authenticated).toBe(true);
      const scrapersAuth = result.authTypes.find(([c]) => c === 'scrapers')?.[1];
      expect(scrapersAuth).toBe(AuthType.USER_PROVIDED);
    });

    it('should reject non-HTTP schemes like file://', async () => {
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        scraperProvider: 'firecrawl' as ScraperProviders,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'FIRECRAWL_API_URL') {
            result[field] = 'file:///etc/passwd';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.firecrawlApiUrl).toBeUndefined();
      expect(result.authenticated).toBe(true);
    });

    it('should allow legitimate external URLs', async () => {
      const webSearchConfig: TCustomConfig['webSearch'] = {
        serperApiKey: '${SERPER_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        firecrawlApiUrl: '${FIRECRAWL_API_URL}',
        jinaApiKey: '${JINA_API_KEY}',
        jinaApiUrl: '${JINA_API_URL}',
        safeSearch: SafeSearchTypes.MODERATE,
        scraperProvider: 'firecrawl' as ScraperProviders,
        rerankerType: 'jina' as RerankerTypes,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'FIRECRAWL_API_URL') {
            result[field] = 'https://api.firecrawl.dev';
          } else if (field === 'JINA_API_URL') {
            result[field] = 'https://api.jina.ai/v1/rerank';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authResult.firecrawlApiUrl).toBe('https://api.firecrawl.dev');
      expect(result.authResult.jinaApiUrl).toBe('https://api.jina.ai/v1/rerank');
      expect(result.authenticated).toBe(true);
    });

    it('should fail required URL field and mark category unauthenticated', async () => {
      mockIsSSRFTarget.mockImplementation((hostname: string) => hostname === '127.0.0.1');

      const webSearchConfig: TCustomConfig['webSearch'] = {
        searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        searxngApiKey: '${SEARXNG_API_KEY}',
        firecrawlApiKey: '${FIRECRAWL_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
        safeSearch: SafeSearchTypes.MODERATE,
        searchProvider: 'searxng' as SearchProviders,
      };

      mockLoadAuthValues.mockImplementation(({ authFields }) => {
        const result: Record<string, string> = {};
        authFields.forEach((field: string) => {
          if (field === 'SEARXNG_INSTANCE_URL') {
            result[field] = 'http://127.0.0.1:8888/search';
          } else {
            result[field] = 'test-api-key';
          }
        });
        return Promise.resolve(result);
      });

      const result = await loadWebSearchAuth({
        userId,
        webSearchConfig,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(result.authenticated).toBe(false);
      const providersAuthType = result.authTypes.find(
        ([category]) => category === 'providers',
      )?.[1];
      expect(providersAuthType).toBe(AuthType.USER_PROVIDED);
    });

    it('should report SYSTEM_DEFINED when only user-provided field is a stripped SSRF URL', async () => {
      mockIsSSRFTarget.mockImplementation((hostname: string) => hostname === 'localhost');

      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          JINA_API_KEY: 'system-jina-key',
        };

        const webSearchConfig: TCustomConfig['webSearch'] = {
          serperApiKey: '${SERPER_API_KEY}',
          firecrawlApiKey: '${FIRECRAWL_API_KEY}',
          jinaApiKey: '${JINA_API_KEY}',
          jinaApiUrl: '${JINA_API_URL}',
          safeSearch: SafeSearchTypes.MODERATE,
          rerankerType: 'jina' as RerankerTypes,
        };

        mockLoadAuthValues.mockImplementation(({ authFields }) => {
          const result: Record<string, string> = {};
          authFields.forEach((field: string) => {
            if (field === 'JINA_API_KEY') {
              result[field] = 'system-jina-key';
            } else if (field === 'JINA_API_URL') {
              result[field] = 'http://localhost:9999/rerank';
            } else {
              result[field] = 'test-api-key';
            }
          });
          return Promise.resolve(result);
        });

        const result = await loadWebSearchAuth({
          userId,
          webSearchConfig,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result.authResult.jinaApiUrl).toBe('https://api.jina.ai/v1/rerank');
        expect(result.authenticated).toBe(true);
        const rerankersAuth = result.authTypes.find(([c]) => c === 'rerankers')?.[1];
        expect(rerankersAuth).toBe(AuthType.SYSTEM_DEFINED);
      } finally {
        process.env = originalEnv;
      }
    });
  });
});
