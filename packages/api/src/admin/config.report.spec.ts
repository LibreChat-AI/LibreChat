import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AdminConfigReadResponse } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

type DataSchemas = typeof import('@librechat/data-schemas');
type Methods = ReturnType<DataSchemas['createMethods']>;
type AdminConfigHandlers = ReturnType<typeof import('./config').createAdminConfigHandlers>;
type AdminConfigDeps = Parameters<typeof import('./config').createAdminConfigHandlers>[0];
type Handler = (req: ServerRequest, res: Response) => Promise<Response>;
type Location = { path: string; segments: string[]; reason?: string; kind?: string };

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

let mongoServer: MongoMemoryServer;
let methods: Methods;
let createAdminConfigHandlers: typeof import('./config').createAdminConfigHandlers;

/** librechat.yaml: a stdio server, a remote one, and fields only librechat.yaml sets. */
const YAML = {
  mcpServers: {
    local: { type: 'stdio', command: 'node', args: ['server.js'] },
    remote: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
  },
  endpoints: {
    agents: {
      pullRequests: { provider: 'github' },
      eventDriven: { deadLetterRetentionDays: 7 },
    },
  },
  memory: { agent: { id: 'agent_1' } },
};

function mockReq(overrides: Record<string, unknown> = {}): ServerRequest {
  return {
    user: { id: 'u1', role: 'ADMIN', _id: { toString: () => 'u1' } },
    params: {},
    body: {},
    query: {},
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

function createHandlers(overrides: Partial<AdminConfigDeps> = {}): AdminConfigHandlers {
  return createAdminConfigHandlers({
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    getAppConfig: async () => ({ config: structuredClone(YAML) }) as never,
    ...overrides,
  });
}

let counter = 0;
function nextParams(): { principalType: string; principalId: string } {
  counter += 1;
  return { principalType: 'role', principalId: `report-${counter}` };
}

async function call(handler: Handler, request: Record<string, unknown>): Promise<MockRes> {
  const res = mockRes();
  await handler(mockReq(request), res);
  return res;
}

/** Stores a document as an older server or another writer left it, with no write-time checks. */
async function seed(
  params: { principalType: string; principalId: string },
  overrides: Record<string, unknown>,
  tombstones: string[] = [],
): Promise<void> {
  await methods.writeConfigDocument(
    params.principalType as never,
    params.principalId,
    { principalModel: 'Role' as never, priority: 10, overrides, tombstones, isActive: true },
    'absent',
  );
}

async function stored(params: { principalType: string; principalId: string }) {
  return methods.findConfigByPrincipal(params.principalType as never, params.principalId, {
    includeInactive: true,
  });
}

/** `kind:path:reason`, sorted, for comparing report lists whatever their order. */
function describeAll(list: unknown): string[] {
  return ((list as Location[] | undefined) ?? [])
    .map(({ path, reason, kind }) => [kind, path, reason].filter(Boolean).join(':'))
    .sort();
}

const LIFECYCLE_TIMEOUT_MS = 180_000;

beforeAll(async () => {
  const [dataSchemas, handlersModule, server] = await Promise.all([
    import('@librechat/data-schemas'),
    import('./config'),
    MongoMemoryServer.create(),
  ]);
  mongoServer = server;
  ({ createAdminConfigHandlers } = handlersModule);
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);

  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  await mongoose.models.Config.init();
  methods = dataSchemas.createMethods(mongoose);
}, LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, LIFECYCLE_TIMEOUT_MS);

describe('write report', () => {
  it('PATCH stores what it can and reports each part it skipped, at its own location', async () => {
    const params = nextParams();
    const res = await call(createHandlers().patchConfigField, {
      params,
      body: {
        entries: [
          { fieldPath: 'interface', value: { prompts: false, modelSelect: true } },
          {
            fieldPath: 'endpoints.agents',
            value: { pullRequests: { provider: 'gitlab' }, recursionLimit: 20 },
          },
          { fieldPath: 'rateLimits.fileUploads.ipMax', value: 1 },
          { fieldPath: 'filters.x', value: 1 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body?.applied).toEqual([
      { path: 'interface', segments: ['interface'] },
      { path: 'endpoints.agents', segments: ['endpoints', 'agents'] },
    ]);
    expect(describeAll(res.body?.skipped)).toEqual([
      'endpoints.agents.pullRequests.provider:base_only_path',
      'filters.x:base_only_section',
      'interface.prompts:interface_permission',
      'rateLimits.fileUploads.ipMax:deployment_only_path',
    ]);
    expect((await stored(params))?.overrides).toEqual({
      interface: { modelSelect: true },
      endpoints: { agents: { recursionLimit: 20 } },
    });
  });

  it('PATCH resets a path whose whole value is skipped, as a written value replaces it', async () => {
    const params = nextParams();
    await seed(params, { interface: { customWelcome: 'stored' }, memory: { disabled: true } });

    const res = await call(createHandlers().patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'interface', value: { prompts: false } }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body?.applied).toEqual([{ path: 'interface', segments: ['interface'] }]);
    expect(describeAll(res.body?.skipped)).toEqual(['interface.prompts:interface_permission']);
    expect((await stored(params))?.overrides).toEqual({ memory: { disabled: true } });
  });

  it('PATCH applies a reset where the request puts it, as a written value would land', async () => {
    const later = nextParams();
    const handlers = createHandlers();
    const resetLast = await call(handlers.patchConfigField, {
      params: later,
      body: {
        entries: [
          { fieldPath: 'interface.modelSelect', value: true },
          { fieldPath: 'interface', value: { prompts: false } },
          { fieldPath: 'memory.disabled', value: true },
        ],
      },
    });
    expect(resetLast.statusCode).toBe(200);
    expect((await stored(later))?.overrides).toEqual({ memory: { disabled: true } });

    const earlier = nextParams();
    const resetFirst = await call(handlers.patchConfigField, {
      params: earlier,
      body: {
        entries: [
          { fieldPath: 'interface', value: { prompts: false } },
          { fieldPath: 'interface.modelSelect', value: true },
        ],
      },
    });
    expect(resetFirst.statusCode).toBe(200);
    expect((await stored(earlier))?.overrides).toEqual({ interface: { modelSelect: true } });
  });

  it('PATCH answers a section manager whose every entry is skipped as a write, not a 403', async () => {
    const params = nextParams();
    await seed(params, {
      endpoints: { agents: { recursionLimit: 5 } },
      memory: { disabled: true },
    });
    const sectionManager = createHandlers({
      hasConfigCapability: async (_user, section) => section === 'endpoints',
      hasCapability: async () => false,
    });

    const res = await call(sectionManager.patchConfigField, {
      params,
      body: {
        entries: [
          { fieldPath: 'endpoints.agents.eventDriven', value: { deadLetterRetentionDays: 3 } },
          { fieldPath: 'endpoints.agents.pullRequests.provider', value: 'gitlab' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      message: 'No actionable field entries provided',
      applied: [],
      config: { overrides: { endpoints: { agents: { recursionLimit: 5 } } } },
    });
    expect(res.body?.config).not.toHaveProperty('overrides.memory');
    expect(describeAll(res.body?.skipped)).toEqual([
      'endpoints.agents.eventDriven:deployment_only_path',
      'endpoints.agents.pullRequests.provider:base_only_path',
    ]);

    for (const entries of [
      [{ fieldPath: 'rateLimits.fileUploads.ipMax', value: 1 }],
      [
        { fieldPath: 'endpoints.agents.recursionLimit', value: 9 },
        { fieldPath: 'rateLimits.fileUploads.ipMax', value: 1 },
      ],
    ]) {
      const denied = await call(sectionManager.patchConfigField, { params, body: { entries } });
      expect([denied.statusCode, denied.body?.code, denied.body?.section]).toEqual([
        403,
        'FORBIDDEN_SECTION',
        'rateLimits',
      ]);
    }
    expect((await stored(params))?.overrides).toEqual({
      endpoints: { agents: { recursionLimit: 5 } },
      memory: { disabled: true },
    });
  });

  it('PUT leaves out every field only librechat.yaml sets, Base included', async () => {
    const base = { principalType: 'role', principalId: '__base__' };
    const res = await call(createHandlers().upsertConfigOverrides, {
      params: base,
      body: {
        overrides: {
          cloudfront: { domain: 'https://cdn.example.com' },
          permissions: { leaseTtlMs: 1000 },
          endpoints: {
            agents: {
              toolApproval: { hooks: [{ module: './hooks.js' }] },
              pullRequests: { host: 'ghe.example.com' },
              disableBuilder: true,
            },
          },
          registration: { openidDiscovery: { startupAttempts: 2 }, allowedDomains: ['a.com'] },
          interface: { modelSelect: false, agents: { use: false } },
        },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body?.applied).toEqual([
      { path: 'endpoints', segments: ['endpoints'] },
      { path: 'registration', segments: ['registration'] },
      { path: 'interface', segments: ['interface'] },
    ]);
    expect(describeAll(res.body?.skipped)).toEqual([
      'cloudfront:deployment_only_path',
      'endpoints.agents.pullRequests.host:base_only_path',
      'endpoints.agents.toolApproval.hooks:deployment_only_path',
      'interface.agents.use:interface_permission',
      'permissions:deployment_only_path',
      'registration.openidDiscovery:deployment_only_path',
    ]);
    expect((await stored(base))?.overrides).toEqual({
      endpoints: { agents: { disableBuilder: true } },
      registration: { allowedDomains: ['a.com'] },
      interface: { modelSelect: false },
    });
    await methods.deleteConfig('role' as never, '__base__');
  });

  it('a tombstone of a field only librechat.yaml sets is skipped; deleting a stored one is cleanup', async () => {
    const params = nextParams();
    await seed(params, { rateLimits: { fileUploads: { ipMax: 1 } }, memory: { disabled: true } });
    const handlers = createHandlers();

    for (const fieldPath of ['rateLimits', 'endpoints.agents.pullRequests.provider', 'openapi']) {
      const res = await call(handlers.tombstoneConfigField, { params, body: { fieldPath } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        message: 'No actionable field path provided',
        applied: [],
        config: expect.objectContaining({ overrides: expect.any(Object) }),
      });
      expect(describeAll(res.body?.skipped)).toEqual([
        `${fieldPath}:${fieldPath === 'endpoints.agents.pullRequests.provider' ? 'base_only_path' : 'deployment_only_path'}`,
      ]);
    }
    expect((await stored(params))?.tombstones).toEqual([]);

    const cleanup = await call(handlers.deleteConfigField, {
      params,
      query: { fieldPath: 'rateLimits' },
    });
    expect(cleanup.statusCode).toBe(200);
    expect(cleanup.body?.applied).toEqual([{ path: 'rateLimits', segments: ['rateLimits'] }]);
    expect(cleanup.body?.skipped).toEqual([]);
    expect((await stored(params))?.overrides).toEqual({ memory: { disabled: true } });
  });

  it('refuses a tombstone at an array element, which would hide nothing', async () => {
    const params = nextParams();
    const res = await call(createHandlers().tombstoneConfigField, {
      params,
      body: { fieldPath: 'endpoints.custom.0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONFIG_PATH_INVALID', reason: 'inside_array' });
    expect(await stored(params)).toBeNull();
  });

  it('reports a tombstone as applied', async () => {
    const params = nextParams();
    const handlers = createHandlers();
    const tombstone = await call(handlers.tombstoneConfigField, {
      params,
      body: { fieldPath: 'memory.agent' },
    });
    expect(tombstone.statusCode).toBe(200);
    expect(tombstone.body?.applied).toEqual([
      { path: 'memory.agent', segments: ['memory', 'agent'] },
    ]);
    expect(tombstone.body?.skipped).toEqual([]);
  });

  it.each([
    [0, 'too_small', { minimum: 1, inclusive: true, exact: false, type: 'number' }],
    [2.5, 'invalid_type', { expected: 'integer', received: 'float' }],
  ])('refuses a recursionLimit of %s with its bound', async (value, code, params) => {
    const res = await call(createHandlers().patchConfigField, {
      params: nextParams(),
      body: { entries: [{ fieldPath: 'endpoints.agents.recursionLimit', value }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body?.issues).toEqual([
      {
        path: 'endpoints.agents.recursionLimit',
        segments: ['endpoints', 'agents', 'recursionLimit'],
        code,
        params,
      },
    ]);
  });
});

describe('MCP servers librechat.yaml runs as local processes', () => {
  it('refuses a field write or tombstone inside one, and keeps the process-field refusal', async () => {
    const params = nextParams();
    const handlers = createHandlers();

    const title = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'mcpServers.local.title', value: 'Local' }] },
    });
    expect(title.statusCode).toBe(400);
    expect(title.body).toEqual({
      error:
        'An MCP server librechat.yaml runs as a local process can only be configured in librechat.yaml',
      code: 'PROCESS_MCP_SERVER_OVERRIDE',
    });

    const args = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'mcpServers.local.args', value: ['x'] }] },
    });
    expect(args.statusCode).toBe(400);
    expect(args.body?.code).toBe('PROCESS_MCP_CONFIG');

    for (const fieldPath of ['mcpServers.local', 'mcpServers.local.timeout']) {
      const tombstone = await call(handlers.tombstoneConfigField, { params, body: { fieldPath } });
      expect(tombstone.statusCode).toBe(400);
      expect(tombstone.body?.code).toBe('PROCESS_MCP_SERVER_OVERRIDE');
    }
    expect(await stored(params)).toBeNull();

    const remote = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'mcpServers.remote.title', value: 'Remote' }] },
    });
    expect(remote.statusCode).toBe(200);
  });

  it('a whole-document or whole-section write leaves one out, so a stored no-op round-trips', async () => {
    const params = nextParams();
    await seed(params, {
      mcpServers: { local: { title: 'Local' }, remote: { title: 'Remote' } },
    });
    const handlers = createHandlers();

    const read = await call(handlers.getConfig, { params });
    expect(describeAll(read.body?.ignored)).toEqual([
      'override:mcpServers.local:process_mcp_server',
    ]);

    const put = await call(handlers.upsertConfigOverrides, {
      params,
      body: { overrides: (read.body?.config as { overrides: object }).overrides },
    });
    expect(put.statusCode).toBe(200);
    expect(describeAll(put.body?.skipped)).toEqual(['mcpServers.local:process_mcp_server']);
    expect((await stored(params))?.overrides).toEqual({
      mcpServers: { remote: { title: 'Remote' } },
    });

    const section = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'mcpServers', value: { local: { title: 'L' } } }] },
    });
    expect(section.statusCode).toBe(200);
    expect(describeAll(section.body?.skipped)).toEqual(['mcpServers.local:process_mcp_server']);
    expect((await stored(params))?.overrides).toEqual({});
  });

  it('still lets a field delete clean up what an older server stored there', async () => {
    const params = nextParams();
    await seed(params, { mcpServers: { local: { title: 'Local' } } });

    const res = await call(createHandlers().deleteConfigField, {
      params,
      query: { fieldPath: 'mcpServers.local.title' },
    });

    expect(res.statusCode).toBe(200);
    expect((await stored(params))?.overrides).toEqual({});
  });
});

describe('GET reports what the merge leaves out of a stored document', () => {
  it('lists each stored part by location, reason and kind, judged over the Base floor', async () => {
    const params = nextParams();
    await seed(
      params,
      {
        paths: { uploads: '/tmp' },
        rateLimits: { fileUploads: { ipMax: 1 } },
        interface: { prompts: false, modelSelect: true },
        githubCompare: { timeoutMs: 40_000 },
        endpoints: { agents: { pullRequests: { provider: 'gitlab' } } },
      },
      ['filters', 'endpoints.agents'],
    );

    const res = await call(createHandlers().getConfig, { params });

    expect(res.statusCode).toBe(200);
    expect(res.body?.ignoredBasis).toBe('base');
    expect(describeAll(res.body?.ignored)).toEqual([
      'override:endpoints.agents.pullRequests.provider:base_only_path',
      'override:githubCompare.timeoutMs:invalid',
      'override:interface.prompts:interface_permission',
      'override:paths:unknown_section',
      'override:rateLimits:deployment_only_path',
      'tombstone:endpoints.agents.eventDriven:deployment_only_path',
      'tombstone:endpoints.agents.pullRequests.provider:base_only_path',
      'tombstone:filters:base_only_section',
    ]);
  });

  it('judges a profile on the active Base, and Base on librechat.yaml alone', async () => {
    const base = { principalType: 'role', principalId: '__base__' };
    await seed(base, { memory: { agent: { provider: 'openAI', model: 'gpt-4o' } } }, [
      'memory.agent.id',
    ]);
    const params = nextParams();
    await seed(params, { memory: { agent: { model: 'gpt-4.1' } } });
    const handlers = createHandlers();

    const profile = await call(handlers.getConfig, { params });
    expect(profile.body?.ignored).toEqual([]);

    const baseRead = await call(handlers.getConfig, { params: base });
    expect(baseRead.body?.ignoredBasis).toBe('yaml');
    expect(baseRead.body?.ignored).toEqual([]);

    await methods.deleteConfig('role' as never, '__base__');
    const withoutBase = await call(handlers.getConfig, { params });
    expect(describeAll(withoutBase.body?.ignored)).toEqual(['override:memory.agent.model:invalid']);
  });

  it('shows a section-scoped reader only the sections it can read', async () => {
    const params = nextParams();
    await seed(params, { rateLimits: { fileUploads: { ipMax: 1 } }, filters: { x: 1 } });

    const res = await call(
      createHandlers({
        getReadableConfigSections: async () => ({ broad: false, sections: new Set(['filters']) }),
      }).getConfig,
      { params },
    );

    expect(describeAll(res.body?.ignored)).toEqual(['override:filters:base_only_section']);
  });

  it('still answers with the document when the Base document cannot be read', async () => {
    const params = nextParams();
    await seed(params, { rateLimits: { fileUploads: { ipMax: 1 } } });

    const res = await call(
      createHandlers({
        findConfigByPrincipal: async (principalType, principalId, options) => {
          if (principalId === '__base__') {
            throw new Error('base unavailable');
          }
          return methods.findConfigByPrincipal(principalType, principalId, options);
        },
      }).getConfig,
      { params },
    );

    expect(res.statusCode).toBe(200);
    expect((res.body?.config as { overrides: object }).overrides).toEqual({
      rateLimits: { fileUploads: { ipMax: 1 } },
    });
    expect(res.body).not.toHaveProperty('ignored');
  });

  it('leaves the report out, rather than claiming nothing is ignored, when it cannot judge', async () => {
    const params = nextParams();
    await seed(params, { rateLimits: { fileUploads: { ipMax: 1 } } });

    const res = await call(
      createHandlers({
        getAppConfig: async () => {
          throw new Error('yaml unavailable');
        },
      }).getConfig,
      { params },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('ignored');
    const noBase = await call(createHandlers({ getAppConfig: undefined }).getConfig, { params });
    expect(noBase.statusCode).toBe(200);
    expect(noBase.body).not.toHaveProperty('ignored');
    expect(noBase.body).not.toHaveProperty('ignoredBasis');
    /** The read contract types this answer: a document whose report is left out. */
    const unjudged: AdminConfigReadResponse = {
      config: noBase.body?.config as AdminConfigReadResponse['config'],
    };
    expect(noBase.body).toEqual(unjudged);
  });
});

describe('Azure groups a deployment without CONFIG_REDERIVE_ENDPOINTS stores but never serves', () => {
  const azureGroup = (name: string, model: string) => ({
    group: name,
    apiKey: `${name}-key`,
    instanceName: name,
    version: '2024-10-21',
    deploymentName: model,
    models: { [model]: true },
  });
  const AZURE_YAML = {
    endpoints: {
      azureOpenAI: { groups: [azureGroup('east', 'gpt-4o'), azureGroup('north', 'o3')] },
    },
  };
  const GROUPS = ['endpoints', 'azureOpenAI', 'groups'];
  const handlersFor = (rederiveEndpoints: boolean) =>
    createHandlers({
      getAppConfig: async () => ({ config: structuredClone(AZURE_YAML) }) as never,
      rederiveEndpoints,
    });
  const ops = [
    {
      op: 'upsertEntry',
      fieldPath: 'endpoints.azureOpenAI.groups',
      entry: azureGroup('west', 'gpt-5'),
    },
    { op: 'tombstone', fieldPath: 'endpoints.azureOpenAI.groups["east"]' },
    { op: 'tombstone', fieldPath: 'endpoints.azureOpenAI.groups["north"].models.o3' },
    { op: 'set', fieldPath: 'endpoints.azureOpenAI.titleModel', value: 'gpt-4o' },
  ];

  it('reports each group write and tombstone of them as inert, on the batch and on a read', async () => {
    const params = nextParams();
    const handlers = handlersFor(false);

    const write = await call(handlers.applyConfigChanges, { params, body: { ops } });

    expect(write.statusCode).toBe(200);
    expect(
      (write.body?.ignored as Array<{ opIndex: number; segments: string[]; reason: string }>).map(
        ({ opIndex, segments, reason }) => [opIndex, segments, reason],
      ),
    ).toEqual([
      [0, GROUPS, 'endpoint_rederive_off'],
      [1, GROUPS, 'endpoint_rederive_off'],
      [2, GROUPS, 'endpoint_rederive_off'],
    ]);
    const read = await call(handlers.getConfig, { params });
    expect(describeAll(read.body?.ignored)).toEqual([
      'override:endpoints.azureOpenAI.groups:endpoint_rederive_off',
      'tombstone:endpoints.azureOpenAI.groups["east"]:endpoint_rederive_off',
      'tombstone:endpoints.azureOpenAI.groups["north"].models.o3:endpoint_rederive_off',
    ]);

    const whole = nextParams();
    const replaced = await call(handlers.applyConfigChanges, {
      params: whole,
      body: {
        ops: [
          { op: 'tombstone', fieldPath: 'endpoints.azureOpenAI.groups' },
          {
            op: 'set',
            fieldPath: 'endpoints.azureOpenAI',
            value: { groups: [azureGroup('west', 'gpt-5')] },
          },
        ],
      },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body?.ignored).toEqual([
      { opIndex: 0, op: 'tombstone', segments: GROUPS, reason: 'endpoint_rederive_off' },
      { opIndex: 1, op: 'set', segments: GROUPS, reason: 'endpoint_rederive_off' },
    ]);
  });

  it('reports none of them where the deployment resolves the groups', async () => {
    const params = nextParams();
    const handlers = handlersFor(true);

    const write = await call(handlers.applyConfigChanges, { params, body: { ops } });

    expect(write.statusCode).toBe(200);
    expect(write.body?.ignored).toEqual([]);
    expect((await call(handlers.getConfig, { params })).body?.ignored).toEqual([]);
  });

  it('reports a tombstone that leaves its group unable to resolve where the groups are resolved', async () => {
    const params = nextParams();
    const handlers = handlersFor(true);
    const tombstone = 'endpoints.azureOpenAI.groups["north"].instanceName';

    const write = await call(handlers.applyConfigChanges, {
      params,
      body: { ops: [{ op: 'tombstone', fieldPath: tombstone }] },
    });

    expect(write.statusCode).toBe(200);
    expect((await call(handlers.getConfig, { params })).body?.ignored).toEqual([
      {
        path: tombstone,
        segments: [...GROUPS, 'north', 'instanceName'],
        reason: 'azure_groups_unresolved',
        kind: 'tombstone',
      },
    ]);
  });
});

describe('every 4xx a config handler answers carries a stable code', () => {
  const params = { principalType: 'role', principalId: 'codes' };
  const cases: Array<[string, keyof AdminConfigHandlers, Record<string, unknown>, string]> = [
    [
      'bad principal type',
      'getConfig',
      { params: { ...params, principalType: 'x' } },
      'INVALID_PRINCIPAL_TYPE',
    ],
    ['missing document', 'getConfig', { params }, 'CONFIG_NOT_FOUND'],
    [
      'overrides not an object',
      'upsertConfigOverrides',
      { params, body: { overrides: [] } },
      'INVALID_OVERRIDES',
    ],
    [
      'bad priority',
      'upsertConfigOverrides',
      { params, body: { overrides: {}, priority: -1 } },
      'INVALID_PRIORITY',
    ],
    [
      'bad revision',
      'upsertConfigOverrides',
      { params, body: { overrides: {}, expectedRevision: 'x' } },
      'INVALID_EXPECTED_REVISION',
    ],
    [
      'process server config',
      'upsertConfigOverrides',
      { params, body: { overrides: { mcpServers: { s: { command: 'x' } } } } },
      'PROCESS_MCP_CONFIG',
    ],
    ['no entries', 'patchConfigField', { params, body: { entries: [] } }, 'ENTRIES_REQUIRED'],
    [
      'too many entries',
      'patchConfigField',
      {
        params,
        body: {
          entries: Array.from({ length: 101 }, (_, i) => ({
            fieldPath: `interface.x${i}`,
            value: 1,
          })),
        },
      },
      'PATCH_TOO_LARGE',
    ],
    [
      'unsafe path',
      'patchConfigField',
      { params, body: { entries: [{ fieldPath: 'a..b', value: 1 }] } },
      'INVALID_FIELD_PATH',
    ],
    [
      'unknown section',
      'patchConfigField',
      { params, body: { entries: [{ fieldPath: 'paths.uploads', value: 1 }] } },
      'UNKNOWN_SECTION',
    ],
    [
      'duplicate path',
      'patchConfigField',
      {
        params,
        body: {
          entries: [
            { fieldPath: 'interface.a', value: 1 },
            { fieldPath: 'interface.a', value: 2 },
          ],
        },
      },
      'DUPLICATE_FIELD_PATH',
    ],
    [
      'langfuse headers',
      'patchConfigField',
      { params, body: { entries: [{ fieldPath: 'langfuse.headers', value: {} }] } },
      'LANGFUSE_HEADERS_CONFIG',
    ],
    [
      'secret preview',
      'patchConfigField',
      { params, body: { entries: [{ fieldPath: 'langfuse.secretKeyPreview', value: 'x' }] } },
      'SECRET_PATH',
    ],
    [
      'invalid value',
      'patchConfigField',
      { params, body: { entries: [{ fieldPath: 'githubCompare.timeoutMs', value: 0 }] } },
      'CONFIG_OVERRIDE_INVALID',
    ],
    [
      'tombstone without a path',
      'tombstoneConfigField',
      { params, body: {} },
      'INVALID_FIELD_PATH',
    ],
    ['delete without a path', 'deleteConfigField', { params, query: {} }, 'INVALID_FIELD_PATH'],
    [
      'delete of a missing document',
      'deleteConfigField',
      { params, query: { fieldPath: 'memory.disabled' } },
      'CONFIG_NOT_FOUND',
    ],
    ['toggle without isActive', 'toggleConfig', { params, body: {} }, 'INVALID_IS_ACTIVE'],
    [
      'toggle of a missing document',
      'toggleConfig',
      { params, body: { isActive: false } },
      'CONFIG_NOT_FOUND',
    ],
    ['delete of a missing profile', 'deleteConfigOverrides', { params }, 'CONFIG_NOT_FOUND'],
    ['no ops', 'applyConfigChanges', { params, body: { ops: [] } }, 'OPS_REQUIRED'],
  ];

  it.each(cases)('%s', async (_label, handler, request, code) => {
    const res = await call(createHandlers()[handler], request);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).toMatchObject({ code, error: expect.any(String) });
  });

  it('answers 401 and 403 with codes on every route', async () => {
    const denied = createHandlers({
      hasConfigCapability: async () => false,
      hasAnyConfigReadAccess: async () => false,
      hasCapability: async () => false,
    });
    const routes: Array<[keyof AdminConfigHandlers, Record<string, unknown>]> = [
      ['listConfigs', {}],
      ['getConfigMeta', {}],
      ['getBaseConfig', {}],
      ['getConfig', { params }],
      ['upsertConfigOverrides', { params, body: { overrides: { memory: {} } } }],
      [
        'patchConfigField',
        { params, body: { entries: [{ fieldPath: 'memory.disabled', value: true }] } },
      ],
      ['tombstoneConfigField', { params, body: { fieldPath: 'memory.disabled' } }],
      ['deleteConfigField', { params, query: { fieldPath: 'memory.disabled' } }],
      ['applyConfigChanges', { params, body: { ops: [{ op: 'unset', fieldPath: 'memory' }] } }],
      ['deleteConfigOverrides', { params }],
      ['toggleConfig', { params, body: { isActive: true } }],
      ['updateConfigPriority', { params, body: { priority: 1 } }],
      ['reloadConfig', {}],
    ];
    for (const [handler, request] of routes) {
      const forbidden = await call(denied[handler], request);
      expect([handler, forbidden.statusCode, forbidden.body?.code]).toEqual([
        handler,
        403,
        expect.stringMatching(/^FORBIDDEN/),
      ]);
      const anonymous = await call(denied[handler], { ...request, user: undefined });
      expect([handler, anonymous.statusCode, anonymous.body?.code]).toEqual([
        handler,
        401,
        'AUTH_REQUIRED',
      ]);
    }
  });
});
