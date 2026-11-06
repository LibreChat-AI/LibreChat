import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { SlackWorkspaceRecord } from '~/models/slackWorkspace';
import type { AgentChannelRecord } from '~/models/channel';
import {
  createSlackWorkspaceModel,
  createSlackInstallGenerationModel,
} from '~/models/slackWorkspace';
import { retireAgentChannel, initializeChannelScope, touchChannelScope } from './channelScope';
import { eraseChannelFeedbackForChannel } from './channelFeedbackErasure';
import { startRequiredTransactionSession } from '~/utils/transactions';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { touchSlackWorkspace } from './slackWorkspaceScope';
import { createChannelIndexGate } from './channelIndexes';

export type { AgentChannelRecord } from '~/models/channel';
export type AgentChannelMetadata = Pick<
  AgentChannelRecord,
  | 'channelId'
  | 'tenantId'
  | 'agentId'
  | 'createdBy'
  | 'type'
  | 'status'
  | 'credentialMode'
  | 'revision'
  | 'workspaceId'
  | 'slack'
>;

export type AgentChannelDeletionResult =
  | { status: 'deleted' }
  | { status: 'pending_drain' }
  | { status: 'not_found' };

export interface AgentChannelMethods {
  createAgentChannel(input: AgentChannelRecord): Promise<AgentChannelRecord>;
  listAgentChannels(agentId: string): Promise<AgentChannelRecord[]>;
  listAgentChannelTenants(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ channels: Array<{ tenantId?: string }>; next?: string }>;
  getAgentChannel(channelId: string): Promise<AgentChannelRecord | null>;
  /** Resolve workspace credentials and current installation status for service execution. */
  getActiveAgentChannel(channelId: string): Promise<AgentChannelRecord | null>;
  getAgentChannelMetadata(channelId: string): Promise<AgentChannelMetadata | null>;
  listDeletingAgentChannels(
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    channels: Array<{ tenantId?: string; channelId: string }>;
    next?: string;
  }>;
  updateAgentChannel(
    channelId: string,
    createdBy: string,
    update: Partial<Omit<AgentChannelRecord, 'channelId' | 'tenantId' | 'agentId' | 'createdBy'>>,
    expectedStatus?: AgentChannelRecord['status'],
    expectedRevision?: string,
  ): Promise<AgentChannelRecord | null>;
  /** Close admission and retire links before external credential cleanup. */
  beginAgentChannelDeletion(
    channelId: string,
    createdBy: string,
  ): Promise<AgentChannelRecord | null>;
  deleteAgentChannel(channelId: string, createdBy: string): Promise<AgentChannelDeletionResult>;
}

export function createAgentChannelMethods(
  mongoose: typeof import('mongoose'),
  getStorageConfig: () => Promise<Partial<ChannelStorageConfig>> = async () => ({}),
): AgentChannelMethods {
  const channel = () => mongoose.model<AgentChannelRecord>('AgentChannel');
  const ensureIndexes = createChannelIndexGate(() => [channel()]);
  const secrets = '+encryptedBotToken +encryptedSigningSecret';

  function withInstallation(
    record: AgentChannelRecord,
    workspace?: SlackWorkspaceRecord | null,
  ): AgentChannelRecord {
    if (
      !workspace ||
      record.credentialMode !== 'per_user' ||
      (workspace.tenantId || undefined) !== (record.tenantId || undefined)
    )
      return { ...record, status: 'disabled' };
    return {
      ...record,
      slack: { teamId: workspace.teamId, appId: workspace.appId, botUserId: workspace.botUserId },
      ...(workspace.encryptedBotToken ? { encryptedBotToken: workspace.encryptedBotToken } : {}),
    };
  }

  async function installed(
    record: AgentChannelRecord | null,
    includeCredentials: boolean,
  ): Promise<AgentChannelRecord | null> {
    if (!record?.workspaceId || record.status !== 'active') return record;
    const query = createSlackWorkspaceModel(mongoose)
      .findOne({
        workspaceId: record.workspaceId,
        tenantId: record.tenantId ?? null,
        status: 'active',
      })
      .read('primary');
    const workspace = await (
      includeCredentials ? query.select('+encryptedBotToken') : query
    ).lean();
    const resolved = withInstallation(record, workspace);
    if (!includeCredentials || !workspace || resolved.status !== 'active') return resolved;
    const app = await createSlackInstallGenerationModel(mongoose)
      .findOne({
        partition: record.tenantId || '_',
        tenantId: record.tenantId ?? null,
        appId: workspace.appId,
        clientId: { $exists: true },
      })
      .select('+encryptedSigningSecret')
      .read('primary')
      .lean();
    return app?.encryptedSigningSecret
      ? { ...resolved, encryptedSigningSecret: app.encryptedSigningSecret }
      : { ...resolved, status: 'disabled' };
  }

  function validWorkspaceBinding(record: AgentChannelRecord): void {
    if (
      record.workspaceId &&
      (record.credentialMode !== 'per_user' ||
        record.encryptedBotToken ||
        record.encryptedSigningSecret)
    )
      throw new TypeError(
        'Workspace channels require personal identities and installation-owned credentials',
      );
  }

  async function ownerWrite<T>(
    createdBy: string,
    tenantId: string | undefined,
    write: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const admit = await prepareChannelOwnerAdmission(mongoose, { userId: createdBy, tenantId });
    const session = await startRequiredTransactionSession(mongoose);
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        if (!(await admit(session))) throw new Error('Channel owner unavailable');
        result = await write(session);
      });
      if (result === undefined) throw new Error('Channel write did not commit');
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function validateMetadataPage(cursor: string | undefined, limit: number): Promise<void> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      (cursor !== undefined && (typeof cursor !== 'string' || !mongoose.isValidObjectId(cursor)))
    )
      throw new Error('Invalid channel metadata page');
    const limits = channelStorageConfigSchema.parse(await getStorageConfig());
    if (limit > limits.maxMetadataPageSize) throw new Error('Invalid channel metadata page');
  }

  async function beginDeletion(channelId: string, createdBy: string) {
    const parent = await channel().findOne({ channelId, createdBy }).select('tenantId').lean();
    if (!parent) return null;
    return retireAgentChannel(mongoose, { channelId, createdBy, tenantId: parent.tenantId });
  }

  return {
    async createAgentChannel(input: AgentChannelRecord): Promise<AgentChannelRecord> {
      const currentTenant = getTenantId();
      input = {
        ...input,
        tenantId:
          input.tenantId ?? (currentTenant === SYSTEM_TENANT_ID ? undefined : currentTenant),
      };
      validWorkspaceBinding(input);
      if (input.status === 'deleting') throw new TypeError('Channel deletion requires retirement');
      await ensureIndexes();
      await initializeChannelScope(mongoose, input.tenantId, input.channelId);
      return ownerWrite(input.createdBy, input.tenantId, async (session) => {
        if (!(await touchChannelScope(mongoose, input.tenantId, input.channelId, session)))
          throw new Error('Channel admission closed');
        if (
          input.workspaceId &&
          input.status === 'active' &&
          !(await touchSlackWorkspace(
            mongoose,
            { workspaceId: input.workspaceId, tenantId: input.tenantId },
            session,
          ))
        )
          throw new Error('Slack installation unavailable');
        const [record] = await channel().create([input], { session });
        return record.toObject();
      });
    },
    async listAgentChannels(agentId: string): Promise<AgentChannelRecord[]> {
      const records = await channel()
        .find({ agentId })
        .sort({ createdAt: 1 })
        .read('primary')
        .lean();
      const workspaceIds = [
        ...new Set(
          records
            .filter((record) => record.status === 'active')
            .flatMap((record) => (record.workspaceId ? [record.workspaceId] : [])),
        ),
      ];
      if (!workspaceIds.length) return records;
      const workspaces = await createSlackWorkspaceModel(mongoose)
        .find({ workspaceId: { $in: workspaceIds }, status: 'active' })
        .read('primary')
        .lean();
      const byId = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
      return records.map((record) =>
        record.workspaceId && record.status === 'active'
          ? withInstallation(record, byId.get(record.workspaceId))
          : record,
      );
    },
    async listAgentChannelTenants(cursor, limit) {
      await validateMetadataPage(cursor, limit);
      const records = await channel()
        .find(cursor ? { _id: { $gt: cursor } } : {})
        .select({ _id: 1, tenantId: 1 })
        .sort({ _id: 1 })
        .limit(limit + 1)
        .lean();
      const page = records.slice(0, limit);
      return {
        channels: page.map(({ tenantId }) => ({ tenantId })),
        ...(records.length > limit ? { next: String(page[page.length - 1]._id) } : {}),
      };
    },
    async getAgentChannel(channelId: string): Promise<AgentChannelRecord | null> {
      return channel().findOne({ channelId }).select(secrets).lean();
    },
    async getActiveAgentChannel(channelId) {
      const record = await installed(
        await channel().findOne({ channelId }).select(secrets).read('primary').lean(),
        true,
      );
      return record?.status === 'active' ? record : null;
    },
    async getAgentChannelMetadata(channelId) {
      const record = await channel()
        .findOne({ channelId })
        .select({
          _id: 0,
          channelId: 1,
          tenantId: 1,
          agentId: 1,
          createdBy: 1,
          type: 1,
          status: 1,
          credentialMode: 1,
          revision: 1,
          workspaceId: 1,
          'slack.teamId': 1,
          'slack.appId': 1,
          'slack.botUserId': 1,
        })
        .read('primary')
        .lean();
      return installed(record, false);
    },
    async listDeletingAgentChannels(cursor, limit) {
      await validateMetadataPage(cursor, limit);
      await ensureIndexes();
      const records = await channel()
        .find({ status: 'deleting', ...(cursor ? { _id: { $gt: cursor } } : {}) })
        .select({ _id: 1, tenantId: 1, channelId: 1 })
        .sort({ _id: 1 })
        .limit(limit + 1)
        .lean();
      const page = records.slice(0, limit);
      return {
        channels: page.map(({ tenantId, channelId }) => ({ tenantId, channelId })),
        ...(records.length > limit ? { next: String(page[page.length - 1]._id) } : {}),
      };
    },
    async updateAgentChannel(
      channelId: string,
      createdBy: string,
      update: Partial<Omit<AgentChannelRecord, 'channelId' | 'tenantId' | 'agentId' | 'createdBy'>>,
      expectedStatus?: AgentChannelRecord['status'],
      expectedRevision?: string,
    ): Promise<AgentChannelRecord | null> {
      // Deleting is an irreversible lifecycle operation, never a generic metadata patch.
      if (expectedStatus === 'deleting' || update.status === 'deleting') return null;
      const write = async (session: ClientSession): Promise<AgentChannelRecord | null> =>
        channel()
          .findOneAndUpdate(
            {
              channelId,
              createdBy,
              status: expectedStatus ?? { $ne: 'deleting' },
              ...(expectedRevision !== undefined ? { revision: expectedRevision } : {}),
            },
            { $set: update },
            { new: true, session, runValidators: true },
          )
          .select(secrets)
          .lean();
      const parent = await channel().findOne({ channelId, createdBy }).select('tenantId').lean();
      if (!parent) return null;
      await initializeChannelScope(mongoose, parent.tenantId, channelId);
      return ownerWrite(createdBy, parent.tenantId, async (session) => {
        if (!(await touchChannelScope(mongoose, parent.tenantId, channelId, session))) return null;
        const current = await channel()
          .findOne({ channelId, createdBy })
          .select(secrets)
          .session(session)
          .lean();
        if (!current) return null;
        const next = { ...current, ...update };
        validWorkspaceBinding(next);
        if (
          next.workspaceId &&
          next.status === 'active' &&
          !(await touchSlackWorkspace(
            mongoose,
            { workspaceId: next.workspaceId, tenantId: parent.tenantId },
            session,
          ))
        )
          return null;
        return write(session);
      });
    },
    beginAgentChannelDeletion: beginDeletion,
    async deleteAgentChannel(
      channelId: string,
      createdBy: string,
    ): Promise<AgentChannelDeletionResult> {
      const deleting = await beginDeletion(channelId, createdBy);
      if (!deleting) return { status: 'not_found' };
      if (
        await mongoose.models.ChannelRun.exists({
          channelId,
          tenantId: deleting.tenantId || '_',
          state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
        })
      )
        return { status: 'pending_drain' };
      // Keep the deleting parent available for a retry if dependent cleanup fails.
      await eraseChannelFeedbackForChannel(mongoose, deleting.tenantId, channelId);
      const result = await channel().deleteOne({
        channelId,
        createdBy,
        status: 'deleting',
      });
      return { status: result.deletedCount > 0 ? 'deleted' : 'not_found' };
    },
  };
}
