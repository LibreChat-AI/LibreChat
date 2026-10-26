import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, tenantStorage } from '@librechat/data-schemas';
import {
  AccessRoleIds,
  PermissionBits,
  PrincipalType,
  ResourceType,
} from 'librechat-data-provider';
import type { InsightsAccessUser, InsightsAgentAccessDeps } from './access';
import { createInsightsAccessResolver, createInsightsAgentAccessResolver } from './access';

let mongo: MongoMemoryServer;
let models: ReturnType<typeof createModels>;
let methods: ReturnType<typeof createMethods>;
let deps: InsightsAgentAccessDeps;
let roleBits: Record<string, number>;
const actorRole = 'ANALYST';
const actor: InsightsAccessUser = {
  id: new Types.ObjectId().toString(),
  role: actorRole,
  tenantId: 'tenant-a',
  idOnTheSource: null,
};

const withinTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
  tenantStorage.run({ tenantId }, fn);

const resolve = (user = actor) =>
  withinTenant(user.tenantId ?? 'tenant-a', () => createInsightsAccessResolver(deps)(user));

async function agent(id: string, tenantId = 'tenant-a') {
  const record = { _id: new Types.ObjectId(), id, name: id, tenantId };
  await models.Agent.collection.insertOne(record);
  return record;
}

async function grant(
  resourceId: Types.ObjectId,
  principalType: PrincipalType,
  principalId: string | Types.ObjectId | undefined,
  permBits: number,
  tenantId = 'tenant-a',
) {
  await models.AclEntry.collection.insertOne({
    resourceId,
    resourceType: ResourceType.AGENT,
    principalType,
    principalId,
    permBits,
    tenantId,
  });
}

async function memberGroup(memberId: string, tenantId = 'tenant-a') {
  const group = { _id: new Types.ObjectId(), name: 'Editors', memberIds: [memberId], tenantId };
  await models.Group.collection.insertOne(group);
  return group._id;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  models = createModels(mongoose);
  methods = createMethods(mongoose);
  deps = {
    getAgents: methods.getAgents,
    getUserPrincipals: methods.getUserPrincipals,
    hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
    findAccessibleResources: methods.findAccessibleResources,
  };
  const roles = await withinTenant('tenant-a', () => methods.seedDefaultRoles());
  roleBits = Object.fromEntries(Object.entries(roles).map(([id, role]) => [id, role.permBits]));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await Promise.all(
    [models.Agent, models.AclEntry, models.Group, models.SystemGrant].map((model) =>
      model.collection.deleteMany({}),
    ),
  );
});

describe('Insights access with real ACLs and memberships', () => {
  it.each(
    [PrincipalType.USER, PrincipalType.GROUP, PrincipalType.ROLE].flatMap((type) =>
      [AccessRoleIds.AGENT_EDITOR, AccessRoleIds.AGENT_OWNER].map((role) => [type, role] as const),
    ),
  )('grants statistics only through %s %s rights', async (type, role) => {
    const target = await agent('editable-agent');
    let principalId: string | Types.ObjectId = new Types.ObjectId(actor.id);
    if (type === PrincipalType.GROUP) {
      principalId = await memberGroup(actor.id);
    } else if (type === PrincipalType.ROLE) {
      principalId = actorRole;
    }
    await grant(target._id, type, principalId, roleBits[role]);
    const before = await models.AclEntry.collection.findOne({ resourceId: target._id });

    expect(await resolve()).toEqual({
      agents: [{ id: target.id, name: target.name }],
      detailAgentIds: [],
    });
    expect(await models.AclEntry.collection.findOne({ resourceId: target._id })).toEqual(before);
    expect(roleBits[role] & PermissionBits.VIEW_INSIGHTS).toBe(0);
  });

  it('resolves external group membership through the loaded source identity', async () => {
    const target = await agent('external-group-agent');
    const groupId = await memberGroup('external-directory-id');
    await grant(target._id, PrincipalType.GROUP, groupId, roleBits[AccessRoleIds.AGENT_EDITOR]);

    const result = await resolve({ ...actor, idOnTheSource: 'external-directory-id' });
    expect(result.agents.map((entry) => entry.id)).toEqual([target.id]);
    expect(result.detailAgentIds).toEqual([]);
  });

  it('preserves explicit Insights grants separately from editing grants and legacy route access', async () => {
    const inspected = await agent('a-insights-grant');
    const edited = await agent('b-editing-grant');
    await grant(
      inspected._id,
      PrincipalType.USER,
      new Types.ObjectId(actor.id),
      PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
    );
    await grant(edited._id, PrincipalType.ROLE, actor.role, roleBits[AccessRoleIds.AGENT_OWNER]);

    const result = await resolve();
    expect(result.agents.map((entry) => entry.id)).toEqual([inspected.id, edited.id]);
    expect(result.detailAgentIds).toEqual([inspected.id]);
    const legacy = await withinTenant('tenant-a', () =>
      createInsightsAgentAccessResolver(deps)(actor),
    );
    expect(legacy.map((entry) => entry.id)).toEqual([inspected.id]);
  });

  it('does not grant statistics for viewer or public access alone', async () => {
    const viewer = await agent('viewer-agent');
    const publicEditor = await agent('public-editor');
    const publicInsights = await agent('public-insights');
    await grant(
      viewer._id,
      PrincipalType.USER,
      new Types.ObjectId(actor.id),
      roleBits[AccessRoleIds.AGENT_VIEWER],
    );
    await grant(
      publicEditor._id,
      PrincipalType.PUBLIC,
      undefined,
      roleBits[AccessRoleIds.AGENT_OWNER],
    );
    await grant(
      publicInsights._id,
      PrincipalType.PUBLIC,
      undefined,
      PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
    );

    expect(await resolve()).toEqual({ agents: [], detailAgentIds: [] });
  });

  it.each([PermissionBits.EDIT, PermissionBits.VIEW_INSIGHTS])(
    'does not assemble VIEW and bit %s from different ACL entries',
    async (bit) => {
      const target = await agent('split-permissions');
      const groupId = await memberGroup(actor.id);
      await grant(
        target._id,
        PrincipalType.USER,
        new Types.ObjectId(actor.id),
        PermissionBits.VIEW,
      );
      await grant(target._id, PrincipalType.GROUP, groupId, bit);

      expect(await resolve()).toEqual({ agents: [], detailAgentIds: [] });
    },
  );

  it('excludes foreign-tenant agents, ACL entries and group memberships', async () => {
    const local = await agent('local-agent');
    const foreign = await agent('foreign-agent', 'tenant-b');
    const foreignGroup = await memberGroup(actor.id, 'tenant-b');
    const ownerBits = roleBits[AccessRoleIds.AGENT_OWNER];
    await grant(local._id, PrincipalType.USER, new Types.ObjectId(actor.id), ownerBits, 'tenant-b');
    await grant(foreign._id, PrincipalType.USER, new Types.ObjectId(actor.id), ownerBits);
    await grant(local._id, PrincipalType.GROUP, foreignGroup, ownerBits);

    expect(await resolve()).toEqual({ agents: [], detailAgentIds: [] });
  });

  it('reflects a revoked ACL on the next resolution', async () => {
    const target = await agent('revoked-agent');
    await grant(
      target._id,
      PrincipalType.USER,
      new Types.ObjectId(actor.id),
      roleBits[AccessRoleIds.AGENT_EDITOR],
    );
    expect((await resolve()).agents).toHaveLength(1);
    await models.AclEntry.collection.deleteMany({ resourceId: target._id });
    expect(await resolve()).toEqual({ agents: [], detailAgentIds: [] });
  });
});
