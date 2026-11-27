import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ResourceType,
  SystemRoles,
  PrincipalType,
  PrincipalModel,
  PermissionBits,
} from 'librechat-data-provider';
import type * as t from '~/types';
import { SystemCapabilities } from '~/admin/capabilities';
import { createSystemGrantMethods } from './systemGrant';
import { createUserGroupMethods } from './userGroup';
import systemGrantSchema from '~/schema/systemGrant';
import { createConfigModel } from '~/models/config';
import { createAclEntryMethods } from './aclEntry';
import { createConfigMethods } from './config';
import aclEntrySchema from '~/schema/aclEntry';
import groupSchema from '~/schema/group';
import userSchema from '~/schema/user';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/** Entra sync creates a group for every group a member belongs to (#16918). */
const GROUP_COUNT = 300;

type Principals = Awaited<
  ReturnType<ReturnType<typeof createUserGroupMethods>['getUserPrincipals']>
>;

interface Command {
  commandName: string;
  command: Record<string, unknown>;
}

let mongoServer: MongoMemoryServer;
let AclEntry: mongoose.Model<t.IAclEntry>;
let acl: ReturnType<typeof createAclEntryMethods>;
let grants: ReturnType<typeof createSystemGrantMethods>;
let configs: ReturnType<typeof createConfigMethods>;
let principals: Principals;
let memberGroup: Types.ObjectId;
let userId: Types.ObjectId;
/** Commands seen while a check runs, with the widest `$or` each one sent. */
let sent: Array<{ collection: string; widest: number }> | null = null;

/** The most clauses any `$or` in a command carries. */
function widestOr(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((widest: number, item) => Math.max(widest, widestOr(item)), 0);
  }
  if (value == null || Object.getPrototypeOf(value) !== Object.prototype) {
    return 0;
  }
  let widest = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$or' && Array.isArray(child)) {
      widest = Math.max(widest, child.length);
    }
    widest = Math.max(widest, widestOr(child));
  }
  return widest;
}

function onCommand({ commandName, command }: Command) {
  const collection = command[commandName];
  if (sent && typeof collection === 'string') {
    sent.push({ collection, widest: widestOr(command) });
  }
}

/** Runs `check` and returns the widest principal `$or` it sent to `collection`. */
async function widestSentTo(collection: string, check: () => Promise<void>): Promise<number> {
  sent = [];
  try {
    await check();
    const widths = sent.filter((c) => c.collection === collection).map((c) => c.widest);
    expect(widths.length).toBeGreaterThan(0);
    return Math.max(...widths);
  } finally {
    sent = null;
  }
}

/** The pre-fold query: one clause per principal. */
function clausePerPrincipal(list: Principals) {
  return list.map((p) => ({
    principalType: p.principalType,
    ...(p.principalType !== PrincipalType.PUBLIC && { principalId: p.principalId }),
  }));
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { monitorCommands: true });
  mongoose.connection.getClient().on('commandStarted', onCommand);

  const User = mongoose.models.User || mongoose.model<t.IUser>('User', userSchema);
  const Group = mongoose.models.Group || mongoose.model<t.IGroup>('Group', groupSchema);
  AclEntry = mongoose.models.AclEntry || mongoose.model<t.IAclEntry>('AclEntry', aclEntrySchema);
  const SystemGrant =
    mongoose.models.SystemGrant || mongoose.model<t.ISystemGrant>('SystemGrant', systemGrantSchema);
  await Promise.all([SystemGrant.init(), createConfigModel(mongoose).init()]);
  acl = createAclEntryMethods(mongoose);
  grants = createSystemGrantMethods(mongoose);
  configs = createConfigMethods(mongoose);

  const user = await User.create({
    name: 'Member',
    email: 'member@example.com',
    provider: 'openid',
    role: SystemRoles.USER,
    idOnTheSource: 'entra-member',
  });
  userId = user._id;
  const groups = await Group.insertMany(
    Array.from({ length: GROUP_COUNT }, (_, i) => ({
      name: `Entra group ${i}`,
      source: 'entra',
      idOnTheSource: `entra-group-${i}`,
      memberIds: ['entra-member'],
    })),
  );
  memberGroup = groups[GROUP_COUNT / 2]._id;
  principals = await createUserGroupMethods(mongoose).getUserPrincipals({
    userId: userId.toString(),
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('principal queries for a user in many groups', () => {
  it('resolves every synced group as a principal', () => {
    const types = principals.map((p) => p.principalType);
    expect(types.filter((type) => type === PrincipalType.GROUP)).toHaveLength(GROUP_COUNT);
    expect(principals).toHaveLength(GROUP_COUNT + 3);
  });

  it('checks ACL entries with one clause per principal type and still finds a group share', async () => {
    const agentId = new Types.ObjectId();
    await acl.grantPermission(
      PrincipalType.GROUP,
      memberGroup,
      ResourceType.AGENT,
      agentId,
      PermissionBits.VIEW,
      userId,
    );

    const widest = await widestSentTo('aclentries', async () => {
      const { VIEW, EDIT } = PermissionBits;
      expect(await acl.hasPermission(principals, ResourceType.AGENT, agentId, VIEW)).toBe(true);
      expect(await acl.hasPermission(principals, ResourceType.AGENT, agentId, EDIT)).toBe(false);
      expect(await acl.getEffectivePermissions(principals, ResourceType.AGENT, agentId)).toBe(VIEW);
      const batch = await acl.getEffectivePermissionsForResources(principals, ResourceType.AGENT, [
        agentId,
      ]);
      expect(batch.get(agentId.toString())).toBe(VIEW);
      expect(await acl.findAccessibleResources(principals, ResourceType.AGENT, VIEW)).toEqual([
        agentId,
      ]);
    });

    /** User, role, every group in one `$in`, and public. */
    expect(widest).toBe(4);
  });

  it('matches the same ACL entries as one clause per principal', async () => {
    const resourceId = new Types.ObjectId();
    const otherGroup = new Types.ObjectId();
    const entry = (
      principalType: PrincipalType,
      principalId: Types.ObjectId | string | undefined,
      principalModel: PrincipalModel | undefined,
      permBits: number,
    ) => ({
      principalType,
      ...(principalId !== undefined && { principalId, principalModel }),
      resourceType: ResourceType.PROMPTGROUP,
      resourceId,
      permBits,
      grantedBy: userId,
    });
    await AclEntry.insertMany([
      entry(PrincipalType.USER, userId, PrincipalModel.USER, 1),
      entry(PrincipalType.ROLE, SystemRoles.USER, PrincipalModel.ROLE, 1),
      entry(PrincipalType.GROUP, memberGroup, PrincipalModel.GROUP, 2),
      entry(PrincipalType.PUBLIC, undefined, undefined, 4),
      /** Decoys: an id the user holds under another type, and principals the user is not. */
      entry(PrincipalType.GROUP, userId, PrincipalModel.GROUP, 8),
      entry(PrincipalType.USER, memberGroup, PrincipalModel.USER, 8),
      entry(PrincipalType.GROUP, otherGroup, PrincipalModel.GROUP, 16),
      entry(PrincipalType.ROLE, SystemRoles.ADMIN, PrincipalModel.ROLE, 16),
    ]);

    const legacy = await AclEntry.find({
      $or: clausePerPrincipal(principals),
      resourceType: ResourceType.PROMPTGROUP,
      resourceId,
    }).lean();
    const entries = await acl.findEntriesByPrincipalsAndResource(
      principals,
      ResourceType.PROMPTGROUP,
      resourceId,
    );

    const ids = (list: Array<{ _id: Types.ObjectId }>) => list.map((e) => e._id.toString()).sort();
    expect(entries).toHaveLength(4);
    expect(ids(entries)).toEqual(ids(legacy));
    expect(
      await acl.getEffectivePermissions(principals, ResourceType.PROMPTGROUP, resourceId),
    ).toBe(1 | 2 | 4);
  });

  it('checks capabilities with one clause per principal type', async () => {
    await grants.grantCapability({
      principalType: PrincipalType.GROUP,
      principalId: memberGroup,
      capability: SystemCapabilities.READ_CONFIGS,
    });

    const widest = await widestSentTo('systemgrants', async () => {
      const capability = SystemCapabilities.READ_CONFIGS;
      expect(await grants.hasCapabilityForPrincipals({ principals, capability })).toBe(true);
      expect(
        await grants.hasCapabilityForPrincipals({
          principals,
          capability: SystemCapabilities.MANAGE_CONFIGS,
        }),
      ).toBe(false);
      const held = await grants.getHeldCapabilities({
        principals,
        capabilities: [capability, SystemCapabilities.READ_USERS],
      });
      expect([...held]).toEqual([capability]);
      expect(await grants.hasAnyConfigReadAccess({ principals })).toBe(true);
      const listed = await grants.getCapabilitiesForPrincipals({
        principals: principals.filter(
          (p): p is typeof p & { principalId: string | Types.ObjectId } => p.principalId != null,
        ),
      });
      expect(listed.map((grant) => grant.capability)).toEqual([capability]);
    });

    /** User, role, and every group in one `$in`; grants have no public principal. */
    expect(widest).toBe(3);
  });

  it('reads config overrides with one clause per principal type', async () => {
    await configs.upsertConfig(
      PrincipalType.GROUP,
      memberGroup.toString(),
      PrincipalModel.GROUP,
      { interface: { modelSelect: false } },
      30,
    );

    const widest = await widestSentTo('configs', async () => {
      const applicable = await configs.getApplicableConfigs(principals);
      expect(applicable.map((config) => config.principalId)).toEqual([memberGroup.toString()]);
    });

    /** Base and role names in one `$in`, the user, and every group in one `$in`. */
    expect(widest).toBe(3);
  });
});
