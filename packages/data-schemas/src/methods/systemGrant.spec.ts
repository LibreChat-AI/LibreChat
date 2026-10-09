import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { SystemCapability } from '~/types/admin';
import type * as t from '~/types';
import { SystemCapabilities, CapabilityImplications } from '~/admin/capabilities';
import { createSystemGrantMethods } from './systemGrant';
import systemGrantSchema from '~/schema/systemGrant';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let SystemGrant: mongoose.Model<t.ISystemGrant>;
let methods: ReturnType<typeof createSystemGrantMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  SystemGrant =
    mongoose.models.SystemGrant || mongoose.model<t.ISystemGrant>('SystemGrant', systemGrantSchema);
  methods = createSystemGrantMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  // Connecting does not wait for the unique index. Complete initialization
  // before any seeding or duplicate writes can race the background build.
  await SystemGrant.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await SystemGrant.deleteMany({});
});

describe('systemGrant methods', () => {
  describe('seedSystemGrants', () => {
    it('seeds every SystemCapabilities value for the ADMIN role', async () => {
      await methods.seedSystemGrants();

      const grants = await SystemGrant.find({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
      }).lean();

      const expected = Object.values(SystemCapabilities).sort();
      const actual = grants.map((g) => g.capability).sort();
      expect(actual).toEqual(expected);
    });

    it('is idempotent — duplicate calls produce no extra documents', async () => {
      await methods.seedSystemGrants();
      await methods.seedSystemGrants();
      await methods.seedSystemGrants();

      const count = await SystemGrant.countDocuments({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
      });
      expect(count).toBe(Object.values(SystemCapabilities).length);
    });

    it('seeds platform-level grants (no tenantId field)', async () => {
      await methods.seedSystemGrants();

      const withTenant = await SystemGrant.countDocuments({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
        tenantId: { $exists: true },
      });
      expect(withTenant).toBe(0);
    });

    it('does not throw when called (try-catch protects startup)', async () => {
      await expect(methods.seedSystemGrants()).resolves.not.toThrow();
    });

    it('retries on transient failure and succeeds', async () => {
      jest.useFakeTimers();
      jest.spyOn(SystemGrant, 'bulkWrite').mockRejectedValueOnce(new Error('disk full'));

      const seedPromise = methods.seedSystemGrants();
      await jest.advanceTimersByTimeAsync(5000);
      await seedPromise;

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Attempt 1/3 failed'));
      jest.useRealTimers();
    });

    it('logs error after all retries exhausted', async () => {
      jest.useFakeTimers();
      jest
        .spyOn(SystemGrant, 'bulkWrite')
        .mockRejectedValueOnce(new Error('disk full'))
        .mockRejectedValueOnce(new Error('disk full'))
        .mockRejectedValueOnce(new Error('disk full'));

      const seedPromise = methods.seedSystemGrants();
      await jest.advanceTimersByTimeAsync(10000);
      await seedPromise;

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to seed capabilities after all retries'),
        expect.any(Error),
      );
      jest.useRealTimers();
    });
  });

  describe('grantCapability', () => {
    it('creates a grant and returns the document', async () => {
      const userId = new Types.ObjectId();
      const { grant: doc, created } = await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });

      expect(doc).toBeTruthy();
      expect(created).toBe(true);
      expect(doc!.principalType).toBe(PrincipalType.USER);
      expect(doc!.capability).toBe(SystemCapabilities.READ_USERS);
      expect(doc!.grantedAt).toBeInstanceOf(Date);
    });

    it('is idempotent — second call does not create a duplicate', async () => {
      const userId = new Types.ObjectId();
      const params = {
        principalType: PrincipalType.USER as const,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS as SystemCapability,
      };

      await methods.grantCapability(params);
      await methods.grantCapability(params);

      const count = await SystemGrant.countDocuments({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });
      expect(count).toBe(1);
    });

    it('stores grantedBy when provided', async () => {
      const userId = new Types.ObjectId();
      const grantedBy = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_CONFIGS,
        grantedBy,
      });

      const grant = await SystemGrant.findOne({
        principalType: PrincipalType.USER,
        principalId: userId,
      }).lean();

      expect(grant!.grantedBy!.toString()).toBe(grantedBy.toString());
    });

    it('stores tenant-scoped grants with tenantId field present', async () => {
      const userId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USAGE,
        tenantId: 'tenant-abc',
      });

      const grant = await SystemGrant.findOne({
        principalType: PrincipalType.USER,
        principalId: userId,
        tenantId: 'tenant-abc',
      }).lean();

      expect(grant).toBeTruthy();
      expect(grant!.tenantId).toBe('tenant-abc');
    });

    it('normalizes string userId to ObjectId for USER principal', async () => {
      const userId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId.toString(),
        capability: SystemCapabilities.READ_USERS,
      });

      const grant = await SystemGrant.findOne({ capability: SystemCapabilities.READ_USERS }).lean();
      expect(grant!.principalId.toString()).toBe(userId.toString());
      expect(grant!.principalId).toBeInstanceOf(Types.ObjectId);
    });

    it('normalizes string groupId to ObjectId for GROUP principal', async () => {
      const groupId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: groupId.toString(),
        capability: SystemCapabilities.READ_AGENTS,
      });

      const grant = await SystemGrant.findOne({
        capability: SystemCapabilities.READ_AGENTS,
      }).lean();
      expect(grant!.principalId).toBeInstanceOf(Types.ObjectId);
    });

    it('keeps ROLE principalId as a string (no ObjectId cast)', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'CUSTOM_ROLE',
        capability: SystemCapabilities.READ_CONFIGS,
      });

      const grant = await SystemGrant.findOne({
        principalType: PrincipalType.ROLE,
        principalId: 'CUSTOM_ROLE',
      }).lean();

      expect(grant).toBeTruthy();
      expect(typeof grant!.principalId).toBe('string');
    });

    it('allows same capability for same principal in different tenants', async () => {
      const userId = new Types.ObjectId();
      const params = {
        principalType: PrincipalType.USER as const,
        principalId: userId,
        capability: SystemCapabilities.ACCESS_ADMIN as SystemCapability,
      };

      await methods.grantCapability({ ...params, tenantId: 'tenant-1' });
      await methods.grantCapability({ ...params, tenantId: 'tenant-2' });

      const count = await SystemGrant.countDocuments({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      expect(count).toBe(2);
    });

    it('handles E11000 race condition — returns existing doc instead of throwing', async () => {
      const userId = new Types.ObjectId();
      const params = {
        principalType: PrincipalType.USER as const,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS as SystemCapability,
      };

      const { grant: original } = await methods.grantCapability(params);

      // Simulate a race: findOneAndUpdate upserts but hits a duplicate key
      const model = mongoose.models.SystemGrant;
      jest
        .spyOn(model, 'findOneAndUpdate')
        .mockRejectedValueOnce(
          Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }),
        );

      const { grant: result, created } = await methods.grantCapability(params);
      expect(result).toBeTruthy();
      // a lost upsert race is not a new creation, so it must not be audited
      expect(created).toBe(false);
      expect(result!.capability).toBe(SystemCapabilities.READ_USERS);
      expect(result!.principalId.toString()).toBe(original!.principalId.toString());
    });

    it('re-throws non-E11000 errors from findOneAndUpdate', async () => {
      const model = mongoose.models.SystemGrant;
      jest.spyOn(model, 'findOneAndUpdate').mockRejectedValueOnce(new Error('connection timeout'));

      await expect(
        methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: new Types.ObjectId(),
          capability: SystemCapabilities.READ_USERS,
        }),
      ).rejects.toThrow('connection timeout');
    });

    it('throws TypeError for invalid ObjectId string on USER principal', async () => {
      await expect(
        methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: 'not-a-valid-objectid',
          capability: SystemCapabilities.READ_USERS,
        }),
      ).rejects.toThrow(TypeError);
    });

    it('throws TypeError for invalid ObjectId string on GROUP principal', async () => {
      await expect(
        methods.grantCapability({
          principalType: PrincipalType.GROUP,
          principalId: 'also-invalid',
          capability: SystemCapabilities.READ_AGENTS,
        }),
      ).rejects.toThrow(TypeError);
    });

    it('accepts any string for ROLE principal without ObjectId validation', async () => {
      const { grant: doc } = await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'ANY_STRING_HERE',
        capability: SystemCapabilities.READ_CONFIGS,
      });
      expect(doc).toBeTruthy();
      expect(doc!.principalId).toBe('ANY_STRING_HERE');
    });
  });

  describe('revokeCapability', () => {
    it('removes the grant document', async () => {
      const userId = new Types.ObjectId();

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
      }).lean();
      expect(grant).toBeNull();
    });

    it('is a no-op when the grant does not exist', async () => {
      await expect(
        methods.revokeCapability({
          principalType: PrincipalType.USER,
          principalId: new Types.ObjectId(),
          capability: SystemCapabilities.MANAGE_USERS,
        }),
      ).resolves.not.toThrow();
    });

    it('normalizes string userId when revoking', async () => {
      const userId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USAGE,
      });

      await methods.revokeCapability({
        principalType: PrincipalType.USER,
        principalId: userId.toString(),
        capability: SystemCapabilities.READ_USAGE,
      });

      const count = await SystemGrant.countDocuments({
        principalType: PrincipalType.USER,
        principalId: userId,
      });
      expect(count).toBe(0);
    });

    it('only revokes the specified tenant grant', async () => {
      const userId = new Types.ObjectId();
      const params = {
        principalType: PrincipalType.USER as const,
        principalId: userId,
        capability: SystemCapabilities.READ_CONFIGS as SystemCapability,
      };

      await methods.grantCapability({ ...params, tenantId: 'tenant-1' });
      await methods.grantCapability({ ...params, tenantId: 'tenant-2' });

      await methods.revokeCapability({ ...params, tenantId: 'tenant-1' });

      const remaining = await SystemGrant.find({
        principalType: PrincipalType.USER,
        principalId: userId,
      }).lean();

      expect(remaining).toHaveLength(1);
      expect(remaining[0].tenantId).toBe('tenant-2');
    });

    it('throws TypeError for invalid ObjectId string on USER principal', async () => {
      await expect(
        methods.revokeCapability({
          principalType: PrincipalType.USER,
          principalId: 'bad-id',
          capability: SystemCapabilities.READ_USERS,
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('hasCapabilityForPrincipals', () => {
    it('returns true when a role principal holds the capability', async () => {
      await methods.seedSystemGrants();

      const result = await methods.hasCapabilityForPrincipals({
        principals: [
          { principalType: PrincipalType.USER, principalId: new Types.ObjectId() },
          { principalType: PrincipalType.ROLE, principalId: SystemRoles.ADMIN },
          { principalType: PrincipalType.PUBLIC },
        ],
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      expect(result).toBe(true);
    });

    it('returns false when no principal has the capability', async () => {
      const result = await methods.hasCapabilityForPrincipals({
        principals: [
          { principalType: PrincipalType.USER, principalId: new Types.ObjectId() },
          { principalType: PrincipalType.ROLE, principalId: SystemRoles.USER },
          { principalType: PrincipalType.PUBLIC },
        ],
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      expect(result).toBe(false);
    });

    it('returns false for an empty principals array', async () => {
      const result = await methods.hasCapabilityForPrincipals({
        principals: [],
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      expect(result).toBe(false);
    });

    it('returns false when only PUBLIC principals are present', async () => {
      const result = await methods.hasCapabilityForPrincipals({
        principals: [{ principalType: PrincipalType.PUBLIC }],
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      expect(result).toBe(false);
    });

    it('matches user-level grants', async () => {
      const userId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_CONFIGS,
      });

      const result = await methods.hasCapabilityForPrincipals({
        principals: [
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.ROLE, principalId: SystemRoles.USER },
        ],
        capability: SystemCapabilities.READ_CONFIGS,
      });
      expect(result).toBe(true);
    });

    it('matches group-level grants', async () => {
      const groupId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        capability: SystemCapabilities.READ_USAGE,
      });

      const result = await methods.hasCapabilityForPrincipals({
        principals: [
          { principalType: PrincipalType.USER, principalId: new Types.ObjectId() },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ],
        capability: SystemCapabilities.READ_USAGE,
      });
      expect(result).toBe(true);
    });

    it('finds grant when string userId was used to create it and ObjectId to query', async () => {
      const userId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId.toString(),
        capability: SystemCapabilities.READ_USAGE,
      });

      const result = await methods.hasCapabilityForPrincipals({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
        capability: SystemCapabilities.READ_USAGE,
      });
      expect(result).toBe(true);
    });

    describe('capability implications', () => {
      it.each(
        (
          Object.entries(CapabilityImplications) as [SystemCapability, SystemCapability[]][]
        ).flatMap(([broad, implied]) => implied.map((imp) => [broad, imp] as const)),
      )('%s implies %s', async (broadCap, impliedCap) => {
        const userId = new Types.ObjectId();

        await methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: userId,
          capability: broadCap,
        });

        const result = await methods.hasCapabilityForPrincipals({
          principals: [{ principalType: PrincipalType.USER, principalId: userId }],
          capability: impliedCap,
        });
        expect(result).toBe(true);
      });

      it.each(
        (
          Object.entries(CapabilityImplications) as [SystemCapability, SystemCapability[]][]
        ).flatMap(([broad, implied]) => implied.map((imp) => [imp, broad] as const)),
      )('%s does NOT imply %s (reverse)', async (narrowCap, broadCap) => {
        const userId = new Types.ObjectId();

        await methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: userId,
          capability: narrowCap,
        });

        const result = await methods.hasCapabilityForPrincipals({
          principals: [{ principalType: PrincipalType.USER, principalId: userId }],
          capability: broadCap,
        });
        expect(result).toBe(false);
      });
    });

    describe('hierarchical config capabilities', () => {
      it('manage:configs satisfies manage:configs:<section>', async () => {
        const userId = new Types.ObjectId();
        await methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: userId,
          capability: SystemCapabilities.MANAGE_CONFIGS,
        });

        const result = await methods.hasCapabilityForPrincipals({
          principals: [{ principalType: PrincipalType.USER, principalId: userId }],
          capability: 'manage:configs:endpoints' as SystemCapability,
        });
        expect(result).toBe(true);
      });

      it('manage:configs satisfies read:configs:<section> transitively', async () => {
        const userId = new Types.ObjectId();
        await methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: userId,
          capability: SystemCapabilities.MANAGE_CONFIGS,
        });

        const result = await methods.hasCapabilityForPrincipals({
          principals: [{ principalType: PrincipalType.USER, principalId: userId }],
          capability: 'read:configs:endpoints' as SystemCapability,
        });
        expect(result).toBe(true);
      });

      it('read:configs satisfies read:configs:<section> but NOT manage:configs:<section>', async () => {
        const userId = new Types.ObjectId();
        await methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: userId,
          capability: SystemCapabilities.READ_CONFIGS,
        });

        const readResult = await methods.hasCapabilityForPrincipals({
          principals: [{ principalType: PrincipalType.USER, principalId: userId }],
          capability: 'read:configs:endpoints' as SystemCapability,
        });
        expect(readResult).toBe(true);

        const manageResult = await methods.hasCapabilityForPrincipals({
          principals: [{ principalType: PrincipalType.USER, principalId: userId }],
          capability: 'manage:configs:endpoints' as SystemCapability,
        });
        expect(manageResult).toBe(false);
      });

      it('assign:configs satisfies assign:configs:<target>', async () => {
        const userId = new Types.ObjectId();
        await methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: userId,
          capability: SystemCapabilities.ASSIGN_CONFIGS,
        });

        const result = await methods.hasCapabilityForPrincipals({
          principals: [{ principalType: PrincipalType.USER, principalId: userId }],
          capability: 'assign:configs:user' as SystemCapability,
        });
        expect(result).toBe(true);
      });
    });

    describe('tenant scoping', () => {
      it('tenant-scoped grant does not match platform-level query', async () => {
        const userId = new Types.ObjectId();

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

      it('platform-level grant satisfies tenant-scoped query', async () => {
        const userId = new Types.ObjectId();

        await methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: userId,
          capability: SystemCapabilities.READ_CONFIGS,
        });

        const result = await methods.hasCapabilityForPrincipals({
          principals: [{ principalType: PrincipalType.USER, principalId: userId }],
          capability: SystemCapabilities.READ_CONFIGS,
          tenantId: 'tenant-1',
        });
        expect(result).toBe(true);
      });

      it('tenant-scoped grant matches same-tenant query', async () => {
        const userId = new Types.ObjectId();

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
        const userId = new Types.ObjectId();

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

  describe('getCapabilitiesForPrincipal', () => {
    it('lists all capabilities for the ADMIN role after seeding', async () => {
      await methods.seedSystemGrants();

      const grants = await methods.getCapabilitiesForPrincipal({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
      });

      expect(grants).toHaveLength(Object.values(SystemCapabilities).length);
      const caps = grants.map((g) => g.capability).sort();
      expect(caps).toEqual(Object.values(SystemCapabilities).sort());
    });

    it('returns empty array when principal has no grants', async () => {
      const grants = await methods.getCapabilitiesForPrincipal({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
      });
      expect(grants).toHaveLength(0);
    });

    it('normalizes string userId for lookup', async () => {
      const userId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USAGE,
      });

      const grants = await methods.getCapabilitiesForPrincipal({
        principalType: PrincipalType.USER,
        principalId: userId.toString(),
      });
      expect(grants).toHaveLength(1);
      expect(grants[0].capability).toBe(SystemCapabilities.READ_USAGE);
    });

    it('only returns grants for the specified tenant', async () => {
      const userId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-1',
      });
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USAGE,
        tenantId: 'tenant-2',
      });

      const grants = await methods.getCapabilitiesForPrincipal({
        principalType: PrincipalType.USER,
        principalId: userId,
        tenantId: 'tenant-1',
      });
      expect(grants).toHaveLength(1);
      expect(grants[0].capability).toBe(SystemCapabilities.READ_CONFIGS);
    });

    it('includes platform-level grants when called with a tenantId', async () => {
      await methods.seedSystemGrants();

      const grants = await methods.getCapabilitiesForPrincipal({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
        tenantId: 'acme',
      });

      expect(grants.some((g) => g.capability === SystemCapabilities.ACCESS_ADMIN)).toBe(true);
      expect(grants).toHaveLength(Object.values(SystemCapabilities).length);
    });

    it('throws TypeError for invalid ObjectId string on USER principal', async () => {
      await expect(
        methods.getCapabilitiesForPrincipal({
          principalType: PrincipalType.USER,
          principalId: 'not-valid',
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('deleteGrantsForPrincipal', () => {
    it('deletes all grants for a principal', async () => {
      const groupId = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        capability: SystemCapabilities.READ_USERS,
      });
      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        capability: SystemCapabilities.READ_CONFIGS,
      });

      await methods.deleteGrantsForPrincipal(PrincipalType.GROUP, groupId);

      const remaining = await SystemGrant.countDocuments({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
      });
      expect(remaining).toBe(0);
    });

    it('is a no-op for principal with no grants', async () => {
      const groupId = new Types.ObjectId();

      await expect(
        methods.deleteGrantsForPrincipal(PrincipalType.GROUP, groupId),
      ).resolves.not.toThrow();
    });

    it('does not affect other principals', async () => {
      const groupA = new Types.ObjectId();
      const groupB = new Types.ObjectId();

      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: groupA,
        capability: SystemCapabilities.READ_USERS,
      });
      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: groupB,
        capability: SystemCapabilities.READ_USERS,
      });

      await methods.deleteGrantsForPrincipal(PrincipalType.GROUP, groupA);

      const remainingA = await SystemGrant.countDocuments({
        principalType: PrincipalType.GROUP,
        principalId: groupA,
      });
      const remainingB = await SystemGrant.countDocuments({
        principalType: PrincipalType.GROUP,
        principalId: groupB,
      });
      expect(remainingA).toBe(0);
      expect(remainingB).toBe(1);
    });

    it('with tenantId deletes only tenant-scoped grants, not platform-level grants', async () => {
      // Platform-level grant (no tenantId)
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
        capability: SystemCapabilities.READ_USERS,
      });
      // Tenant-scoped grant
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
        capability: SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-1',
      });
      // Different tenant grant
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
        capability: SystemCapabilities.READ_GROUPS,
        tenantId: 'tenant-2',
      });

      await methods.deleteGrantsForPrincipal(PrincipalType.ROLE, 'editor', {
        tenantId: 'tenant-1',
      });

      const remaining = await SystemGrant.find({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
      }).lean();
      const caps = remaining.map((g) => g.capability).sort();
      // Platform-level and tenant-2 grants survive
      expect(caps).toEqual([SystemCapabilities.READ_GROUPS, SystemCapabilities.READ_USERS]);
    });

    it('without tenantId deletes all grants across all tenants', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'temp-role',
        capability: SystemCapabilities.READ_USERS,
      });
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'temp-role',
        capability: SystemCapabilities.READ_CONFIGS,
        tenantId: 'tenant-a',
      });

      await methods.deleteGrantsForPrincipal(PrincipalType.ROLE, 'temp-role');

      const remaining = await SystemGrant.countDocuments({
        principalType: PrincipalType.ROLE,
        principalId: 'temp-role',
      });
      expect(remaining).toBe(0);
    });
  });

  describe('schema validation', () => {
    it('starts with the non-sparse unique grant index ready', async () => {
      const indexes = await SystemGrant.collection.indexes();
      const unique = indexes.find((index) => index.unique === true);
      expect(unique?.key).toEqual({
        principalType: 1,
        principalId: 1,
        capability: 1,
        tenantId: 1,
      });
      expect(unique?.sparse).not.toBe(true);
    });

    it('rejects null tenantId at the schema level', async () => {
      await expect(
        SystemGrant.create({
          principalType: PrincipalType.USER,
          principalId: new Types.ObjectId(),
          capability: SystemCapabilities.READ_USERS,
          tenantId: null,
        }),
      ).rejects.toThrow(/tenantId/);
    });

    it('rejects empty string tenantId at the schema level', async () => {
      await expect(
        SystemGrant.create({
          principalType: PrincipalType.USER,
          principalId: new Types.ObjectId(),
          capability: SystemCapabilities.READ_USERS,
          tenantId: '',
        }),
      ).rejects.toThrow(/tenantId/);
    });

    it('rejects invalid principalType values', async () => {
      await expect(
        SystemGrant.create({
          principalType: 'INVALID_TYPE',
          principalId: new Types.ObjectId(),
          capability: SystemCapabilities.READ_USERS,
        }),
      ).rejects.toThrow(/principalType/);
    });

    it('requires principalType field', async () => {
      await expect(
        SystemGrant.create({
          principalId: new Types.ObjectId(),
          capability: SystemCapabilities.READ_USERS,
        }),
      ).rejects.toThrow(/principalType/);
    });

    it('requires principalId field', async () => {
      await expect(
        SystemGrant.create({
          principalType: PrincipalType.USER,
          capability: SystemCapabilities.READ_USERS,
        }),
      ).rejects.toThrow(/principalId/);
    });

    it('requires capability field', async () => {
      await expect(
        SystemGrant.create({
          principalType: PrincipalType.USER,
          principalId: new Types.ObjectId(),
        }),
      ).rejects.toThrow(/capability/);
    });

    it('rejects invalid capability strings', async () => {
      await expect(
        SystemGrant.create({
          principalType: PrincipalType.USER,
          principalId: new Types.ObjectId(),
          capability: 'god:mode',
        }),
      ).rejects.toThrow(/Invalid capability string/);
    });

    it('accepts valid section-level config capabilities', async () => {
      const doc = await SystemGrant.create({
        principalType: PrincipalType.USER,
        principalId: new Types.ObjectId(),
        capability: 'manage:configs:endpoints',
      });
      expect(doc.capability).toBe('manage:configs:endpoints');
    });

    it('accepts valid assign config capabilities', async () => {
      const doc = await SystemGrant.create({
        principalType: PrincipalType.USER,
        principalId: new Types.ObjectId(),
        capability: 'assign:configs:group',
      });
      expect(doc.capability).toBe('assign:configs:group');
    });

    it('enforces unique compound index (principalType + principalId + capability + tenantId)', async () => {
      const doc = {
        principalType: PrincipalType.USER,
        principalId: new Types.ObjectId(),
        capability: SystemCapabilities.READ_USERS,
      };

      await SystemGrant.create(doc);

      await expect(SystemGrant.create(doc)).rejects.toThrow(/duplicate key|E11000/);
    });

    it('rejects duplicate platform-level grants (absent tenantId) — non-sparse index', async () => {
      const principalId = new Types.ObjectId();

      await SystemGrant.create({
        principalType: PrincipalType.USER,
        principalId,
        capability: SystemCapabilities.ACCESS_ADMIN,
      });

      await expect(
        SystemGrant.create({
          principalType: PrincipalType.USER,
          principalId,
          capability: SystemCapabilities.ACCESS_ADMIN,
        }),
      ).rejects.toThrow(/duplicate key|E11000/);
    });

    it('allows same grant for different tenants (tenantId is part of unique key)', async () => {
      const principalId = new Types.ObjectId();
      const base = {
        principalType: PrincipalType.USER,
        principalId,
        capability: SystemCapabilities.ACCESS_ADMIN,
      };

      await SystemGrant.create({ ...base, tenantId: 'tenant-a' });
      await SystemGrant.create({ ...base, tenantId: 'tenant-b' });

      const count = await SystemGrant.countDocuments({ principalId });
      expect(count).toBe(2);
    });

    it('platform-level and tenant-scoped grants coexist (different unique key values)', async () => {
      const principalId = new Types.ObjectId();
      const base = {
        principalType: PrincipalType.USER,
        principalId,
        capability: SystemCapabilities.ACCESS_ADMIN,
      };

      await SystemGrant.create(base);
      await SystemGrant.create({ ...base, tenantId: 'tenant-1' });

      const count = await SystemGrant.countDocuments({ principalId });
      expect(count).toBe(2);
    });
  });

  describe('listGrants', () => {
    beforeEach(async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
        capability: SystemCapabilities.READ_USERS,
      });
      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: new Types.ObjectId(),
        capability: SystemCapabilities.READ_CONFIGS,
      });
    });

    it('returns all platform-level grants when called without options', async () => {
      const grants = await methods.listGrants();
      expect(grants).toHaveLength(3);
    });

    it('respects limit parameter', async () => {
      const grants = await methods.listGrants({ limit: 2 });
      expect(grants).toHaveLength(2);
    });

    it('respects offset parameter', async () => {
      const all = await methods.listGrants();
      const page2 = await methods.listGrants({ offset: 2, limit: 10 });
      expect(page2).toHaveLength(1);
      expect(page2[0].capability).toBe(all[2].capability);
    });

    it('filters by principalTypes', async () => {
      const grants = await methods.listGrants({
        principalTypes: [PrincipalType.ROLE],
      });
      expect(grants).toHaveLength(2);
      for (const g of grants) {
        expect(g.principalType).toBe(PrincipalType.ROLE);
      }
    });

    it('returns empty array for principalTypes with no grants', async () => {
      const grants = await methods.listGrants({
        principalTypes: [PrincipalType.USER],
      });
      expect(grants).toHaveLength(0);
    });

    it('excludes tenant-scoped grants when no tenantId provided', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.MANAGE_USERS,
        tenantId: 'tenant-1',
      });

      const grants = await methods.listGrants();
      expect(grants.every((g) => !('tenantId' in g && g.tenantId))).toBe(true);
    });

    it('includes tenant and platform grants when tenantId provided', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.MANAGE_USERS,
        tenantId: 'tenant-1',
      });

      const grants = await methods.listGrants({ tenantId: 'tenant-1' });
      expect(grants).toHaveLength(4);
    });

    it('sorts by principalType then capability', async () => {
      const grants = await methods.listGrants();
      for (let i = 1; i < grants.length; i++) {
        const prev = `${grants[i - 1].principalType}:${grants[i - 1].capability}`;
        const curr = `${grants[i].principalType}:${grants[i].capability}`;
        expect(prev <= curr).toBe(true);
      }
    });
  });

  describe('countGrants', () => {
    it('returns total count matching the filter', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
        capability: SystemCapabilities.READ_USERS,
      });
      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: new Types.ObjectId(),
        capability: SystemCapabilities.READ_CONFIGS,
      });

      const total = await methods.countGrants();
      expect(total).toBe(3);
    });

    it('filters by principalTypes', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: new Types.ObjectId(),
        capability: SystemCapabilities.READ_CONFIGS,
      });

      const count = await methods.countGrants({
        principalTypes: [PrincipalType.ROLE],
      });
      expect(count).toBe(1);
    });

    it('returns 0 when no grants match', async () => {
      const count = await methods.countGrants();
      expect(count).toBe(0);
    });
  });

  describe('getCapabilitiesForPrincipals', () => {
    it('returns grants across multiple principals in a single query', async () => {
      const userId = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'editor',
        capability: SystemCapabilities.READ_ROLES,
      });

      const grants = await methods.getCapabilitiesForPrincipals({
        principals: [
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.ROLE, principalId: 'editor' },
        ],
      });

      expect(grants).toHaveLength(2);
      const caps = grants.map((g) => g.capability).sort();
      expect(caps).toEqual([SystemCapabilities.READ_ROLES, SystemCapabilities.READ_USERS]);
    });

    it('returns empty array for empty principals list', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.ACCESS_ADMIN,
      });

      const grants = await methods.getCapabilitiesForPrincipals({ principals: [] });
      expect(grants).toEqual([]);
    });

    it('returns only matching principals, not all grants', async () => {
      const userId = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'unrelated',
        capability: SystemCapabilities.MANAGE_ROLES,
      });

      const grants = await methods.getCapabilitiesForPrincipals({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
      });

      expect(grants).toHaveLength(1);
      expect(grants[0].capability).toBe(SystemCapabilities.READ_USERS);
    });

    it('returns multiple grants for the same principal', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.MANAGE_ROLES,
      });

      const grants = await methods.getCapabilitiesForPrincipals({
        principals: [{ principalType: PrincipalType.ROLE, principalId: 'admin' }],
      });

      expect(grants).toHaveLength(2);
    });

    it('excludes tenant-scoped grants when no tenantId provided', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.MANAGE_USERS,
        tenantId: 'tenant-1',
      });

      const grants = await methods.getCapabilitiesForPrincipals({
        principals: [{ principalType: PrincipalType.ROLE, principalId: 'admin' }],
      });

      expect(grants).toHaveLength(1);
      expect(grants[0].capability).toBe(SystemCapabilities.ACCESS_ADMIN);
    });

    it('includes both platform and tenant grants when tenantId provided', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.ACCESS_ADMIN,
      });
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.MANAGE_USERS,
        tenantId: 'tenant-1',
      });

      const grants = await methods.getCapabilitiesForPrincipals({
        principals: [{ principalType: PrincipalType.ROLE, principalId: 'admin' }],
        tenantId: 'tenant-1',
      });

      expect(grants).toHaveLength(2);
    });

    it('filters out PUBLIC principals before querying', async () => {
      const userId = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USERS,
      });

      const grants = await methods.getCapabilitiesForPrincipals({
        principals: [
          { principalType: PrincipalType.PUBLIC, principalId: '' },
          { principalType: PrincipalType.USER, principalId: userId },
        ],
      });

      expect(grants).toHaveLength(1);
      expect(grants[0].capability).toBe(SystemCapabilities.READ_USERS);
    });

    it('returns empty array when all principals are PUBLIC', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.ACCESS_ADMIN,
      });

      const grants = await methods.getCapabilitiesForPrincipals({
        principals: [{ principalType: PrincipalType.PUBLIC, principalId: '' }],
      });

      expect(grants).toEqual([]);
    });
  });

  describe('getHeldCapabilities', () => {
    const userId = new Types.ObjectId();

    it('returns the subset of capabilities the principals hold', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_ROLES,
      });

      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
        capabilities: [SystemCapabilities.READ_ROLES, SystemCapabilities.READ_GROUPS],
      });

      expect(held).toEqual(new Set([SystemCapabilities.READ_ROLES]));
    });

    it('returns empty set when no capabilities match', async () => {
      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: new Types.ObjectId() }],
        capabilities: [SystemCapabilities.MANAGE_ROLES],
      });

      expect(held.size).toBe(0);
    });

    it('returns empty set for empty principals', async () => {
      const held = await methods.getHeldCapabilities({
        principals: [],
        capabilities: [SystemCapabilities.READ_ROLES],
      });

      expect(held.size).toBe(0);
    });

    it('returns empty set for empty capabilities', async () => {
      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
        capabilities: [],
      });

      expect(held.size).toBe(0);
    });

    it('resolves implied capabilities via reverse implication map', async () => {
      const implUser = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: implUser,
        capability: SystemCapabilities.MANAGE_ROLES,
      });

      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: implUser }],
        capabilities: [SystemCapabilities.READ_ROLES, SystemCapabilities.MANAGE_GROUPS],
      });

      expect(held).toEqual(new Set([SystemCapabilities.READ_ROLES]));
    });

    it('excludes principals with undefined principalId', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'admin',
        capability: SystemCapabilities.READ_ROLES,
      });

      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.ROLE }],
        capabilities: [SystemCapabilities.READ_ROLES],
      });

      expect(held.size).toBe(0);
    });

    it('filters out PUBLIC principals', async () => {
      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.PUBLIC, principalId: '' }],
        capabilities: [SystemCapabilities.READ_ROLES],
      });

      expect(held.size).toBe(0);
    });

    it('respects tenant scoping', async () => {
      const tenantUser = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: tenantUser,
        capability: SystemCapabilities.READ_ROLES,
        tenantId: 'tenant-a',
      });

      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: tenantUser }],
        capabilities: [SystemCapabilities.READ_ROLES],
        tenantId: 'tenant-a',
      });
      expect(held).toEqual(new Set([SystemCapabilities.READ_ROLES]));

      const heldOther = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: tenantUser }],
        capabilities: [SystemCapabilities.READ_ROLES],
        tenantId: 'tenant-b',
      });
      expect(heldOther.size).toBe(0);

      const heldNoTenant = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: tenantUser }],
        capabilities: [SystemCapabilities.READ_ROLES],
      });
      expect(heldNoTenant.size).toBe(0);
    });

    it('resolves extended capability when principal holds the parent base capability', async () => {
      const extUser = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: extUser,
        capability: SystemCapabilities.MANAGE_CONFIGS,
      });

      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: extUser }],
        capabilities: ['manage:configs:endpoints' as SystemCapability],
      });

      expect(held).toEqual(new Set(['manage:configs:endpoints']));
    });

    it('does not resolve extended capability when principal holds a different verb parent', async () => {
      const readOnlyUser = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: readOnlyUser,
        capability: SystemCapabilities.READ_CONFIGS,
      });

      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: readOnlyUser }],
        capabilities: ['manage:configs:endpoints' as SystemCapability],
      });

      expect(held.size).toBe(0);
    });

    it('resolves a section-scoped read capability when the principal holds the same-section manage grant', async () => {
      const sectionManager = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: sectionManager,
        capability: 'manage:configs:endpoints' as SystemCapability,
      });

      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: sectionManager }],
        capabilities: ['read:configs:endpoints' as SystemCapability],
      });

      expect(held).toEqual(new Set(['read:configs:endpoints']));
    });

    it("does not resolve a read capability from a different section's manage grant", async () => {
      const otherSectionManager = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: otherSectionManager,
        capability: 'manage:configs:balance' as SystemCapability,
      });

      const held = await methods.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.USER, principalId: otherSectionManager }],
        capabilities: ['read:configs:endpoints' as SystemCapability],
      });

      expect(held.size).toBe(0);
    });
  });

  describe('hasAnyConfigReadAccess', () => {
    it('returns true for a broad read:configs holder', async () => {
      const userId = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_CONFIGS,
      });

      const result = await methods.hasAnyConfigReadAccess({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
      });
      expect(result).toBe(true);
    });

    it('returns true for a broad manage:configs holder, which implies read', async () => {
      const userId = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.MANAGE_CONFIGS,
      });

      const result = await methods.hasAnyConfigReadAccess({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
      });
      expect(result).toBe(true);
    });

    it('returns true for a section-scoped read:configs:<section> holder', async () => {
      const userId = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: 'read:configs:endpoints' as SystemCapability,
      });

      const result = await methods.hasAnyConfigReadAccess({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
      });
      expect(result).toBe(true);
    });

    it('returns true for a section-scoped manage:configs:<section> holder', async () => {
      const userId = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: 'manage:configs:endpoints' as SystemCapability,
      });

      const result = await methods.hasAnyConfigReadAccess({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
      });
      expect(result).toBe(true);
    });

    it('returns false for a caller with no config capability at all', async () => {
      const userId = new Types.ObjectId();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: SystemCapabilities.READ_USAGE,
      });

      const result = await methods.hasAnyConfigReadAccess({
        principals: [{ principalType: PrincipalType.USER, principalId: userId }],
      });
      expect(result).toBe(false);
    });

    it('returns false for an empty principals array', async () => {
      const result = await methods.hasAnyConfigReadAccess({ principals: [] });
      expect(result).toBe(false);
    });
  });
});
