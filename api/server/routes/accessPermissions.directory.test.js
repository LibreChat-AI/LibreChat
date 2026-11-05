const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionTypes,
} = require('librechat-data-provider');

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
  checkBan: (_req, _res, next) => next(),
  uaParser: (_req, _res, next) => next(),
  canAccessResource: jest.requireActual('~/server/middleware/accessResources/canAccessResource')
    .canAccessResource,
  configMiddleware: (req, _res, next) => {
    req.config = {};
    next();
  },
}));
jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/services/GraphApiService', () => ({
  ...jest.requireActual('~/server/services/GraphApiService'),
  createGraphClient: jest.fn(),
  getGroupMembers: jest.fn().mockResolvedValue(['trusted-member']),
  getGroupOwners: jest.fn().mockResolvedValue([]),
}));
jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  getRoleByName: jest.fn(),
}));

const db = require('~/models');
const { createGraphClient } = require('~/server/services/GraphApiService');
const { grantPermission } = require('~/server/services/PermissionService');
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
  let User;
  let Group;
  let AclEntry;
  const originalEnv = {
    USE_ENTRA_ID_FOR_PEOPLE_SEARCH: process.env.USE_ENTRA_ID_FOR_PEOPLE_SEARCH,
    OPENID_REUSE_TOKENS: process.env.OPENID_REUSE_TOKENS,
  };

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    ({ User, Group, AclEntry } = mongoose.models);
    await db.seedDefaultRoles();
    app = express();
    app.use(express.json());
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
    await Promise.all([User.deleteMany({}), Group.deleteMany({}), AclEntry.deleteMany({})]);
    process.env.USE_ENTRA_ID_FOR_PEOPLE_SEARCH = 'true';
    process.env.OPENID_REUSE_TOKENS = 'true';
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
      },
    });
    graphGet = jest.fn().mockResolvedValue(null);
    createGraphClient.mockResolvedValue({ api: () => ({ select: () => ({ get: graphGet }) }) });
  });

  const update = (principals, token = 'test-access-token', extra = {}) => {
    const call = request(app).put(`/api/permissions/${ResourceType.SHARED_LINK}/${resourceId}`);
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

  it.each([403, 404, 503])(
    'fails closed without disclosure on Graph status %i',
    async (statusCode) => {
      const existing = await User.create({ email: forged.email, name: 'Private User' });
      graphGet.mockRejectedValue(
        Object.assign(new Error('Private upstream detail'), { statusCode }),
      );
      const response = await update([forged]);
      expect(response.status).toBe(200);
      expect(response.body.results.principals).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(existing._id.toString());
      expect(JSON.stringify(response.body)).not.toContain('Private upstream detail');
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
