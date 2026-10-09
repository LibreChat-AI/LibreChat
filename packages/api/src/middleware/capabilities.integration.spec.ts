import express from 'express';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { tenantStorage } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  SystemCapabilities,
  CapabilityImplications,
} from '@librechat/data-schemas';
import type { SystemCapability, ConfigSection } from '@librechat/data-schemas';
import type { AllMethods } from '@librechat/data-schemas';
import {
  generateCapabilityCheck,
  capabilityStore,
  capabilityContextMiddleware,
} from './capabilities';
import { createResetToolApprovalController } from '~/agents/hitl/controller';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

let mongoServer: MongoMemoryServer;
let methods: AllMethods;

const mockGetUserPrincipals = () =>
  jest.fn<ReturnType<AllMethods['getUserPrincipals']>, Parameters<AllMethods['getUserPrincipals']>>(
    methods.getUserPrincipals,
  );

const mockHasCapabilityForPrincipals = () =>
  jest.fn<
    ReturnType<AllMethods['hasCapabilityForPrincipals']>,
    Parameters<AllMethods['hasCapabilityForPrincipals']>
  >(methods.hasCapabilityForPrincipals);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

/**
 * Runs `fn` inside an AsyncLocalStorage context identical to what
 * capabilityContextMiddleware sets up for real Express requests.
 */
function withinRequestContext<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    capabilityContextMiddleware(
      {} as Parameters<typeof capabilityContextMiddleware>[0],
      {} as Parameters<typeof capabilityContextMiddleware>[1],
      () => {
        fn().then(resolve, reject);
      },
    );
  });
}

describe('capabilities integration (real MongoDB)', () => {
  let adminUser: { _id: Types.ObjectId; id: string; role: string };
  let regularUser: { _id: Types.ObjectId; id: string; role: string };

  beforeEach(async () => {
    const User = mongoose.models.User;

    const admin = await User.create({
      name: 'Admin',
      email: 'admin@test.com',
      password: 'password123',
      provider: 'local',
      role: SystemRoles.ADMIN,
    });
    adminUser = { _id: admin._id, id: admin._id.toString(), role: SystemRoles.ADMIN };

    const user = await User.create({
      name: 'Regular',
      email: 'user@test.com',
      password: 'password123',
      provider: 'local',
      role: SystemRoles.USER,
    });
    regularUser = { _id: user._id, id: user._id.toString(), role: SystemRoles.USER };
  });

  describe('end-to-end with real getUserPrincipals + hasCapabilityForPrincipals', () => {
    let hasCapability: ReturnType<typeof generateCapabilityCheck>['hasCapability'];
    let hasConfigCapability: ReturnType<typeof generateCapabilityCheck>['hasConfigCapability'];

    beforeEach(() => {
      ({ hasCapability, hasConfigCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      }));
    });

    it('returns true for ADMIN after seedSystemGrants', async () => {
      await methods.seedSystemGrants();

      const result = await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
      expect(result).toBe(true);
    });

    it('returns false for regular USER (no grants)', async () => {
      await methods.seedSystemGrants();

      const result = await hasCapability(regularUser, SystemCapabilities.ACCESS_ADMIN);
      expect(result).toBe(false);
    });

    it('resolves all seeded capabilities for ADMIN', async () => {
      await methods.seedSystemGrants();

      for (const cap of Object.values(SystemCapabilities)) {
        const result = await hasCapability(adminUser, cap);
        expect(result).toBe(true);
      }
    });

    it('resolves capability implications (MANAGE_X implies READ_X)', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
        capability: SystemCapabilities.MANAGE_USERS,
      });

      const hasManage = await hasCapability(regularUser, SystemCapabilities.MANAGE_USERS);
      const hasRead = await hasCapability(regularUser, SystemCapabilities.READ_USERS);

      expect(hasManage).toBe(true);
      expect(hasRead).toBe(true);
    });

    it('implication is one-directional (READ_X does NOT imply MANAGE_X)', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
        capability: SystemCapabilities.READ_USERS,
      });

      const hasRead = await hasCapability(regularUser, SystemCapabilities.READ_USERS);
      const hasManage = await hasCapability(regularUser, SystemCapabilities.MANAGE_USERS);

      expect(hasRead).toBe(true);
      expect(hasManage).toBe(false);
    });

    it('grants to a specific user work independently of role', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: SystemCapabilities.READ_AGENTS,
      });

      const result = await hasCapability(regularUser, SystemCapabilities.READ_AGENTS);
      expect(result).toBe(true);
    });

    it('grants via group membership are resolved', async () => {
      const Group = mongoose.models.Group;
      const group = await Group.create({
        name: 'Editors',
        source: 'local',
        memberIds: [regularUser.id],
      });

      await methods.grantCapability({
        principalType: PrincipalType.GROUP,
        principalId: group._id,
        capability: SystemCapabilities.MANAGE_PROMPTS,
      });

      const result = await hasCapability(regularUser, SystemCapabilities.MANAGE_PROMPTS);
      expect(result).toBe(true);
    });

    it('revoked capability is no longer granted', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
        capability: SystemCapabilities.READ_USAGE,
      });
      expect(await hasCapability(regularUser, SystemCapabilities.READ_USAGE)).toBe(true);

      await methods.revokeCapability({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
        capability: SystemCapabilities.READ_USAGE,
      });
      expect(await hasCapability(regularUser, SystemCapabilities.READ_USAGE)).toBe(false);
    });

    it('tenant-scoped grant does not leak to platform-level check', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
        capability: SystemCapabilities.ACCESS_ADMIN,
        tenantId: 'tenant-a',
      });

      const platformResult = await hasCapability(regularUser, SystemCapabilities.ACCESS_ADMIN);
      expect(platformResult).toBe(false);

      const tenantResult = await hasCapability(
        { ...regularUser, tenantId: 'tenant-a' },
        SystemCapabilities.ACCESS_ADMIN,
      );
      expect(tenantResult).toBe(true);
    });

    it('personal approval reset honors manage:agents only in its tenant, without a VIEW ACL', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: SystemCapabilities.MANAGE_AGENTS,
        tenantId: 'tenant-a',
      });
      let tenantId = 'tenant-a';
      const acl = jest.fn(async () => false);
      const reset = jest.fn(methods.resetToolApprovalGrants);
      const controller = createResetToolApprovalController({
        getAgent: async () => ({ id: 'shared-agent' }),
        hasCapability,
        canAccessAgent: acl,
        storage: { ...methods, resetToolApprovalGrants: reset },
      });
      const app = express();
      app.use(express.json());
      app.post('/reset', (req, res) =>
        tenantStorage.run({ tenantId }, () =>
          controller(Object.assign(req, { user: { ...regularUser, tenantId } }), res),
        ),
      );
      await request(app)
        .post('/reset')
        .send({ agentId: 'shared-agent' })
        .expect(200, { reset: true });
      expect(acl).not.toHaveBeenCalled();
      expect(reset).toHaveBeenCalledWith(regularUser.id, 'shared-agent', undefined);
      expect(
        await mongoose.models.ToolApprovalGrant.countDocuments({
          user: regularUser.id,
          tenantId: 'tenant-a',
          agentId: 'shared-agent',
        }),
      ).toBe(1);
      tenantId = 'tenant-b';
      await request(app).post('/reset').send({ agentId: 'shared-agent' }).expect(403);
      expect(acl).toHaveBeenCalled();
      expect(reset).toHaveBeenCalledTimes(1);
      expect(await mongoose.models.ToolApprovalGrant.countDocuments({ tenantId: 'tenant-b' })).toBe(
        0,
      );
    });

    it('hasConfigCapability falls back to section-specific grant', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: 'manage:configs:endpoints' as SystemCapability,
      });

      const hasBroad = await hasConfigCapability(regularUser, 'endpoints');
      expect(hasBroad).toBe(true);

      const hasOtherSection = await hasConfigCapability(regularUser, 'balance');
      expect(hasOtherSection).toBe(false);
    });
  });

  describe('getReadableConfigSections', () => {
    let getReadableConfigSections: ReturnType<
      typeof generateCapabilityCheck
    >['getReadableConfigSections'];

    beforeEach(() => {
      ({ getReadableConfigSections } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
        getHeldCapabilities: methods.getHeldCapabilities,
      }));
    });

    it('reports broad access for a broad read:configs holder', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: SystemCapabilities.READ_CONFIGS,
      });

      const readable = await getReadableConfigSections(regularUser, [
        'endpoints',
        'balance',
      ] as ConfigSection[]);
      expect(readable.broad).toBe(true);
    });

    it('reports broad access for a broad manage:configs holder (manage implies read)', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: SystemCapabilities.MANAGE_CONFIGS,
      });

      const readable = await getReadableConfigSections(regularUser, [
        'endpoints',
      ] as ConfigSection[]);
      expect(readable.broad).toBe(true);
    });

    it('resolves only the sections held via section-scoped read grants', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: 'read:configs:endpoints' as SystemCapability,
      });

      const readable = await getReadableConfigSections(regularUser, [
        'endpoints',
        'balance',
      ] as ConfigSection[]);
      expect(readable.broad).toBe(false);
      expect(readable.sections).toEqual(new Set(['endpoints']));
    });

    it('resolves a section as readable for a caller holding only the same-section manage grant', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: 'manage:configs:endpoints' as SystemCapability,
      });

      const readable = await getReadableConfigSections(regularUser, [
        'endpoints',
        'balance',
      ] as ConfigSection[]);
      expect(readable.broad).toBe(false);
      expect(readable.sections).toEqual(new Set(['endpoints']));
    });

    it('resolves an empty set for a caller with no config access', async () => {
      const readable = await getReadableConfigSections(regularUser, [
        'endpoints',
        'balance',
      ] as ConfigSection[]);
      expect(readable.broad).toBe(false);
      expect(readable.sections.size).toBe(0);
    });

    it('resolves all sections via a single getHeldCapabilities call regardless of section count', async () => {
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: 'read:configs:endpoints' as SystemCapability,
      });

      const getHeldCapabilities = jest.fn<
        ReturnType<AllMethods['getHeldCapabilities']>,
        Parameters<AllMethods['getHeldCapabilities']>
      >(methods.getHeldCapabilities);

      const { getReadableConfigSections: batched } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
        getHeldCapabilities,
      });

      const readable = await batched(regularUser, [
        'endpoints',
        'balance',
        'interface',
        'mcpServers',
      ] as ConfigSection[]);

      expect(readable.sections).toEqual(new Set(['endpoints']));
      expect(getHeldCapabilities).toHaveBeenCalledTimes(1);
    });
  });

  describe('AsyncLocalStorage per-request caching', () => {
    it('caches getUserPrincipals within a single request context', async () => {
      await methods.seedSystemGrants();
      const getUserPrincipals = mockGetUserPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      await withinRequestContext(async () => {
        await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
        await hasCapability(adminUser, SystemCapabilities.MANAGE_USERS);
        await hasCapability(adminUser, SystemCapabilities.READ_CONFIGS);
      });

      expect(getUserPrincipals).toHaveBeenCalledTimes(1);
    });

    it('caches capability results within a single request context', async () => {
      await methods.seedSystemGrants();
      const hasCapabilityForPrincipals = mockHasCapabilityForPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals,
      });

      await withinRequestContext(async () => {
        const r1 = await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
        const r2 = await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
        expect(r1).toBe(true);
        expect(r2).toBe(true);
      });

      const accessAdminCalls = hasCapabilityForPrincipals.mock.calls.filter(
        (args) =>
          (args[0] as { capability: SystemCapability }).capability ===
          SystemCapabilities.ACCESS_ADMIN,
      );
      expect(accessAdminCalls).toHaveLength(1);
    });

    it('does NOT share cache across separate request contexts', async () => {
      await methods.seedSystemGrants();
      const getUserPrincipals = mockGetUserPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      await withinRequestContext(async () => {
        await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
      });

      await withinRequestContext(async () => {
        await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
      });

      expect(getUserPrincipals).toHaveBeenCalledTimes(2);
    });

    it('isolates cache between concurrent request contexts', async () => {
      await methods.seedSystemGrants();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: SystemCapabilities.READ_AGENTS,
      });

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      const results = await Promise.all([
        withinRequestContext(async () => {
          const admin = await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
          const agents = await hasCapability(adminUser, SystemCapabilities.READ_AGENTS);
          return { admin, agents, who: 'admin' };
        }),
        withinRequestContext(async () => {
          const admin = await hasCapability(regularUser, SystemCapabilities.ACCESS_ADMIN);
          const agents = await hasCapability(regularUser, SystemCapabilities.READ_AGENTS);
          return { admin, agents, who: 'regular' };
        }),
      ]);

      const adminResult = results.find((r) => r.who === 'admin')!;
      const regularResult = results.find((r) => r.who === 'regular')!;

      expect(adminResult.admin).toBe(true);
      expect(adminResult.agents).toBe(true);
      expect(regularResult.admin).toBe(false);
      expect(regularResult.agents).toBe(true);
    });

    it('falls through to DB when outside request context (no ALS)', async () => {
      await methods.seedSystemGrants();
      const getUserPrincipals = mockGetUserPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
      await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);

      expect(getUserPrincipals).toHaveBeenCalledTimes(2);
    });

    it('caches false results correctly (negative caching)', async () => {
      const hasCapabilityForPrincipals = mockHasCapabilityForPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals,
      });

      await withinRequestContext(async () => {
        const r1 = await hasCapability(regularUser, SystemCapabilities.MANAGE_USERS);
        const r2 = await hasCapability(regularUser, SystemCapabilities.MANAGE_USERS);
        expect(r1).toBe(false);
        expect(r2).toBe(false);
      });

      const manageUserCalls = hasCapabilityForPrincipals.mock.calls.filter(
        (args) =>
          (args[0] as { capability: SystemCapability }).capability ===
          SystemCapabilities.MANAGE_USERS,
      );
      expect(manageUserCalls).toHaveLength(1);
    });

    it('uses separate principal cache keys for different users in same context', async () => {
      await methods.seedSystemGrants();
      const getUserPrincipals = mockGetUserPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      await withinRequestContext(async () => {
        await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
        await hasCapability(regularUser, SystemCapabilities.ACCESS_ADMIN);
      });

      expect(getUserPrincipals).toHaveBeenCalledTimes(2);
    });

    it('uses separate principal cache keys for different tenantIds (same user)', async () => {
      await methods.seedSystemGrants();
      const getUserPrincipals = mockGetUserPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      await withinRequestContext(async () => {
        await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
        await hasCapability(
          { ...adminUser, tenantId: 'tenant-a' },
          SystemCapabilities.ACCESS_ADMIN,
        );
      });

      expect(getUserPrincipals).toHaveBeenCalledTimes(2);
    });
  });

  describe('requireCapability middleware (real DB, real ALS)', () => {
    it('calls next() for granted capability inside request context', async () => {
      await methods.seedSystemGrants();

      const { requireCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      const middleware = requireCapability(SystemCapabilities.ACCESS_ADMIN);
      const next = jest.fn();
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const req = { user: { id: adminUser.id, role: adminUser.role } };
      const res = { status: statusMock };

      await withinRequestContext(async () => {
        await middleware(req as never, res as never, next);
      });

      expect(next).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it('returns 403 for denied capability inside request context', async () => {
      await methods.seedSystemGrants();

      const { requireCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      const middleware = requireCapability(SystemCapabilities.MANAGE_USERS);
      const next = jest.fn();
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const req = { user: { id: regularUser.id, role: regularUser.role } };
      const res = { status: statusMock };

      await withinRequestContext(async () => {
        await middleware(req as never, res as never, next);
      });

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
    });
  });

  describe('ALS edge cases', () => {
    it('returns correct results when ALS context is missing (background job / child process)', async () => {
      await methods.seedSystemGrants();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      expect(capabilityStore.getStore()).toBeUndefined();

      const adminResult = await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
      const userResult = await hasCapability(regularUser, SystemCapabilities.ACCESS_ADMIN);

      expect(adminResult).toBe(true);
      expect(userResult).toBe(false);
    });

    it('every DB call executes (no caching) when ALS context is missing', async () => {
      await methods.seedSystemGrants();
      const getUserPrincipals = mockGetUserPrincipals();
      const hasCapabilityForPrincipals = mockHasCapabilityForPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals,
        hasCapabilityForPrincipals,
      });

      expect(capabilityStore.getStore()).toBeUndefined();

      await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
      await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
      await hasCapability(adminUser, SystemCapabilities.MANAGE_USERS);

      expect(getUserPrincipals).toHaveBeenCalledTimes(3);
      expect(hasCapabilityForPrincipals).toHaveBeenCalledTimes(3);
    });

    it('nested capabilityContextMiddleware creates an independent inner context', async () => {
      await methods.seedSystemGrants();
      const getUserPrincipals = mockGetUserPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      await withinRequestContext(async () => {
        await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);

        await withinRequestContext(async () => {
          await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
        });

        await hasCapability(adminUser, SystemCapabilities.MANAGE_USERS);
      });

      /**
       * Outer context: 1 call (ACCESS_ADMIN) — principals cached, MANAGE_USERS reuses them.
       * Inner context: 1 call (ACCESS_ADMIN) — fresh context, no cache from outer.
       * Total: 2 getUserPrincipals calls.
       */
      expect(getUserPrincipals).toHaveBeenCalledTimes(2);
    });

    it('store.results.set with undefined store is a no-op (optional chaining safety)', async () => {
      await methods.seedSystemGrants();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      expect(capabilityStore.getStore()).toBeUndefined();

      await expect(hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN)).resolves.toBe(true);
    });

    it('grant change mid-request is invisible due to result caching', async () => {
      await methods.seedSystemGrants();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      await withinRequestContext(async () => {
        const before = await hasCapability(regularUser, SystemCapabilities.READ_AGENTS);
        expect(before).toBe(false);

        await methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: regularUser.id,
          capability: SystemCapabilities.READ_AGENTS,
        });

        const after = await hasCapability(regularUser, SystemCapabilities.READ_AGENTS);
        expect(after).toBe(false);
      });

      const afterContext = await hasCapability(regularUser, SystemCapabilities.READ_AGENTS);
      expect(afterContext).toBe(true);
    });

    it('requireCapability works correctly without ALS context', async () => {
      await methods.seedSystemGrants();

      const { requireCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      expect(capabilityStore.getStore()).toBeUndefined();

      const middleware = requireCapability(SystemCapabilities.ACCESS_ADMIN);
      const next = jest.fn();
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const req = { user: { id: adminUser.id, role: adminUser.role } };
      const res = { status: statusMock };

      await middleware(req as never, res as never, next);

      expect(next).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it('concurrent contexts with interleaved awaits maintain isolation', async () => {
      await methods.seedSystemGrants();

      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: regularUser.id,
        capability: SystemCapabilities.READ_AGENTS,
      });

      const getUserPrincipals = mockGetUserPrincipals();

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      let adminResolve: () => void;
      const adminGate = new Promise<void>((r) => {
        adminResolve = r;
      });

      let userResolve: () => void;
      const userGate = new Promise<void>((r) => {
        userResolve = r;
      });

      const adminPromise = withinRequestContext(async () => {
        const r1 = await hasCapability(adminUser, SystemCapabilities.ACCESS_ADMIN);
        adminResolve!();
        await userGate;
        const r2 = await hasCapability(adminUser, SystemCapabilities.READ_AGENTS);
        return { r1, r2 };
      });

      const userPromise = withinRequestContext(async () => {
        await adminGate;
        const r1 = await hasCapability(regularUser, SystemCapabilities.ACCESS_ADMIN);
        userResolve!();
        const r2 = await hasCapability(regularUser, SystemCapabilities.READ_AGENTS);
        return { r1, r2 };
      });

      const [adminResults, userResults] = await Promise.all([adminPromise, userPromise]);

      expect(adminResults.r1).toBe(true);
      expect(adminResults.r2).toBe(true);
      expect(userResults.r1).toBe(false);
      expect(userResults.r2).toBe(true);

      expect(getUserPrincipals).toHaveBeenCalledTimes(2);
    });
  });

  describe('CapabilityImplications consistency', () => {
    it('every implication pair resolves correctly through the full stack', async () => {
      const pairs = Object.entries(CapabilityImplications) as [
        SystemCapability,
        SystemCapability[],
      ][];

      const { hasCapability } = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
      });

      for (const [broadCap, impliedCaps] of pairs) {
        await mongoose.connection.dropDatabase();

        await methods.grantCapability({
          principalType: PrincipalType.USER,
          principalId: regularUser.id,
          capability: broadCap,
        });

        for (const impliedCap of impliedCaps) {
          const result = await hasCapability(regularUser, impliedCap);
          expect(result).toBe(true);
        }

        const hasBroad = await hasCapability(regularUser, broadCap);
        expect(hasBroad).toBe(true);
      }
    });
  });
});
