import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalModel, PrincipalType } from 'librechat-data-provider';
import type {
  AppConfig,
  SystemCapability,
  AdminResolvedConfigResponse,
  AdminEffectiveConfigResponse,
} from '@librechat/data-schemas';
import type { DeepPartial, TCustomConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

type DataSchemas = typeof import('@librechat/data-schemas');
type Methods = ReturnType<DataSchemas['createMethods']>;
type ReadDeps = Parameters<typeof import('./resolved').createAdminConfigReadHandlers>[0];
type AppConfigService = ReturnType<typeof import('~/app/service').createAppConfigService>;

interface MockRes {
  statusCode: number;
  body: Record<string, unknown> | undefined;
  status: jest.Mock;
  json: jest.Mock;
}

const ROLE = PrincipalType.ROLE;
const YAML_KEY = 'yaml-gateway-literal-key';
const BASE_KEY = 'sk-base-entered-secret-9876';

const YAML: DeepPartial<TCustomConfig> = {
  version: '1.3.0',
  cache: true,
  interface: { customWelcome: 'Hello from YAML' },
  registration: { socialLogins: ['github'] },
  endpoints: {
    custom: [
      {
        name: 'Gateway',
        apiKey: YAML_KEY,
        baseURL: 'https://gateway.example.com/v1',
        models: { default: ['gpt-4o'] },
      },
    ],
  },
};

let mongoServer: MongoMemoryServer;
let dataSchemas: DataSchemas;
let methods: Methods;
let service: AppConfigService;
let createAdminConfigReadHandlers: typeof import('./resolved').createAdminConfigReadHandlers;
let createAdminConfigHandlers: typeof import('./config').createAdminConfigHandlers;

function mockReq(overrides: Record<string, unknown> = {}): ServerRequest {
  return {
    user: { id: 'admin-1', role: 'ADMIN', _id: { toString: () => 'admin-1' } },
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

function readHandlers(extra: Partial<ReadDeps> = {}) {
  return createAdminConfigReadHandlers({
    findConfigByPrincipal: methods.findConfigByPrincipal,
    hasAnyConfigReadAccess: async () => true,
    getReadableConfigSections: async (_user, sections) => ({
      broad: true,
      sections: new Set(sections),
    }),
    hasCapability: async () => true,
    resolveConfigLayers: service.resolveConfigLayers,
    principalExists: methods.principalExists,
    findPartitionUser: methods.findPartitionUser,
    getUserPrincipals: methods.getUserPrincipals,
    getApplicableConfigs: methods.getApplicableConfigs,
    ...extra,
  });
}

/** The real admin write path, so stored documents carry what the API stores (encrypted keys). */
async function patch(
  principalType: string,
  principalId: string,
  entries: Array<{ fieldPath: string; value: unknown }>,
  priority?: number,
): Promise<void> {
  const handlers = createAdminConfigHandlers({
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    principalExists: methods.principalExists,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    getAppConfig: service.getAppConfig,
    invalidateConfigCaches: service.clearOverrideCache,
  });
  const res = mockRes();
  await handlers.patchConfigField(
    mockReq({ params: { principalType, principalId }, body: { entries, priority } }),
    res,
  );
  expect(res.statusCode).toBe(200);
}

async function getResolved(
  principalType: string,
  principalId: string,
  extra: Partial<ReadDeps> = {},
  user?: Record<string, unknown>,
): Promise<MockRes> {
  const res = mockRes();
  await readHandlers(extra).getResolvedConfig(
    mockReq({ params: { principalType, principalId }, ...(user && { user }) }),
    res,
  );
  return res;
}

async function getEffective(
  userId: string,
  extra: Partial<ReadDeps> = {},
  user?: Record<string, unknown>,
): Promise<MockRes> {
  const res = mockRes();
  await readHandlers(extra).getEffectiveConfig(
    mockReq({ query: { userId }, ...(user && { user }) }),
    res,
  );
  return res;
}

async function createUser(email: string, role = 'USER'): Promise<string> {
  const user = await new mongoose.models.User({ email, provider: 'local', role }).save();
  return user._id.toString();
}

async function createGroup(name: string, memberIds: string[]): Promise<string> {
  const group = await new mongoose.models.Group({ name, source: 'local', memberIds }).save();
  return group._id.toString();
}

beforeAll(async () => {
  jest.resetModules();
  dataSchemas = await import('@librechat/data-schemas');
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  ({ createAdminConfigReadHandlers } = await import('./resolved'));
  ({ createAdminConfigHandlers } = await import('./config'));
  const { createAppConfigService } = await import('~/app/service');

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  methods = dataSchemas.createMethods(mongoose);

  const appConfig: AppConfig = await dataSchemas.AppService({ config: structuredClone(YAML) });
  const store = new Map<string, unknown>();
  service = createAppConfigService({
    loadBaseConfig: async () => structuredClone(appConfig),
    setCachedTools: async () => undefined,
    getCache: () => ({
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: async (key: string) => store.delete(key),
      opts: { store: { keys: () => store.keys() } },
    }),
    cacheKeys: { APP_CONFIG: 'app_config' },
    getApplicableConfigs: methods.getApplicableConfigs,
    getUserPrincipals: methods.getUserPrincipals,
  });
});

afterEach(async () => {
  await Promise.all(
    ['Config', 'User', 'Group', 'Role'].map((name) => mongoose.models[name].deleteMany({})),
  );
  await service.clearOverrideCache();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('GET /resolved/:principalType/:principalId', () => {
  it('resolves a profile over librechat.yaml and Base, in merge order and librechat.yaml shape', async () => {
    await patch(ROLE, dataSchemas.BASE_CONFIG_PRINCIPAL_ID, [
      { fieldPath: 'interface.customWelcome', value: 'Hello from Base' },
      { fieldPath: 'registration.socialLogins', value: ['google'] },
    ]);
    await patch(ROLE, 'USER', [
      { fieldPath: 'interface.customWelcome', value: 'Hello, users' },
      { fieldPath: 'interface.prompts', value: false },
    ]);

    const res = await getResolved(ROLE, 'USER');
    const body = res.body as AdminResolvedConfigResponse;

    expect(res.statusCode).toBe(200);
    expect(body.yaml.interface?.customWelcome).toBe('Hello from YAML');
    expect(body.layers.map(({ principalId, priority }) => [principalId, priority])).toEqual([
      [dataSchemas.BASE_CONFIG_PRINCIPAL_ID, 0],
      ['USER', 10],
    ]);
    expect(body.layers[1].revision).toMatch(/^[0-9a-f]{24}:1$/);
    expect(body.resolved.interface?.customWelcome).toBe('Hello, users');
    expect(body.resolved.registration?.socialLogins).toEqual(['google']);
    expect(body.resolved).not.toHaveProperty('interfaceConfig');
  });

  it('shows a write the override cache has not caught up with', async () => {
    await patch(ROLE, 'USER', [{ fieldPath: 'interface.customWelcome', value: 'Before' }]);
    const cached = await service.getAppConfig({ role: 'USER' });
    expect(cached.interfaceConfig?.customWelcome).toBe('Before');
    /** Written below the admin API, so nothing clears the merged config the read above cached. */
    await methods.patchConfigFields(ROLE, 'USER', PrincipalModel.ROLE, {
      'interface.customWelcome': 'After',
    });
    expect((await service.getAppConfig({ role: 'USER' })).interfaceConfig?.customWelcome).toBe(
      'Before',
    );

    const body = (await getResolved(ROLE, 'USER')).body as AdminResolvedConfigResponse;
    expect(body.resolved.interface?.customWelcome).toBe('After');
  });

  it('lists an inactive profile without merging it', async () => {
    await patch(ROLE, 'USER', [{ fieldPath: 'interface.customWelcome', value: 'Inactive' }]);
    await methods.toggleConfigActive(ROLE, 'USER', false);

    const body = (await getResolved(ROLE, 'USER')).body as AdminResolvedConfigResponse;
    expect(body.layers).toEqual([
      expect.objectContaining({ principalId: 'USER', isActive: false, ignored: [] }),
    ]);
    expect(body.resolved.interface?.customWelcome).toBe('Hello from YAML');
  });

  it('resolves a principal without a profile to Base, and 404s one that does not exist', async () => {
    await patch(ROLE, dataSchemas.BASE_CONFIG_PRINCIPAL_ID, [
      { fieldPath: 'interface.customWelcome', value: 'Base' },
    ]);
    const userId = await createUser('nobody@example.com');

    const existing = await getResolved(PrincipalType.USER, userId);
    expect(existing.statusCode).toBe(200);
    expect((existing.body as AdminResolvedConfigResponse).resolved.interface?.customWelcome).toBe(
      'Base',
    );

    const missing = await getResolved(
      PrincipalType.GROUP,
      new mongoose.Types.ObjectId().toString(),
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ error: 'Principal not found', code: 'PRINCIPAL_NOT_FOUND' });
  });

  it('never returns a stored or librechat.yaml secret', async () => {
    await patch(ROLE, dataSchemas.BASE_CONFIG_PRINCIPAL_ID, [
      { fieldPath: 'endpoints.custom', value: [{ name: 'Gateway', apiKey: BASE_KEY }] },
    ]);

    const res = await getResolved(ROLE, 'USER');
    const body = res.body as AdminResolvedConfigResponse;
    const text = JSON.stringify(body);

    expect(text).not.toContain(BASE_KEY);
    expect(text).not.toContain(YAML_KEY);
    expect(text).not.toContain('v3:');
    expect(body.yaml.endpoints?.custom?.[0]).toMatchObject({ apiKeyPreview: '********' });
    expect(body.resolved.endpoints?.custom?.[0]).toMatchObject({
      apiKeyPreview: expect.stringContaining('9876'),
    });
    expect(body.layers[0].overrides.endpoints?.custom?.[0]).not.toHaveProperty('apiKey');
  });

  it('shows no preview for a stored key the merge drops', async () => {
    await patch(ROLE, dataSchemas.BASE_CONFIG_PRINCIPAL_ID, [
      { fieldPath: 'endpoints.custom', value: [{ name: 'Gateway', apiKey: BASE_KEY }] },
    ]);
    await patch(ROLE, 'USER', [
      {
        fieldPath: 'endpoints.custom',
        value: [{ name: 'Gateway', baseURL: 'https://collector.example.com/v1' }],
      },
    ]);

    const body = (await getResolved(ROLE, 'USER')).body as AdminResolvedConfigResponse;

    expect(body.layers[0].overrides.endpoints?.custom?.[0]).toMatchObject({
      apiKeyPreview: expect.stringContaining('9876'),
    });
    const gateway = body.resolved.endpoints?.custom?.[0];
    expect(gateway).toMatchObject({ baseURL: 'https://collector.example.com/v1' });
    expect(gateway).not.toHaveProperty('apiKeyPreview');
    expect(body.layers[1].ignored).toEqual([
      expect.objectContaining({
        reason: 'secret_rebinding',
        path: 'endpoints.custom["Gateway"].apiKey',
      }),
    ]);
  });

  it('shows a section-scoped reader only the sections it can read, its ignored parts included', async () => {
    await patch(ROLE, 'USER', [
      { fieldPath: 'interface.customWelcome', value: 'Role' },
      { fieldPath: 'registration.socialLogins', value: ['google'] },
    ]);
    await mongoose.models.Config.updateOne(
      { principalType: ROLE, principalId: 'USER' },
      { $set: { 'overrides.paths': { uploads: '/tmp/x' } } },
    );

    const res = await getResolved(ROLE, 'USER', {
      getReadableConfigSections: async () => ({ broad: false, sections: new Set(['interface']) }),
    });
    const body = res.body as AdminResolvedConfigResponse;

    expect(Object.keys(body.yaml)).toEqual(['interface']);
    expect(Object.keys(body.resolved)).toEqual(['interface']);
    expect(Object.keys(body.layers[0].overrides)).toEqual(['interface']);
    expect(body.layers[0].ignored).toEqual([]);

    const broad = (await getResolved(ROLE, 'USER')).body as AdminResolvedConfigResponse;
    expect(broad.layers[0].ignored).toEqual([
      { path: 'paths', segments: ['paths'], reason: 'unknown_section' },
    ]);
  });

  it('answers 403 without config read access, and 400 for an unknown principal type', async () => {
    const forbidden = await getResolved(ROLE, 'USER', {
      hasAnyConfigReadAccess: async () => false,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body?.code).toBe('FORBIDDEN');
    const invalid = await getResolved('tenant', 'x');
    expect(invalid.statusCode).toBe(400);
  });

  it('answers 404 for a role of another tenant', async () => {
    await dataSchemas.tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      new mongoose.models.Role({ name: 'tenant-a-editors' }).save(),
    );
    const res = await dataSchemas.tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      getResolved(
        ROLE,
        'tenant-a-editors',
        {},
        {
          id: 'admin-b',
          role: 'ADMIN',
          tenantId: 'tenant-b',
        },
      ),
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /effective?userId=', () => {
  it('resolves a user over Base, their role and both groups, in merge order', async () => {
    await new mongoose.models.Role({ name: 'EDITOR' }).save();
    const userId = await createUser('member@example.com', 'EDITOR');
    const early = await createGroup('Early', [userId]);
    const late = await createGroup('Late', [userId]);
    await patch(ROLE, dataSchemas.BASE_CONFIG_PRINCIPAL_ID, [
      { fieldPath: 'interface.customWelcome', value: 'Base' },
    ]);
    await patch(ROLE, 'EDITOR', [{ fieldPath: 'interface.customWelcome', value: 'Editor' }]);
    await patch(
      PrincipalType.GROUP,
      early,
      [{ fieldPath: 'registration.socialLogins', value: ['early'] }],
      5,
    );
    await patch(
      PrincipalType.GROUP,
      late,
      [{ fieldPath: 'interface.customWelcome', value: 'Late group' }],
      30,
    );

    const res = await getEffective(userId);
    const body = res.body as AdminEffectiveConfigResponse;

    expect(res.statusCode).toBe(200);
    expect(body.userId).toBe(userId);
    expect(
      body.layers.map(({ principalType, principalId }) => [principalType, principalId]),
    ).toEqual([
      [ROLE, dataSchemas.BASE_CONFIG_PRINCIPAL_ID],
      [PrincipalType.GROUP, early],
      [ROLE, 'EDITOR'],
      [PrincipalType.GROUP, late],
    ]);
    expect(body.principals).toEqual(
      expect.arrayContaining([
        { principalType: PrincipalType.USER, principalId: userId },
        { principalType: ROLE, principalId: 'EDITOR' },
        { principalType: PrincipalType.GROUP, principalId: early },
        { principalType: PrincipalType.GROUP, principalId: late },
      ]),
    );
    expect(body.resolved.interface?.customWelcome).toBe('Late group');
    expect(body.resolved.registration?.socialLogins).toEqual(['early']);
  });

  it('needs read:users and read:groups besides config read access', async () => {
    const userId = await createUser('member@example.com');
    const withoutGroups = await getEffective(userId, {
      hasCapability: async (_user, capability: SystemCapability) => capability === 'read:users',
    });
    expect(withoutGroups.statusCode).toBe(403);
    expect(withoutGroups.body?.code).toBe('FORBIDDEN');
    const withoutConfigs = await getEffective(userId, {
      hasAnyConfigReadAccess: async () => false,
    });
    expect(withoutConfigs.statusCode).toBe(403);
    expect((await getEffective('')).statusCode).toBe(400);
  });

  it('answers 404 for a user who is not in the caller tenant', async () => {
    const userId = await dataSchemas.tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      createUser('a@example.com'),
    );
    const res = await dataSchemas.tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      getEffective(userId, {}, { id: 'admin-b', role: 'ADMIN', tenantId: 'tenant-b' }),
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'User not found', code: 'USER_NOT_FOUND' });
    expect((await getEffective(new mongoose.Types.ObjectId().toString())).statusCode).toBe(404);
  });
});
