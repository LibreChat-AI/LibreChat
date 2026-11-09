const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, tenantStorage } = require('@librechat/data-schemas');
const {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionTypes,
  PermissionBits,
} = require('librechat-data-provider');

let mockDirectoryConfig = {};

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
  checkBan: (_req, _res, next) => next(),
  uaParser: (_req, _res, next) => next(),
  canAccessResource: jest.requireActual('~/server/middleware/accessResources/canAccessResource')
    .canAccessResource,
  configMiddleware: (req, _res, next) => {
    req.config = mockDirectoryConfig;
    next();
  },
}));
jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/services/GraphApiService', () => ({
  ...jest.requireActual('~/server/services/GraphApiService'),
  createGraphClient: jest.fn(),
}));
jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  getRoleByName: jest.fn(),
}));

const db = require('~/models');
const { createGraphClient } = require('~/server/services/GraphApiService');
const { grantPermission, checkPermission } = require('~/server/services/PermissionService');
const router = require('./accessPermissions');

const sourceId = '767f2e31-cd94-4247-909e-64b6b104e1f0';
const forged = {
  type: PrincipalType.USER,
  source: 'entra',
  name: 'Forged Name',
  email: 'forged@example.com',
  idOnTheSource: sourceId,
  accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
};

describe('Shared-link directory principal provisioning', () => {
  let mongoServer;
  let app;
  let owner;
  let resourceId;
  let graphGet;
  let graphMembers;
  let graphOwners;
  let User;
  let Group;
  let AclEntry;
  let requestTenant;
  const originalEnv = {
    USE_ENTRA_ID_FOR_PEOPLE_SEARCH: process.env.USE_ENTRA_ID_FOR_PEOPLE_SEARCH,
    OPENID_REUSE_TOKENS: process.env.OPENID_REUSE_TOKENS,
    ENTRA_ID_INCLUDE_OWNERS_AS_MEMBERS: process.env.ENTRA_ID_INCLUDE_OWNERS_AS_MEMBERS,
  };

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    ({ User, Group, AclEntry } = mongoose.models);
    await db.seedDefaultRoles();
    app = express();
    app.use(express.json());
    app.use((_req, _res, next) => tenantStorage.run({ tenantId: requestTenant }, next));
    app.use((req, _res, next) => {
      req.user = { ...owner.toObject(), id: owner._id.toString() };
      next();
    });
    app.use('/api/permissions', router);
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    requestTenant = undefined;
    mockDirectoryConfig = {};
    await Promise.all([User.deleteMany({}), Group.deleteMany({}), AclEntry.deleteMany({})]);
    process.env.USE_ENTRA_ID_FOR_PEOPLE_SEARCH = 'true';
    process.env.OPENID_REUSE_TOKENS = 'true';
    process.env.ENTRA_ID_INCLUDE_OWNERS_AS_MEMBERS = 'false';
    owner = await User.create({
      name: 'Link Owner',
      email: 'owner@example.com',
      provider: 'openid',
      openidId: 'owner-subject',
      role: SystemRoles.USER,
    });
    const link = await mongoose.models.SharedLink.create({
      conversationId: 'test-conversation',
      user: owner._id.toString(),
    });
    resourceId = link._id;
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: owner._id,
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
      grantedBy: owner._id,
    });
    db.getRoleByName.mockResolvedValue({
      permissions: {
        [PermissionTypes.SHARED_LINKS]: { USE: true, SHARE: true, SHARE_PUBLIC: true },
        [PermissionTypes.AGENTS]: { USE: true, SHARE: true, SHARE_PUBLIC: true },
      },
    });
    graphGet = jest.fn().mockResolvedValue(null);
    graphMembers = jest.fn().mockResolvedValue({
      value: [{ id: 'trusted-member', '@odata.type': '#microsoft.graph.user' }],
    });
    graphOwners = jest.fn().mockResolvedValue({ value: [] });
    createGraphClient.mockResolvedValue({
      api: (path) => {
        const request = {
          options: () => request,
          middlewareOptions: () => request,
          select: () => ({
            get: () => graphGet(path),
            top: () => ({
              get: () => (path.includes('/owners') ? graphOwners(path) : graphMembers(path)),
            }),
          }),
        };
        return request;
      },
    });
  });

  afterEach(() => jest.restoreAllMocks());

  const update = (
    principals,
    token = 'test-access-token',
    extra = {},
    resourceType = ResourceType.SHARED_LINK,
  ) => {
    const call = request(app).put(`/api/permissions/${resourceType}/${resourceId}`);
    if (token) {
      call.set('Authorization', `Bearer ${token}`);
    }
    return call.send({ updated: principals, removed: [], ...extra });
  };

  it.each(['disabled', 'token reuse disabled', 'local login', 'missing subject', 'missing token'])(
    'does not create accounts or disclose users when integration is unavailable: %s',
    async (unavailable) => {
      const existing = await User.create({
        name: 'Private Existing User',
        email: 'private@example.com',
        provider: 'local',
        idOnTheSource: 'existing-source-id',
      });
      if (unavailable === 'disabled') {
        process.env.USE_ENTRA_ID_FOR_PEOPLE_SEARCH = 'false';
      } else if (unavailable === 'token reuse disabled') {
        process.env.OPENID_REUSE_TOKENS = 'false';
      } else if (unavailable === 'local login') {
        owner.provider = 'local';
      } else if (unavailable === 'missing subject') {
        owner.openidId = undefined;
      }
      const probes = [
        forged,
        { ...forged, email: existing.email },
        { ...forged, idOnTheSource: existing.idOnTheSource },
        { ...forged, type: PrincipalType.GROUP },
        { ...forged, id: { $ne: null } },
        { ...forged, idOnTheSource: { $ne: null } },
      ];
      const response = await update(probes, unavailable === 'missing token' ? null : undefined);
      expect(response.status).toBe(200);
      expect(response.body.results.principals).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(existing._id.toString());
      expect(JSON.stringify(response.body)).not.toContain(existing.name);
      expect(await User.countDocuments()).toBe(2);
      expect(await Group.countDocuments()).toBe(0);
      expect(await AclEntry.countDocuments()).toBe(1);
      expect(createGraphClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    [403, 502],
    [404, 200],
  ])('fails closed without disclosure on Graph status %i', async (statusCode, status) => {
    const existing = await User.create({ email: forged.email, name: 'Private User' });
    graphGet.mockRejectedValue(Object.assign(new Error('Private upstream detail'), { statusCode }));
    const response = await update([forged]);
    expect(response.status).toBe(status);
    if (status === 200) expect(response.body.results.principals).toEqual([]);
    else expect(response.body.code).toBe('DIRECTORY_VERIFICATION_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain(existing._id.toString());
    expect(JSON.stringify(response.body)).not.toContain('Private upstream detail');
    expect(await User.countDocuments()).toBe(2);
    expect(await AclEntry.countDocuments()).toBe(1);
  });

  it('returns a safe directory failure for an external group denied by Graph', async () => {
    graphGet.mockRejectedValue(
      Object.assign(new Error('Private consent details'), { statusCode: 403 }),
    );
    const response = await update([{ ...forged, type: PrincipalType.GROUP }]);
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('DIRECTORY_VERIFICATION_UNAVAILABLE');
    expect(await Group.countDocuments()).toBe(0);
    expect(await AclEntry.countDocuments()).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain('Private consent');
  });

  it('preserves sharing when People resolves an organizational user after users is denied', async () => {
    graphGet.mockRejectedValueOnce(
      Object.assign(new Error('Missing User.Read.All'), { statusCode: 403 }),
    );
    graphGet.mockResolvedValueOnce({
      id: sourceId,
      displayName: 'Trusted',
      personType: { subclass: 'OrganizationUser' },
      scoredEmailAddresses: [{ address: 'trusted@example.com' }],
    });
    const response = await update([forged]);
    expect(response.status).toBe(200);
    expect(response.body.results.principals).toHaveLength(1);
    expect(await User.findOne({ email: 'trusted@example.com' })).not.toBeNull();
  });

  it.each(['client', 'identity', 'members', 'owners', 'later page'])(
    'returns a retryable failure with no writes when %s stalls past the configured deadline',
    async (phase) => {
      mockDirectoryConfig = {
        timeouts: { directoryMs: 20 },
        concurrency: { permissionPrincipalLookups: 1 },
      };
      const group = await Group.create({
        name: 'Stored',
        source: 'entra',
        idOnTheSource: sourceId,
        memberIds: ['kept-member'],
      });
      const stalled = () => new Promise(() => undefined);
      if (phase === 'client') createGraphClient.mockImplementationOnce(stalled);
      if (phase === 'identity') graphGet.mockImplementationOnce(stalled);
      if (phase === 'members') graphMembers.mockImplementationOnce(stalled);
      if (phase === 'owners') {
        process.env.ENTRA_ID_INCLUDE_OWNERS_AS_MEMBERS = 'true';
        graphOwners.mockImplementationOnce(stalled);
      }
      if (phase === 'later page') {
        graphMembers.mockResolvedValueOnce({
          value: [],
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/groups/${sourceId}/transitiveMembers?page=2`,
        });
        graphMembers.mockImplementationOnce(stalled);
      }
      const persist = jest.spyOn(db, 'persistPermissionPrincipals');
      const response = await update([
        phase === 'client' || phase === 'identity'
          ? forged
          : { ...forged, type: PrincipalType.GROUP, id: group._id.toString() },
      ]);
      expect(response.status).toBe(502);
      expect(response.body).toEqual({
        error: 'Failed to update permissions',
        details: 'Directory identity verification failed',
        code: 'DIRECTORY_VERIFICATION_UNAVAILABLE',
      });
      expect(persist).not.toHaveBeenCalled();
      expect(await User.countDocuments()).toBe(1);
      expect(await Group.countDocuments()).toBe(1);
      expect((await Group.findById(group._id).lean()).memberIds).toEqual(['kept-member']);
      expect(await AclEntry.countDocuments()).toBe(1);
    },
  );

  it.each(['client', 'lookup'])(
    'returns a safe failure without ACL changes on a provider %s outage',
    async (failure) => {
      const existing = await User.create({ email: forged.email, name: 'Private User' });
      const error = Object.assign(new Error('Private upstream detail'), { statusCode: 503 });
      if (failure === 'client') {
        createGraphClient.mockRejectedValueOnce(error);
      } else {
        graphGet.mockRejectedValue(error);
      }
      const response = await update(
        [
          {
            type: PrincipalType.USER,
            id: existing._id.toString(),
            accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
          },
          forged,
        ],
        undefined,
        { public: true, publicAccessRoleId: AccessRoleIds.SHARED_LINK_VIEWER },
      );
      expect(response.status).toBe(502);
      expect(response.body).toEqual({
        error: 'Failed to update permissions',
        details: 'Directory identity verification failed',
        code: 'DIRECTORY_VERIFICATION_UNAVAILABLE',
      });
      expect(JSON.stringify(response.body)).not.toContain(existing._id.toString());
      expect(await User.countDocuments()).toBe(2);
      expect(await AclEntry.countDocuments()).toBe(1);
    },
  );

  it('does not provision or disclose a user for a nonexistent source ID', async () => {
    const existing = await User.create({ email: forged.email, name: 'Private User' });
    const response = await update([forged]);
    expect(response.status).toBe(200);
    expect(response.body.results.principals).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain(existing._id.toString());
    expect(await User.countDocuments()).toBe(2);
    expect(await AclEntry.countDocuments()).toBe(1);
  });

  it('creates a directory placeholder from canonical metadata, not a forged existing-user email', async () => {
    const existing = await User.create({
      email: forged.email,
      name: 'Private User',
      provider: 'local',
    });
    graphGet.mockResolvedValue({
      id: sourceId,
      displayName: 'Trusted Name',
      mail: 'Trusted@Example.com',
    });
    const response = await update([forged]);
    expect(response.status).toBe(200);
    expect(response.body.results.principals).toHaveLength(1);
    const created = await User.findOne({ idOnTheSource: sourceId }).lean();
    expect(created).toMatchObject({
      name: 'Trusted Name',
      email: 'trusted@example.com',
      provider: 'openid',
      emailVerified: false,
    });
    expect(response.body.results.principals[0].id).toBe(created._id.toString());
    expect(JSON.stringify(response.body)).not.toContain(existing._id.toString());
    expect((await User.findById(existing._id).lean()).idOnTheSource).toBeUndefined();
    expect(await AclEntry.countDocuments()).toBe(2);
  });

  it('shares with an existing user by canonical email without changing its authentication identity', async () => {
    const existing = await User.create({
      email: 'trusted@example.com',
      name: 'Local User',
      provider: 'local',
    });
    graphGet.mockResolvedValue({
      id: sourceId,
      displayName: 'Trusted Name',
      mail: 'Trusted@Example.com',
    });
    const response = await update([forged]);
    expect(response.status).toBe(200);
    expect(response.body.results.principals[0].id).toBe(existing._id.toString());
    const unchanged = await User.findById(existing._id).lean();
    expect(unchanged.provider).toBe('local');
    expect(unchanged.idOnTheSource).toBeUndefined();
    expect(await User.countDocuments()).toBe(2);
  });

  it('creates external groups using trusted Graph metadata and members', async () => {
    graphGet.mockResolvedValue({
      id: sourceId,
      displayName: 'Trusted Group',
      mail: 'Group@Example.com',
      description: 'Trusted description',
    });
    const response = await update([
      { ...forged, type: PrincipalType.GROUP, description: 'Forged description' },
    ]);
    expect(response.status).toBe(200);
    const group = await Group.findOne({ idOnTheSource: sourceId }).lean();
    expect(group).toMatchObject({
      name: 'Trusted Group',
      email: 'group@example.com',
      description: 'Trusted description',
      memberIds: ['trusted-member'],
    });
    expect(response.body.results.principals[0].id).toBe(group._id.toString());
    expect(await User.countDocuments()).toBe(1);
  });

  it('refreshes persisted Entra membership from its stored ID before sharing a new link', async () => {
    const removed = await User.create({
      email: 'removed@example.com',
      provider: 'openid',
      idOnTheSource: 'removed-member',
    });
    const active = await User.create({
      email: 'active@example.com',
      provider: 'openid',
      idOnTheSource: 'active-member',
    });
    const group = await Group.create({
      name: 'Stored Directory Group',
      source: 'entra',
      idOnTheSource: sourceId,
      memberIds: ['removed-member', 'active-member'],
    });
    await db.getUserPrincipals({ userId: removed._id.toString(), role: SystemRoles.USER });
    graphMembers.mockResolvedValueOnce({
      value: [{ id: 'active-member', '@odata.type': '#microsoft.graph.user' }],
    });
    const response = await update([
      {
        ...forged,
        type: PrincipalType.GROUP,
        id: group._id.toString(),
        idOnTheSource: 'forged-group-id',
      },
    ]);
    expect(response.status).toBe(200);
    expect(graphMembers).toHaveBeenCalledWith(`/groups/${sourceId}/transitiveMembers`);
    expect((await Group.findById(group._id).lean()).memberIds).toEqual(['active-member']);
    const permission = {
      role: SystemRoles.USER,
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      requiredPermission: PermissionBits.VIEW,
    };
    await expect(checkPermission({ ...permission, userId: removed._id.toString() })).resolves.toBe(
      false,
    );
    await expect(checkPermission({ ...permission, userId: active._id.toString() })).resolves.toBe(
      true,
    );
    expect(createGraphClient).toHaveBeenCalledTimes(1);
  });

  it.each(['disabled', 'local login', 'token reuse disabled', 'missing token'])(
    'shares with persisted Entra groups without Graph when %s',
    async (unavailable) => {
      const group = await Group.create({
        name: 'Stored Directory Group',
        source: 'entra',
        idOnTheSource: sourceId,
        memberIds: ['stored-member'],
      });
      if (unavailable === 'disabled') {
        process.env.USE_ENTRA_ID_FOR_PEOPLE_SEARCH = 'false';
      } else if (unavailable === 'local login') {
        owner.provider = 'local';
      } else if (unavailable === 'token reuse disabled') {
        process.env.OPENID_REUSE_TOKENS = 'false';
      }
      const response = await update(
        [
          {
            ...forged,
            type: PrincipalType.GROUP,
            id: group._id.toString(),
            idOnTheSource: 'forged-source',
          },
        ],
        unavailable === 'missing token' ? null : undefined,
      );
      expect(response.status).toBe(200);
      expect(response.body.results.principals).toHaveLength(1);
      expect(response.body.results.principals[0].id).toBe(group._id.toString());
      expect(await AclEntry.countDocuments()).toBe(2);
      expect(await Group.findById(group._id).lean()).toMatchObject({
        name: group.name,
        idOnTheSource: sourceId,
        memberIds: ['stored-member'],
      });
      expect(createGraphClient).not.toHaveBeenCalled();
    },
  );

  it.each([new mongoose.Types.ObjectId().toString(), { $ne: null }])(
    'rejects a nonexistent or malformed local Entra group ID without provisioning: %j',
    async (id) => {
      const response = await update([{ ...forged, type: PrincipalType.GROUP, id }]);
      expect(response.status).toBe(200);
      expect(response.body.results.principals).toEqual([]);
      expect(await Group.countDocuments()).toBe(0);
      expect(await AclEntry.countDocuments()).toBe(1);
      expect(createGraphClient).not.toHaveBeenCalled();
    },
  );

  it('rejects a persisted Entra group from another tenant', async () => {
    const group = await Group.create({
      name: 'Private Directory Group',
      source: 'entra',
      tenantId: 'other-tenant',
      idOnTheSource: sourceId,
    });
    requestTenant = 'current-tenant';
    await tenantStorage.run({ tenantId: requestTenant }, async () => {
      await db.seedDefaultRoles();
      owner = await User.create({ email: 'tenant-owner@example.com', role: SystemRoles.USER });
      const link = await mongoose.models.SharedLink.create({
        conversationId: 'tenant-conversation',
        user: owner._id.toString(),
      });
      resourceId = link._id;
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: owner._id,
        resourceType: ResourceType.SHARED_LINK,
        resourceId,
        accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
        grantedBy: owner._id,
      });
    });
    const response = await update([
      { ...forged, type: PrincipalType.GROUP, id: group._id.toString() },
    ]);
    expect(response.status).toBe(200);
    expect(response.body.results.principals).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain(group.name);
    expect(await AclEntry.countDocuments({ resourceId })).toBe(1);
    expect(createGraphClient).not.toHaveBeenCalled();
  });

  it('applies a stored Entra group permission downgrade without Graph', async () => {
    owner.provider = 'local';
    const group = await Group.create({
      name: 'Stored Directory Group',
      source: 'entra',
      idOnTheSource: sourceId,
    });
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: owner._id,
      resourceType: ResourceType.AGENT,
      resourceId,
      accessRoleId: AccessRoleIds.AGENT_OWNER,
      grantedBy: owner._id,
    });
    await grantPermission({
      principalType: PrincipalType.GROUP,
      principalId: group._id,
      resourceType: ResourceType.AGENT,
      resourceId,
      accessRoleId: AccessRoleIds.AGENT_EDITOR,
      grantedBy: owner._id,
    });
    const response = await update(
      [
        {
          ...forged,
          type: PrincipalType.GROUP,
          id: group._id.toString(),
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        },
      ],
      null,
      {},
      ResourceType.AGENT,
    );
    expect(response.status).toBe(200);
    expect(response.body.results.principals[0]).toMatchObject({
      id: group._id.toString(),
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
    });
    const entry = await AclEntry.findOne({ resourceId, principalId: group._id }).lean();
    const viewer = await db.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
    expect(entry.permBits).toBe(viewer.permBits);
    expect(createGraphClient).not.toHaveBeenCalled();
  });

  it.each(['client', 'members', 'owners', 'later page'])(
    'leaves persisted group membership and unrelated ACLs unchanged on %s failure',
    async (failure) => {
      const group = await Group.create({
        name: 'Stored Group',
        source: 'entra',
        idOnTheSource: sourceId,
        memberIds: ['kept-member'],
      });
      const otherResource = new mongoose.Types.ObjectId();
      await grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: group._id,
        resourceType: ResourceType.SHARED_LINK,
        resourceId: otherResource,
        accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
        grantedBy: owner._id,
      });
      const before = await AclEntry.find({}).lean();
      const error = new Error('Private Graph diagnostics');
      if (failure === 'client') {
        createGraphClient.mockRejectedValueOnce(error);
      } else if (failure === 'owners') {
        process.env.ENTRA_ID_INCLUDE_OWNERS_AS_MEMBERS = 'true';
        graphOwners.mockRejectedValueOnce(error);
      } else if (failure === 'later page') {
        graphMembers.mockResolvedValueOnce({
          value: [{ id: 'partial-member', '@odata.type': '#microsoft.graph.user' }],
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/groups/${sourceId}/transitiveMembers?$skiptoken=next`,
        });
        graphMembers.mockRejectedValueOnce(error);
      } else {
        graphMembers.mockRejectedValueOnce(error);
      }
      const response = await update(
        [{ ...forged, type: PrincipalType.GROUP, id: group._id.toString() }],
        undefined,
        { public: true, publicAccessRoleId: AccessRoleIds.SHARED_LINK_VIEWER },
      );
      expect(response.status).toBe(502);
      expect(response.body).toEqual({
        error: 'Failed to update permissions',
        details: 'Directory identity verification failed',
        code: 'DIRECTORY_VERIFICATION_UNAVAILABLE',
      });
      expect((await Group.findById(group._id).lean()).memberIds).toEqual(['kept-member']);
      expect(await AclEntry.find({}).lean()).toEqual(before);
    },
  );

  it('persists a genuinely empty group snapshot when Graph succeeds', async () => {
    const group = await Group.create({
      name: 'Stored Group',
      source: 'entra',
      idOnTheSource: sourceId,
      memberIds: ['former-member'],
    });
    graphMembers.mockResolvedValueOnce({ value: [] });
    const response = await update([
      { ...forged, type: PrincipalType.GROUP, id: group._id.toString() },
    ]);
    expect(response.status).toBe(200);
    expect((await Group.findById(group._id).lean()).memberIds).toEqual([]);
  });

  it.each(['findPermissionUser', 'findPermissionGroup', 'persistPermissionPrincipals'])(
    'returns a sanitized failure without ACL changes when %s fails',
    async (method) => {
      const group = await Group.create({
        name: 'Stored Group',
        source: 'entra',
        idOnTheSource: sourceId,
        memberIds: ['kept-member'],
      });
      const local = await User.create({ email: 'local-sharing@example.com' });
      graphGet.mockResolvedValue({
        id: sourceId,
        displayName: 'Trusted',
        mail: 'trusted@example.com',
      });
      const recipient = { ...forged };
      if (method === 'findPermissionGroup' || method === 'persistPermissionPrincipals') {
        recipient.type = PrincipalType.GROUP;
        recipient.id = group._id.toString();
      }
      jest.spyOn(db, method).mockRejectedValueOnce(new Error('Private database diagnostics'));
      const response = await update(
        [
          recipient,
          {
            type: PrincipalType.USER,
            id: local._id.toString(),
            accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
          },
        ],
        undefined,
        { public: true, publicAccessRoleId: AccessRoleIds.SHARED_LINK_VIEWER },
      );
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to update permissions',
        details: 'Principal preparation failed',
        code: 'PRINCIPAL_PREPARATION_FAILED',
      });
      expect(await AclEntry.countDocuments()).toBe(1);
      expect((await Group.findById(group._id).lean()).memberIds).toEqual(['kept-member']);
    },
  );

  it.each(['members', 'database'])(
    'does not persist a staged refresh or new account when a later %s read fails',
    async (failure) => {
      const group = await Group.create({
        name: 'Existing',
        source: 'entra',
        idOnTheSource: sourceId,
        memberIds: ['kept-member'],
      });
      const failing = await Group.create({
        name: 'Later',
        source: 'entra',
        idOnTheSource: 'failing-group',
        memberIds: ['other-member'],
      });
      graphGet.mockResolvedValue({
        id: 'new-user',
        displayName: 'New User',
        mail: 'new-user@example.com',
      });
      let release;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      graphMembers.mockImplementation(async (path) => {
        if (path.includes('failing-group')) {
          await blocked;
          throw new Error('Private provider failure');
        }
        return { value: [{ id: 'new-member', '@odata.type': '#microsoft.graph.user' }] };
      });
      if (failure === 'database') {
        const find = db.findPermissionGroup;
        jest.spyOn(db, 'findPermissionGroup').mockImplementation(async (query) => {
          if (query.id === failing._id.toString()) {
            await blocked;
            throw new Error('Private database failure');
          }
          return find(query);
        });
      }
      const persist = jest.spyOn(db, 'persistPermissionPrincipals');
      const pending = update([
        { ...forged, idOnTheSource: 'new-user' },
        { ...forged, type: PrincipalType.GROUP, id: group._id.toString() },
        { ...forged, type: PrincipalType.GROUP, id: failing._id.toString() },
      ]).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(persist).not.toHaveBeenCalled();
      release();
      const response = await pending;
      expect(response.status).toBe(failure === 'database' ? 500 : 502);
      expect(persist).not.toHaveBeenCalled();
      expect(await User.findOne({ email: 'new-user@example.com' })).toBeNull();
      expect((await Group.findById(group._id).lean()).memberIds).toEqual(['kept-member']);
      expect((await Group.findById(failing._id).lean()).memberIds).toEqual(['other-member']);
      expect(await AclEntry.countDocuments()).toBe(1);
    },
  );

  it('preserves local user, local group, role, public sharing, and revocation without Entra', async () => {
    process.env.USE_ENTRA_ID_FOR_PEOPLE_SEARCH = 'false';
    const localUser = await User.create({ email: 'local@example.com', name: 'Local User' });
    const localGroup = await Group.create({ name: 'Local Group', source: 'local' });
    const response = await update(
      [
        {
          type: PrincipalType.USER,
          id: localUser._id.toString(),
          source: 'local',
          accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
        },
        {
          type: PrincipalType.GROUP,
          id: localGroup._id.toString(),
          source: 'local',
          accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
        },
        {
          type: PrincipalType.ROLE,
          id: SystemRoles.USER,
          accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
        },
      ],
      null,
      { public: true, publicAccessRoleId: AccessRoleIds.SHARED_LINK_VIEWER },
    );
    expect(response.status).toBe(200);
    expect(response.body.results.principals).toHaveLength(4);
    expect(await AclEntry.countDocuments()).toBe(5);
    const revoked = await update([], null, {
      removed: [{ type: PrincipalType.USER, id: localUser._id.toString() }],
      public: false,
    });
    expect(revoked.status).toBe(200);
    expect(await AclEntry.countDocuments()).toBe(3);
    expect(createGraphClient).not.toHaveBeenCalled();
  });
});
