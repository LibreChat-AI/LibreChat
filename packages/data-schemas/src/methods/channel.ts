import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { AgentChannelRecord, AgentChannelThreadRecord } from '~/models/channel';
import { retireChannelScope, initializeChannelScope, touchChannelScope } from './channelScope';
import { prepareChannelOwnerAdmission } from './channelOwner';
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
  getOrCreateAgentChannelThread(
    channelId: string,
    externalThreadKey: string,
  ): Promise<AgentChannelThreadRecord>;
}

export function createAgentChannelMethods(
  mongoose: typeof import('mongoose'),
): AgentChannelMethods {
  const channel = () => mongoose.model<AgentChannelRecord>('AgentChannel');
  const threads = () => mongoose.model<AgentChannelThreadRecord>('AgentChannelThread');
  const ensureIndexes = createChannelIndexGate(() => [channel()]);
  const ensureThreadIndexes = createChannelIndexGate(() => [threads()]);
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

  return {
    async createAgentChannel(input: AgentChannelRecord): Promise<AgentChannelRecord> {
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
      // Deleting is an irreversible lifecycle operation, never a generic metadata patch.
      if (expectedStatus === 'deleting' || update.status === 'deleting') return null;
      const write = async (session?: ClientSession): Promise<AgentChannelRecord | null> =>
        channel()
          .findOneAndUpdate(
            {
              channelId,
              createdBy,
              status: expectedStatus ?? { $ne: 'deleting' },
              ...(expectedRevision ? { revision: expectedRevision } : {}),
            },
            { $set: update },
            { new: true, ...(session ? { session } : {}) },
          )
          .select(secrets)
          .lean();
      if (
        update.status === 'active' ||
        update.encryptedBotToken ||
        update.encryptedSigningSecret ||
        update.encryptedApiKey ||
        update.apiKeyId
      ) {
        const parent = await channel().findOne({ channelId, createdBy }).select('tenantId').lean();
        if (!parent) return null;
        return ownerWrite(createdBy, parent.tenantId, write);
      }
      return write();
    },
    async deleteAgentChannel(channelId: string, createdBy: string): Promise<boolean> {
      const deleting = await channel()
        .findOneAndUpdate({ channelId, createdBy }, { $set: { status: 'deleting' } }, { new: true })
        .select('tenantId')
        .lean();
      if (!deleting) return false;
      await retireChannelScope(mongoose, deleting.tenantId, channelId);
      if (
        await mongoose.models.ChannelRun.exists({
          channelId,
          tenantId: deleting.tenantId || '_',
          state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
        })
      )
        return false;
      // Keep the deleting parent available for a retry if dependent cleanup fails.
      await threads().deleteMany({ channelId, tenantId: deleting.tenantId || { $in: [null, ''] } });
      const result = await channel().deleteOne({
        _id: deleting._id,
        createdBy,
        status: 'deleting',
      });
      return result.deletedCount > 0;
    },
    async getAgentChannelThread(
      channelId: string,
      externalThreadKey: string,
    ): Promise<AgentChannelThreadRecord | null> {
      return threads().findOne({ channelId, externalThreadKey }).lean();
    },
    async getOrCreateAgentChannelThread(
      channelId: string,
      externalThreadKey: string,
    ): Promise<AgentChannelThreadRecord> {
      await ensureThreadIndexes();
      const parent = await channel().findOne({ channelId }).select('tenantId status').lean();
      if (!parent || parent.status === 'deleting')
        throw new Error('Channel thread authority unavailable');
      await initializeChannelScope(mongoose, parent.tenantId, channelId);
      const session = await mongoose.startSession();
      let mapping: AgentChannelThreadRecord | null = null;
      try {
        await session.withTransaction(async () => {
          if (!(await touchChannelScope(mongoose, parent.tenantId, channelId, session)))
            throw new Error('Channel thread authority unavailable');
          mapping = await threads()
            .findOneAndUpdate(
              { channelId, externalThreadKey, tenantId: parent.tenantId || { $in: [null, ''] } },
              {
                $setOnInsert: {
                  channelId,
                  externalThreadKey,
                  tenantId: parent.tenantId,
                  conversationId: randomUUID(),
                },
              },
              { upsert: true, new: true, session },
            )
            .lean();
        });
        if (!mapping) throw new Error('Channel thread mapping unavailable');
        return mapping;
      } finally {
        await session.endSession();
      }
    },
  };
}
