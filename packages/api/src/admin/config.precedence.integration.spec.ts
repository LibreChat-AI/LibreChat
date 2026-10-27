import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
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

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

interface ConfigBody {
  _id: string;
  priority: number;
  overrides: Record<string, unknown>;
  tombstones: string[];
  isActive: boolean;
  configVersion: number;
  revision: string;
}

/**
 * The admin config handlers on a real Config, Role, Group and User collection: precedence and
 * default priorities (W2-1), the profile lifecycle (W2-16) and validation on the Base floor
 * (W2-3).
 */

let mongoServer: MongoMemoryServer;
let methods: Methods;
let dataSchemas: DataSchemas;
let createAdminConfigHandlers: typeof import('./config').createAdminConfigHandlers;

const LIFECYCLE_TIMEOUT_MS = 180_000;

beforeAll(async () => {
  const [schemas, handlersModule, server] = await Promise.all([
    import('@librechat/data-schemas'),
    import('./config'),
    MongoMemoryServer.create(),
  ]);
  dataSchemas = schemas;
  mongoServer = server;
  ({ createAdminConfigHandlers } = handlersModule);
  jest.spyOn(schemas.logger, 'error').mockReturnValue(schemas.logger);
  jest.spyOn(schemas.logger, 'warn').mockReturnValue(schemas.logger);
  jest.spyOn(schemas.logger, 'info').mockReturnValue(schemas.logger);

  await mongoose.connect(mongoServer.getUri());
  schemas.createModels(mongoose);
  await mongoose.models.Config.init();
  methods = schemas.createMethods(mongoose);
}, LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, LIFECYCLE_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    ['Config', 'Role', 'Group', 'User'].map((name) => mongoose.models[name].deleteMany({})),
  );
});

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

/** Handlers wired the way `api/server/routes/admin/config.js` wires them, over `yaml`. */
function createHandlers(
  yaml: Partial<TCustomConfig> = {},
  overrides: Partial<AdminConfigDeps> = {},
): AdminConfigHandlers {
  return createAdminConfigHandlers({
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    setConfigPriority: methods.setConfigPriority,
    principalExists: methods.principalExists,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    getAppConfig: async () => ({ config: yaml }) as never,
    ...overrides,
  });
}

async function call(handler: Handler, request: Record<string, unknown>): Promise<MockRes> {
  const res = mockRes();
  await handler(mockReq(request), res);
  return res;
}

const configOf = (res: MockRes): ConfigBody => res.body?.config as ConfigBody;

const roleParams = (principalId: string) => ({ principalType: 'role', principalId });
const BASE = roleParams('__base__');

async function createRole(name: string): Promise<void> {
  await methods.createRoleByName({ name, permissions: {} });
}

async function createGroup(name: string): Promise<string> {
  const group = await methods.createGroup({ name, source: 'local' });
  return group._id.toString();
}

async function createUser(email: string): Promise<string> {
  const id = await methods.createUser({ email, name: email, provider: 'local' }, undefined, true);
  return id.toString();
}

const stored = (principalType: string, principalId: string) =>
  methods.findConfigByPrincipal(principalType as never, principalId, { includeInactive: true });

describe('validation on the Base floor (W2-3)', () => {
  /** librechat.yaml names a memory agent by id. */
  const agentIdYaml = { memory: { agent: { id: 'agent_1' } } } as Partial<TCustomConfig>;
  /** librechat.yaml picks a memory provider and model. */
  const providerYaml = {
    memory: { agent: { provider: 'openAI', model: 'gpt-4o' } },
  } as Partial<TCustomConfig>;

  /** Base drops the YAML agent id and picks a provider and model instead. */
  async function switchBaseToProvider(handlers: AdminConfigHandlers): Promise<void> {
    const tombstoned = await call(handlers.tombstoneConfigField, {
      params: BASE,
      body: { fieldPath: 'memory.agent.id' },
    });
    expect(tombstoned.statusCode).toBe(200);
    const patched = await call(handlers.patchConfigField, {
      params: BASE,
      body: {
        entries: [
          { fieldPath: 'memory.agent.provider', value: 'openAI' },
          { fieldPath: 'memory.agent.model', value: 'gpt-4o' },
        ],
      },
    });
    expect(patched.statusCode).toBe(200);
  }

  /** Base drops the YAML provider and model and names an agent instead. */
  async function switchBaseToAgentId(handlers: AdminConfigHandlers): Promise<void> {
    for (const fieldPath of ['memory.agent.provider', 'memory.agent.model']) {
      const tombstoned = await call(handlers.tombstoneConfigField, {
        params: BASE,
        body: { fieldPath },
      });
      expect(tombstoned.statusCode).toBe(200);
    }
    const patched = await call(handlers.patchConfigField, {
      params: BASE,
      body: { entries: [{ fieldPath: 'memory.agent.id', value: 'agent_9' }] },
    });
    expect(patched.statusCode).toBe(200);
  }

  it('accepts a profile write that is valid on top of Base, though not on the YAML alone', async () => {
    const handlers = createHandlers(agentIdYaml);
    await createRole('editor');
    await switchBaseToProvider(handlers);

    const patched = await call(handlers.patchConfigField, {
      params: roleParams('editor'),
      body: { entries: [{ fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] },
    });
    const replaced = await call(handlers.upsertConfigOverrides, {
      params: roleParams('editor'),
      body: { overrides: { memory: { agent: { model: 'gpt-4.1-mini' } } } },
    });

    expect(patched.statusCode).toBe(200);
    expect(replaced.statusCode).toBe(200);
    expect((await stored('role', 'editor'))?.overrides).toEqual({
      memory: { agent: { model: 'gpt-4.1-mini' } },
    });
  });

  it('refuses a profile write that only fails on top of Base, which the merge would drop', async () => {
    const handlers = createHandlers(providerYaml);
    await createRole('editor');
    await switchBaseToAgentId(handlers);

    const patched = await call(handlers.patchConfigField, {
      params: roleParams('editor'),
      body: { entries: [{ fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] },
    });

    expect(patched.statusCode).toBe(400);
    expect(patched.body).toEqual({
      error: 'Invalid config override',
      code: 'CONFIG_OVERRIDE_INVALID',
      issues: [
        {
          path: 'memory.agent.model',
          segments: ['memory', 'agent', 'model'],
          code: 'union_dropped_key',
        },
      ],
    });
    expect(await stored('role', 'editor')).toBeNull();
  });

  it('judges a POST /changes batch on the Base floor: valid only on top of Base', async () => {
    const handlers = createHandlers(agentIdYaml);
    await createRole('editor');
    await switchBaseToProvider(handlers);

    const changed = await call(handlers.applyConfigChanges, {
      params: roleParams('editor'),
      body: { ops: [{ op: 'set', fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] },
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.body?.written).toBe(true);
    expect((await stored('role', 'editor'))?.overrides).toEqual({
      memory: { agent: { model: 'gpt-4.1' } },
    });
  });

  it('refuses a POST /changes batch that only fails on top of Base', async () => {
    const handlers = createHandlers(providerYaml);
    await createRole('editor');
    await switchBaseToAgentId(handlers);

    const changed = await call(handlers.applyConfigChanges, {
      params: roleParams('editor'),
      body: { ops: [{ op: 'set', fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] },
    });

    expect(changed.statusCode).toBe(400);
    expect(changed.body).toMatchObject({
      code: 'CONFIG_OVERRIDE_INVALID',
      issues: [
        {
          path: 'memory.agent.model',
          segments: ['memory', 'agent', 'model'],
          code: 'union_dropped_key',
        },
      ],
    });
    expect(await stored('role', 'editor')).toBeNull();
  });

  it("validates a caller without a tenant on the platform Base, never on a tenant's Base", async () => {
    const handlers = createHandlers(providerYaml);
    await createRole('editor');
    await dataSchemas.tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      switchBaseToAgentId(handlers),
    );

    const patched = await call(handlers.patchConfigField, {
      params: roleParams('editor'),
      body: { entries: [{ fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] },
    });

    expect(patched.statusCode).toBe(200);
    expect((await stored('role', 'editor'))?.overrides).toEqual({
      memory: { agent: { model: 'gpt-4.1' } },
    });
  });

  describe("a tenant's group or user profile written by a caller without a tenant", () => {
    const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
      dataSchemas.tenantStorage.run({ tenantId: 'tenant-a' }, run);
    const setModel = { entries: [{ fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] };
    const welcome = { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] };

    /** A tenant-a group or user with a profile its tenant's admin created. */
    async function tenantProfile(
      handlers: AdminConfigHandlers,
      principalType: 'group' | 'user',
    ): Promise<{ principalType: string; principalId: string }> {
      const principalId = await inTenant(() =>
        principalType === 'group'
          ? createGroup('Tenant Engineering')
          : createUser('tenant-person@example.com'),
      );
      const params = { principalType, principalId };
      const created = await inTenant(() =>
        call(handlers.patchConfigField, { params, body: welcome }),
      );
      expect(created.statusCode).toBe(200);
      expect((await stored(principalType, principalId))?.tenantId).toBe('tenant-a');
      return params;
    }

    it("refuses a write that only fails on that tenant's Base, on every write route", async () => {
      const handlers = createHandlers(providerYaml);
      await inTenant(() => switchBaseToAgentId(handlers));
      const group = await tenantProfile(handlers, 'group');
      const platformGroup = { principalType: 'group', principalId: await createGroup('Platform') };

      const patched = await call(handlers.patchConfigField, { params: group, body: setModel });
      const replaced = await call(handlers.upsertConfigOverrides, {
        params: group,
        body: { overrides: { memory: { agent: { model: 'gpt-4.1' } } } },
      });
      const changed = await call(handlers.applyConfigChanges, {
        params: group,
        body: { ops: [{ op: 'set', fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] },
      });
      const platform = await call(handlers.patchConfigField, {
        params: platformGroup,
        body: setModel,
      });

      for (const res of [patched, replaced, changed]) {
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({
          code: 'CONFIG_OVERRIDE_INVALID',
          issues: [expect.objectContaining({ code: 'union_dropped_key' })],
        });
      }
      expect((await stored(group.principalType, group.principalId))?.overrides).toEqual({
        interface: { customWelcome: 'hi' },
      });
      /** A platform group's profile still merges over the platform Base, which allows it. */
      expect(platform.statusCode).toBe(200);
    });

    it("accepts a write that is valid only on that tenant's Base, judged on librechat.yaml as the tenant resolves it", async () => {
      const getAppConfig = jest.fn(async () => ({ config: agentIdYaml }) as never);
      const handlers = createHandlers(agentIdYaml, { getAppConfig });
      await inTenant(() => switchBaseToProvider(handlers));
      const user = await tenantProfile(handlers, 'user');
      getAppConfig.mockClear();

      const patched = await call(handlers.patchConfigField, { params: user, body: setModel });

      expect(patched.statusCode).toBe(200);
      expect((await stored(user.principalType, user.principalId))?.overrides).toEqual({
        interface: { customWelcome: 'hi' },
        memory: { agent: { model: 'gpt-4.1' } },
      });
      expect(getAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-a', baseOnly: true });
      expect(getAppConfig).not.toHaveBeenCalledWith({ tenantId: undefined, baseOnly: true });
    });

    /** librechat.yaml scoped per tenant: `tenantYaml` is what only tenant-a resolves. */
    const yamlByTenant = (tenantYaml: Partial<TCustomConfig>) =>
      jest.fn(
        async (options?: { tenantId?: string }) =>
          ({
            config: options?.tenantId === 'tenant-a' ? tenantYaml : {},
            mcpConfig: options?.tenantId === 'tenant-a' ? tenantYaml.mcpServers : undefined,
          }) as never,
      );

    it('allows the env references librechat.yaml uses as that tenant resolves it, on PUT, PATCH and POST …/changes', async () => {
      /** A custom endpoint librechat.yaml defines for tenant-a only, keyed from the environment. */
      const regional = {
        name: 'Regional',
        tenantId: 'tenant-a',
        apiKey: '${REGIONAL_KEY}',
        baseURL: 'https://regional.example.com/v1',
        models: { default: ['m'] },
      };
      const getAppConfig = yamlByTenant({ endpoints: { custom: [regional] } } as never);
      const handlers = createHandlers({}, { getAppConfig });
      const group = await tenantProfile(handlers, 'group');
      const platformGroup = { principalType: 'group', principalId: await createGroup('Platform') };
      const entry = {
        name: 'Second Region',
        apiKey: '${REGIONAL_KEY}',
        baseURL: 'https://second.example.com/v1',
        models: { default: ['m'] },
      };
      const replace = (params: Record<string, string>) =>
        call(handlers.upsertConfigOverrides, {
          params,
          body: { overrides: { endpoints: { custom: [entry] } } },
        });
      getAppConfig.mockClear();

      const replaced = await replace(group);
      const patched = await call(handlers.patchConfigField, {
        params: group,
        body: { entries: [{ fieldPath: 'endpoints.custom', value: [entry] }] },
      });
      const changed = await call(handlers.applyConfigChanges, {
        params: group,
        body: { ops: [{ op: 'upsertEntry', fieldPath: 'endpoints.custom', entry }] },
      });

      for (const res of [replaced, patched, changed]) {
        expect(res.statusCode).toBe(200);
      }
      expect(getAppConfig).not.toHaveBeenCalledWith({ tenantId: undefined, baseOnly: true });
      expect(getAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-a', baseOnly: true });

      /** The platform group merges over the platform's librechat.yaml, which references no such name. */
      const platform = await replace(platformGroup);
      expect(platform.statusCode).toBe(400);
      expect(platform.body).toMatchObject({
        code: 'CONFIG_OVERRIDE_INVALID',
        issues: [expect.objectContaining({ code: 'env_reference_not_allowed' })],
      });
    });

    it("judges a field delete's credential re-entry on librechat.yaml as that tenant resolves it", async () => {
      const url = 'https://tools.tenant.example/mcp';
      const getAppConfig = yamlByTenant({
        mcpServers: { tools: { type: 'streamable-http', url } },
      } as never);
      const handlers = createHandlers({}, { getAppConfig });
      const group = await tenantProfile(handlers, 'group');
      const keyed = await inTenant(() =>
        call(handlers.patchConfigField, {
          params: group,
          body: {
            entries: [
              { fieldPath: 'mcpServers.tools.url', value: url },
              {
                fieldPath: 'mcpServers.tools.apiKey',
                value: { source: 'admin', authorization_type: 'bearer', key: 'sk-tenant-key' },
              },
            ],
          },
        }),
      );
      expect(keyed.statusCode).toBe(200);

      /** tenant-a's librechat.yaml still sends the key to the same URL once the profile's goes. */
      const removed = await call(handlers.deleteConfigField, {
        params: group,
        query: { fieldPath: 'mcpServers.tools.url' },
      });

      expect(removed.statusCode).toBe(200);
      expect((await stored(group.principalType, group.principalId))?.overrides?.mcpServers).toEqual(
        { tools: { apiKey: expect.objectContaining({ source: 'admin' }) } },
      );
    });

    it('answers 409 when the document moved to another partition after the write resolved it', async () => {
      const handlers = createHandlers(providerYaml);
      const group = await tenantProfile(handlers, 'group');
      let reads = 0;
      const moving = createHandlers(providerYaml, {
        findConfigByPrincipal: async (principalType, principalId, options) => {
          if (principalId === group.principalId && ++reads === 2) {
            await methods.deleteConfig(PrincipalType.GROUP, group.principalId);
            await methods.writeConfigDocument(
              PrincipalType.GROUP,
              group.principalId,
              {
                principalModel: PrincipalModel.GROUP,
                priority: 20,
                overrides: {},
                tombstones: [],
                isActive: true,
              },
              dataSchemas.ABSENT_CONFIG_REVISION,
            );
          }
          return methods.findConfigByPrincipal(principalType, principalId, options);
        },
      });

      const patched = await call(moving.patchConfigField, { params: group, body: welcome });

      expect(patched.statusCode).toBe(409);
      expect(patched.body?.code).toBe('CONFIG_VERSION_CONFLICT');
      const moved = await stored(group.principalType, group.principalId);
      expect(moved?.tenantId).toBeUndefined();
      expect(moved?.overrides).toEqual({});
    });

    it("reports the credentials the profile drops over that tenant's Base, on every write route", async () => {
      const handlers = createHandlers();
      const based = await inTenant(() =>
        call(handlers.patchConfigField, {
          params: BASE,
          body: {
            entries: [
              {
                fieldPath: 'endpoints.custom',
                value: [
                  {
                    name: 'Gateway',
                    apiKey: 'sk-tenant-gateway-key',
                    baseURL: 'https://gateway.example.com/v1',
                    models: { default: ['gpt-4o'] },
                  },
                ],
              },
            ],
          },
        }),
      );
      expect(based.statusCode).toBe(200);
      const group = await tenantProfile(handlers, 'group');
      const moved = await inTenant(() =>
        call(handlers.patchConfigField, {
          params: group,
          body: {
            entries: [
              {
                fieldPath: 'endpoints.custom',
                value: [{ name: 'Gateway', baseURL: 'https://elsewhere.example/v1' }],
              },
              { fieldPath: 'endpoints.agents.disableBuilder', value: true },
              { fieldPath: 'endpoints.agents.recursionLimit', value: 30 },
            ],
          },
        }),
      );
      const dropped = [
        {
          path: 'endpoints.custom["Gateway"].apiKey',
          segments: ['endpoints', 'custom', 'Gateway', 'apiKey'],
          reason: 'secret_rebinding',
        },
      ];
      expect(moved.body?.ignored).toEqual(dropped);

      const patched = await call(handlers.patchConfigField, {
        params: group,
        body: { entries: [{ fieldPath: 'endpoints.agents.recursionLimit', value: 40 }] },
      });
      const tombstoned = await call(handlers.tombstoneConfigField, {
        params: group,
        body: { fieldPath: 'endpoints.agents.recursionLimit' },
      });
      const deleted = await call(handlers.deleteConfigField, {
        params: group,
        query: { fieldPath: 'endpoints.agents.disableBuilder' },
      });

      for (const res of [patched, tombstoned, deleted]) {
        expect(res.statusCode).toBe(200);
        expect(res.body?.ignored).toEqual(dropped);
      }

      /** A read judges the stored profile over the same Base the writes judged it on. */
      const read = await call(handlers.getConfig, { params: group });
      expect(read.statusCode).toBe(200);
      expect(read.body?.ignoredBasis).toBe('base');
      expect(read.body?.ignored).toEqual(dropped);
    });

    it("keeps the stdio servers that tenant's librechat.yaml runs out of PUT and tombstones", async () => {
      const getAppConfig = yamlByTenant({
        mcpServers: { local: { type: 'stdio', command: 'node', args: ['server.js'] } },
      } as never);
      const handlers = createHandlers({}, { getAppConfig });
      const group = await tenantProfile(handlers, 'group');

      const replaced = await call(handlers.upsertConfigOverrides, {
        params: group,
        body: {
          overrides: {
            interface: { customWelcome: 'hi' },
            mcpServers: { local: { title: 'Local' } },
          },
        },
      });
      const tombstoned = await call(handlers.tombstoneConfigField, {
        params: group,
        body: { fieldPath: 'mcpServers.local' },
      });

      expect(replaced.statusCode).toBe(200);
      expect(replaced.body?.skipped).toEqual([
        {
          path: 'mcpServers.local',
          segments: ['mcpServers', 'local'],
          reason: 'process_mcp_server',
        },
      ]);
      expect(tombstoned.statusCode).toBe(400);
      expect(tombstoned.body?.code).toBe('PROCESS_MCP_SERVER_OVERRIDE');
      const kept = await stored(group.principalType, group.principalId);
      expect(kept?.overrides).toEqual({ interface: { customWelcome: 'hi' } });
      expect(kept?.tombstones ?? []).toEqual([]);
    });
  });

  it('ignores an inactive Base, which the merge skips too', async () => {
    const handlers = createHandlers(providerYaml);
    await createRole('editor');
    await switchBaseToAgentId(handlers);
    const toggled = await call(handlers.toggleConfig, {
      params: BASE,
      body: { isActive: false },
    });
    expect(toggled.statusCode).toBe(200);

    const patched = await call(handlers.patchConfigField, {
      params: roleParams('editor'),
      body: { entries: [{ fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] },
    });

    expect(patched.statusCode).toBe(200);
  });

  it('validates a Base write on the YAML alone, not on the Base document it replaces', async () => {
    const handlers = createHandlers(providerYaml);
    await switchBaseToAgentId(handlers);

    /**
     * Base switches back to a provider. On its own stored agent id this would be refused (the id
     * option would drop the provider and model); on the YAML, minus Base's tombstones, it is valid.
     */
    const replaced = await call(handlers.upsertConfigOverrides, {
      params: BASE,
      body: { overrides: { memory: { agent: { provider: 'anthropic', model: 'claude' } } } },
    });

    expect(replaced.statusCode).toBe(200);
    expect(configOf(replaced).overrides).toEqual({
      memory: { agent: { provider: 'anthropic', model: 'claude' } },
    });
  });
});

describe('validation on the Base the write lands over (W2-3)', () => {
  const providerYaml = {
    memory: { agent: { provider: 'openAI', model: 'gpt-4o' } },
  } as Partial<TCustomConfig>;
  const editor = roleParams('editor');
  const setModel = { entries: [{ fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] };
  const setWelcome = (value: string) => ({
    entries: [{ fieldPath: 'interface.customWelcome', value }],
  });

  /** Base drops the YAML provider and model and names an agent, so a profile's model is invalid. */
  async function switchBaseToAgentId(handlers: AdminConfigHandlers): Promise<void> {
    const changed = await call(handlers.applyConfigChanges, {
      params: BASE,
      body: {
        ops: [
          { op: 'tombstone', fieldPath: 'memory.agent.provider' },
          { op: 'tombstone', fieldPath: 'memory.agent.model' },
          { op: 'set', fieldPath: 'memory.agent.id', value: 'agent_9' },
        ],
      },
    });
    expect(changed.statusCode).toBe(200);
  }

  /**
   * Handlers whose first write to `editor` runs `before` just before it reaches the store and
   * `after` once it has committed: what concurrent requests do in between.
   */
  function racingHandlers(
    hooks: { before?: () => Promise<void>; after?: () => Promise<void> },
    overrides: Partial<AdminConfigDeps> = {},
  ): AdminConfigHandlers {
    let raced = false;
    return createHandlers(providerYaml, {
      ...overrides,
      writeConfigDocument: async (principalType, principalId, draft, expected) => {
        const first = !raced && principalId === 'editor';
        raced ||= first;
        if (first) {
          await hooks.before?.();
        }
        const written = await methods.writeConfigDocument(
          principalType,
          principalId,
          draft,
          expected,
        );
        if (first) {
          await hooks.after?.();
        }
        return written;
      },
    });
  }

  it('judges a write that retries after losing a race on the Base it reads again', async () => {
    const handlers = createHandlers(providerYaml);
    await createRole('editor');
    await call(handlers.patchConfigField, { params: editor, body: setWelcome('first') });
    const racing = racingHandlers({
      before: async () => {
        await switchBaseToAgentId(handlers);
        await call(handlers.patchConfigField, { params: editor, body: setWelcome('concurrent') });
      },
    });

    const patched = await call(racing.patchConfigField, { params: editor, body: setModel });

    expect(patched.statusCode).toBe(400);
    expect(patched.body?.issues).toEqual([expect.objectContaining({ code: 'union_dropped_key' })]);
    /** Refused before its retry wrote anything: no write landed to be withdrawn again. */
    expect(await stored('role', 'editor')).toMatchObject({
      overrides: { interface: { customWelcome: 'concurrent' } },
      configVersion: 2,
    });
  });

  it('withdraws a write Base changed under before it committed, and answers as Base now judges it', async () => {
    const handlers = createHandlers(providerYaml);
    await createRole('editor');
    await call(handlers.patchConfigField, { params: editor, body: setWelcome('first') });
    const invalidateConfigCaches = jest.fn().mockResolvedValue(undefined);
    const racing = racingHandlers(
      { before: () => switchBaseToAgentId(handlers) },
      { invalidateConfigCaches },
    );

    const patched = await call(racing.patchConfigField, { params: editor, body: setModel });

    expect(patched.statusCode).toBe(400);
    expect(patched.body?.issues).toEqual([expect.objectContaining({ code: 'union_dropped_key' })]);
    expect((await stored('role', 'editor'))?.overrides).toEqual({
      interface: { customWelcome: 'first' },
    });
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      route: 'POST /changes',
      send: (handlers: AdminConfigHandlers) =>
        call(handlers.applyConfigChanges, {
          params: editor,
          body: { ops: [{ op: 'set', fieldPath: 'memory.agent.model', value: 'gpt-4.1' }] },
        }),
    },
    {
      route: 'PUT',
      send: (handlers: AdminConfigHandlers) =>
        call(handlers.upsertConfigOverrides, {
          params: editor,
          body: { overrides: { memory: { agent: { model: 'gpt-4.1' } } } },
        }),
    },
  ])('$route removes the profile it created on a Base that changed under it', async ({ send }) => {
    const handlers = createHandlers(providerYaml);
    await createRole('editor');

    const res = await send(racingHandlers({ before: () => switchBaseToAgentId(handlers) }));

    expect(res.statusCode).toBe(400);
    expect(res.body?.code).toBe('CONFIG_OVERRIDE_INVALID');
    expect(await stored('role', 'editor')).toBeNull();
  });

  it('keeps a write that is still valid on the Base that changed under it', async () => {
    const handlers = createHandlers(providerYaml);
    await createRole('editor');
    const racing = racingHandlers({
      before: async () => {
        const based = await call(handlers.patchConfigField, {
          params: BASE,
          body: setWelcome('all'),
        });
        expect(based.statusCode).toBe(200);
      },
    });

    const patched = await call(racing.patchConfigField, { params: editor, body: setModel });

    expect(patched.statusCode).toBe(200);
    expect((await stored('role', 'editor'))?.overrides).toEqual({
      memory: { agent: { model: 'gpt-4.1' } },
    });
  });

  it('answers 409 and leaves the profile when a later write landed before the withdrawal', async () => {
    const handlers = createHandlers(providerYaml);
    await createRole('editor');
    await call(handlers.patchConfigField, { params: editor, body: setWelcome('first') });
    const racing = racingHandlers({
      before: () => switchBaseToAgentId(handlers),
      after: async () => {
        await call(handlers.patchConfigField, { params: editor, body: setWelcome('later') });
      },
    });

    const patched = await call(racing.patchConfigField, { params: editor, body: setModel });

    const current = await stored('role', 'editor');
    expect(patched.statusCode).toBe(409);
    expect(patched.body?.code).toBe('CONFIG_VERSION_CONFLICT');
    expect(patched.body?.currentRevision).toBe(`${current?._id}:${current?.configVersion}`);
    expect(current?.overrides).toEqual({
      interface: { customWelcome: 'later' },
      memory: { agent: { model: 'gpt-4.1' } },
    });
  });
});

describe('profile lifecycle (W2-16)', () => {
  it('creates a profile only when none exists: one of two concurrent creates wins', async () => {
    const handlers = createHandlers();
    const groupId = await createGroup('Engineering');
    const create = () =>
      call(handlers.upsertConfigOverrides, {
        params: { principalType: 'group', principalId: groupId },
        body: { overrides: {}, expectedRevision: 'absent' },
      });

    const results = await Promise.all([create(), create()]);
    const statuses = results.map((res) => res.statusCode).sort();

    expect(statuses).toEqual([201, 409]);
    const created = results.find((res) => res.statusCode === 201) as MockRes;
    const refused = results.find((res) => res.statusCode === 409) as MockRes;
    expect(configOf(created)).toMatchObject({ priority: 20, overrides: {}, isActive: true });
    expect(refused.body).toEqual({
      error: 'Config was modified by another request',
      code: 'CONFIG_VERSION_CONFLICT',
      currentRevision: configOf(created).revision,
    });
  });

  it('changes only the priority, keeping overrides, tombstones and the inactive state', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const invalidateConfigCaches = jest.fn().mockResolvedValue(undefined);
    const handlers = createHandlers({}, { recordAuditEntry, invalidateConfigCaches });
    await createRole('editor');
    const params = roleParams('editor');
    await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] },
    });
    await call(handlers.tombstoneConfigField, { params, body: { fieldPath: 'memory' } });
    const toggled = await call(handlers.toggleConfig, { params, body: { isActive: false } });
    recordAuditEntry.mockClear();
    invalidateConfigCaches.mockClear();

    const changed = await call(handlers.updateConfigPriority, {
      params,
      body: { priority: 40, expectedRevision: configOf(toggled).revision },
    });

    expect(changed.statusCode).toBe(200);
    expect(configOf(changed)).toMatchObject({
      priority: 40,
      overrides: { interface: { customWelcome: 'hi' } },
      tombstones: ['memory'],
      isActive: false,
      configVersion: configOf(toggled).configVersion + 1,
    });
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(1);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'config.updated',
        metadata: { operation: 'priority', priority: 40 },
      }),
    );

    recordAuditEntry.mockClear();
    invalidateConfigCaches.mockClear();
    const unchanged = await call(handlers.updateConfigPriority, { params, body: { priority: 40 } });
    expect(unchanged.statusCode).toBe(200);
    expect(configOf(unchanged).revision).toBe(configOf(changed).revision);
    expect(recordAuditEntry).not.toHaveBeenCalled();
    expect(invalidateConfigCaches).not.toHaveBeenCalled();

    const stale = await call(handlers.updateConfigPriority, {
      params,
      body: { priority: 41, expectedRevision: configOf(toggled).revision },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body?.currentRevision).toBe(configOf(changed).revision);
  });

  it('keeps the priority route to broad managers and existing profiles', async () => {
    await createRole('editor');
    const broad = createHandlers();
    const params = roleParams('editor');

    const missing = await call(broad.updateConfigPriority, { params, body: { priority: 5 } });
    expect(missing.statusCode).toBe(404);
    expect(missing.body?.code).toBe('CONFIG_NOT_FOUND');
    expect(await stored('role', 'editor')).toBeNull();

    await call(broad.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] },
    });
    const sectionScoped = createHandlers(
      {},
      {
        hasConfigCapability: async (_user, section) => section === 'interface',
      },
    );
    const denied = await call(sectionScoped.updateConfigPriority, {
      params,
      body: { priority: 5 },
    });
    expect(denied.statusCode).toBe(403);
    expect((await stored('role', 'editor'))?.priority).toBe(10);

    for (const priority of [-1, '5', null, undefined]) {
      const invalid = await call(broad.updateConfigPriority, { params, body: { priority } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body?.code).toBe('INVALID_PRIORITY');
    }
  });

  it("changes the priority only in the caller's tenant partition", async () => {
    const handlers = createHandlers();
    const inTenant = <T>(tenantId: string, run: () => Promise<T>) =>
      dataSchemas.tenantStorage.run({ tenantId }, run);
    const params = roleParams('editor');
    const reorder = (priority: number) =>
      call(handlers.updateConfigPriority, { params, body: { priority } });
    /** Every stored `editor` profile as `tenant:priority`, the platform-level one as `-:…`. */
    const priorities = async () =>
      (
        await mongoose.models.Config.collection
          .find({ principalType: 'role', principalId: 'editor' })
          .project<{ priority: number; tenantId?: string }>({ priority: 1, tenantId: 1 })
          .toArray()
      )
        .map((document) => `${document.tenantId ?? '-'}:${document.priority}`)
        .sort();
    await inTenant('tenant-a', async () => {
      await createRole('editor');
      const created = await call(handlers.patchConfigField, {
        params,
        body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'tenant-a' }] },
      });
      expect(created.statusCode).toBe(200);
    });

    const onlyTenant = await reorder(40);
    expect(onlyTenant.statusCode).toBe(404);
    expect(onlyTenant.body?.code).toBe('CONFIG_NOT_FOUND');
    expect(await priorities()).toEqual(['tenant-a:10']);

    await mongoose.models.Config.collection.insertOne({
      principalType: 'role',
      principalId: 'editor',
      principalModel: 'Role',
      priority: 10,
      overrides: { interface: { customWelcome: 'platform' } },
      tombstones: [],
      isActive: true,
      configVersion: 1,
    });
    const platform = await reorder(40);
    expect(platform.statusCode).toBe(200);
    expect(configOf(platform).overrides).toEqual({ interface: { customWelcome: 'platform' } });
    expect(await priorities()).toEqual(['-:40', 'tenant-a:10']);

    const tenant = await inTenant('tenant-a', () => reorder(30));
    expect(tenant.statusCode).toBe(200);
    expect(configOf(tenant).overrides).toEqual({ interface: { customWelcome: 'tenant-a' } });
    expect(await priorities()).toEqual(['-:40', 'tenant-a:30']);
  });

  it("answers a priority write that loses a race with the revision in the caller's partition", async () => {
    const handlers = createHandlers();
    const params = roleParams('editor');
    await dataSchemas.tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await createRole('editor');
      const created = await call(handlers.patchConfigField, {
        params,
        body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'tenant-a' }] },
      });
      expect(created.statusCode).toBe(200);
    });
    const collection = mongoose.models.Config.collection;
    const { insertedId } = await collection.insertOne({
      principalType: 'role',
      principalId: 'editor',
      principalModel: 'Role',
      priority: 10,
      overrides: { interface: { customWelcome: 'platform' } },
      tombstones: [],
      isActive: true,
      configVersion: 1,
    });
    const findOneAndUpdate = collection.findOneAndUpdate.bind(collection);
    /** Another platform admin deletes the profile between this request's read and its write. */
    jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce((async (
      ...args: Parameters<typeof findOneAndUpdate>
    ) => {
      await collection.deleteOne({ _id: insertedId });
      return findOneAndUpdate(...args);
    }) as unknown as typeof collection.findOneAndUpdate);

    const lost = await call(handlers.updateConfigPriority, {
      params,
      body: { priority: 40, expectedRevision: `${insertedId}:1` },
    });

    expect(lost.statusCode).toBe(409);
    expect(lost.body).toEqual({
      error: 'Config was modified by another request',
      code: 'CONFIG_VERSION_CONFLICT',
      currentRevision: null,
    });
  });

  it('refuses to create a profile for a role, group or user that does not exist', async () => {
    const handlers = createHandlers();
    const missingObjectId = new Types.ObjectId().toString();
    const writes: Array<[Handler, Record<string, unknown>, Record<string, unknown>]> = [
      [handlers.upsertConfigOverrides, roleParams('ghost'), { overrides: {}, priority: 5 }],
      [
        handlers.patchConfigField,
        { principalType: 'group', principalId: 'grp_engineering' },
        { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] },
      ],
      [
        handlers.patchConfigField,
        { principalType: 'group', principalId: missingObjectId },
        { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] },
      ],
      [
        handlers.tombstoneConfigField,
        { principalType: 'user', principalId: missingObjectId },
        { fieldPath: 'memory' },
      ],
    ];

    for (const [handler, params, body] of writes) {
      const res = await call(handler, { params, body });
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Principal not found', code: 'PRINCIPAL_NOT_FOUND' });
    }
    expect(await methods.listAllConfigs()).toEqual([]);
  });

  it('refuses a POST /changes batch that would create a document for a missing principal', async () => {
    const handlers = createHandlers();
    const missingObjectId = new Types.ObjectId().toString();
    const set = [{ op: 'set', fieldPath: 'interface.customWelcome', value: 'hi' }];
    const batches: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [roleParams('ghost'), { ops: set }],
      /** A batch that changes nothing but the priority would otherwise create a document. */
      [
        { principalType: 'group', principalId: missingObjectId },
        { ops: [{ op: 'unset', fieldPath: 'interface.customWelcome' }], priority: 30 },
      ],
      [
        { principalType: 'user', principalId: missingObjectId },
        { ops: [{ op: 'tombstone', fieldPath: 'memory' }], dryRun: true },
      ],
      [{ principalType: 'group', principalId: 'grp_engineering' }, { ops: set }],
    ];

    for (const [params, body] of batches) {
      const res = await call(handlers.applyConfigChanges, { params, body });
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Principal not found', code: 'PRINCIPAL_NOT_FOUND' });
    }
    expect(await methods.listAllConfigs()).toEqual([]);
  });

  it('creates first documents through POST /changes at the type default priority', async () => {
    const handlers = createHandlers();
    await createRole('editor');
    const groupId = await createGroup('Engineering');
    const userId = await createUser('person@example.com');
    const ops = [{ op: 'set', fieldPath: 'interface.customWelcome', value: 'hi' }];

    const results = await Promise.all(
      [
        roleParams('editor'),
        { principalType: 'group', principalId: groupId },
        { principalType: 'user', principalId: userId },
        BASE,
      ].map((params) => call(handlers.applyConfigChanges, { params, body: { ops } })),
    );

    expect(results.map((res) => res.statusCode)).toEqual([200, 200, 200, 200]);
    expect(results.map((res) => configOf(res).priority)).toEqual([10, 20, 100, 0]);
  });

  it('lets a priority-only POST /changes batch create the document of a principal that exists', async () => {
    const handlers = createHandlers();
    const userId = await createUser('person@example.com');

    const res = await call(handlers.applyConfigChanges, {
      params: { principalType: 'user', principalId: userId },
      body: { ops: [{ op: 'unset', fieldPath: 'interface.customWelcome' }], priority: 30 },
    });

    expect(res.statusCode).toBe(200);
    expect(configOf(res)).toMatchObject({ priority: 30, overrides: {}, tombstones: [] });
  });

  it('creates a first document at the type default when tombstoning a web search URL', async () => {
    const handlers = createHandlers();
    const groupId = await createGroup('Engineering');
    const userId = await createUser('person@example.com');

    const results = await Promise.all(
      [
        { principalType: 'group', principalId: groupId },
        { principalType: 'user', principalId: userId },
      ].map((params) =>
        call(handlers.tombstoneConfigField, {
          params,
          body: { fieldPath: 'webSearch.jinaApiUrl' },
        }),
      ),
    );

    expect(results.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(results.map((res) => configOf(res).priority)).toEqual([20, 100]);
    expect(results.map((res) => configOf(res).tombstones)).toEqual([
      ['webSearch.jinaApiUrl'],
      ['webSearch.jinaApiUrl'],
    ]);
  });

  it('creates profiles for principals that exist, at their type default priority', async () => {
    const handlers = createHandlers();
    await createRole('editor');
    const groupId = await createGroup('Engineering');
    const userId = await createUser('person@example.com');
    const entry = { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] };

    const results = await Promise.all([
      call(handlers.patchConfigField, { params: roleParams('editor'), body: entry }),
      call(handlers.patchConfigField, {
        params: { principalType: 'group', principalId: groupId },
        body: entry,
      }),
      call(handlers.tombstoneConfigField, {
        params: { principalType: 'user', principalId: userId },
        body: { fieldPath: 'memory' },
      }),
      call(handlers.patchConfigField, { params: BASE, body: entry }),
    ]);

    expect(results.map((res) => res.statusCode)).toEqual([200, 200, 200, 200]);
    expect(results.map((res) => configOf(res).priority)).toEqual([10, 20, 100, 0]);
  });

  it('checks the principal only when a write would create its first document', async () => {
    const handlers = createHandlers();
    /** A profile left behind by a role deleted before cleanup existed. */
    await methods.patchConfigFields('role' as never, 'retired', 'Role' as never, {
      'interface.customWelcome': 'old',
    });

    const patched = await call(handlers.patchConfigField, {
      params: roleParams('retired'),
      body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'new' }] },
    });

    expect(patched.statusCode).toBe(200);
  });

  it('checks the principal on the document a tombstone writes over, not on an earlier read', async () => {
    const orphans = ['retired', 'retired-search'];
    for (const principalId of orphans) {
      /** A profile left behind by a role renamed or deleted before its profile moved with it. */
      await methods.patchConfigFields('role' as never, principalId, 'Role' as never, {
        'interface.customWelcome': 'old',
      });
    }
    /** A concurrent DELETE of each orphan lands after the tombstone read it, before it writes. */
    const removed = new Set<string>();
    const handlers = createHandlers(
      {},
      {
        findConfigByPrincipal: async (principalType, principalId, options) => {
          const found = await methods.findConfigByPrincipal(principalType, principalId, options);
          if (found && !removed.has(principalId)) {
            removed.add(principalId);
            await methods.deleteConfig(principalType, principalId);
          }
          return found;
        },
      },
    );

    const results = await Promise.all([
      call(handlers.tombstoneConfigField, {
        params: roleParams('retired'),
        body: { fieldPath: 'memory' },
      }),
      call(handlers.tombstoneConfigField, {
        params: roleParams('retired-search'),
        body: { fieldPath: 'webSearch.jinaApiUrl' },
      }),
    ]);

    expect([...removed].sort()).toEqual(orphans);
    for (const res of results) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Principal not found', code: 'PRINCIPAL_NOT_FOUND' });
    }
    expect(await methods.listAllConfigs()).toEqual([]);
  });

  it('looks principals up in the caller tenant only', async () => {
    const handlers = createHandlers();
    const inTenant = <T>(tenantId: string, run: () => Promise<T>) =>
      dataSchemas.tenantStorage.run({ tenantId }, run);
    await inTenant('tenant-a', () => createRole('tenant-role'));
    const write = () =>
      call(handlers.patchConfigField, {
        params: roleParams('tenant-role'),
        body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] },
      });

    const elsewhere = await inTenant('tenant-b', write);
    const home = await inTenant('tenant-a', write);

    expect(elsewhere.statusCode).toBe(404);
    expect(home.statusCode).toBe(200);
  });

  it('looks principals up at platform level for a caller without a tenant', async () => {
    const handlers = createHandlers();
    const tenantPrincipals = await dataSchemas.tenantStorage.run(
      { tenantId: 'tenant-a' },
      async () => {
        await createRole('tenant-role');
        return {
          groupId: await createGroup('Tenant Engineering'),
          userId: await createUser('tenant-person@example.com'),
        };
      },
    );
    await createRole('Editor');
    const entry = { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] };
    const write = (principalType: string, principalId: string) =>
      call(handlers.patchConfigField, { params: { principalType, principalId }, body: entry });

    const refused = await Promise.all([
      write('role', 'tenant-role'),
      write('group', tenantPrincipals.groupId),
      write('user', tenantPrincipals.userId),
      write('role', 'editor'),
    ]);

    expect(refused.map((res) => res.body?.code)).toEqual(Array(4).fill('PRINCIPAL_NOT_FOUND'));
    expect(await methods.listAllConfigs()).toEqual([]);
    expect((await write('role', 'Editor')).statusCode).toBe(200);
  });

  it('treats the system roles as existing without creating their role documents', async () => {
    const handlers = createHandlers();

    const res = await call(handlers.patchConfigField, {
      params: roleParams('USER'),
      body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(configOf(res).priority).toBe(10);
    expect(await mongoose.models.Role.countDocuments({})).toBe(0);
  });
});

describe('priority on writes (W2-1)', () => {
  it('keeps the stored priority when a broad PUT does not send one', async () => {
    const handlers = createHandlers();
    const groupId = await createGroup('Engineering');
    const params = { principalType: 'group', principalId: groupId };
    await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] },
    });

    const replaced = await call(handlers.upsertConfigOverrides, {
      params,
      body: { overrides: { interface: { customWelcome: 'replaced' } } },
    });

    expect(replaced.statusCode).toBe(200);
    expect(configOf(replaced).priority).toBe(20);
    const reprioritized = await call(handlers.upsertConfigOverrides, {
      params,
      body: { overrides: { interface: { customWelcome: 'again' } }, priority: 7 },
    });
    expect(configOf(reprioritized).priority).toBe(7);
  });

  it('lists profiles in the order they merge: Base first, then priority, type and identity', async () => {
    const handlers = createHandlers();
    await createRole('editor');
    const groupId = await createGroup('Engineering');
    const userId = await createUser('person@example.com');
    const entry = { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] };
    for (const params of [
      { principalType: 'user', principalId: userId },
      { principalType: 'group', principalId: groupId },
      roleParams('editor'),
      BASE,
    ]) {
      await call(handlers.patchConfigField, { params, body: entry });
    }
    await call(handlers.updateConfigPriority, { params: BASE, body: { priority: 500 } });
    await call(handlers.updateConfigPriority, {
      params: { principalType: 'group', principalId: groupId },
      body: { priority: 10 },
    });

    const listed = await call(handlers.listConfigs, {});
    const order = (listed.body?.configs as Array<{ principalType: string; priority: number }>).map(
      ({ principalType, priority }) => `${principalType}:${priority}`,
    );

    expect(order).toEqual(['role:500', 'role:10', 'group:10', 'user:100']);
  });
});
