import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AccessRoleIds, ResourceType } from 'librechat-data-provider';
import { _resetStrictCache } from '../models/plugins/tenantIsolation';
import { createAccessRoleModel } from '~/models/accessRole';
import { createAccessRoleMethods } from './accessRole';
import { tenantStorage } from '~/config/tenantContext';
import { RoleBits } from '~/common';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createAccessRoleMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  /** Applies the tenant-isolation plugin, which is what scopes these queries */
  createAccessRoleModel(mongoose);
  methods = createAccessRoleMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  delete process.env.TENANT_ISOLATION_STRICT;
  _resetStrictCache();
});

/** Seeds the global default roles the way startup does: no tenant context, no `tenantId` */
const seedGlobalRoles = () => methods.seedDefaultRoles();

const createTenantRole = (tenantId: string, role: Parameters<typeof methods.createRole>[0]) =>
  tenantStorage.run({ tenantId }, () => methods.createRole(role));

/** A tenant that redefines `agent_owner` with EDITOR bits, shadowing the global OWNER row */
const shadowAgentOwnerAsEditor = (tenantId: string) =>
  createTenantRole(tenantId, {
    accessRoleId: AccessRoleIds.AGENT_OWNER,
    name: 'tenant-owner',
    resourceType: ResourceType.AGENT,
    permBits: RoleBits.EDITOR,
  });

describe('access role resolution under tenant isolation', () => {
  it.each(['global-first', 'tenant-first'])(
    'prefers tenant overrides with %s insertion order',
    async (order) => {
      await seedGlobalRoles();
      await shadowAgentOwnerAsEditor('tenant-a');
      const stored = await mongoose.models.AccessRole.find().lean();
      const globals = stored.filter((role) => role.tenantId == null);
      const scoped = stored.filter((role) => role.tenantId === 'tenant-a');
      await mongoose.connection.dropDatabase();
      await mongoose.models.AccessRole.insertMany(
        order === 'global-first' ? [...globals, ...scoped] : [...scoped, ...globals],
      );
      const find = jest.spyOn(mongoose.models.AccessRole.collection, 'find');

      const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
      );

      expect(role).toEqual(
        expect.objectContaining({ tenantId: 'tenant-a', permBits: RoleBits.EDITOR }),
      );
      expect(find).toHaveBeenCalledTimes(1);
      expect(find.mock.calls[0][0]).toEqual({ tenantId: { $in: ['tenant-a', null] } });
    },
  );

  it('resolves explicit null global roles under strict isolation', async () => {
    await seedGlobalRoles();
    await mongoose.models.AccessRole.collection.updateMany({}, { $set: { tenantId: null } });
    process.env.TENANT_ISOLATION_STRICT = 'true';
    _resetStrictCache();

    const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
    );

    expect(role).toEqual(expect.objectContaining({ tenantId: null, permBits: RoleBits.OWNER }));
  });

  it('isolates tenant-only provisioning and restores the caller context', async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    _resetStrictCache();
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      await tenantStorage.run({ tenantId }, () => methods.seedDefaultRoles());
    }

    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      const role = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER);
      const roles = await methods.findRolesByResourceType(ResourceType.AGENT);
      expect(role?.tenantId).toBe('tenant-a');
      expect(roles).toHaveLength(3);
      expect(roles.every((entry) => entry.tenantId === 'tenant-a')).toBe(true);
      const scopedRoles = await mongoose.models.AccessRole.find().lean();
      expect(scopedRoles.every((entry) => entry.tenantId === 'tenant-a')).toBe(true);
    });
    await tenantStorage.run({ tenantId: 'tenant-c' }, async () => {
      await expect(methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER)).resolves.toBeNull();
      await expect(methods.findRolesByResourceType(ResourceType.AGENT)).resolves.toEqual([]);
    });
  });

  describe('findRoleByIdentifier', () => {
    it('resolves a global default role from inside a tenant context', async () => {
      await seedGlobalRoles();

      const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
      );

      expect(role).toEqual(
        expect.objectContaining({
          accessRoleId: AccessRoleIds.AGENT_OWNER,
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.OWNER,
        }),
      );
    });

    it('resolves a global default role under strict isolation', async () => {
      await seedGlobalRoles();
      process.env.TENANT_ISOLATION_STRICT = 'true';
      _resetStrictCache();

      const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRoleByIdentifier(AccessRoleIds.SKILL_OWNER),
      );

      expect(role).toEqual(expect.objectContaining({ accessRoleId: AccessRoleIds.SKILL_OWNER }));
    });

    it("prefers the tenant's own copy of a role over the global one", async () => {
      await seedGlobalRoles();
      await shadowAgentOwnerAsEditor('tenant-a');

      const scoped = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
      );
      const other = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
      );

      expect(scoped).toEqual(
        expect.objectContaining({ tenantId: 'tenant-a', permBits: RoleBits.EDITOR }),
      );
      expect(other).toEqual(expect.objectContaining({ permBits: RoleBits.OWNER }));
      expect(other?.tenantId).toBeUndefined();
    });

    it("does not resolve another tenant's role", async () => {
      await createTenantRole('tenant-b', {
        accessRoleId: 'tenant_b_owner',
        name: 'tenant-b-owner',
        resourceType: ResourceType.AGENT,
        permBits: RoleBits.OWNER,
      });

      const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRoleByIdentifier('tenant_b_owner'),
      );

      expect(role).toBeNull();
    });

    it('resolves the global role with no tenant context, as before', async () => {
      await seedGlobalRoles();

      await expect(methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER)).resolves.toEqual(
        expect.objectContaining({ accessRoleId: AccessRoleIds.AGENT_OWNER }),
      );
    });
  });

  describe('findRolesByResourceType', () => {
    it('returns the global roles for a tenant, with tenant copies overriding', async () => {
      await seedGlobalRoles();
      await createTenantRole('tenant-a', {
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        name: 'tenant-viewer',
        resourceType: ResourceType.AGENT,
        permBits: RoleBits.VIEWER,
      });

      const roles = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRolesByResourceType(ResourceType.AGENT),
      );

      expect(roles.map((role) => role.accessRoleId).sort()).toEqual(
        [AccessRoleIds.AGENT_EDITOR, AccessRoleIds.AGENT_OWNER, AccessRoleIds.AGENT_VIEWER].sort(),
      );
      expect(roles.find((role) => role.accessRoleId === AccessRoleIds.AGENT_VIEWER)).toEqual(
        expect.objectContaining({ name: 'tenant-viewer', tenantId: 'tenant-a' }),
      );
    });

    it('excludes roles belonging to another tenant', async () => {
      await seedGlobalRoles();
      await createTenantRole('tenant-b', {
        accessRoleId: 'tenant_b_role',
        name: 'tenant-b-role',
        resourceType: ResourceType.AGENT,
        permBits: RoleBits.VIEWER,
      });

      const roles = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRolesByResourceType(ResourceType.AGENT),
      );

      expect(roles.map((role) => role.accessRoleId)).not.toContain('tenant_b_role');
    });
  });

  describe('a tenant override that moves an identifier to another resource type', () => {
    /** The tenant reuses `agent_owner` as a skill role, withdrawing it from agents */
    const moveAgentOwnerToSkill = (tenantId: string) =>
      createTenantRole(tenantId, {
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        name: 'tenant-skill-owner',
        resourceType: ResourceType.SKILL,
        permBits: RoleBits.OWNER,
      });

    it('withdraws the shadowed global role from its old resource type', async () => {
      await seedGlobalRoles();
      await moveAgentOwnerToSkill('tenant-a');

      const roles = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRolesByResourceType(ResourceType.AGENT),
      );

      expect(roles.map((role) => role.accessRoleId)).not.toContain(AccessRoleIds.AGENT_OWNER);
    });

    it('lists the override under its new resource type', async () => {
      await seedGlobalRoles();
      await moveAgentOwnerToSkill('tenant-a');

      const roles = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRolesByResourceType(ResourceType.SKILL),
      );

      expect(roles.find((role) => role.accessRoleId === AccessRoleIds.AGENT_OWNER)).toEqual(
        expect.objectContaining({ tenantId: 'tenant-a', resourceType: ResourceType.SKILL }),
      );
    });

    it('never yields the withdrawn owner bits through a permission lookup', async () => {
      await seedGlobalRoles();
      await moveAgentOwnerToSkill('tenant-a');

      const [exact, closest] = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => [
        await methods.findRoleByPermissions(ResourceType.AGENT, RoleBits.OWNER),
        await methods.getRoleForPermissions(ResourceType.AGENT, RoleBits.OWNER),
      ]);

      expect(exact).toBeNull();
      /** The closest agent role still visible, not the superseded global owner */
      expect(closest?.accessRoleId).toBe(AccessRoleIds.AGENT_EDITOR);
    });

    it('agrees with findRoleByIdentifier on the identifier’s new meaning', async () => {
      await seedGlobalRoles();
      await moveAgentOwnerToSkill('tenant-a');

      const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
      );

      expect(role).toEqual(
        expect.objectContaining({ tenantId: 'tenant-a', resourceType: ResourceType.SKILL }),
      );
    });
  });

  describe('findRoleByPermissions', () => {
    it('resolves a global default role from inside a tenant context', async () => {
      await seedGlobalRoles();

      const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRoleByPermissions(ResourceType.AGENT, RoleBits.OWNER),
      );

      expect(role).toEqual(expect.objectContaining({ accessRoleId: AccessRoleIds.AGENT_OWNER }));
    });

    it('does not match a global role whose identifier the tenant has redefined', async () => {
      await seedGlobalRoles();
      await shadowAgentOwnerAsEditor('tenant-a');

      const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.findRoleByPermissions(ResourceType.AGENT, RoleBits.OWNER),
      );

      /** No role visible to the tenant carries OWNER bits any more */
      expect(role).toBeNull();
    });
  });

  describe('getRoleForPermissions', () => {
    it('falls back to the global roles from inside a tenant context', async () => {
      await seedGlobalRoles();

      const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.getRoleForPermissions(ResourceType.AGENT, RoleBits.OWNER),
      );

      expect(role).toEqual(expect.objectContaining({ accessRoleId: AccessRoleIds.AGENT_OWNER }));
    });

    it('never grants the shadowed global bits when the tenant redefined the role', async () => {
      await seedGlobalRoles();
      await shadowAgentOwnerAsEditor('tenant-a');

      const role = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.getRoleForPermissions(ResourceType.AGENT, RoleBits.OWNER),
      );

      /** The closest visible role without exceeding OWNER, not the global OWNER row */
      expect(role?.permBits).toBe(RoleBits.EDITOR);
    });

    it('agrees with findRoleByIdentifier on what a shadowed identifier means', async () => {
      await seedGlobalRoles();
      await shadowAgentOwnerAsEditor('tenant-a');

      const [byIdentifier, byPermissions] = await tenantStorage.run(
        { tenantId: 'tenant-a' },
        async () => [
          await methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
          await methods.getRoleForPermissions(ResourceType.AGENT, RoleBits.EDITOR),
        ],
      );

      expect(byIdentifier?.permBits).toBe(RoleBits.EDITOR);
      expect(byPermissions?.permBits).toBe(RoleBits.EDITOR);
    });
  });
});
