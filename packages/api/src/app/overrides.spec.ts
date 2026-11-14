process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { PrincipalType } from 'librechat-data-provider';
import type { AppConfig, ConfigOverrideLayer } from '@librechat/data-schemas';

type DataSchemas = typeof import('@librechat/data-schemas');
type Service = typeof import('./service');

/** Loaded after `CREDS_KEY` is set: the encryption key is read when data-schemas loads. */
let dataSchemas: DataSchemas;
let createAppConfigService: Service['createAppConfigService'];

beforeAll(async () => {
  dataSchemas = await import('@librechat/data-schemas');
  ({ createAppConfigService } = await import('./service'));
});

const yaml = {
  ocr: { apiKey: '${OCR_API_KEY}', baseURL: 'https://api.mistral.ai/v1' },
  mcpServers: {
    tools: { type: 'streamable-http', url: 'https://tools.example.com/mcp' },
  },
};

function createService(
  layers: ConfigOverrideLayer[],
  overrideEnvAllowlist?: string,
  baseYaml: Record<string, unknown> = yaml,
) {
  const store = new Map<string, unknown>();
  const cache = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => store.delete(key),
  };
  const source = structuredClone(baseYaml) as typeof yaml & {
    endpoints?: { custom?: unknown[] };
  };
  const baseConfig = {
    config: source,
    ocr: structuredClone(source.ocr),
    mcpConfig: structuredClone(source.mcpServers),
    ...(source.endpoints && { endpoints: structuredClone(source.endpoints) }),
  } as unknown as AppConfig;
  const service = createAppConfigService({
    loadBaseConfig: async () => baseConfig,
    setCachedTools: async () => undefined,
    getCache: () => cache,
    cacheKeys: { APP_CONFIG: 'app_config' },
    getApplicableConfigs: async () => layers,
    getUserPrincipals: async () => [{ principalType: PrincipalType.ROLE, principalId: 'USER' }],
    overrideEnvAllowlist,
  });
  return { ...service, store };
}

function roleLayer(overrides: Record<string, unknown>): ConfigOverrideLayer {
  return {
    principalType: PrincipalType.ROLE,
    principalId: 'USER',
    priority: 10,
    overrides,
  } as ConfigOverrideLayer;
}

describe('getAppConfig with admin-written overrides', () => {
  it('hands runtime readers the decrypted MCP credentials an override stores', async () => {
    const stored = dataSchemas.encryptV3('sk-runtime-mcp-key');
    const secret = dataSchemas.encryptV3('runtime-client-secret');
    const { getAppConfig } = createService([
      roleLayer({
        mcpServers: {
          tools: {
            apiKey: {
              source: 'admin',
              authorization_type: 'bearer',
              key: stored,
              keyPreview: '...-key',
            },
            oauth: {
              client_id: 'client',
              client_secret: secret,
              authorization_url: 'https://auth.example.com/authorize',
              token_url: 'https://auth.example.com/token',
            },
          },
        },
      }),
    ]);

    const config = await getAppConfig({ role: 'USER' });
    const server = config.mcpConfig?.tools as {
      url: string;
      apiKey: Record<string, string>;
      oauth: Record<string, string>;
    };

    expect(server.url).toBe('https://tools.example.com/mcp');
    expect(server.apiKey.key).toBe('sk-runtime-mcp-key');
    expect(server.oauth.client_secret).toBe('runtime-client-secret');
    expect(JSON.stringify(config)).not.toContain(stored);

    const yamlOnly = await getAppConfig({ baseOnly: true });
    expect(yamlOnly.mcpConfig?.tools).toEqual(yaml.mcpServers.tools);
  });

  it('keeps ciphertext in the shared override cache and decrypts it on every read', async () => {
    const stored = dataSchemas.encryptV3('sk-cached-mcp-key');
    const { getAppConfig, store } = createService([
      roleLayer({
        mcpServers: {
          tools: { apiKey: { source: 'admin', authorization_type: 'bearer', key: stored } },
        },
      }),
    ]);

    const first = await getAppConfig({ role: 'USER' });
    expect((first.mcpConfig?.tools as { apiKey: { key: string } }).apiKey.key).toBe(
      'sk-cached-mcp-key',
    );

    const cachedKeys = [...store.keys()].filter((key) => key.startsWith('_OVERRIDE_'));
    expect(cachedKeys).toHaveLength(1);
    const cached = JSON.stringify(store.get(cachedKeys[0]));
    expect(cached).toContain(stored);
    expect(cached).not.toContain('sk-cached-mcp-key');

    /** A Redis-backed cache hands back a fresh copy on every read. */
    store.set(cachedKeys[0], JSON.parse(cached));
    const fromCache = await getAppConfig({ role: 'USER' });
    expect((fromCache.mcpConfig?.tools as { apiKey: { key: string } }).apiKey.key).toBe(
      'sk-cached-mcp-key',
    );
  });

  it('keeps `${...}` in text no reader expands', async () => {
    const welcome = 'Tip: template literals look like `${name}`';
    const { getAppConfig } = createService([roleLayer({ interface: { customWelcome: welcome } })]);

    const config = await getAppConfig({ role: 'USER' });
    expect(config.interfaceConfig?.customWelcome).toBe(welcome);
  });

  it('resolves a disallowed env reference in an override to nothing', async () => {
    const { getAppConfig } = createService([
      roleLayer({
        ocr: { apiKey: '${CREDS_KEY}', baseURL: 'https://api.mistral.ai/${UNLISTED}' },
        mcpServers: { tools: { headers: { Authorization: 'Bearer ${OCR_API_KEY}' } } },
      }),
    ]);

    const config = await getAppConfig({ role: 'USER' });

    expect(config.ocr?.apiKey).toBe('');
    expect(config.ocr?.baseURL).toBe('https://api.mistral.ai/');
    /** librechat.yaml references OCR_API_KEY, so an override may too. */
    expect((config.mcpConfig?.tools as { headers: Record<string, string> }).headers).toEqual({
      Authorization: 'Bearer ${OCR_API_KEY}',
    });
  });

  it('keeps a reference the operator allowlists', async () => {
    const { getAppConfig } = createService(
      [roleLayer({ ocr: { apiKey: '${GATEWAY_OCR_KEY}' } })],
      'GATEWAY_OCR_KEY,OTHER',
    );

    const config = await getAppConfig({ role: 'USER' });
    expect(config.ocr?.apiKey).toBe('${GATEWAY_OCR_KEY}');
  });

  it('drops an inherited credential an override points somewhere else', async () => {
    const warn = jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
    const { getAppConfig } = createService([
      roleLayer({ ocr: { baseURL: 'https://evil.example/v1' } }),
    ]);

    const config = await getAppConfig({ role: 'USER' });

    expect(config.ocr).toMatchObject({ apiKey: '', baseURL: 'https://evil.example/v1' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Dropping secret "ocr.apiKey" for role/USER'),
    );
  });

  it("serves a profile's own key bound to a destination Base defines, without the fingerprint", async () => {
    const { mergeOverrideLayers } = await import('./overrides');
    const { createEnvReferencePolicy } = await import('./allowlist');
    const baseLayer = {
      principalType: PrincipalType.ROLE,
      principalId: dataSchemas.BASE_CONFIG_PRINCIPAL_ID,
      priority: 0,
      overrides: {
        mcpServers: {
          shared: {
            type: 'streamable-http',
            url: 'https://shared.example.com/mcp',
            apiKey: {
              source: 'admin',
              authorization_type: 'bearer',
              key: dataSchemas.encryptV3('sk-base-key'),
            },
          },
        },
      },
    } as ConfigOverrideLayer;
    const ownKey = (keyBinding?: string) =>
      roleLayer({
        mcpServers: {
          shared: {
            apiKey: {
              source: 'admin',
              authorization_type: 'bearer',
              key: dataSchemas.encryptV3('sk-role-key'),
              ...(keyBinding != null && { keyBinding }),
            },
          },
        },
      });
    const bindings: Array<string | undefined> = [];
    mergeOverrideLayers({ config: yaml } as unknown as AppConfig, [baseLayer, ownKey()], {
      envPolicy: createEnvReferencePolicy({ config: yaml }),
      onRebinding: ({ layer, binding }) => {
        if (layer.principalId === 'USER') {
          bindings.push(binding);
        }
      },
    });
    expect(bindings).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);

    const unbound = await createService([baseLayer, ownKey()]).getAppConfig({ role: 'USER' });
    expect((unbound.mcpConfig?.shared as { apiKey: { key: string } }).apiKey.key).toBe('');

    const config = await createService([baseLayer, ownKey(bindings[0])]).getAppConfig({
      role: 'USER',
    });
    expect(config.mcpConfig?.shared).toMatchObject({
      url: 'https://shared.example.com/mcp',
      apiKey: { key: 'sk-role-key' },
    });
    expect(JSON.stringify(config)).not.toContain('keyBinding');
  });

  it('resolves ${...} under a prompt-named header to nothing, and keeps a real prompt as text', async () => {
    const { getAppConfig } = createService([
      roleLayer({
        mcpServers: {
          tools: { headers: { 'X-Prompt': '${HOME}', instructions: 'Bearer ${CREDS_KEY}' } },
        },
        summarization: { prompt: 'Summarize ${conversation}' },
      }),
    ]);

    const config = await getAppConfig({ role: 'USER' });

    expect((config.mcpConfig?.tools as { headers: Record<string, string> }).headers).toEqual({
      'X-Prompt': '',
      instructions: 'Bearer ',
    });
    expect(config.summarization?.prompt).toBe('Summarize ${conversation}');
  });

  it('never hands summarization a destination an override chose without its own key', async () => {
    const warn = jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
    const { getAppConfig } = createService([
      roleLayer({
        summarization: {
          provider: 'openAI',
          parameters: { baseURL: 'https://evil.example/v1', apiKey: '${CREDS_KEY}' },
        },
      }),
    ]);

    const config = await getAppConfig({ role: 'USER' });

    /** The disallowed reference resolves to nothing, so the provider's own key would be used. */
    expect(config.summarization?.parameters).toEqual({ apiKey: '' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring "summarization.parameters.baseURL" for role/USER'),
    );
  });

  it("does not allow a name only another tenant's librechat.yaml endpoint references", async () => {
    const tenantYaml = {
      ...yaml,
      endpoints: {
        custom: [
          {
            name: 'Tenant A Gateway',
            tenantId: 'tenant-a',
            apiKey: '${TENANT_A_KEY}',
            baseURL: 'https://a.example/v1',
            models: { default: ['a-model'] },
          },
        ],
      },
    };
    const { getAppConfig } = createService(
      [roleLayer({ ocr: { apiKey: '${TENANT_A_KEY}' } })],
      undefined,
      tenantYaml,
    );

    const owner = await getAppConfig({ role: 'USER', tenantId: 'tenant-a' });
    expect(owner.ocr?.apiKey).toBe('${TENANT_A_KEY}');

    const other = await getAppConfig({ role: 'USER', tenantId: 'tenant-b' });
    expect(other.ocr?.apiKey).toBe('');
  });
});

describe('mergeOverrideLayers and web search keys', () => {
  const SEARX = { searxngInstanceUrl: 'https://searx.corp.example', searxngApiKey: 'sx-yaml-key' };
  const webSearchBase = () =>
    ({ config: { webSearch: { ...SEARX } }, webSearch: { ...SEARX } }) as unknown as AppConfig;
  const layerAt = (principalId: string, priority: number, webSearch: Record<string, unknown>) =>
    ({
      principalType: PrincipalType.ROLE,
      principalId,
      priority,
      overrides: { webSearch },
    }) as ConfigOverrideLayer;

  async function mergeWebSearch(layers: ConfigOverrideLayer[]) {
    const [{ mergeOverrideLayers }, { createEnvReferencePolicy }] = await Promise.all([
      import('./overrides'),
      import('./allowlist'),
    ]);
    const rebindings: Array<{ principalId: string; kind: string; path: string }> = [];
    const merged = mergeOverrideLayers(webSearchBase(), layers, {
      envPolicy: createEnvReferencePolicy({ allowlist: ['SEARXNG_URL'] }),
      onRebinding: ({ layer, kind, path }) =>
        rebindings.push({ principalId: layer.principalId.toString(), kind, path }),
    });
    return { webSearch: merged.webSearch as Record<string, unknown> | undefined, rebindings };
  }

  it('reports the key the merge withholds from a URL a layer moves, naming that layer', async () => {
    const { webSearch, rebindings } = await mergeWebSearch([
      layerAt('USER', 10, { searxngInstanceUrl: 'https://evil.example' }),
    ]);

    expect(webSearch?.searxngApiKey).toBeUndefined();
    expect(rebindings).toEqual([
      { principalId: 'USER', kind: 'secret', path: 'webSearch.searxngApiKey' },
    ]);
  });

  it('keeps a key stored over a ${VAR} URL a lower layer set, as webSearchStoredKeys states', async () => {
    const stored = dataSchemas.encryptV3('sx-editors-key');
    const { webSearch, rebindings } = await mergeWebSearch([
      layerAt('__base__', 0, {
        searxngInstanceUrl: '${SEARXNG_URL}',
        searxngApiKey: dataSchemas.encryptV3('sx-base-key'),
      }),
      layerAt('editors', 10, { searxngApiKey: stored }),
    ]);

    expect(webSearch?.searxngInstanceUrl).toBe('${SEARXNG_URL}');
    expect(webSearch?.searxngApiKey).toBe(stored);
    expect(rebindings).toEqual([]);
  });

  it('sets back a ${VAR} URL a layer sets without entering the key the client would send it', async () => {
    const { webSearch, rebindings } = await mergeWebSearch([
      layerAt('__base__', 0, { searxngInstanceUrl: '${SEARXNG_URL}' }),
    ]);

    expect(webSearch?.searxngInstanceUrl).toBe(SEARX.searxngInstanceUrl);
    expect(rebindings).toContainEqual({
      principalId: '__base__',
      kind: 'destination',
      path: 'webSearch.searxngInstanceUrl',
    });
  });
});
