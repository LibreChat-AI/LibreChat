process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { PrincipalType } from 'librechat-data-provider';
import type {
  AppConfig,
  ConfigOverrideLayer,
  AdminConfigLayerIgnored,
} from '@librechat/data-schemas';
import type { DeepPartial, TCustomConfig } from 'librechat-data-provider';

type DataSchemas = typeof import('@librechat/data-schemas');
type Overrides = typeof import('./overrides');
type Service = typeof import('./service');
type Allowlist = typeof import('./allowlist');

/** Loaded after `CREDS_KEY` is set: the encryption key is read when data-schemas loads. */
let dataSchemas: DataSchemas;
let overrides: Overrides;
let createAppConfigService: Service['createAppConfigService'];
let createEnvReferencePolicy: Allowlist['createEnvReferencePolicy'];

const YAML: DeepPartial<TCustomConfig> = {
  version: '1.3.0',
  cache: true,
  interface: { customWelcome: 'Hello' },
  endpoints: {
    custom: [
      {
        name: 'Gateway',
        apiKey: 'yaml-gateway-key',
        baseURL: 'https://gateway.example.com/v1',
        models: { default: ['gpt-4o'] },
      },
      {
        name: 'Private',
        tenantId: 'other-tenant',
        apiKey: 'private-key',
        baseURL: 'https://private.example.com/v1',
        models: { default: ['p-1'] },
      },
    ],
  },
  mcpServers: {
    tools: {
      type: 'streamable-http',
      url: 'https://tools.example.com/mcp',
      apiKey: { source: 'admin', authorization_type: 'bearer', key: '${TOOLS_KEY}' },
    },
  },
};

let appConfig: AppConfig;

beforeAll(async () => {
  dataSchemas = await import('@librechat/data-schemas');
  overrides = await import('./overrides');
  ({ createAppConfigService } = await import('./service'));
  ({ createEnvReferencePolicy } = await import('./allowlist'));
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);
  appConfig = await dataSchemas.AppService({ config: structuredClone(YAML) });
});

afterAll(() => {
  jest.restoreAllMocks();
});

function layer(
  principalType: string,
  principalId: string,
  values: Record<string, unknown>,
  priority = 10,
): ConfigOverrideLayer {
  return {
    _id: `${principalType}-${principalId}`,
    principalType: principalType as PrincipalType,
    principalId,
    priority,
    overrides: values as Partial<TCustomConfig>,
  };
}

const role = (values: Record<string, unknown>) => layer(PrincipalType.ROLE, 'editors', values);
const base = (values: Record<string, unknown>) =>
  layer(PrincipalType.ROLE, dataSchemas.BASE_CONFIG_PRINCIPAL_ID, values, 0);

function reasons(ignored: readonly AdminConfigLayerIgnored[]): Array<[string, string]> {
  return ignored.map(({ path, reason }) => [path, reason]);
}

function policy() {
  return { envPolicy: createEnvReferencePolicy({ config: YAML }) };
}

describe('resolveOverrideLayers', () => {
  const cases: Array<[string, () => ConfigOverrideLayer[]]> = [
    ['no layers', () => []],
    [
      'a custom endpoint moved without its key',
      () => [
        role({
          endpoints: {
            custom: [{ name: 'Gateway', baseURL: 'https://collector.example.com/v1' }],
          },
        }),
      ],
    ],
    [
      'an MCP server moved without its key',
      () => [role({ mcpServers: { tools: { url: 'https://collector.example.com/mcp' } } })],
    ],
    [
      'a disallowed env reference',
      () => [
        role({
          endpoints: {
            custom: [{ name: 'Gateway', headers: { 'X-Key': '${UNLISTED_SECRET}' } }],
          },
        }),
      ],
    ],
    [
      'Base and a profile',
      () => [
        base({ interface: { customWelcome: 'Base' } }),
        role({ interface: { customWelcome: 'Role' } }),
      ],
    ],
  ];

  it.each(cases)('serves exactly what mergeOverrideLayers serves: %s', (_name, build) => {
    const configs = build();
    expect(overrides.resolveOverrideLayers(appConfig, configs, policy()).merged).toEqual(
      overrides.mergeOverrideLayers(appConfig, configs, policy()),
    );
  });

  it('drops a credential the layer sends elsewhere from the YAML-shaped result too', () => {
    const configs = cases[1][1]();
    const resolution = overrides.resolveOverrideLayers(appConfig, configs, policy());
    const gateway = resolution.resolved.endpoints?.custom?.[0];
    expect(gateway).toMatchObject({ baseURL: 'https://collector.example.com/v1', apiKey: '' });
    expect(reasons(resolution.layers[0].ignored)).toEqual([
      ['endpoints.custom["Gateway"].apiKey', 'secret_rebinding'],
    ]);
    expect(resolution.layers[0].layer).toBe(configs[0]);
  });

  it('drops an MCP credential moved to a new URL, under librechat.yaml keys', () => {
    const resolution = overrides.resolveOverrideLayers(appConfig, cases[2][1](), policy());
    expect(resolution.resolved.mcpServers?.tools).toMatchObject({
      url: 'https://collector.example.com/mcp',
      apiKey: { key: '' },
    });
    expect(reasons(resolution.layers[0].ignored)).toEqual([
      ['mcpServers.tools.apiKey.key', 'secret_rebinding'],
    ]);
  });

  it('leaves out the stored preview of a credential the merge drops', () => {
    const resolution = overrides.resolveOverrideLayers(
      appConfig,
      [
        base({
          endpoints: {
            custom: [{ name: 'Gateway', apiKey: 'base-gateway-2222', apiKeyPreview: '...2222' }],
          },
          mcpServers: { tools: { apiKey: { key: 'base-tools-3333', keyPreview: '...3333' } } },
          webSearch: { searxngApiKey: 'base-search-4444', searxngApiKeyPreview: '...4444' },
        }),
        role({
          endpoints: {
            custom: [{ name: 'Gateway', baseURL: 'https://collector.example.com/v1' }],
          },
          mcpServers: { tools: { url: 'https://collector.example.com/mcp' } },
          webSearch: { searxngInstanceUrl: 'https://collector.example.com/search' },
        }),
      ],
      policy(),
    );
    const gateway = resolution.resolved.endpoints?.custom?.[0];
    expect(gateway).toMatchObject({ baseURL: 'https://collector.example.com/v1', apiKey: '' });
    expect(gateway).not.toHaveProperty('apiKeyPreview');
    expect(resolution.resolved.mcpServers?.tools?.apiKey).toEqual(
      expect.objectContaining({ key: '' }),
    );
    expect(resolution.resolved.mcpServers?.tools?.apiKey).not.toHaveProperty('keyPreview');
    expect(resolution.resolved.webSearch).toEqual({
      searxngInstanceUrl: 'https://collector.example.com/search',
    });
    expect(reasons(resolution.layers[1].ignored)).toEqual(
      expect.arrayContaining([
        ['endpoints.custom["Gateway"].apiKey', 'secret_rebinding'],
        ['mcpServers.tools.apiKey.key', 'secret_rebinding'],
        ['webSearch.searxngApiKey', 'secret_rebinding'],
      ]),
    );
  });

  it('keeps the stored preview of a credential the merge applies', () => {
    const resolution = overrides.resolveOverrideLayers(
      appConfig,
      [
        base({
          endpoints: {
            custom: [{ name: 'Gateway', apiKey: 'base-gateway-2222', apiKeyPreview: '...2222' }],
          },
        }),
        role({ endpoints: { custom: [{ name: 'Gateway', models: { default: ['gpt-4.1'] } }] } }),
      ],
      policy(),
    );
    expect(resolution.resolved.endpoints?.custom?.[0]).toMatchObject({
      apiKey: 'base-gateway-2222',
      apiKeyPreview: '...2222',
    });
  });

  it('resolves a disallowed env reference to nothing and reports it on the document as written', () => {
    const configs = cases[3][1]();
    const resolution = overrides.resolveOverrideLayers(appConfig, configs, policy());
    expect(resolution.resolved.endpoints?.custom?.[0]?.headers).toEqual({ 'X-Key': '' });
    expect(resolution.layers[0].layer).toBe(configs[0]);
    expect(resolution.layers[0].ignored).toEqual([
      {
        path: 'endpoints.custom.0.headers.X-Key',
        segments: ['endpoints', 'custom', '0', 'headers', 'X-Key'],
        reason: 'env_reference_not_allowed',
      },
    ]);
  });

  it('leaves out the destination fingerprints stored beside secrets', () => {
    const resolution = overrides.resolveOverrideLayers(
      appConfig,
      [
        role({
          endpoints: {
            custom: [{ name: 'Gateway', apiKey: 'role-key', apiKeyBinding: 'fingerprint' }],
          },
        }),
      ],
      policy(),
    );
    expect(resolution.resolved.endpoints?.custom?.[0]).not.toHaveProperty('apiKeyBinding');
  });
});

function createService(configs: ConfigOverrideLayer[]) {
  const store = new Map<string, unknown>();
  const cache = {
    get: jest.fn(async (key: string) => store.get(key)),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: jest.fn(async (key: string) => store.delete(key)),
  };
  const getApplicableConfigs = jest.fn(async () => configs);
  const service = createAppConfigService({
    loadBaseConfig: async () => structuredClone(appConfig),
    setCachedTools: async () => undefined,
    getCache: () => cache,
    cacheKeys: { APP_CONFIG: 'app_config' },
    getApplicableConfigs,
    getUserPrincipals: async () => [{ principalType: PrincipalType.ROLE, principalId: 'editors' }],
  });
  return { ...service, cache, getApplicableConfigs };
}

const INVALID_THEME = {
  version: 1,
  name: 'broken',
  modes: { light: { colors: { 'surface-primary': '999 0 0' } } },
};

describe('createAppConfigService().resolveConfigLayers', () => {
  it('merges exactly as getAppConfig serves the same documents', async () => {
    const configs = [
      base({ interface: { customWelcome: 'Base' } }),
      role({
        endpoints: {
          custom: [
            { name: 'Gateway', baseURL: 'https://collector.example.com/v1' },
            {
              name: 'Private',
              apiKey: 'k',
              baseURL: 'https://shadow.example.com',
              models: { default: ['x'] },
            },
          ],
        },
      }),
    ];
    const service = createService(configs);
    const served = await service.getAppConfig({
      role: 'editors',
      tenantId: 'mine',
      bypassOverrideCache: true,
      skipRuntimeAugmentation: true,
    });
    const resolution = await service.resolveConfigLayers({ tenantId: 'mine', configs });
    expect(resolution.merged).toEqual(served);
  });

  it('never reads or fills the override cache', async () => {
    const service = createService([role({ interface: { customWelcome: 'Role' } })]);
    await service.resolveConfigLayers({ configs: [role({ interface: { customWelcome: 'Now' } })] });
    const overrideKeys = (calls: unknown[][]) =>
      calls.filter(([key]) => String(key).startsWith('_OVERRIDE_'));
    expect(overrideKeys(service.cache.get.mock.calls)).toEqual([]);
    expect(overrideKeys(service.cache.set.mock.calls)).toEqual([]);
    expect(service.getApplicableConfigs).not.toHaveBeenCalled();
  });

  it('returns librechat.yaml as the tenant sees it, without another tenant endpoint', async () => {
    const service = createService([]);
    const resolution = await service.resolveConfigLayers({ tenantId: 'mine', configs: [] });
    expect(resolution.yaml.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual([
      'Gateway',
    ]);
    expect(resolution.resolved).toBe(resolution.yaml);
    expect(resolution.layers).toEqual([]);
  });

  it('leaves out an endpoint scoped to another tenant, and the specs that use it', async () => {
    const configs = [
      role({
        endpoints: {
          custom: [
            {
              name: 'Private',
              apiKey: 'k',
              baseURL: 'https://shadow.example.com',
              models: { default: ['x'] },
            },
          ],
        },
        modelSpecs: {
          list: [
            { name: 'shadow', label: 'Shadow', preset: { endpoint: 'Private', model: 'x' } },
            { name: 'kept', label: 'Kept', preset: { endpoint: 'Gateway', model: 'gpt-4o' } },
          ],
        },
      }),
    ];
    const resolution = await createService(configs).resolveConfigLayers({
      tenantId: 'mine',
      configs,
    });
    expect(resolution.resolved.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual([
      'Gateway',
    ]);
    expect(resolution.resolved.modelSpecs?.list?.map((spec) => spec.name)).toEqual(['kept']);
    expect(resolution.merged.modelSpecs?.list?.map((spec) => spec.name)).toEqual(['kept']);
    expect(reasons(resolution.layers[0].ignored)).toEqual([
      ['endpoints.custom.0', 'tenant_hidden'],
      ['modelSpecs.list.0', 'tenant_hidden'],
    ]);
  });

  it('leaves out what selects an endpoint a profile hides by key, as getAppConfig does', async () => {
    const configs: ConfigOverrideLayer[] = [
      {
        ...role({
          modelSpecs: {
            list: [
              { name: 'hidden', label: 'Hidden', preset: { endpoint: 'Gateway', model: 'gpt-4o' } },
              { name: 'kept', label: 'Kept', preset: { endpoint: 'openAI', model: 'gpt-4o' } },
            ],
          },
          endpoints: { agents: { allowedProviders: ['Gateway', 'openAI'] } },
        }),
        tombstones: ['endpoints.custom["Gateway"]'],
      },
    ];
    const service = createService(configs);
    const served = await service.getAppConfig({
      role: 'editors',
      bypassOverrideCache: true,
      skipRuntimeAugmentation: true,
    });
    const resolution = await service.resolveConfigLayers({ configs });
    expect(resolution.merged).toEqual(served);
    expect(served.modelSpecs?.list?.map((spec) => spec.name)).toEqual(['kept']);
    expect(served.endpoints?.agents?.allowedProviders).toEqual(['openAI']);
    expect(resolution.resolved.endpoints?.custom ?? []).toEqual([]);
    expect(resolution.resolved.modelSpecs?.list?.map((spec) => spec.name)).toEqual(['kept']);
    expect(resolution.resolved.endpoints?.agents?.allowedProviders).toEqual(['openAI']);
  });

  it('shows the librechat.yaml theme where a profile theme fails the client rules', async () => {
    const configs = [role({ interface: { customWelcome: 'Role', theme: INVALID_THEME } })];
    const resolution = await createService(configs).resolveConfigLayers({ configs });
    expect(resolution.merged.interfaceConfig?.theme).toEqual(appConfig.interfaceConfig?.theme);
    expect(resolution.resolved.interface).toEqual({ customWelcome: 'Role' });
    expect(reasons(resolution.layers[0].ignored)).toEqual([['interface.theme', 'invalid_theme']]);
  });
});
