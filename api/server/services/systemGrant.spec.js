const mongoose = require('mongoose');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { SystemRoles, PrincipalType } = require('librechat-data-provider');
const { SystemCapabilities } = require('@librechat/data-schemas');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  getTransactionSupport: jest.fn().mockResolvedValue(false),
  createModels: jest.requireActual('@librechat/data-schemas').createModels,
  createMethods: jest.requireActual('@librechat/data-schemas').createMethods,
}));

jest.mock('~/server/services/GraphApiService', () => ({
  entraIdPrincipalFeatureEnabled: jest.fn().mockReturnValue(false),
  getUserOwnedEntraGroups: jest.fn().mockResolvedValue([]),
  getUserEntraGroups: jest.fn().mockResolvedValue([]),
  getGroupMembers: jest.fn().mockResolvedValue([]),
  getGroupOwners: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/config', () => ({
  logger: { error: jest.fn() },
}));

let mongoServer;
let methods;
let SystemGrant;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  createModels(mongoose);
  const dbModels = require('~/db/models');
  Object.assign(mongoose.models, dbModels);
  SystemGrant = dbModels.SystemGrant;

  methods = createMethods(mongoose, {
    matchModelName: () => null,
    findMatchingPattern: () => null,
    getCache: () => ({
      get: async () => null,
      set: async () => {},
    }),
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await SystemGrant.deleteMany({});
});

describe('SystemGrant methods', () => {
  describe('seedSystemGrants', () => {
    it('seeds all capabilities for the ADMIN role', async () => {
      await methods.seedSystemGrants();

      const grants = await SystemGrant.find({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
      }).lean();

      const expectedCount = Object.values(SystemCapabilities).length;
      expect(grants).toHaveLength(expectedCount);

      const capabilities = grants.map((g) => g.capability).sort();
      const expected = Object.values(SystemCapabilities).sort();
      expect(capabilities).toEqual(expected);
    });

    it('is idempotent — calling twice does not duplicate grants', async () => {
      await methods.seedSystemGrants();
      await methods.seedSystemGrants();

      const count = await SystemGrant.countDocuments({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
      });

      expect(count).toBe(Object.values(SystemCapabilities).length);
    });

    it('seeds grants with no tenantId', async () => {
      await methods.seedSystemGrants();

      const withTenant = await SystemGrant.countDocuments({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
        tenantId: { $exists: true },
      });

      expect(withTenant).toBe(0);
    });
  });

  describe('grantCapability / revokeCapability', () => {
    it('grants a capability to a user', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });

      const grant = await SystemGrant.findOne({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      }).lean();

      expect(grant).toBeTruthy();
      expect(grant.grantedAt).toBeInstanceOf(Date);
    });

    it('upsert does not create duplicates', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });

      const count = await SystemGrant.countDocuments({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });

      expect(count).toBe(1);
    });

    it('revokes a capability', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });

      await methods.revokeCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });

      const grant = await SystemGrant.findOne({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      }).lean();

      expect(grant).toBeNull();
    });
  });

  describe('hasCapabilityForPrincipals', () => {
    it('returns true when role principal has the capability', async () => {
      await methods.seedSystemGrants();

      const principals = [
        { principalType: PrincipalType.USER, principalId: new mongoose.Types.ObjectId() },
        { principalType: PrincipalType.ROLE, principalId: SystemRoles.ADMIN },
        { principalType: PrincipalType.PUBLIC },
      ];

      const result = await methods.hasCapabilityForPrincipals({
        principals,
        capability: SystemCapabilities.ACCESS_ADMIN,
      });

      expect(result).toBe(true);
    });

    it('returns false when no principal has the capability', async () => {
      const principals = [
        { principalType: PrincipalType.USER, principalId: new mongoose.Types.ObjectId() },
        { principalType: PrincipalType.ROLE, principalId: SystemRoles.USER },
        { principalType: PrincipalType.PUBLIC },
      ];

      const result = await methods.hasCapabilityForPrincipals({
        principals,
        capability: SystemCapabilities.ACCESS_ADMIN,
      });

      expect(result).toBe(false);
    });

    it('returns false for an empty principals list', async () => {
      const result = await methods.hasCapabilityForPrincipals({
        principals: [],
        capability: SystemCapabilities.ACCESS_ADMIN,
      });

      expect(result).toBe(false);
    });

    it('ignores PUBLIC principals', async () => {
      const result = await methods.hasCapabilityForPrincipals({
        principals: [{ principalType: PrincipalType.PUBLIC }],
        capability: SystemCapabilities.ACCESS_ADMIN,
      });

      expect(result).toBe(false);
    });

    it('matches user-level grants', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_CONFIGS,
      });

      const principals = [
        { principalType: PrincipalType.USER, principalId: userId },
        { principalType: PrincipalType.ROLE, principalId: SystemRoles.USER },
        { principalType: PrincipalType.PUBLIC },
      ];

      const result = await methods.hasCapabilityForPrincipals({
        principals,
        capability: SystemCapabilities.READ_CONFIGS,
      });

      expect(result).toBe(true);
    });

    it('matches group-level grants', async () => {
      const groupId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        capability: SystemCapabilities.READ_USAGE,
      });

      const principals = [
        { principalType: PrincipalType.USER, principalId: new mongoose.Types.ObjectId() },
        { principalType: PrincipalType.GROUP, principalId: groupId },
        { principalType: PrincipalType.PUBLIC },
      ];

      const result = await methods.hasCapabilityForPrincipals({
        principals,
        capability: SystemCapabilities.READ_USAGE,
      });

      expect(result).toBe(true);
    });
  });

  describe('getCapabilitiesForPrincipal', () => {
    it('lists all capabilities for a principal', async () => {
      await methods.seedSystemGrants();

      const grants = await methods.getCapabilitiesForPrincipal({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
      });

      expect(grants).toHaveLength(Object.values(SystemCapabilities).length);
    });

    it('returns empty array for a principal with no grants', async () => {
      const grants = await methods.getCapabilitiesForPrincipal({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
      });

      expect(grants).toHaveLength(0);
    });
  });

  describe('principalId normalization', () => {
    it('grant with string userId is found by hasCapabilityForPrincipals with ObjectId', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId.toString(), // string input
        capability: SystemCapabilities.READ_USAGE,
      });

      const result = await methods.hasCapabilityForPrincipals({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }], // ObjectId input
        capability: SystemCapabilities.READ_USAGE,
      });

      expect(result).toBe(true);
    });

    it('revoke with string userId removes the grant stored as ObjectId', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId.toString(),
        capability: SystemCapabilities.READ_USAGE,
      });

      await methods.revokeCapability({
        principalType: PrincipalType.USER,
        principalId: userId.toString(), // string revoke
        capability: SystemCapabilities.READ_USAGE,
      });

      const result = await methods.hasCapabilityForPrincipals({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
        capability: SystemCapabilities.READ_USAGE,
      });

      expect(result).toBe(false);
    });

    it('getCapabilitiesForPrincipal with string userId returns grants stored as ObjectId', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId.toString(),
        capability: SystemCapabilities.READ_USAGE,
      });

      const grants = await methods.getCapabilitiesForPrincipal({
        principalType: PrincipalType.USER,
        principalId: userId.toString(), // string lookup
      });

      expect(grants).toHaveLength(1);
      expect(grants[0].capability).toBe(SystemCapabilities.READ_USAGE);
    });
  });

  describe('tenant scoping', () => {
    it('tenant-scoped grant does not match platform-level query', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-1',
      });

      const result = await methods.hasCapabilityForPrincipals({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
        capability: SystemCapabilities.READ_CONFIGS,
      });

      expect(result).toBe(false);
    });

    it('tenant-scoped grant matches same-tenant query', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-1',
      });

      const result = await methods.hasCapabilityForPrincipals({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
        capability: SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-1',
      });

      expect(result).toBe(true);
    });

    it('tenant-scoped grant does not match different tenant', async () => {
      const userId = new mongoose.Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-1',
      });

      const result = await methods.hasCapabilityForPrincipals({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
        capability: SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-2',
      });

      expect(result).toBe(false);
    });
  });
});
