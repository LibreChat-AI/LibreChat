import axios from 'axios';
import { createSearchTool } from '@librechat/agents';
import { loadWebSearchConfig } from '@librechat/data-schemas';
import {
  AuthType,
  RerankerTypes,
  SearchProviders,
  ScraperProviders,
  SearchCategories,
  webSearchSchema,
} from 'librechat-data-provider';
import type { TWebSearchConfigInput } from 'librechat-data-provider';
import { loadWebSearchAuth, getWebSearchInstallEntries, getWebSearchUninstallFields } from './web';
import { encryptConfigSecretFields, redactConfigSecrets } from '~/admin/secrets';

jest.mock('@librechat/data-schemas', () => {
  process.env.CREDS_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  return jest.requireActual('@librechat/data-schemas');
});

const config: TWebSearchConfigInput = {
  searchProvider: SearchProviders.KAGI,
  scraperProvider: ScraperProviders.KAGI,
  rerankerType: RerankerTypes.NONE,
  kagiApiKey: 'kagi-test-secret',
};

const loadEmptyAuth = async (): Promise<Record<string, string>> => ({});

async function authenticate(overrides: TWebSearchConfigInput = {}) {
  return loadWebSearchAuth({
    userId: 'kagi-user',
    webSearchConfig: loadWebSearchConfig({ ...config, ...overrides }),
    loadAuthValues: loadEmptyAuth,
  });
}

describe('Kagi web search integration', () => {
  it('authenticates both categories with one configured key and forwards their options', async () => {
    const result = await authenticate({
      kagiSearchOptions: { limit: 12, timeout: 18000 },
      kagiScraperOptions: { timeout: 20000 },
    });
    expect(result.authenticated).toBe(true);
    expect(result.authTypes).toEqual([
      [SearchCategories.PROVIDERS, AuthType.SYSTEM_DEFINED],
      [SearchCategories.SCRAPERS, AuthType.SYSTEM_DEFINED],
      [SearchCategories.RERANKERS, AuthType.SYSTEM_DEFINED],
    ]);
    expect(result.authResult).toMatchObject({
      kagiApiKey: config.kagiApiKey,
      searchProvider: SearchProviders.KAGI,
      scraperProvider: ScraperProviders.KAGI,
      kagiSearchOptions: { limit: 12, timeout: 18000 },
      kagiScraperOptions: { timeout: 20000 },
      scraperTimeout: 20000,
    });
  });

  it('gives the global scraper timeout precedence', async () => {
    const result = await authenticate({
      scraperTimeout: 6000,
      kagiScraperOptions: { timeout: 20000 },
    });
    expect(result.authResult.scraperTimeout).toBe(6000);
  });

  it('does not apply Kagi scraper timeout to another scraper', async () => {
    const result = await authenticate({
      scraperProvider: ScraperProviders.SERPER,
      serperApiKey: 'serper-test-secret',
      kagiScraperOptions: { timeout: 20000 },
    });
    expect(result.authenticated).toBe(true);
    expect(result.authResult.scraperTimeout).toBe(7500);
  });

  it.each([
    { searchProvider: SearchProviders.SERPER, serperApiKey: 'serper-test-secret' },
    { scraperProvider: ScraperProviders.SERPER, serperApiKey: 'serper-test-secret' },
  ])('supports independent provider selection: %j', async (overrides) => {
    const result = await authenticate(overrides);
    expect(result.authenticated).toBe(true);
    expect(result.authResult).toMatchObject({ ...config, ...overrides });
  });

  it('requires credentials for both selected Kagi services', async () => {
    const result = await authenticate({ kagiApiKey: '' });
    expect(result.authenticated).toBe(false);
    expect(result.authTypes).toContainEqual([SearchCategories.PROVIDERS, AuthType.USER_PROVIDED]);
    expect(result.authTypes).toContainEqual([SearchCategories.SCRAPERS, AuthType.USER_PROVIDED]);
  });

  it('loads a user key and saved Kagi selections through the existing credential contract', async () => {
    const result = await loadWebSearchAuth({
      userId: 'kagi-user',
      webSearchConfig: loadWebSearchConfig({}),
      loadAuthValues: async () => ({
        KAGI_API_KEY: 'user-kagi-secret',
        LIBRECHAT_WEB_SEARCH_PROVIDER: SearchProviders.KAGI,
        LIBRECHAT_WEB_SEARCH_SCRAPER: ScraperProviders.KAGI,
        LIBRECHAT_WEB_SEARCH_RERANKER: RerankerTypes.NONE,
      }),
    });
    expect(result.authenticated).toBe(true);
    expect(result.authResult).toMatchObject({
      searchProvider: SearchProviders.KAGI,
      scraperProvider: ScraperProviders.KAGI,
      kagiApiKey: 'user-kagi-secret',
    });
    expect(result.authTypes).toContainEqual([SearchCategories.PROVIDERS, AuthType.USER_PROVIDED]);
  });

  it('encrypts, redacts and resolves an admin-stored shared key', async () => {
    const stored = encryptConfigSecretFields({ webSearch: config });
    const storedConfig = webSearchSchema.parse(stored.webSearch);
    expect(storedConfig.kagiApiKey).toMatch(/^v3:/);
    expect(JSON.stringify(redactConfigSecrets(stored))).not.toContain(config.kagiApiKey);
    const result = await authenticate(storedConfig);
    expect(result.authenticated).toBe(true);
    expect(result.authResult.kagiApiKey).toBe(config.kagiApiKey);
  });

  it('maps installation and revocation to the Kagi credential field', () => {
    expect(
      getWebSearchInstallEntries({
        auth: { kagiApiKey: 'user-kagi-secret' },
        config: loadWebSearchConfig({}),
      }),
    ).toEqual([['KAGI_API_KEY', 'user-kagi-secret']]);
    expect(getWebSearchUninstallFields(loadWebSearchConfig({}))).toContain('KAGI_API_KEY');
  });

  it('runs the resolved host configuration through native Kagi search and Markdown extraction', async () => {
    const post = jest.spyOn(axios, 'post');
    post.mockResolvedValueOnce({
      data: {
        data: { search: [{ title: 'Example', url: 'https://example.com', snippet: 'A page' }] },
      },
    });
    post.mockResolvedValueOnce({
      data: { data: [{ url: 'https://example.com', markdown: '# Example\n\nExtracted content.' }] },
    });
    const result = await authenticate();
    const { authResult } = result;
    const tool = createSearchTool({
      searchProvider: authResult.searchProvider,
      scraperProvider: authResult.scraperProvider,
      rerankerType: authResult.rerankerType,
      kagiApiKey: authResult.kagiApiKey,
      kagiSearchOptions: authResult.kagiSearchOptions,
      kagiScraperOptions: authResult.kagiScraperOptions,
      scraperTimeout: authResult.scraperTimeout,
      safeSearch: authResult.safeSearch,
    });
    const output: string = await tool.invoke({ query: 'example' });
    expect(output).toContain('Example');
    expect(post).toHaveBeenNthCalledWith(
      1,
      'https://kagi.com/api/v1/search',
      expect.objectContaining({ query: 'example', workflow: 'search', format: 'json' }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer kagi-test-secret' }),
      }),
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      'https://kagi.com/api/v1/extract',
      { pages: [{ url: 'https://example.com' }], format: 'json' },
      expect.objectContaining({ timeout: 7500 }),
    );
  });
});
