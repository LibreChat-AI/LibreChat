import http from 'node:http';
import { createSearchTool } from '@librechat/agents';
import {
  AuthType,
  RerankerTypes,
  SearchProviders,
  ScraperProviders,
} from 'librechat-data-provider';
import {
  logger,
  loadWebSearchConfig,
  mergeConfigOverrides,
  BASE_CONFIG_PRINCIPAL_ID,
} from '@librechat/data-schemas';
import type { TCustomConfig, TWebSearchConfigInput } from 'librechat-data-provider';
import type { AppConfig, IConfig } from '@librechat/data-schemas';
import type { AddressInfo } from 'node:net';
import { encryptConfigSecretFields } from '~/admin/secrets';
import { resolveWebSearchSSRFAgents } from './agent';
import { loadWebSearchAuth } from './web';

/** Encryption reads `CREDS_KEY` when data-schemas loads, before any spec code runs. */
jest.mock('@librechat/data-schemas', () => {
  process.env.CREDS_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  return jest.requireActual('@librechat/data-schemas');
});

const PLATFORM_KEY = 'platform-env-key-0001';
const ENV_NAMES = [
  'KEENABLE_API_KEY',
  'KEENABLE_API_URL',
  'KEENABLE_FETCH_URL',
  'SEARXNG_API_KEY',
  'SEARXNG_INSTANCE_URL',
] as const;

interface CapturedRequest {
  path: string;
  apiKey: string | null;
}

/**
 * Runs web search the way `handleTools` does — auth resolution, connect-time
 * SSRF agents, then the search library's own clients — against a local
 * endpoint that records the API key each request carries.
 */
describe('web search credentials reach the search library', () => {
  const requests: CapturedRequest[] = [];
  /** Search hits the endpoint returns; a hit makes the scraper fetch its page. */
  let results: Array<{ title: string; url: string; snippet: string }> = [];
  const server = http.createServer((req, res) => {
    const apiKey = req.headers['x-api-key'];
    requests.push({ path: req.url ?? '', apiKey: typeof apiKey === 'string' ? apiKey : null });
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ results, content: 'Scraped page content.' }));
    });
  });
  let endpoint = '';
  let allowedAddress = '';
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    allowedAddress = `127.0.0.1:${port}`;
    endpoint = `http://${allowedAddress}/v1/search`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.KEENABLE_API_KEY = PLATFORM_KEY;
    process.env.SEARXNG_API_KEY = PLATFORM_KEY;
    requests.length = 0;
    results = [];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /** The value the admin config API stores for a web search secret. */
  function stored(path: string, secret: string): string {
    return encryptConfigSecretFields({ [path]: secret })[path] as string;
  }

  /** Mirrors `loadAuthValues`: a set environment value wins, otherwise the user's saved value. */
  function authValuesFor(userValues: Record<string, string>) {
    return async ({ authFields }: { authFields: string[] }) => {
      const values: Record<string, string> = {};
      for (const field of authFields) {
        const envValue = process.env[field];
        const value =
          envValue && envValue.trim() !== '' && envValue !== AuthType.USER_PROVIDED
            ? envValue
            : userValues[field];
        if (value != null) {
          values[field] = value;
        }
      }
      return values;
    };
  }

  function withDefaults(config: TWebSearchConfigInput): TWebSearchConfigInput {
    return {
      scraperProvider: ScraperProviders.KEENABLE,
      rerankerType: RerankerTypes.NONE,
      allowedAddresses: [allowedAddress],
      ...config,
    };
  }

  async function search(
    config: TWebSearchConfigInput,
    userValues: Record<string, string> = {},
  ): Promise<CapturedRequest[]> {
    return searchWith(loadWebSearchConfig(withDefaults(config)), userValues);
  }

  async function searchWith(
    webSearchConfig: TCustomConfig['webSearch'],
    userValues: Record<string, string> = {},
  ): Promise<CapturedRequest[]> {
    const { authenticated, authResult } = await loadWebSearchAuth({
      userId: 'web-integration-user',
      webSearchConfig,
      loadAuthValues: authValuesFor(userValues),
    });
    expect(authenticated).toBe(true);

    /** Firecrawl's option block is typed looser than the library's and no case here scrapes with it. */
    const { firecrawlOptions: _firecrawlOptions, ...searchConfig } = authResult;
    const agents = resolveWebSearchSSRFAgents(authResult, webSearchConfig?.allowedAddresses);
    const tool = createSearchTool({ ...searchConfig, ...agents, logger });
    await tool.invoke({ query: 'librechat' });
    return requests.splice(0);
  }

  it('sends the environment key to an endpoint the environment supplies', async () => {
    process.env.KEENABLE_API_URL = endpoint;

    const sent = await search({ searchProvider: SearchProviders.KEENABLE });

    expect(sent).toEqual([{ path: '/v1/search', apiKey: PLATFORM_KEY }]);
  });

  it.each([
    {
      name: 'Keenable',
      config: (url: string): TWebSearchConfigInput => ({
        searchProvider: SearchProviders.KEENABLE,
        keenableApiUrl: url,
        keenableApiKey: stored('webSearch.keenableApiKey', 'keenable-admin-key-0001'),
      }),
      secret: 'keenable-admin-key-0001',
    },
    {
      name: 'SearXNG',
      config: (url: string): TWebSearchConfigInput => ({
        searchProvider: SearchProviders.SEARXNG,
        searxngInstanceUrl: url,
        searxngApiKey: stored('webSearch.searxngApiKey', 'searxng-admin-key-0001'),
      }),
      secret: 'searxng-admin-key-0001',
    },
  ])('sends an admin-stored $name key to the URL stored beside it', async ({ config, secret }) => {
    const sent = await search(config(endpoint));

    expect(sent).toHaveLength(1);
    expect(sent[0].apiKey).toBe(secret);
  });

  it.each([
    {
      name: 'a SearXNG URL stored in config',
      config: (url: string): TWebSearchConfigInput => ({
        searchProvider: SearchProviders.SEARXNG,
        searxngInstanceUrl: url,
      }),
    },
    {
      name: 'a SearXNG URL stored in config beside a blank key',
      config: (url: string): TWebSearchConfigInput => ({
        searchProvider: SearchProviders.SEARXNG,
        searxngInstanceUrl: url,
        searxngApiKey: '',
      }),
    },
  ])('never sends the environment key to $name', async ({ config }) => {
    const sent = await search(config(endpoint));

    expect(sent).toHaveLength(1);
    expect(sent[0].apiKey).toBeNull();
  });

  it("never sends a user's saved SearXNG key to a URL stored in config", async () => {
    process.env.SEARXNG_API_KEY = AuthType.USER_PROVIDED;

    const sent = await search(
      { searchProvider: SearchProviders.SEARXNG, searxngInstanceUrl: endpoint },
      { SEARXNG_API_KEY: 'user-own-searxng-key-0001' },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].apiKey).toBeNull();
  });

  it.each([
    {
      name: 'the environment key',
      env: PLATFORM_KEY,
      userValues: {} as Record<string, string>,
      key: PLATFORM_KEY,
    },
    {
      name: "a user's saved key",
      env: AuthType.USER_PROVIDED,
      userValues: { KEENABLE_API_KEY: 'user-own-keenable-key-0001' },
      key: 'user-own-keenable-key-0001',
    },
  ])(
    'sends $name to the Keenable URL the environment supplies, never to one stored in config',
    async ({ env, userValues, key }) => {
      process.env.KEENABLE_API_KEY = env;
      process.env.KEENABLE_API_URL = `http://${allowedAddress}/operator/v1/search`;
      process.env.KEENABLE_FETCH_URL = `http://${allowedAddress}/v1/fetch`;
      results = [{ title: 'LibreChat', url: 'https://www.librechat.ai/', snippet: 'Open source' }];

      const sent = await search(
        {
          searchProvider: SearchProviders.KEENABLE,
          keenableApiUrl: `http://${allowedAddress}/stored-in-config/v1/search`,
        },
        userValues,
      );

      expect(sent.map(({ path, apiKey }) => [path.split('?')[0], apiKey])).toEqual([
        ['/operator/v1/search', key],
        ['/v1/fetch', key],
      ]);
    },
  );

  it('never sends the environment key to a user-provided Keenable URL', async () => {
    process.env.KEENABLE_API_URL = AuthType.USER_PROVIDED;

    const sent = await search(
      { searchProvider: SearchProviders.KEENABLE },
      { KEENABLE_API_URL: endpoint },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].apiKey).toBeNull();
  });

  it('never sends an admin-stored key to a user-provided Keenable URL', async () => {
    delete process.env.KEENABLE_API_KEY;
    process.env.KEENABLE_API_URL = AuthType.USER_PROVIDED;

    const sent = await search(
      {
        searchProvider: SearchProviders.KEENABLE,
        keenableApiKey: stored('webSearch.keenableApiKey', 'keenable-admin-key-0002'),
      },
      { KEENABLE_API_URL: endpoint },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].apiKey).toBeNull();
  });

  it('keeps the environment key for the Keenable scraper beside a user-provided search URL', async () => {
    process.env.KEENABLE_API_URL = AuthType.USER_PROVIDED;
    process.env.KEENABLE_FETCH_URL = `http://${allowedAddress}/v1/fetch`;
    results = [{ title: 'LibreChat', url: 'https://www.librechat.ai/', snippet: 'Open source' }];

    const sent = await search(
      { searchProvider: SearchProviders.KEENABLE },
      { KEENABLE_API_URL: endpoint },
    );

    expect(sent.map(({ path, apiKey }) => [path.split('?')[0], apiKey])).toEqual([
      ['/v1/search', null],
      ['/v1/fetch', PLATFORM_KEY],
    ]);
  });

  describe('keys and URLs set by different config layers', () => {
    const SEARXNG_BASE_KEY = 'sx-base-secret-0001';

    function profile(
      principalId: string,
      priority: number,
      webSearch: TWebSearchConfigInput,
    ): IConfig {
      return {
        principalType: 'role',
        principalId,
        principalModel: 'Role',
        priority,
        overrides: { webSearch },
        isActive: true,
        configVersion: 1,
      } as unknown as IConfig;
    }

    /** The merged config a user with the ADMIN role gets, as `getAppConfig` builds it. */
    function mergedWebSearch(
      yaml: TWebSearchConfigInput,
      ...configs: IConfig[]
    ): TCustomConfig['webSearch'] {
      const config = withDefaults(yaml);
      const base = { config: { webSearch: config }, webSearch: loadWebSearchConfig(config) };
      return mergeConfigOverrides(base as AppConfig, configs).webSearch;
    }

    it('never sends a base-profile key to a URL only a role profile set', async () => {
      const sent = await searchWith(
        mergedWebSearch(
          { searchProvider: SearchProviders.SEARXNG },
          profile(BASE_CONFIG_PRINCIPAL_ID, 0, {
            searxngInstanceUrl: `http://${allowedAddress}/base`,
            searxngApiKey: stored('webSearch.searxngApiKey', SEARXNG_BASE_KEY),
          }),
          profile('ADMIN', 10, { searxngInstanceUrl: endpoint }),
        ),
      );

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ path: expect.stringMatching(/^\/v1\/search/), apiKey: null });
    });

    it('never sends a librechat.yaml key to a URL a config override set', async () => {
      const sent = await searchWith(
        mergedWebSearch(
          {
            searchProvider: SearchProviders.KEENABLE,
            keenableApiUrl: `http://${allowedAddress}/operator`,
            keenableApiKey: 'kn-yaml-literal-0001',
          },
          profile(BASE_CONFIG_PRINCIPAL_ID, 0, { keenableApiUrl: endpoint }),
        ),
      );

      expect(sent).toEqual([{ path: '/v1/search', apiKey: null }]);
    });

    it('never sends a base-profile key to an environment URL a role profile chose', async () => {
      delete process.env.SEARXNG_API_KEY;
      process.env.LC3_OTHER_SERVICE_URL = endpoint;

      try {
        const sent = await searchWith(
          mergedWebSearch(
            { searchProvider: SearchProviders.SEARXNG },
            profile(BASE_CONFIG_PRINCIPAL_ID, 0, {
              searxngInstanceUrl: `http://${allowedAddress}/base`,
              searxngApiKey: stored('webSearch.searxngApiKey', SEARXNG_BASE_KEY),
            }),
            profile('ADMIN', 10, { searxngInstanceUrl: '${LC3_OTHER_SERVICE_URL}' }),
          ),
        );

        expect(sent).toHaveLength(1);
        expect(sent[0]).toEqual({ path: expect.stringMatching(/^\/v1\/search/), apiKey: null });
      } finally {
        delete process.env.LC3_OTHER_SERVICE_URL;
      }
    });

    it('never sends a base-profile key to the default URL once a role profile blanks it', async () => {
      delete process.env.KEENABLE_API_KEY;
      process.env.KEENABLE_API_URL = endpoint;

      const sent = await searchWith(
        mergedWebSearch(
          { searchProvider: SearchProviders.KEENABLE },
          profile(BASE_CONFIG_PRINCIPAL_ID, 0, {
            keenableApiUrl: `http://${allowedAddress}/base`,
            keenableApiKey: stored('webSearch.keenableApiKey', 'kn-base-secret-0003'),
          }),
          profile('ADMIN', 10, { keenableApiUrl: '' }),
        ),
      );

      expect(sent).toEqual([{ path: '/v1/search', apiKey: null }]);
    });

    it("never sends a user's saved key to a URL a role profile set", async () => {
      process.env.SEARXNG_API_KEY = AuthType.USER_PROVIDED;

      const sent = await searchWith(
        mergedWebSearch(
          { searchProvider: SearchProviders.SEARXNG },
          profile('ADMIN', 10, { searxngInstanceUrl: endpoint }),
        ),
        { SEARXNG_API_KEY: 'user-own-searxng-key-0001' },
      );

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ path: expect.stringMatching(/^\/v1\/search/), apiKey: null });
    });

    it('sends a key to the URL the same profile set beside it', async () => {
      const sent = await searchWith(
        mergedWebSearch(
          { searchProvider: SearchProviders.SEARXNG },
          profile(BASE_CONFIG_PRINCIPAL_ID, 0, {
            searxngInstanceUrl: `http://${allowedAddress}/base`,
            searxngApiKey: stored('webSearch.searxngApiKey', SEARXNG_BASE_KEY),
          }),
          profile('ADMIN', 10, {
            searxngInstanceUrl: endpoint,
            searxngApiKey: stored('webSearch.searxngApiKey', 'sx-admin-role-0002'),
          }),
        ),
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].apiKey).toBe('sx-admin-role-0002');
    });
  });

  it('never lets a provider option block redirect the environment key', async () => {
    process.env.KEENABLE_API_URL = endpoint;
    process.env.KEENABLE_FETCH_URL = `http://${allowedAddress}/v1/fetch`;
    results = [{ title: 'LibreChat', url: 'https://www.librechat.ai/', snippet: 'Open source' }];
    const keenableScraperOptions = {
      attributionTitle: 'LibreChat',
      apiUrl: `http://${allowedAddress}/stored-in-config`,
    };

    const sent = await search({ searchProvider: SearchProviders.KEENABLE, keenableScraperOptions });

    expect(sent.map(({ path, apiKey }) => [path.split('?')[0], apiKey])).toEqual([
      ['/v1/search', PLATFORM_KEY],
      ['/v1/fetch', PLATFORM_KEY],
    ]);
  });
});
