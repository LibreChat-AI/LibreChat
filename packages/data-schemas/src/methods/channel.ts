import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig, DurableStorageConfig } from 'librechat-data-provider';
import type { ClientSession, Types } from 'mongoose';
import type { AgentChannelRecord } from '~/models/channel';
import { retireAgentChannel, initializeChannelScope, touchChannelScope } from './channelScope';
import { eraseChannelFeedbackForChannel } from './channelFeedbackErasure';
import { startRequiredTransactionSession } from '~/utils/transactions';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { createManagedAgentChannel } from './channelCreation';
import { includeManagedAllocations } from '~/utils/managed';
import { createChannelIndexGate } from './channelIndexes';
import { CHANNEL_PRIVATE_FIELDS } from '~/models/channel';
import { assertChannelBudget } from './channelBudget';

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
  getDurableConfig: () => Promise<Partial<DurableStorageConfig>> = async () => ({}),
): AgentChannelMethods {
  const channel = () => mongoose.model<AgentChannelRecord>('AgentChannel');
  const ensureIndexes = createChannelIndexGate(() => [channel()]);
  const secrets = CHANNEL_PRIVATE_FIELDS.map((field) => `+${field}`).join(' ');

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
    const parent = await channel()
      .findOne({ channelId, createdBy })
      .select('tenantId')
      .read('primary')
      .lean();
    if (!parent) return null;
    const record = await retireAgentChannel(
      mongoose,
      {
        channelId,
        createdBy,
        tenantId: parent.tenantId,
        id: String(parent._id),
      },
      false,
      await getStorageConfig(),
    );
    return record ? { record, id: String(parent._id) } : null;
  }

  return {
    async createAgentChannel(input: AgentChannelRecord): Promise<AgentChannelRecord> {
      const limits = await getDurableConfig();
      await ensureIndexes();
      return createManagedAgentChannel(mongoose, input, limits);
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
      const fields = {
        ...(update.type !== undefined && { type: update.type }),
        ...(update.status !== undefined && { status: update.status }),
        ...(update.credentialMode !== undefined && { credentialMode: update.credentialMode }),
        ...(update.revision !== undefined && { revision: update.revision }),
        ...(update.slack !== undefined && {
          slack: {
            teamId: update.slack?.teamId,
            appId: update.slack?.appId,
            botUserId: update.slack?.botUserId,
          },
        }),
        ...(update.encryptedBotToken !== undefined && {
          encryptedBotToken: update.encryptedBotToken,
        }),
        ...(update.encryptedSigningSecret !== undefined && {
          encryptedSigningSecret: update.encryptedSigningSecret,
        }),
      };
      const parent = await channel()
        .findOne({ channelId, createdBy })
        .select('tenantId _managed.incarnation')
        .read('primary')
        .lean<AgentChannelRecord & { _id: Types.ObjectId; _managed?: { incarnation: string } }>();
      if (!parent) return null;
      const physical = {
        _id: parent._id,
        '_managed.incarnation': parent._managed?.incarnation ?? { $exists: false },
      };
      const write = async (session: ClientSession): Promise<AgentChannelRecord | null> => {
        const current = await channel()
          .findOne({ ...physical, channelId, createdBy })
          .select(`${secrets} +_managed +pending +pendingCount +retentionEpoch`)
          .session(session)
          .read('primary')
          .lean();
        if (!current || current.status === 'deleting') return null;
        assertChannelBudget(mongoose, 'channel', current, fields);
        return channel()
          .findOneAndUpdate(
            {
              ...physical,
              channelId,
              createdBy,
              status: expectedStatus ?? { $ne: 'deleting' },
              ...(expectedRevision !== undefined ? { revision: expectedRevision } : {}),
            },
            { $set: fields },
            { new: true, session, runValidators: true },
          )
          .select(secrets)
          .lean();
      };
      await initializeChannelScope(mongoose, parent.tenantId, channelId);
      return ownerWrite(createdBy, parent.tenantId, async (session) => {
        if (!(await touchChannelScope(mongoose, parent.tenantId, channelId, session))) return null;
        return write(session);
      });
    },
    async beginAgentChannelDeletion(channelId, createdBy) {
      return (await beginDeletion(channelId, createdBy))?.record ?? null;
    },
    async deleteAgentChannel(
      channelId: string,
      createdBy: string,
    ): Promise<AgentChannelDeletionResult> {
      const started = await beginDeletion(channelId, createdBy);
      if (!started) return { status: 'not_found' };
      const deleting = started.record;
      if (
        await mongoose.models.ChannelRun.exists({
          channelId,
          tenantId: deleting.tenantId || '_',
          state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
        }).read('primary')
      )
        return { status: 'pending_drain' };
      if (
        await includeManagedAllocations(
          mongoose.models.ChannelIdentity.exists({
            tenantId: deleting.tenantId || '_',
            'identity.channelId': channelId,
          }),
        ).read('primary')
      )
        return { status: 'pending_drain' };
      // Keep the deleting parent available for a retry if dependent cleanup fails.
      await eraseChannelFeedbackForChannel(mongoose, deleting.tenantId, channelId);
      const result = await channel().deleteOne({
        _id: started.id,
        channelId,
        createdBy,
        status: 'deleting',
        pendingCount: { $in: [null, 0] },
        'pending.0': { $exists: false },
      });
      if (result.deletedCount > 0) return { status: 'deleted' };
      return (await channel().exists({ _id: started.id, channelId, createdBy }).read('primary'))
        ? { status: 'pending_drain' }
        : { status: 'not_found' };
    },
  };
}
