import { nanoid } from 'nanoid';
import { Types } from 'mongoose';
import {
  PermissionBits,
  PrincipalModel,
  PrincipalType,
  ResourceType,
} from 'librechat-data-provider';
import type { SlackBotManager } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { SlackWorkspaceRecord } from '~/models/slackWorkspace';
import type { IUser } from '~/types';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createSlackWorkspaceModel } from '~/models/slackWorkspace';
import { createResponseScopeModel } from '~/models/responseScope';
import { withRequiredTransaction } from '~/utils/transactions';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { createChannelIndexGate } from './channelIndexes';
import { createAclEntryModel } from '~/models/aclEntry';
import { buildUserSearchFilter } from '~/utils/search';
import { permissionBitSupersets } from './aclEntry';
import { createUserModel } from '~/models/user';

type Workspace = Pick<SlackWorkspaceRecord, 'workspaceId' | 'tenantId'> & { _id: Types.ObjectId };

export type BotManagerWriteResult =
  | { ok: true; revision: string }
  | { ok: false; code: 'workspace_changed' | 'manager_unavailable' | 'principal_unavailable' };

export interface BotManagerUpdate {
  workspaceId: string;
  revision: string;
  userIds: string[];
  actorId: string;
  maxManagers: number;
}

interface SlackBotAccess {
  allowedResources(
    records: Workspace[] | undefined,
    userId: string,
    session?: ClientSession,
  ): Promise<Set<string>>;
  allows(record: Workspace, userId: string, session?: ClientSession): Promise<boolean>;
  read(workspaceId: string): Promise<{ revision: string; managers: SlackBotManager[] } | null>;
  search(workspaceId: string, query: string, limit: number): Promise<SlackBotManager[] | null>;
  set(input: BotManagerUpdate): Promise<BotManagerWriteResult>;
  clear(record: Workspace, session: ClientSession): Promise<void>;
}

/** Bot-management grants use existing ACL storage; only installation-admin routes write them. */
export function createSlackBotAccess(mongoose: typeof import('mongoose')): SlackBotAccess {
  const workspaces = createSlackWorkspaceModel(mongoose);
  const acl = createAclEntryModel(mongoose);
  const users = createUserModel(mongoose);
  const manager = (user: Pick<IUser, '_id' | 'name' | 'email' | 'avatar'>): SlackBotManager => ({
    id: String(user._id),
    name: user.name,
    email: user.email,
    avatar: user.avatar,
  });
  const ensureIndexes = createChannelIndexGate(() => [
    workspaces,
    acl,
    createResponseScopeModel(mongoose),
  ]);
  const scope = () => {
    const tenantId = getTenantId();
    if (tenantId === SYSTEM_TENANT_ID) throw new Error('Bot management requires a tenant scope');
    return tenantId || undefined;
  };

  const managerFilter = () => ({
    tenantId: scope() ?? null,
    resourceType: ResourceType.SLACK_BOT,
    principalType: PrincipalType.USER,
    permBits: { $in: permissionBitSupersets(PermissionBits.EDIT) },
    $or: [
      { expiredAt: { $exists: false } },
      { expiredAt: null },
      { expiredAt: { $gt: new Date() } },
    ],
  });

  async function allowedResources(
    records: Workspace[] | undefined,
    userId: string,
    session?: ClientSession,
  ) {
    if (!Types.ObjectId.isValid(userId) || records?.length === 0) return new Set<string>();
    const entries = await acl
      .find({
        ...managerFilter(),
        ...(records ? { resourceId: { $in: records.map((record) => record._id) } } : {}),
        principalId: new Types.ObjectId(userId),
      })
      .select('resourceId')
      .session(session ?? null)
      .read('primary')
      .lean();
    return new Set(entries.map((entry) => String(entry.resourceId)));
  }

  return {
    allowedResources,
    async search(workspaceId, query, limit) {
      const tenantId = scope();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError('Invalid bot manager search page size');
      if (
        !(await workspaces
          .exists({ workspaceId, tenantId: tenantId ?? null, status: 'active' })
          .read('primary'))
      )
        return null;
      const filter = buildUserSearchFilter(query);
      if (!filter) return [];
      const candidates = await users
        .find({
          ...filter,
          tenantId: tenantId ?? null,
          agentTriggerDeletionStartedAt: { $exists: false },
        })
        .select('_id name email avatar')
        .limit(limit)
        .read('primary')
        .lean();
      return candidates.map(manager);
    },
    async allows(record: Workspace, userId: string, session?: ClientSession) {
      return (await allowedResources([record], userId, session)).has(String(record._id));
    },
    async read(workspaceId: string) {
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          const tenantId = scope();
          const workspace = await workspaces
            .findOne({ workspaceId, tenantId: tenantId ?? null, status: 'active' })
            .session(session)
            .lean();
          if (!workspace) return null;
          const entries = await acl
            .find({
              ...managerFilter(),
              resourceId: workspace._id,
            })
            .select('principalId')
            .session(session)
            .lean();
          const records = await users
            .find({
              _id: { $in: entries.map((entry) => entry.principalId) },
              tenantId: tenantId ?? null,
              agentTriggerDeletionStartedAt: { $exists: false },
            })
            .select('_id name email avatar')
            .session(session)
            .lean();
          const managers = records.map(manager);
          return { revision: workspace.revision, managers };
        },
        ensureIndexes,
      );
    },
    async set(input: BotManagerUpdate): Promise<BotManagerWriteResult> {
      const tenantId = scope();
      const ids = [...new Set(input.userIds.map((id) => id.toLowerCase()))].sort();
      if (
        ids.length > input.maxManagers ||
        ![input.actorId, ...ids].every((id) => Types.ObjectId.isValid(id))
      )
        return { ok: false, code: 'manager_unavailable' };
      const subjects = [...new Set([input.actorId, ...ids])].sort();
      const userFilter = {
        _id: { $in: subjects },
        tenantId: tenantId ?? null,
        agentTriggerDeletionStartedAt: { $exists: false },
      };
      if ((await users.countDocuments(userFilter).read('primary')) !== subjects.length)
        return { ok: false, code: 'manager_unavailable' };
      const admit = await Promise.all(
        subjects.map((userId) => prepareChannelOwnerAdmission(mongoose, { userId, tenantId })),
      );
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          const current = await workspaces
            .findOne({
              workspaceId: input.workspaceId,
              tenantId: tenantId ?? null,
              revision: input.revision,
              status: 'active',
            })
            .session(session)
            .lean();
          if (!current) return { ok: false, code: 'workspace_changed' };
          if ((await users.countDocuments(userFilter).session(session)) !== subjects.length)
            return { ok: false, code: 'manager_unavailable' };
          for (const touch of admit)
            if (!(await touch(session))) return { ok: false, code: 'principal_unavailable' };
          const revision = nanoid();
          const changed = await workspaces.updateOne(
            { _id: current._id, revision: input.revision },
            { $set: { revision }, $inc: { authorityWrites: 1 } },
            { session },
          );
          if (!changed.matchedCount) throw new Error('Bot management changed during transaction');
          await acl.deleteMany(
            {
              resourceType: ResourceType.SLACK_BOT,
              resourceId: current._id,
              tenantId: tenantId ?? null,
            },
            { session },
          );
          if (ids.length)
            await acl.insertMany(
              ids.map((id) => ({
                tenantId,
                resourceType: ResourceType.SLACK_BOT,
                resourceId: current._id,
                principalType: PrincipalType.USER,
                principalId: new Types.ObjectId(id),
                principalModel: PrincipalModel.USER,
                permBits: PermissionBits.VIEW | PermissionBits.EDIT,
                grantedBy: new Types.ObjectId(input.actorId),
                grantedAt: new Date(),
              })),
              { session },
            );
          return { ok: true, revision };
        },
        ensureIndexes,
      );
    },
    async clear(record: Workspace, session: ClientSession) {
      await acl.deleteMany(
        {
          resourceType: ResourceType.SLACK_BOT,
          resourceId: record._id,
          tenantId: record.tenantId ?? null,
        },
        { session },
      );
    },
  };
}
