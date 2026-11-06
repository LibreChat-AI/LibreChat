import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { AgentChannelRecord } from '~/models/channel';
import { retireAgentChannel, initializeChannelScope, touchChannelScope } from './channelScope';
import { eraseChannelFeedbackForChannel } from './channelFeedbackErasure';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createAgentChannelThreadModel } from '~/models/channel';
import { prepareChannelOwnerAdmission } from './channelOwner';
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
  | 'slack'
  | 'apiKeyId'
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
  const threads = () => createAgentChannelThreadModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [channel()]);
  const secrets = '+encryptedBotToken +encryptedSigningSecret +encryptedApiKey +apiKeyId';

  async function ownerWrite<T>(
    createdBy: string,
    tenantId: string | undefined,
    write: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const admit = await prepareChannelOwnerAdmission(mongoose, { userId: createdBy, tenantId });
    const session = await mongoose.startSession();
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
      if (input.status === 'deleting') throw new TypeError('Channel deletion requires retirement');
      await ensureIndexes();
      await initializeChannelScope(mongoose, input.tenantId, input.channelId);
      return ownerWrite(input.createdBy, input.tenantId, async (session) => {
        if (!(await touchChannelScope(mongoose, input.tenantId, input.channelId, session)))
          throw new Error('Channel admission closed');
        const [record] = await channel().create([input], { session });
        return record.toObject();
      });
    },
    async listAgentChannels(agentId: string): Promise<AgentChannelRecord[]> {
      return channel().find({ agentId }).sort({ createdAt: 1 }).lean();
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
    async getAgentChannelMetadata(channelId) {
      return channel()
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
          'slack.teamId': 1,
          'slack.appId': 1,
          'slack.botUserId': 1,
          apiKeyId: 1,
        })
        .lean();
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
      await threads().deleteMany({ channelId, tenantId: deleting.tenantId || { $in: [null, ''] } });
      const result = await channel().deleteOne({
        channelId,
        createdBy,
        status: 'deleting',
      });
      return { status: result.deletedCount > 0 ? 'deleted' : 'not_found' };
    },
  };
}
