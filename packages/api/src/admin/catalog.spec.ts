process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { PrincipalType, EModelEndpoint } from 'librechat-data-provider';
import type {
  AppConfig,
  ConfigRecord,
  ConfigOverrideLayer,
  AdminConfigCatalogResponse,
  AdminConfigEnvStatusResponse,
} from '@librechat/data-schemas';
import type { DeepPartial, TCustomConfig, TPlugin } from 'librechat-data-provider';
import type { Response } from 'express';
import type { FetchModelsParams } from '~/endpoints/models';
import type { AdminConfigCatalogDeps, CatalogScopeRequest } from './catalog';
import type { ServerRequest } from '~/types/http';

type DataSchemas = typeof import('@librechat/data-schemas');

interface MockRes {
  statusCode: number;
  body: Record<string, unknown> | undefined;
  status: jest.Mock;
  json: jest.Mock;
}

const ROLE = PrincipalType.ROLE;
const GATEWAY_SECRET = 'gateway-secret-env-value';

const YAML: DeepPartial<TCustomConfig> = {
  version: '1.3.0',
  cache: true,
  endpoints: {
    custom: [
      {
        name: 'Gateway',
        apiKey: '${GATEWAY_KEY}',
        baseURL: 'https://gateway.example.com/v1',
        headers: { 'X-User': '{{LIBRECHAT_USER_EMAIL}}' },
        models: { default: ['gpt-4o'], fetch: true },
      },
      {
        name: 'BYOK',
        apiKey: 'user_provided',
        baseURL: 'https://byok.example.com/v1',
        models: { default: ['byok-default'], fetch: true },
      },
    ],
  },
  mcpServers: {
    docs: { type: 'streamable-http', url: 'https://docs.example.com/mcp', title: 'Docs' },
    legacy: { url: 'https://legacy.example.com/sse' },
    local: { command: 'node', args: ['server.js'] },
  },
  webSearch: { searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}' },
};

let dataSchemas: DataSchemas;
let createAdminConfigCatalogHandlers: typeof import('./catalog').createAdminConfigCatalogHandlers;
let BUILT_IN_ENDPOINT_ENV: typeof import('./catalog').BUILT_IN_ENDPOINT_ENV;
let ENDPOINT_CREDENTIAL_ENV_NAMES: readonly string[];
let appConfig: AppConfig;
let documents: ConfigOverrideLayer[];

const ENV_KEYS = [
  'ANTHROPIC_USE_VERTEX',
  'ENDPOINTS',
  'GATEWAY_KEY',
  'OPENAI_API_KEY',
  'OPENAI_MODELS',
  'TENANT_ISOLATION_STRICT',
  'PROFILE_ONLY_NAME',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function mockReq(overrides: Record<string, unknown> = {}): ServerRequest {
  return {
    user: { id: 'admin-1', role: 'ADMIN', _id: { toString: () => 'admin-1' } },
    params: {},
    body: {},
    query: {},
    headers: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

function mockRes(): Response & MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: MockRes['body']) => {
      res.body = data;
      return res;
    }),
  };
  return res as Partial<Response> as Response & MockRes;
}

function roleDocument(
  principalId: string,
  overrides: Record<string, unknown>,
  tombstones?: string[],
) {
  return {
    _id: `doc-${principalId}`,
    principalType: ROLE,
    principalId,
    priority: 10,
    overrides,
    tombstones,
    isActive: true,
  } as ConfigOverrideLayer;
}

/** Real config resolution, endpoint config and model loaders; only the provider HTTP is faked. */
async function createDeps(extra: Partial<AdminConfigCatalogDeps> = {}) {
  const { createAppConfigService } = await import('~/app/service');
  const { createEndpointsConfigService, createLoadConfigModels, configuredModelList } =
    await import('~/endpoints/config');
  const { getOpenAIModels } = await import('~/endpoints/models');
  const store = new Map<string, unknown>();
  const service = createAppConfigService({
    loadBaseConfig: async () => structuredClone(appConfig),
    setCachedTools: async () => undefined,
    getCache: () => ({
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: async (key: string) => store.delete(key),
    }),
    cacheKeys: { APP_CONFIG: 'app_config' },
    getApplicableConfigs: async (principals = []) =>
      documents.filter(
        (doc) =>
          dataSchemas.isBaseConfigPrincipal(doc) ||
          principals.some(
            ({ principalType, principalId }) =>
              principalType === doc.principalType && String(principalId) === doc.principalId,
          ),
      ),
    getUserPrincipals: async () => [],
  });
  const getAppConfig = jest.fn(service.getAppConfig);
  const { getEndpointsConfig } = createEndpointsConfigService({
    getAppConfig,
    loadDefaultEndpointsConfig: async () => ({
      [EModelEndpoint.openAI]: { userProvide: false, order: 0 },
      [EModelEndpoint.agents]: { userProvide: false, order: 1 },
    }),
  });
  const fetchModels = jest.fn(async ({ name }: FetchModelsParams) => [`${name}-fetched`]);
  const getUserKeyValues = jest.fn(async () => ({ apiKey: 'a-user-key' }));
  const loadConfigModels = createLoadConfigModels({ getAppConfig, getUserKeyValues, fetchModels });
  const loadDefaultModels = jest.fn(async (req: CatalogScopeRequest) => ({
    [EModelEndpoint.openAI]: await getOpenAIModels({
      configuredModels: configuredModelList(req.config, EModelEndpoint.openAI),
    }),
  }));
  const deps: AdminConfigCatalogDeps = {
    hasAnyConfigReadAccess: async () => true,
    getReadableConfigSections: async (_user, sections) => ({
      broad: true,
      sections: new Set(sections),
    }),
    hasConfigCapability: async () => true,
    getAppConfig,
    getEndpointsConfig: (req) => getEndpointsConfig(req as ServerRequest),
    loadDefaultModels,
    loadConfigModels: (req) => loadConfigModels(req as ServerRequest),
    getCachedTools: async () => ({ calculator: {}, image_gen_oai: {} }),
    toolManifest: [
      { name: 'Calculator', pluginKey: 'calculator', description: 'Math' },
      { name: 'Not loaded', pluginKey: 'not_loaded' },
      {
        name: 'Keyed',
        pluginKey: 'image_gen_oai',
        authConfig: [{ authField: 'GATEWAY_KEY', label: 'Key', description: 'Key' }],
      },
    ] as TPlugin[],
    toolkits: [],
    principalExists: async (_type, id) => id !== 'ghost',
    listAllConfigs: async () => documents as ConfigRecord[],
    overrideEnvAllowlist: 'ALLOWLISTED_NAME',
    ...extra,
  };
  return { deps, fetchModels, getUserKeyValues, getAppConfig, loadDefaultModels };
}

async function catalog(query: Record<string, string>, extra: Partial<AdminConfigCatalogDeps> = {}) {
  const created = await createDeps(extra);
  const handlers = createAdminConfigCatalogHandlers(created.deps);
  const res = mockRes();
  await handlers.getConfigCatalog(mockReq({ query }), res);
  return { ...created, handlers, res, body: res.body as AdminConfigCatalogResponse };
}

beforeAll(async () => {
  dataSchemas = await import('@librechat/data-schemas');
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  ({ createAdminConfigCatalogHandlers, BUILT_IN_ENDPOINT_ENV } = await import('./catalog'));
  ({ ENDPOINT_CREDENTIAL_ENV_NAMES } = await import('~/app/allowlist'));
  appConfig = await dataSchemas.AppService({ config: structuredClone(YAML) });
});

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.GATEWAY_KEY = GATEWAY_SECRET;
  process.env.OPENAI_MODELS = 'gpt-env-a,gpt-env-b';
  documents = [
    roleDocument(dataSchemas.BASE_CONFIG_PRINCIPAL_ID, {}),
    roleDocument(
      'editors',
      {
        endpoints: {
          openAI: { models: ['gpt-4.1'] },
          custom: [
            {
              name: 'Extra',
              apiKey: 'extra-key',
              baseURL: 'https://extra.example.com/v1',
              models: { default: ['extra-1'] },
            },
            { name: 'NoKey', baseURL: 'https://nokey.example.com', models: { default: ['n'] } },
          ],
        },
        mcpServers: { added: { type: 'sse', url: 'https://added.example.com/sse' } },
      },
      ['mcpServers.docs'],
    ),
  ];
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  jest.restoreAllMocks();
});

describe('GET /catalog', () => {
  it('lists what the Base scope serves by default, resolved from the stored documents', async () => {
    const { res, body, getAppConfig } = await catalog({});
    expect(res.statusCode).toBe(200);
    expect(body.principalType).toBe(ROLE);
    expect(body.principalId).toBe(dataSchemas.BASE_CONFIG_PRINCIPAL_ID);
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ bypassOverrideCache: true, skipRuntimeAugmentation: true }),
    );
    expect(body.endpoints?.Gateway).toMatchObject({
      enabled: true,
      custom: true,
      envVars: ['GATEWAY_KEY'],
    });
    expect(body.endpoints).not.toHaveProperty('Extra');
    expect(body.mcpServers?.map(({ name }) => name)).toEqual(['docs', 'legacy', 'local']);
  });

  it('resolves a role scope as that role gets it, its own endpoints and hidden servers included', async () => {
    const { body } = await catalog({ principalType: ROLE, principalId: 'editors' });
    expect(body.endpoints?.Extra).toMatchObject({ enabled: true, custom: true, envVars: [] });
    expect(body.endpoints?.NoKey).toEqual({
      enabled: false,
      custom: true,
      envVars: [],
      reason: 'missing_api_key',
    });
    expect(body.mcpServers).toEqual([
      { name: 'legacy', transport: 'sse', source: 'yaml', processBacked: false },
      { name: 'local', transport: 'stdio', source: 'yaml', processBacked: true },
      { name: 'added', transport: 'sse', source: 'override', processBacked: false },
    ]);
  });

  it('reports built-in endpoints that are not served, with why and the env names they read', async () => {
    const { body } = await catalog({});
    expect(body.endpoints?.[EModelEndpoint.openAI]).toMatchObject({ enabled: true });
    expect(body.endpoints?.[EModelEndpoint.anthropic]).toEqual({
      enabled: false,
      custom: false,
      envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_USE_VERTEX'],
      reason: 'missing_credentials',
    });
    process.env.ENDPOINTS = 'openAI,agents';
    const listed = await catalog({});
    expect(listed.body.endpoints?.[EModelEndpoint.google]?.reason).toBe('not_listed');
  });

  it('lists each endpoint models as served, configured and by default', async () => {
    const base = await catalog({});
    expect(base.body.models?.[EModelEndpoint.openAI]).toEqual({
      served: ['gpt-env-a', 'gpt-env-b'],
      defaults: ['gpt-env-a', 'gpt-env-b'],
    });
    expect(base.body.models?.Gateway).toEqual({
      served: ['Gateway-fetched'],
      configured: ['gpt-4o'],
      defaults: ['Gateway-fetched'],
    });

    const role = await catalog({ principalType: ROLE, principalId: 'editors' });
    expect(role.body.models?.[EModelEndpoint.openAI]).toEqual({
      served: ['gpt-4.1'],
      configured: ['gpt-4.1'],
      defaults: ['gpt-env-a', 'gpt-env-b'],
    });
    expect(role.body.models?.Extra).toEqual({ served: ['extra-1'], configured: ['extra-1'] });
  });

  it('never loads models with a user key or the caller identity', async () => {
    const { body, fetchModels, getUserKeyValues } = await catalog({});
    expect(body.models?.BYOK).toEqual({ served: ['byok-default'], configured: ['byok-default'] });
    expect(getUserKeyValues).not.toHaveBeenCalled();
    expect(fetchModels).toHaveBeenCalledTimes(1);
    const [params] = fetchModels.mock.calls[0];
    expect(params).toMatchObject({ name: 'Gateway', apiKey: GATEWAY_SECRET });
    expect(params.user).toBeUndefined();
    expect(JSON.stringify(params.userObject)).not.toContain('admin');
  });

  it('reuses a scope model lists until its endpoint config changes or they expire', async () => {
    const { handlers, fetchModels } = await catalog({});
    const read = () => handlers.getConfigCatalog(mockReq({ query: {} }), mockRes());
    await read();
    expect(fetchModels).toHaveBeenCalledTimes(1);

    documents[0] = roleDocument(dataSchemas.BASE_CONFIG_PRINCIPAL_ID, {
      endpoints: { custom: [{ name: 'Gateway', headers: { 'X-Team': 'b' } }] },
    });
    await read();
    expect(fetchModels).toHaveBeenCalledTimes(2);

    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 3 * 60_000);
    await read();
    clock.mockRestore();
    expect(fetchModels).toHaveBeenCalledTimes(3);
  });

  describe('with a model-list lifetime in librechat.yaml', () => {
    let original: AppConfig;

    async function withLifetime(catalogModelsTtlMs: number) {
      appConfig = await dataSchemas.AppService({
        config: {
          ...structuredClone(YAML),
          endpoints: { ...structuredClone(YAML.endpoints), catalogModelsTtlMs },
        },
      });
      const { handlers, fetchModels } = await catalog({});
      const read = (query: Record<string, string> = {}) =>
        handlers.getConfigCatalog(mockReq({ query }), mockRes());
      return { read, fetchModels };
    }

    beforeEach(() => {
      original = appConfig;
    });

    afterEach(() => {
      appConfig = original;
    });

    it('keeps a scope model lists for that lifetime, or loads them on every read at zero', async () => {
      const long = await withLifetime(10 * 60_000);
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 3 * 60_000);
      try {
        await long.read();
        expect(long.fetchModels).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(now + 11 * 60_000);
        await long.read();
        expect(long.fetchModels).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
      }

      const none = await withLifetime(0);
      await none.read();
      expect(none.fetchModels).toHaveBeenCalledTimes(2);
    });

    it('keeps the lifetime librechat.yaml sets whatever a profile says', async () => {
      documents[1] = roleDocument('editors', { endpoints: { catalogModelsTtlMs: 0 } });
      const kept = await withLifetime(10 * 60_000);
      const editors = { principalType: ROLE, principalId: 'editors' };
      await kept.read(editors);
      await kept.read(editors);
      expect(kept.fetchModels).toHaveBeenCalledTimes(2);
    });
  });

  it('reports each duplicated custom endpoint name from the definition the endpoint config serves', async () => {
    const original = appConfig;
    const endpoint = (name: string, key: string, models: string[], iconURL?: string) => ({
      name,
      apiKey: `\${${key}}`,
      baseURL: `https://${key.toLowerCase()}.example.com/v1`,
      models: { default: models },
      ...(iconURL && { iconURL }),
    });
    appConfig = await dataSchemas.AppService({
      config: {
        ...structuredClone(YAML),
        endpoints: {
          custom: [
            endpoint('Ollama', 'FIRST_OLLAMA_KEY', ['first-model'], 'first.png'),
            endpoint('ollama', 'LAST_OLLAMA_KEY', ['last-model'], 'last.png'),
            endpoint('Kept', 'SERVED_KEY', ['kept-model']),
            { name: 'Kept', apiKey: '${UNSERVED_KEY}' },
            { name: 'Unserved', apiKey: '${FIRST_UNSERVED_KEY}' },
            { name: 'Unserved', baseURL: 'https://unserved.example.com/v1' },
          ],
        },
      },
    });
    try {
      const { body } = await catalog({});
      expect(body.endpoints?.ollama).toMatchObject({
        enabled: true,
        envVars: ['LAST_OLLAMA_KEY'],
        config: { iconURL: 'last.png' },
      });
      expect(body.endpoints).not.toHaveProperty('Ollama');
      expect(body.models?.ollama).toEqual({ served: ['last-model'], configured: ['last-model'] });
      expect(body.endpoints?.Kept).toMatchObject({ enabled: true, envVars: ['SERVED_KEY'] });
      expect(body.models?.Kept).toEqual({ served: ['kept-model'], configured: ['kept-model'] });
      expect(body.endpoints?.Unserved).toEqual({
        enabled: false,
        custom: true,
        envVars: [],
        reason: 'missing_api_key',
      });
    } finally {
      appConfig = original;
    }
  });

  it('lists the tools the server loaded, marking those it holds the credentials of', async () => {
    const { body } = await catalog({});
    expect(body.tools).toEqual([
      { pluginKey: 'calculator', name: 'Calculator', description: 'Math' },
      { pluginKey: 'image_gen_oai', name: 'Keyed', authenticated: true },
    ]);
  });

  it('leaves out each part the caller cannot read', async () => {
    const { body } = await catalog(
      {},
      {
        getReadableConfigSections: async () => ({
          broad: false,
          sections: new Set(['mcpServers']),
        }),
      },
    );
    expect(Object.keys(body)).toEqual(['principalType', 'principalId', 'mcpServers']);
    expect(JSON.stringify(body)).not.toContain(GATEWAY_SECRET);
  });

  it('answers 403 without config read access, 400 for a half-named principal, 404 for a missing one', async () => {
    const forbidden = await catalog({}, { hasAnyConfigReadAccess: async () => false });
    expect(forbidden.res.statusCode).toBe(403);
    expect(forbidden.res.body?.code).toBe('FORBIDDEN');
    expect((await catalog({ principalType: ROLE })).res.statusCode).toBe(400);
    expect((await catalog({ principalType: 'tenant', principalId: 'x' })).res.statusCode).toBe(400);
    const missing = await catalog({ principalType: ROLE, principalId: 'ghost' });
    expect(missing.res.statusCode).toBe(404);
  });

  it('names every endpoint credential overrides may reference under a built-in endpoint', () => {
    const listed = new Set(Object.values(BUILT_IN_ENDPOINT_ENV).flat());
    expect(ENDPOINT_CREDENTIAL_ENV_NAMES.filter((name) => !listed.has(name))).toEqual([]);
  });
});

describe('GET /env-status', () => {
  async function envStatus(extra: Partial<AdminConfigCatalogDeps> = {}) {
    const { deps } = await createDeps(extra);
    const res = mockRes();
    await createAdminConfigCatalogHandlers(deps).getEnvStatus(mockReq(), res);
    return { res, body: res.body as AdminConfigEnvStatusResponse };
  }

  beforeEach(() => {
    documents.push(
      roleDocument('profile', {
        endpoints: {
          custom: [{ name: 'Gateway', headers: { 'X-Profile': '${PROFILE_ONLY_NAME}' } }],
        },
      }),
    );
    process.env.PROFILE_ONLY_NAME = 'profile-value';
    process.env.OPENAI_API_KEY = 'user_provided';
  });

  it('reports whether each referenced name is set, never its value', async () => {
    const { res, body } = await envStatus();
    expect(res.statusCode).toBe(200);
    expect(body.vars.GATEWAY_KEY).toEqual({ set: true, sources: ['yaml'] });
    expect(body.vars.SEARXNG_INSTANCE_URL).toEqual({ set: false, sources: ['yaml'] });
    expect(body.vars.SERPER_API_KEY).toEqual({ set: false, sources: ['default'] });
    expect(body.vars.OPENAI_API_KEY).toEqual({
      set: true,
      userProvided: true,
      sources: ['endpoint'],
    });
    expect(body.vars.ANTHROPIC_USE_VERTEX).toEqual({ set: false, sources: ['endpoint'] });
    expect(body.vars.ALLOWLISTED_NAME).toEqual({ set: false, sources: ['allowlist'] });
    expect(body.vars.PROFILE_ONLY_NAME).toEqual({ set: true, sources: ['override'] });
    expect(body.vars).not.toHaveProperty('OPENAI_MODELS');
    const text = JSON.stringify(body);
    expect(text).not.toContain(GATEWAY_SECRET);
    expect(text).not.toContain('profile-value');
  });

  it('adds the names profiles reference only for broad managers, outside strict isolation', async () => {
    const reader = await envStatus({
      hasConfigCapability: async (_user, section) => section != null,
    });
    expect(reader.body.vars).not.toHaveProperty('PROFILE_ONLY_NAME');
    process.env.TENANT_ISOLATION_STRICT = 'true';
    const strict = await envStatus();
    expect(strict.body.vars).not.toHaveProperty('PROFILE_ONLY_NAME');
  });

  it('shows a section-scoped reader only the names of the sections it can read', async () => {
    const { body } = await envStatus({
      getReadableConfigSections: async () => ({ broad: false, sections: new Set(['webSearch']) }),
    });
    expect(body.vars.SEARXNG_INSTANCE_URL).toBeDefined();
    expect(body.vars).not.toHaveProperty('GATEWAY_KEY');
    expect(body.vars).not.toHaveProperty('OPENAI_API_KEY');
    expect(body.vars).not.toHaveProperty('ALLOWLISTED_NAME');
  });

  it('never lists an infrastructure secret, whatever references it', async () => {
    const original = appConfig;
    appConfig = await dataSchemas.AppService({
      config: { ...structuredClone(YAML), ocr: { apiKey: '${CREDS_KEY}' } },
    });
    try {
      const { body } = await envStatus();
      expect(body.vars).not.toHaveProperty('CREDS_KEY');
    } finally {
      appConfig = original;
    }
  });

  it('answers 403 without config read access', async () => {
    const { res } = await envStatus({ hasAnyConfigReadAccess: async () => false });
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('FORBIDDEN');
  });
});
