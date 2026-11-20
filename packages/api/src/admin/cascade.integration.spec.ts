import { Keyv } from 'keyv';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

type DataSchemas = typeof import('@librechat/data-schemas');
type Methods = ReturnType<DataSchemas['createMethods']>;
type AdminGroupsDeps = Parameters<typeof import('./groups').createAdminGroupsHandlers>[0];
type AdminRolesDeps = Parameters<typeof import('./roles').createAdminRolesHandlers>[0];

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

/**
 * Deleting a group or role removes its config profile, and putting the profile back when the
 * deletion cannot finish restores it. Both are config changes, so merged configs cached before
 * them must not outlive them: the real config service, its in-memory cache and the cache
 * invalidation `api/server/services/Config/app.js` wires, over real collections.
 */

let mongoServer: MongoMemoryServer;
let methods: Methods;
let dataSchemas: DataSchemas;
let createAdminGroupsHandlers: typeof import('./groups').createAdminGroupsHandlers;
let createAdminRolesHandlers: typeof import('./roles').createAdminRolesHandlers;
let createAppConfigService: typeof import('~/app/service').createAppConfigService;
let createConfigCacheInvalidation: typeof import('~/app/invalidation').createConfigCacheInvalidation;

const LIFECYCLE_TIMEOUT_MS = 180_000;

beforeAll(async () => {
  const [schemas, groupsModule, rolesModule, serviceModule, invalidationModule, server] =
    await Promise.all([
      import('@librechat/data-schemas'),
      import('./groups'),
      import('./roles'),
      import('~/app/service'),
      import('~/app/invalidation'),
      MongoMemoryServer.create(),
    ]);
  dataSchemas = schemas;
  mongoServer = server;
  ({ createAdminGroupsHandlers } = groupsModule);
  ({ createAdminRolesHandlers } = rolesModule);
  ({ createAppConfigService } = serviceModule);
  ({ createConfigCacheInvalidation } = invalidationModule);
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
    ['Config', 'Group', 'Role', 'User', 'AclEntry', 'SystemGrant'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
});

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

function adminRequest(params: Record<string, string>): ServerRequest {
  return {
    params,
    body: {},
    query: {},
    user: { id: 'admin', role: 'ADMIN' },
  } as Partial<ServerRequest> as ServerRequest;
}

/**
 * The config service with an in-memory cache, and the invalidation the Config service wires over
 * it (spied on, so a test can wait for or hold one).
 */
function createConfigCaches() {
  const keyv = new Keyv({ namespace: 'APP_CONFIG' });
  const entries = keyv.opts.store as Map<string, unknown>;
  /** Keyv's in-memory store, with the key listing the override cache clears by. */
  const cache = {
    get: (key: string) => keyv.get(key),
    set: (key: string, value: unknown, ttl?: number) => keyv.set(key, value, ttl),
    delete: (key: string) => keyv.delete(key),
    opts: { store: { keys: () => entries.keys() } },
  };
  const service = createAppConfigService({
    loadBaseConfig: () => dataSchemas.AppService({ config: {} }),
    setCachedTools: async () => undefined,
    getCache: () => cache,
    cacheKeys: { APP_CONFIG: 'APP_CONFIG' },
    getApplicableConfigs: methods.getApplicableConfigs,
    getUserPrincipals: methods.getUserPrincipals,
  });
  const invalidation = createConfigCacheInvalidation({
    clears: [
      { label: 'clearAppConfigCache', clear: () => service.clearAppConfigCache() },
      { label: 'clearOverrideCache', clear: service.clearOverrideCache },
    ],
  });
  return {
    getAppConfig: service.getAppConfig,
    invalidateConfigCaches: jest.fn((tenantId?: string) => invalidation.invalidate(tenantId)),
  };
}

const welcomeOf = (config: AppConfig): string | undefined =>
  config.interfaceConfig?.customWelcome as string | undefined;

function groupHandlers(overrides: Partial<AdminGroupsDeps>) {
  return createAdminGroupsHandlers({
    listGroups: jest.fn(),
    countGroups: jest.fn(),
    findGroupById: methods.findGroupById,
    createGroup: methods.createGroup,
    updateGroupFieldsTracked: methods.updateGroupFieldsTracked,
    deleteGroup: methods.deleteGroup,
    addUserToGroup: methods.addUserToGroup,
    removeUserFromGroup: methods.removeUserFromGroup,
    removeMemberByIdTracked: methods.removeMemberByIdTracked,
    findUsers: methods.findUsers,
    deleteConfig: methods.deleteConfig,
    deleteAclEntries: methods.deleteAclEntries,
    restoreConfig: methods.restoreConfig,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    ...overrides,
  });
}

function roleHandlers(overrides: Partial<AdminRolesDeps>) {
  return createAdminRolesHandlers({
    listRoles: methods.listRoles,
    countRoles: methods.countRoles,
    getRoleByName: methods.getPartitionRole,
    createRoleByName: methods.createRoleByName,
    updateRoleByName: methods.updateRoleByName,
    updateAccessPermissions: methods.updateAccessPermissions,
    deleteRoleByName: methods.deleteRoleByName,
    findUser: methods.findUser,
    updateUser: methods.updateUser,
    updateUsersByRole: methods.updateUsersByRole,
    findUserIdsByRole: methods.findUserIdsByRole,
    updateUsersRoleByIds: methods.updateUsersRoleByIds,
    listUsersByRole: methods.listUsersByRole,
    countUsersByRole: methods.countUsersByRole,
    deleteConfig: methods.deleteConfig,
    deleteAclEntries: methods.deletePrincipalAclEntries,
    deleteGrantsForPrincipal: methods.deleteGrantsForPrincipal,
    restoreConfig: methods.restoreConfig,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    findGrantsForPrincipal: methods.findGrantsForPrincipal,
    ...overrides,
  });
}

/** A member of a group whose profile sets the welcome text, and that group's id. */
async function memberOfProfiledGroup(): Promise<{ userId: string; groupId: string }> {
  const userId = (
    await methods.createUser(
      { email: 'member@example.com', name: 'Member', provider: 'local', role: 'USER' },
      undefined,
      true,
    )
  ).toString();
  const group = await methods.createGroup({
    name: 'Engineering',
    source: 'local',
    memberIds: [userId],
  });
  const groupId = group._id.toString();
  await methods.upsertConfig(
    PrincipalType.GROUP,
    groupId,
    PrincipalModel.GROUP,
    { interface: { customWelcome: 'group welcome' } },
    20,
  );
  return { userId, groupId };
}

describe('deleting a principal clears the merged configs its profile reached', () => {
  it('stops serving a deleted group’s profile to its members, before the response', async () => {
    const caches = createConfigCaches();
    const { userId, groupId } = await memberOfProfiledGroup();
    const read = () => caches.getAppConfig({ userId, role: 'USER' });
    expect(welcomeOf(await read())).toBe('group welcome');

    const res = mockRes();
    await groupHandlers({ invalidateConfigCaches: caches.invalidateConfigCaches }).deleteGroup(
      adminRequest({ id: groupId }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(caches.invalidateConfigCaches).toHaveBeenCalledWith(undefined);
    expect(welcomeOf(await read())).toBeUndefined();
  });

  it('serves a group’s profile again once a deletion that cannot finish puts it back', async () => {
    const caches = createConfigCaches();
    const { userId, groupId } = await memberOfProfiledGroup();
    const read = () => caches.getAppConfig({ userId, role: 'USER' });
    expect(welcomeOf(await read())).toBe('group welcome');
    let profileRemoved: () => void = () => undefined;
    const removed = new Promise<void>((resolve) => (profileRemoved = resolve));
    const invalidateConfigCaches = jest.fn(async (tenantId?: string) => {
      await caches.invalidateConfigCaches(tenantId);
      profileRemoved();
    });

    const res = mockRes();
    await groupHandlers({
      invalidateConfigCaches,
      /** A member's request lands while the profile is gone, then the ACL removal fails. */
      deleteAclEntries: async () => {
        await Promise.race([removed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        expect(welcomeOf(await read())).toBeUndefined();
        throw new Error('acl store down');
      },
    }).deleteGroup(adminRequest({ id: groupId }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body?.code).toBe('GROUP_CLEANUP_FAILED');
    expect(await methods.findConfigByPrincipal(PrincipalType.GROUP, groupId)).not.toBeNull();
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(2);
    expect(welcomeOf(await read())).toBe('group welcome');
  });

  it('leaves the caches alone when the group had no profile', async () => {
    const caches = createConfigCaches();
    const group = await methods.createGroup({ name: 'Plain', source: 'local' });

    const res = mockRes();
    await groupHandlers({ invalidateConfigCaches: caches.invalidateConfigCaches }).deleteGroup(
      adminRequest({ id: group._id.toString() }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(caches.invalidateConfigCaches).not.toHaveBeenCalled();
  });

  it('stops serving a deleted role’s profile, before the response', async () => {
    const caches = createConfigCaches();
    await methods.createRoleByName({ name: 'editor', permissions: {} });
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'editor',
      PrincipalModel.ROLE,
      { interface: { customWelcome: 'editor welcome' } },
      10,
    );
    /** A request whose cached user still names the role, as one can until its user is reloaded. */
    const read = () => caches.getAppConfig({ role: 'editor' });
    expect(welcomeOf(await read())).toBe('editor welcome');

    let release: () => void = () => undefined;
    const invalidateConfigCaches = jest.fn(async (tenantId?: string) => {
      await new Promise<void>((resolve) => (release = resolve));
      await caches.invalidateConfigCaches(tenantId);
    });
    const res = mockRes();
    const deleting = roleHandlers({ invalidateConfigCaches }).deleteRole(
      adminRequest({ name: 'editor' }),
      res,
    );
    while (invalidateConfigCaches.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    /** The response waits for the invalidation. */
    expect(res.status).not.toHaveBeenCalled();
    release();
    await deleting;

    expect(res.statusCode).toBe(200);
    expect(await methods.findConfigByPrincipal(PrincipalType.ROLE, 'editor')).toBeNull();
    expect(welcomeOf(await read())).toBeUndefined();
  });

  it('serves a role’s profile again once a deletion that cannot finish puts it back', async () => {
    const caches = createConfigCaches();
    await methods.createRoleByName({ name: 'editor', permissions: {} });
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'editor',
      PrincipalModel.ROLE,
      { interface: { customWelcome: 'editor welcome' } },
      10,
    );
    const read = () => caches.getAppConfig({ role: 'editor' });
    expect(welcomeOf(await read())).toBe('editor welcome');
    let profileRemoved: () => void = () => undefined;
    const removed = new Promise<void>((resolve) => (profileRemoved = resolve));
    const invalidateConfigCaches = jest.fn(async (tenantId?: string) => {
      await caches.invalidateConfigCaches(tenantId);
      profileRemoved();
    });

    const res = mockRes();
    await roleHandlers({
      invalidateConfigCaches,
      /** A request lands while the profile is gone, then the grant removal fails. */
      deleteGrantsForPrincipal: async () => {
        await Promise.race([removed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        expect(welcomeOf(await read())).toBeUndefined();
        throw new Error('grant store down');
      },
    }).deleteRole(adminRequest({ name: 'editor' }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body?.code).toBe('ROLE_CLEANUP_FAILED');
    expect(await methods.findConfigByPrincipal(PrincipalType.ROLE, 'editor')).not.toBeNull();
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(2);
    expect(welcomeOf(await read())).toBe('editor welcome');
  });
});
