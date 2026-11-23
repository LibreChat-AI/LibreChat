import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  PrincipalType,
  PrincipalModel,
  ResourceType,
  PermissionBits,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

type DataSchemas = typeof import('@librechat/data-schemas');
type Methods = ReturnType<DataSchemas['createMethods']>;
type AdminRolesDeps = Parameters<typeof import('./roles').createAdminRolesHandlers>[0];

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

/**
 * Role rename on real collections (BE-20): the config profile, system grants and ACL entries
 * keyed by the role's name move with it, and a rename that cannot finish leaves everything as
 * it was.
 */

let mongoServer: MongoMemoryServer;
let methods: Methods;
let dataSchemas: DataSchemas;
let createAdminRolesHandlers: typeof import('./roles').createAdminRolesHandlers;

const LIFECYCLE_TIMEOUT_MS = 180_000;

beforeAll(async () => {
  const [schemas, rolesModule, server] = await Promise.all([
    import('@librechat/data-schemas'),
    import('./roles'),
    MongoMemoryServer.create(),
  ]);
  dataSchemas = schemas;
  mongoServer = server;
  ({ createAdminRolesHandlers } = rolesModule);
  jest.spyOn(schemas.logger, 'error').mockReturnValue(schemas.logger);
  jest.spyOn(schemas.logger, 'warn').mockReturnValue(schemas.logger);
  jest.spyOn(schemas.logger, 'info').mockReturnValue(schemas.logger);

  await mongoose.connect(mongoServer.getUri());
  schemas.createModels(mongoose);
  await Promise.all(['Config', 'SystemGrant'].map((name) => mongoose.models[name].init()));
  methods = schemas.createMethods(mongoose);
}, LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, LIFECYCLE_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    ['Config', 'Role', 'User', 'SystemGrant', 'AclEntry'].map((name) =>
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

/** Handlers wired the way `api/server/routes/admin/roles.js` wires them. */
function createHandlers(overrides: Partial<AdminRolesDeps> = {}) {
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
    renameConfigPrincipal: methods.renameConfigPrincipal,
    moveGrantsToPrincipal: methods.moveGrantsToPrincipal,
    restoreMovedGrants: methods.restoreMovedGrants,
    moveAclEntriesToPrincipal: methods.moveAclEntriesToPrincipal,
    ...overrides,
  });
}

/** Runs `run` in a tenant's context, as the tenant middleware does for that tenant's requests. */
function inTenant<T>(tenantId: string, run: () => Promise<T>): Promise<T> {
  return dataSchemas.tenantStorage.run({ tenantId }, run);
}

/** Renames as an admin without a tenant, or as one of `tenantId` inside its context. */
async function rename(
  handlers: ReturnType<typeof createHandlers>,
  from: string,
  body: Record<string, unknown>,
  tenantId?: string,
): Promise<MockRes> {
  const res = mockRes();
  const req = {
    params: { name: from },
    body,
    query: {},
    user: { _id: new Types.ObjectId(), id: 'admin', role: 'ADMIN', tenantId },
  } as Partial<ServerRequest> as ServerRequest;
  const run = () => handlers.updateRole(req, res);
  await (tenantId ? inTenant(tenantId, run) : run());
  return res;
}

/** Every stored role profile as `tenant/name: welcome`, platform-level ones as `-/name: …`. */
async function profileLayout(): Promise<string[]> {
  const documents = await mongoose.connection
    .db!.collection('configs')
    .find({ principalType: PrincipalType.ROLE })
    .toArray();
  return documents
    .map(
      (document) =>
        `${document.tenantId || '-'}/${document.principalId}: ${document.overrides?.interface?.customWelcome}`,
    )
    .sort();
}

/** Every stored role grant as `tenant/name: capability`, platform-level ones as `-/name: …`. */
async function grantLayout(): Promise<string[]> {
  const grants = await mongoose.models.SystemGrant.find({ principalType: PrincipalType.ROLE })
    .select('principalId capability tenantId')
    .lean<Array<{ principalId: string; capability: string; tenantId?: string }>>();
  return grants
    .map((grant) => `${grant.tenantId || '-'}/${grant.principalId}: ${grant.capability}`)
    .sort();
}

const setWelcome = (name: string, welcome: string) =>
  methods.patchConfigFields(PrincipalType.ROLE, name, PrincipalModel.ROLE, {
    'interface.customWelcome': welcome,
  });

/** A role with a member, a config profile, a grant and an ACL entry, all keyed by its name. */
async function seedRole(name: string, description = 'Writes things') {
  await methods.createRoleByName({ name, description, permissions: {} });
  const userId = await methods.createUser(
    { email: `${name}@example.com`, name, provider: 'local', role: name },
    undefined,
    true,
  );
  await methods.patchConfigFields(PrincipalType.ROLE, name, PrincipalModel.ROLE, {
    'interface.customWelcome': `hello ${name}`,
  });
  await methods.setConfigPriority(PrincipalType.ROLE, name, 15);
  await methods.grantCapability({
    principalType: PrincipalType.ROLE,
    principalId: name,
    capability: dataSchemas.SystemCapabilities.READ_USERS,
  });
  const resourceId = new Types.ObjectId();
  await methods.grantPermission(
    PrincipalType.ROLE,
    name,
    ResourceType.AGENT,
    resourceId,
    PermissionBits.VIEW,
  );
  return { userId: userId.toString(), resourceId };
}

/**
 * Everything keyed by `name` in the active tenant partition (platform-level outside a tenant):
 * its role document, members, profile, grants and ACL entries.
 */
async function keyedBy(name: string) {
  const tenantId = dataSchemas.getTenantId();
  const [role, members, profile, grants, aclEntries] = await Promise.all([
    methods.getPartitionRole(name),
    methods.findUserIdsByRole(name),
    methods.findConfigByPrincipal(PrincipalType.ROLE, name, { includeInactive: true }),
    methods.findGrantsForPrincipal(PrincipalType.ROLE, name, { tenantId }),
    mongoose.models.AclEntry.find({
      principalType: PrincipalType.ROLE,
      principalId: name,
      tenantId: tenantId ?? { $in: [null, ''] },
    })
      .select('resourceId')
      .lean<Array<{ resourceId: Types.ObjectId }>>(),
  ]);
  return {
    role: role ? { name: role.name, description: role.description } : null,
    members,
    profile: profile
      ? { overrides: profile.overrides, priority: profile.priority, isActive: profile.isActive }
      : null,
    grants: grants.map((grant) => grant.capability),
    aclEntries: aclEntries.map((entry) => entry.resourceId.toString()),
  };
}

const nothing = { role: null, members: [], profile: null, grants: [], aclEntries: [] };

describe('role rename moves what is keyed by the role name', () => {
  it('moves the profile, grants and ACL entries with the role and its members', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const invalidateConfigCaches = jest.fn().mockResolvedValue(undefined);
    const invalidatePromptGroupAccessContext = jest.fn().mockResolvedValue(undefined);
    const handlers = createHandlers({
      recordAuditEntry,
      invalidateConfigCaches,
      invalidatePromptGroupAccessContext,
    });
    const { userId, resourceId } = await seedRole('editor');
    const before = await keyedBy('editor');

    const res = await rename(handlers, 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(200);
    expect(await keyedBy('editor')).toEqual(nothing);
    expect(await keyedBy('writer')).toEqual({
      ...before,
      role: { name: 'writer', description: 'Writes things' },
      members: [userId],
      aclEntries: [resourceId.toString()],
    });
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(1);
    expect(invalidatePromptGroupAccessContext).toHaveBeenCalledTimes(1);
    expect(recordAuditEntry.mock.calls.map(([entry]) => [entry.action, entry.target.id])).toEqual([
      ['role.updated', 'writer'],
      ['config.deleted', 'role:editor'],
      ['config.created', 'role:writer'],
    ]);
    expect(recordAuditEntry.mock.calls.map(([entry]) => entry.metadata)).toEqual([
      {
        previousName: 'editor',
        descriptionChanged: false,
        configMoved: true,
        grantsMoved: 1,
        grantCapabilities: dataSchemas.SystemCapabilities.READ_USERS,
        aclEntriesMoved: 1,
      },
      { cause: 'role_renamed', movedTo: 'role:writer' },
      { operation: 'move', cause: 'role_renamed', movedFrom: 'role:editor', priority: 15 },
    ]);
  });

  it('renames a role without a profile, grants or ACL entries, auditing no config move', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const handlers = createHandlers({ recordAuditEntry });
    await methods.createRoleByName({ name: 'plain', permissions: {} });

    const res = await rename(handlers, 'plain', { name: 'simple' });

    expect(res.statusCode).toBe(200);
    expect((await keyedBy('simple')).role?.name).toBe('simple');
    expect((await keyedBy('plain')).role).toBeNull();
    expect(recordAuditEntry.mock.calls.map(([entry]) => entry.action)).toEqual(['role.updated']);
  });

  it('refuses with 409 before changing anything when the new name already has a profile', async () => {
    const handlers = createHandlers();
    await seedRole('editor');
    await methods.patchConfigFields(PrincipalType.ROLE, 'writer', PrincipalModel.ROLE, {
      'interface.customWelcome': 'orphaned',
    });
    const before = await keyedBy('editor');

    const res = await rename(handlers, 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'A config profile already exists for role "writer"',
      code: 'ROLE_CONFIG_CONFLICT',
    });
    expect(await keyedBy('editor')).toEqual(before);
    expect((await keyedBy('writer')).profile?.overrides).toEqual({
      interface: { customWelcome: 'orphaned' },
    });
  });

  it('rolls everything back with 409 when a profile for the new name appears mid-rename', async () => {
    await seedRole('editor');
    const before = await keyedBy('editor');
    /** The profile lands after the pre-check, between the role update and the profile move. */
    const handlers = createHandlers({
      renameConfigPrincipal: async (principalType, from, to) => {
        await methods.patchConfigFields(principalType, to, PrincipalModel.ROLE, {
          'interface.customWelcome': 'racer',
        });
        return methods.renameConfigPrincipal(principalType, from, to);
      },
    });

    const res = await rename(handlers, 'editor', { name: 'writer', description: 'Renamed' });

    expect(res.statusCode).toBe(409);
    expect(res.body?.code).toBe('ROLE_CONFIG_CONFLICT');
    expect(await keyedBy('editor')).toEqual(before);
    const writer = await keyedBy('writer');
    expect(writer.role).toBeNull();
    expect(writer.grants).toEqual([]);
    expect(writer.aclEntries).toEqual([]);
  });

  it('reports a profile move that kept losing races as a failed rename, not a conflict', async () => {
    await seedRole('editor');
    const before = await keyedBy('editor');
    const handlers = createHandlers({
      renameConfigPrincipal: async () => {
        throw new dataSchemas.ConfigRevisionConflictError();
      },
    });

    const res = await rename(handlers, 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(500);
    expect(res.body?.code).toBe('ROLE_RENAME_FAILED');
    expect(await keyedBy('editor')).toEqual(before);
    expect(await keyedBy('writer')).toEqual(nothing);
  });

  it('undoes the ACL move without taking the entries the new name already had', async () => {
    await seedRole('editor');
    const writerResource = new Types.ObjectId();
    await methods.grantPermission(
      PrincipalType.ROLE,
      'writer',
      ResourceType.AGENT,
      writerResource,
      PermissionBits.EDIT,
    );
    const before = await keyedBy('editor');
    const handlers = createHandlers({
      moveGrantsToPrincipal: async () => {
        throw new Error('grant write failed');
      },
    });

    const res = await rename(handlers, 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(500);
    expect(res.body?.code).toBe('ROLE_RENAME_FAILED');
    expect(await keyedBy('editor')).toEqual(before);
    expect(await keyedBy('writer')).toEqual({
      ...nothing,
      aclEntries: [writerResource.toString()],
    });
  });

  it('rolls everything back when moving a dependent fails', async () => {
    const invalidateConfigCaches = jest.fn().mockResolvedValue(undefined);
    await seedRole('editor');
    const before = await keyedBy('editor');
    const handlers = createHandlers({
      invalidateConfigCaches,
      moveAclEntriesToPrincipal: async () => {
        throw new Error('acl write failed');
      },
    });

    const res = await rename(handlers, 'editor', { name: 'writer', description: 'Renamed' });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to move the role profile, grants or permissions; the role was not renamed',
      code: 'ROLE_RENAME_FAILED',
    });
    expect(await keyedBy('editor')).toEqual(before);
    expect(await keyedBy('writer')).toEqual(nothing);
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(1);
  });

  it('takes back the new description of a role stored without one when the rename rolls back', async () => {
    await mongoose.models.Role.collection.insertOne({ name: 'legacy', permissions: {} });
    expect((await keyedBy('legacy')).role).toEqual({ name: 'legacy', description: undefined });
    const handlers = createHandlers({
      moveAclEntriesToPrincipal: async () => {
        throw new Error('acl write failed');
      },
    });

    const res = await rename(handlers, 'legacy', { name: 'modern', description: 'Renamed' });

    expect(res.statusCode).toBe(500);
    expect(res.body?.code).toBe('ROLE_RENAME_FAILED');
    expect((await keyedBy('legacy')).role).toEqual({ name: 'legacy', description: '' });
    expect((await keyedBy('modern')).role).toBeNull();
  });
});

describe('a rename that rolls back undoes only what it changed', () => {
  /** The ACL move fails; every other move still finishes before the rollback starts. */
  const failingAclMove = async (): Promise<string[]> => {
    throw new Error('acl write failed');
  };
  const failAcl = (meanwhile: () => Promise<unknown>) =>
    createHandlers({
      moveAclEntriesToPrincipal: async () => {
        await meanwhile();
        return failingAclMove();
      },
    });

  it('never re-creates a moved grant that another admin revoked before the rollback', async () => {
    await seedRole('editor');
    await methods.grantCapability({
      principalType: PrincipalType.ROLE,
      principalId: 'editor',
      capability: dataSchemas.SystemCapabilities.READ_CONFIGS,
    });
    /** The grants move, then another admin revokes one of them from the role's new name. */
    const handlers = createHandlers({
      moveGrantsToPrincipal: async (...args) => {
        const move = await methods.moveGrantsToPrincipal(...args);
        await methods.revokeCapability({
          principalType: PrincipalType.ROLE,
          principalId: 'writer',
          capability: dataSchemas.SystemCapabilities.READ_USERS,
        });
        return move;
      },
      moveAclEntriesToPrincipal: failingAclMove,
    });

    const res = await rename(handlers, 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(500);
    expect(res.body?.code).toBe('ROLE_RENAME_FAILED');
    expect(await grantLayout()).toEqual([
      `-/editor: ${dataSchemas.SystemCapabilities.READ_CONFIGS}`,
    ]);
  });

  it('moves back only the profile it moved, never one another admin put at the new name', async () => {
    await seedRole('editor');
    /** Another admin removes the moved profile and writes one of their own for the new name. */
    const handlers = createHandlers({
      renameConfigPrincipal: async (principalType, from, to, options) => {
        const moved = await methods.renameConfigPrincipal(principalType, from, to, options);
        if (!options) {
          await methods.deleteConfig(principalType, to);
          await setWelcome(to, 'theirs');
        }
        return moved;
      },
      moveAclEntriesToPrincipal: failingAclMove,
    });

    const res = await rename(handlers, 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(500);
    expect((await keyedBy('editor')).role?.name).toBe('editor');
    expect(await profileLayout()).toEqual(['-/writer: theirs']);
  });

  it('brings the moved profile back with an edit made to it meanwhile', async () => {
    await seedRole('editor');
    const handlers = createHandlers({
      renameConfigPrincipal: async (principalType, from, to, options) => {
        const moved = await methods.renameConfigPrincipal(principalType, from, to, options);
        if (!options) {
          await setWelcome(to, 'edited');
        }
        return moved;
      },
      moveAclEntriesToPrincipal: failingAclMove,
    });

    const res = await rename(handlers, 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(500);
    expect(await profileLayout()).toEqual(['-/editor: edited']);
    expect((await keyedBy('editor')).profile?.priority).toBe(15);
  });

  it('leaves a member another admin reassigned during the rename on their new role', async () => {
    const { userId } = await seedRole('editor');
    const otherId = await methods.createUser(
      { email: 'second@example.com', name: 'second', provider: 'local', role: 'editor' },
      undefined,
      true,
    );
    const handlers = failAcl(() => methods.updateUser(userId, { role: 'REVIEWER' }));

    const res = await rename(handlers, 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(500);
    expect((await keyedBy('editor')).members).toEqual([otherId.toString()]);
    expect(await methods.findUserIdsByRole('REVIEWER')).toEqual([userId]);
    expect(await methods.findUserIdsByRole('writer')).toEqual([]);
  });

  it('keeps a description another admin set during the rename', async () => {
    await seedRole('editor');
    const handlers = failAcl(() =>
      methods.updateRoleByName('writer', { description: 'Edited meanwhile' }),
    );

    const res = await rename(handlers, 'editor', { name: 'writer', description: 'Renamed' });

    expect(res.statusCode).toBe(500);
    expect((await keyedBy('editor')).role).toEqual({
      name: 'editor',
      description: 'Edited meanwhile',
    });
  });

  it('finishes the rename when the profile copy committed but its acknowledgement was lost', async () => {
    await seedRole('editor');
    const collection = mongoose.models.Config.collection;
    const findOneAndUpdate = collection.findOneAndUpdate.bind(collection);
    jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce((async (
      ...args: Parameters<typeof findOneAndUpdate>
    ) => {
      await findOneAndUpdate(...args);
      throw new mongoose.mongo.MongoNetworkError('connection reset after the write applied');
    }) as unknown as typeof collection.findOneAndUpdate);

    const res = await rename(createHandlers(), 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(200);
    expect(await profileLayout()).toEqual(['-/writer: hello editor']);
    expect((await keyedBy('writer')).profile?.priority).toBe(15);
  });
});

describe('role names never reach the Base config document', () => {
  const BASE = '__base__';

  async function seedBase(customWelcome: string) {
    await methods.patchConfigFields(PrincipalType.ROLE, BASE, PrincipalModel.ROLE, {
      'interface.customWelcome': customWelcome,
    });
    return methods.findConfigByPrincipal(PrincipalType.ROLE, BASE, { includeInactive: true });
  }

  function request(params: Record<string, string>, body: Record<string, unknown> = {}) {
    return {
      params,
      body,
      query: {},
      user: { _id: new Types.ObjectId(), id: 'admin', role: 'ADMIN' },
    } as Partial<ServerRequest> as ServerRequest;
  }

  it('refuses to create a role named after the Base principal', async () => {
    const res = mockRes();

    await createHandlers().createRole(request({}, { name: BASE }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'name is reserved for the base config',
      code: 'ROLE_NAME_RESERVED',
    });
    expect(await methods.getRoleByName(BASE)).toBeNull();
  });

  it('refuses to rename a role onto the Base principal, so its profile never becomes Base', async () => {
    await seedRole('promoted');
    const before = await keyedBy('promoted');

    const res = await rename(createHandlers(), 'promoted', { name: BASE });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'name is reserved for the base config',
      code: 'ROLE_NAME_RESERVED',
    });
    expect(await keyedBy('promoted')).toEqual(before);
    expect(await methods.findConfigByPrincipal(PrincipalType.ROLE, BASE)).toBeNull();
  });

  it('renames a role that already had the name without moving Base off it', async () => {
    const base = await seedBase('everyone');
    await methods.createRoleByName({ name: BASE, permissions: {} });
    await methods.grantCapability({
      principalType: PrincipalType.ROLE,
      principalId: BASE,
      capability: dataSchemas.SystemCapabilities.READ_USERS,
    });

    const res = await rename(createHandlers(), BASE, { name: 'legacy' });

    expect(res.statusCode).toBe(200);
    expect(await methods.findConfigByPrincipal(PrincipalType.ROLE, BASE)).toEqual(base);
    const legacy = await keyedBy('legacy');
    expect(legacy.role?.name).toBe('legacy');
    expect(legacy.profile).toBeNull();
    expect(legacy.grants).toEqual([dataSchemas.SystemCapabilities.READ_USERS]);
  });

  it('deletes a role that already had the name without deleting Base', async () => {
    const base = await seedBase('everyone');
    await methods.createRoleByName({ name: BASE, permissions: {} });
    const res = mockRes();

    await createHandlers().deleteRole(request({ name: BASE }), res);

    expect(res.statusCode).toBe(200);
    expect(await methods.getRoleByName(BASE)).toBeNull();
    expect(await methods.findConfigByPrincipal(PrincipalType.ROLE, BASE)).toEqual(base);
  });
});

describe('role rename without a tenant', () => {
  it('moves platform-level grants and ACL entries only, never a tenant role of the same name', async () => {
    await seedRole('editor');
    await dataSchemas.tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
        capability: dataSchemas.SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-a',
      });
      await methods.grantPermission(
        PrincipalType.ROLE,
        'editor',
        ResourceType.AGENT,
        new Types.ObjectId(),
        PermissionBits.VIEW,
      );
    });
    const tenantKeyed = () =>
      dataSchemas.tenantStorage.run({ tenantId: 'tenant-a' }, async () => ({
        grants: (
          await methods.findGrantsForPrincipal(PrincipalType.ROLE, 'editor', {
            tenantId: 'tenant-a',
          })
        ).map((grant) => grant.capability),
        aclEntries: await mongoose.models.AclEntry.countDocuments({
          principalType: PrincipalType.ROLE,
          principalId: 'editor',
        }),
      }));
    const tenantBefore = await tenantKeyed();

    const res = await rename(createHandlers(), 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(200);
    expect(tenantBefore).toEqual({
      grants: [dataSchemas.SystemCapabilities.READ_CONFIGS],
      aclEntries: 1,
    });
    expect(await tenantKeyed()).toEqual(tenantBefore);
    const writer = await keyedBy('writer');
    expect(writer.grants).toEqual([dataSchemas.SystemCapabilities.READ_USERS]);
    expect(writer.aclEntries).toHaveLength(1);
  });

  it("leaves a tenant role's profile in its tenant when the platform role has none", async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    await methods.createRoleByName({ name: 'editor', permissions: {} });
    await inTenant('tenant-a', async () => {
      await methods.createRoleByName({ name: 'editor', permissions: {} });
      await setWelcome('editor', 'tenant-a');
    });

    const res = await rename(createHandlers({ recordAuditEntry }), 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(200);
    expect(await profileLayout()).toEqual(['tenant-a/editor: tenant-a']);
    expect(recordAuditEntry.mock.calls.map(([entry]) => entry.action)).toEqual(['role.updated']);
    expect(recordAuditEntry.mock.calls[0][0].metadata.configMoved).toBe(false);
  });

  it('moves the platform profile and is not refused by a tenant profile at the new name', async () => {
    await seedRole('editor');
    await inTenant('tenant-a', () => setWelcome('writer', 'tenant-a'));

    const res = await rename(createHandlers(), 'editor', { name: 'writer' });

    expect(res.statusCode).toBe(200);
    expect(await profileLayout()).toEqual(['-/writer: hello editor', 'tenant-a/writer: tenant-a']);
  });
});

describe('role operations without a tenant keep to the platform role', () => {
  /** A tenant-a role of `name` with one member, created in that tenant. */
  async function seedTenantRole(name: string, description: string): Promise<string> {
    return inTenant('tenant-a', async () => {
      await methods.createRoleByName({ name, description, permissions: {} });
      const userId = await methods.createUser(
        { email: `tenant-${name}@example.com`, name, provider: 'local', role: name },
        undefined,
        true,
      );
      await setWelcome(name, `tenant ${name}`);
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: name,
        capability: dataSchemas.SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-a',
      });
      await methods.grantPermission(
        PrincipalType.ROLE,
        name,
        ResourceType.AGENT,
        new Types.ObjectId(),
        PermissionBits.VIEW,
      );
      return userId.toString();
    });
  }

  /** What tenant-a holds for `name`, read in that tenant. */
  const tenantKeyedBy = (name: string) => inTenant('tenant-a', () => keyedBy(name));

  async function remove(name: string, tenantId?: string): Promise<MockRes> {
    const res = mockRes();
    const req = {
      params: { name },
      body: {},
      query: {},
      user: { _id: new Types.ObjectId(), id: 'admin', role: 'ADMIN', tenantId },
    } as Partial<ServerRequest> as ServerRequest;
    const run = () => createHandlers().deleteRole(req, res);
    await (tenantId ? inTenant(tenantId, run) : run());
    return res;
  }

  it("migrates and renames only the platform role and its members, never a tenant's role", async () => {
    const { userId } = await seedRole('editor');
    const tenantUserId = await seedTenantRole('editor', 'Tenant editors');
    const tenantBefore = await tenantKeyedBy('editor');

    const res = await rename(createHandlers(), 'editor', { name: 'writer', description: 'New' });

    expect(res.statusCode).toBe(200);
    expect(await keyedBy('writer')).toMatchObject({
      role: { name: 'writer', description: 'New' },
      members: [userId],
    });
    expect(tenantBefore.members).toEqual([tenantUserId]);
    expect(await tenantKeyedBy('editor')).toEqual(tenantBefore);
    expect(await inTenant('tenant-a', () => keyedBy('writer'))).toEqual(nothing);
  });

  it("serves a platform role created or renamed after a tenant's role of its name to the platform's permission checks", async () => {
    await seedTenantRole('editor', 'Tenant editors');
    await seedTenantRole('tenant-only', 'Tenant only');
    await seedRole('writer');
    const params: Record<string, string> = {};
    const body: Record<string, unknown> = { name: 'editor', description: 'Platform editors' };
    const created = mockRes();
    await createHandlers().createRole(
      {
        params,
        body,
        query: {},
        user: { _id: new Types.ObjectId(), id: 'admin', role: 'ADMIN' },
      } as Partial<ServerRequest> as ServerRequest,
      created,
    );
    const renamed = await rename(createHandlers(), 'writer', { name: 'tenant-only' });
    /** `getRoleByName` as every request's permission checks read it, with no cached role. */
    const served = async (name: string) => (await methods.getRoleByName(name))?.description;

    expect(created.statusCode).toBe(201);
    expect(renamed.statusCode).toBe(200);
    expect(await served('editor')).toBe('Platform editors');
    expect(await served('tenant-only')).toBe('Writes things');
    expect(await inTenant('tenant-a', () => served('editor'))).toBe('Tenant editors');
    expect(await inTenant('tenant-a', () => served('tenant-only'))).toBe('Tenant only');
  });

  it('answers 404 for a role only a tenant holds, renaming nothing in that tenant', async () => {
    await seedTenantRole('tenant-editor', 'Tenant only');
    const before = await tenantKeyedBy('tenant-editor');

    const res = await rename(createHandlers(), 'tenant-editor', { name: 'renamed' });

    expect(res.statusCode).toBe(404);
    expect(await tenantKeyedBy('tenant-editor')).toEqual(before);
    expect(await inTenant('tenant-a', () => keyedBy('renamed'))).toEqual(nothing);
  });

  it("deletes only the platform role and what it holds, never a tenant role's members, grants or ACL entries", async () => {
    await seedRole('editor');
    await seedTenantRole('editor', 'Tenant editors');
    const tenantBefore = await tenantKeyedBy('editor');

    const res = await remove('editor');

    expect(res.statusCode).toBe(200);
    expect(await keyedBy('editor')).toEqual(nothing);
    expect(await tenantKeyedBy('editor')).toEqual(tenantBefore);
    expect(tenantBefore).toMatchObject({
      role: { name: 'editor', description: 'Tenant editors' },
      grants: [dataSchemas.SystemCapabilities.READ_CONFIGS],
      aclEntries: [expect.any(String)],
    });
  });

  it('answers 404 for a deletion of a role only a tenant holds, removing nothing there', async () => {
    await seedTenantRole('tenant-editor', 'Tenant only');
    const before = await tenantKeyedBy('tenant-editor');

    const res = await remove('tenant-editor');

    expect(res.statusCode).toBe(404);
    expect(await tenantKeyedBy('tenant-editor')).toEqual(before);
  });

  it("lists, adds and removes only the platform's users as the platform role's members", async () => {
    const { userId } = await seedRole('editor');
    const tenantMember = await seedTenantRole('editor', 'Tenant editors');
    const tenantUser = await inTenant('tenant-a', async () =>
      (
        await methods.createUser(
          { email: 'tenant-user@example.com', name: 'tu', provider: 'local', role: 'USER' },
          undefined,
          true,
        )
      ).toString(),
    );
    const handlers = createHandlers();
    const call = async (
      handler: 'getRoleMembers' | 'addRoleMember' | 'removeRoleMember',
      params: Record<string, string>,
      body: Record<string, unknown> = {},
    ): Promise<MockRes> => {
      const res = mockRes();
      const req = {
        params,
        body,
        query: {},
        user: { _id: new Types.ObjectId(), id: 'admin', role: 'ADMIN' },
      } as Partial<ServerRequest> as ServerRequest;
      await handlers[handler](req, res);
      return res;
    };
    const roleOf = async (id: string) =>
      (await mongoose.models.User.collection.findOne({ _id: new Types.ObjectId(id) }))?.role;

    const members = await call('getRoleMembers', { name: 'editor' });
    const added = await call('addRoleMember', { name: 'editor' }, { userId: tenantUser });
    const removed = await call('removeRoleMember', { name: 'editor', userId: tenantMember });

    expect(members.statusCode).toBe(200);
    expect(members.body).toMatchObject({ members: [{ userId }], total: 1 });
    expect(added.statusCode).toBe(404);
    expect(removed.statusCode).toBe(404);
    expect(await roleOf(tenantUser)).toBe('USER');
    expect(await roleOf(tenantMember)).toBe('editor');
  });

  it("deletes only the active tenant's role inside it, leaving the platform role", async () => {
    await seedRole('editor');
    await seedTenantRole('editor', 'Tenant editors');
    const platformBefore = await keyedBy('editor');

    const res = await remove('editor', 'tenant-a');

    expect(res.statusCode).toBe(200);
    expect(await tenantKeyedBy('editor')).toEqual(nothing);
    expect(await keyedBy('editor')).toEqual(platformBefore);
  });
});

describe('role rename inside a tenant', () => {
  it("moves only that tenant's profile, never the platform role's of the same name", async () => {
    await seedRole('editor');
    await inTenant('tenant-a', async () => {
      await methods.createRoleByName({ name: 'editor', permissions: {} });
      await setWelcome('editor', 'tenant-a');
    });

    const res = await rename(createHandlers(), 'editor', { name: 'writer' }, 'tenant-a');

    expect(res.statusCode).toBe(200);
    expect(await profileLayout()).toEqual(['-/editor: hello editor', 'tenant-a/writer: tenant-a']);
    expect((await keyedBy('editor')).profile?.overrides).toEqual({
      interface: { customWelcome: 'hello editor' },
    });
  });

  it("moves only that tenant's grants, never the platform role's of the same name", async () => {
    await seedRole('editor');
    await inTenant('tenant-a', async () => {
      await methods.createRoleByName({ name: 'editor', permissions: {} });
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
        capability: dataSchemas.SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-a',
      });
    });
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);

    const res = await rename(
      createHandlers({ recordAuditEntry }),
      'editor',
      { name: 'writer' },
      'tenant-a',
    );

    expect(res.statusCode).toBe(200);
    expect(await grantLayout()).toEqual([
      `-/editor: ${dataSchemas.SystemCapabilities.READ_USERS}`,
      `tenant-a/writer: ${dataSchemas.SystemCapabilities.READ_CONFIGS}`,
    ]);
    expect(recordAuditEntry.mock.calls[0][0].metadata).toMatchObject({
      grantsMoved: 1,
      grantCapabilities: dataSchemas.SystemCapabilities.READ_CONFIGS,
    });
  });

  it("answers 409 for a profile at the new name in the caller's tenant", async () => {
    await inTenant('tenant-a', async () => {
      await methods.createRoleByName({ name: 'editor', permissions: {} });
      await setWelcome('editor', 'tenant-a');
      await setWelcome('writer', 'orphaned');
    });

    const res = await rename(createHandlers(), 'editor', { name: 'writer' }, 'tenant-a');

    expect(res.statusCode).toBe(409);
    expect(res.body?.code).toBe('ROLE_CONFIG_CONFLICT');
    expect(await profileLayout()).toEqual([
      'tenant-a/editor: tenant-a',
      'tenant-a/writer: orphaned',
    ]);
  });
});
