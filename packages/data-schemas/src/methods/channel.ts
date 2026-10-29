import type { AgentChannelRecord, AgentChannelThreadRecord } from '~/models/channel';
import { createChannelIndexGate } from './channelIndexes';

export type { AgentChannelRecord, AgentChannelThreadRecord } from '~/models/channel';
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
  deleteAgentChannel(channelId: string, createdBy: string): Promise<boolean>;
  getAgentChannelThread(
    channelId: string,
    externalThreadKey: string,
  ): Promise<AgentChannelThreadRecord | null>;
  putAgentChannelThread(
    channelId: string,
    externalThreadKey: string,
    conversationId: string,
  ): Promise<void>;
}

export function createAgentChannelMethods(
  mongoose: typeof import('mongoose'),
): AgentChannelMethods {
  const channel = () => mongoose.model<AgentChannelRecord>('AgentChannel');
  const threads = () => mongoose.model<AgentChannelThreadRecord>('AgentChannelThread');
  const ensureIndexes = createChannelIndexGate(() => [channel()]);
  const secrets = '+encryptedBotToken +encryptedSigningSecret +encryptedApiKey +apiKeyId';

  return {
    async createAgentChannel(input: AgentChannelRecord): Promise<AgentChannelRecord> {
      const record = await channel().create(input);
      return record.toObject();
    },
    async listAgentChannels(agentId: string): Promise<AgentChannelRecord[]> {
      return channel().find({ agentId }).sort({ createdAt: 1 }).lean();
    },
    async listAgentChannelTenants(cursor, limit) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (cursor && !mongoose.isValidObjectId(cursor))
      ) {
        throw new Error('Invalid channel metadata page');
      }
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
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (cursor && !mongoose.isValidObjectId(cursor))
      )
        throw new Error('Invalid deleting channel page');
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
      return channel()
        .findOneAndUpdate(
          {
            channelId,
            createdBy,
            ...(expectedStatus ? { status: expectedStatus } : {}),
            ...(expectedRevision ? { revision: expectedRevision } : {}),
          },
          { $set: update },
          { new: true },
        )
        .select(secrets)
        .lean();
    },
    async deleteAgentChannel(channelId: string, createdBy: string): Promise<boolean> {
      if (!(await channel().exists({ channelId, createdBy }))) {
        return false;
      }
      if (
        await mongoose.models.ChannelRun.exists({
          channelId,
          state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
        })
      )
        return false;
      // Keep the deleting parent available for a retry if dependent cleanup fails.
      await threads().deleteMany({ channelId });
      const result = await channel().deleteOne({ channelId, createdBy });
      return result.deletedCount > 0;
    },
    async getAgentChannelThread(
      channelId: string,
      externalThreadKey: string,
    ): Promise<AgentChannelThreadRecord | null> {
      return threads().findOne({ channelId, externalThreadKey }).lean();
    },
    async putAgentChannelThread(
      channelId: string,
      externalThreadKey: string,
      conversationId: string,
    ): Promise<void> {
      await threads().updateOne(
        { channelId, externalThreadKey },
        { $set: { conversationId } },
        { upsert: true },
      );
    },
  };
}
