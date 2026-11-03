import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig, DurableStorageConfig } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { AgentChannelRecord } from '~/models/channel';
import type { ManagedState } from '~/types/managed';
import { eraseChannelIdentitiesForChannel } from './channelIdentityErasure';
import { eraseChannelFeedbackForChannel } from './channelFeedbackErasure';
import { reconcileClosedChannelTarget } from './channelRegistry';
import { createManagedAgentChannel } from './channelCreation';
import { includeManagedAllocations } from '~/utils/managed';
import { updateManagedAgentChannel } from './channelUpdate';
import { createChannelIndexGate } from './channelIndexes';
import { CHANNEL_PRIVATE_FIELDS } from '~/models/channel';
import { eraseChannelCopies } from './channelCopies';
import { retireAgentChannel } from './channelScope';
import { managedTargetPredicate } from './managed';

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
      .select('tenantId +_managed')
      .read('primary')
      .lean<{ _id: Types.ObjectId; tenantId?: string; _managed: ManagedState }>();
    if (!parent) return null;
    const config = channelStorageConfigSchema.parse(await getStorageConfig());
    const record = await retireAgentChannel(
      mongoose,
      {
        channelId,
        createdBy,
        tenantId: parent.tenantId,
        id: String(parent._id),
        incarnation: parent._managed.incarnation,
      },
      false,
      config,
    );
    return record
      ? {
          record,
          batchSize: config.erasureBatchSize,
          id: String(parent._id),
          target: {
            kind: 'channel' as const,
            id: String(parent._id),
            incarnation: parent._managed.incarnation,
            ...(parent.tenantId && { tenantId: parent.tenantId }),
          },
        }
      : null;
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
      await ensureIndexes();
      return updateManagedAgentChannel(
        mongoose,
        channelId,
        createdBy,
        update,
        expectedStatus,
        expectedRevision,
        channelStorageConfigSchema.parse(await getStorageConfig()).erasureBatchSize,
        getDurableConfig,
      );
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
      const frame = { target: started.target, channelId, createdBy };
      if (!(await eraseChannelCopies(mongoose, frame, started.batchSize)))
        return { status: 'pending_drain' };
      await eraseChannelIdentitiesForChannel(
        mongoose,
        started.target,
        channelId,
        started.batchSize,
      );
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
      await eraseChannelFeedbackForChannel(mongoose, started.target);
      await reconcileClosedChannelTarget(mongoose, started.target);
      const result = await channel().deleteOne({
        ...managedTargetPredicate(mongoose, started.target),
        channelId,
        createdBy,
        status: 'deleting',
        pendingCount: { $in: [null, 0] },
        'pending.0': { $exists: false },
      });
      if (result.deletedCount > 0) return { status: 'deleted' };
      return (await channel()
        .exists({ ...managedTargetPredicate(mongoose, started.target), channelId, createdBy })
        .read('primary'))
        ? { status: 'pending_drain' }
        : { status: 'not_found' };
    },
  };
}
