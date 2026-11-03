import type { ChannelExternalIdentity, DurableStorageConfig } from 'librechat-data-provider';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import { writeChannelIdentity } from './channelIdentityWrite';
import { createChannelIndexGate } from './channelIndexes';
import { assertChannelTenant } from './channelScope';
export type { ChannelIdentityRecord } from '~/models/channelIdentity';

export interface ChannelIdentityStorage {
  readChannelIdentity(identity: ChannelExternalIdentity): Promise<ChannelIdentityRecord | null>;
  readChannelTicket(tenantId: string, ticketHash: string): Promise<ChannelIdentityRecord | null>;
  readChannelLink(tenantId: string, linkId: string): Promise<ChannelIdentityRecord | null>;
  listChannelLinks(tenantId: string, userId: string): Promise<ChannelIdentityRecord[]>;
  /** Exact private replacement; the first owner is immutable and reissue selects a fresh link root. */
  saveChannelIdentity(
    record: ChannelIdentityRecord,
    expectedRevision: string | null,
  ): Promise<boolean>;
  /** Owner-only authority reduction remains available after the channel closes. */
  revokeChannelIdentity(
    owner: Pick<ChannelIdentityRecord, 'tenantId' | 'linkId' | 'revision'> & { userId: string },
    revision: string,
  ): Promise<boolean>;
  /** Existing-row authority reduction only: no inserts or private-field replacements. */
  revokeChannelIdentities(tenantId: string, channelId: string, revision: string): Promise<void>;
}

export function createChannelIdentityStorage(
  mongoose: typeof import('mongoose'),
  getDurableConfig: () => Promise<Partial<DurableStorageConfig>> = async () => ({}),
): ChannelIdentityStorage {
  const model = () => mongoose.model<ChannelIdentityRecord>('ChannelIdentity');
  const ensureIndexes = createChannelIndexGate(() => [model()]);
  return {
    async readChannelIdentity(identity) {
      assertChannelTenant(identity.tenantId);
      return model()
        .findOne({
          tenantId: identity.tenantId,
          'identity.channelId': identity.channelId,
          'identity.teamId': identity.teamId,
          'identity.externalUserId': identity.externalUserId,
        })
        .select('+ticketHash')
        .lean();
    },
    async readChannelTicket(tenantId, ticketHash) {
      assertChannelTenant(tenantId);
      return model().findOne({ tenantId, ticketHash }).select('+ticketHash').lean();
    },
    async readChannelLink(tenantId, linkId) {
      assertChannelTenant(tenantId);
      return model().findOne({ tenantId, linkId }).select('+ticketHash').lean();
    },
    async listChannelLinks(tenantId, userId) {
      assertChannelTenant(tenantId);
      return model().find({ tenantId, userId }).sort({ createdAt: -1 }).lean();
    },
    async saveChannelIdentity(record, expectedRevision) {
      assertChannelTenant(record.tenantId);
      if (record.tenantId !== record.identity.tenantId)
        throw new TypeError('Channel identity tenant mismatch');
      if (typeof record.identity.channelRevision !== 'string' || !record.identity.channelRevision)
        throw new TypeError('Channel revision required');
      await ensureIndexes();
      if (
        (!record.userId && record.accountLabel != null) ||
        (['accepted', 'active'].includes(record.state) && !record.userId)
      )
        throw new TypeError('Channel account identity required');
      return writeChannelIdentity(mongoose, record, expectedRevision, await getDurableConfig());
    },

    async revokeChannelIdentity(owner, revision) {
      assertChannelTenant(owner.tenantId);
      if (
        ![owner.tenantId, owner.userId, owner.linkId, owner.revision, revision].every(
          (value) => typeof value === 'string' && value.length > 0,
        )
      )
        throw new TypeError('Channel identity revocation requires owner and revision');
      if (revision === owner.revision)
        throw new TypeError('Channel identity revision must advance');
      const filter = {
        tenantId: owner.tenantId,
        userId: owner.userId,
        linkId: owner.linkId,
        revision: owner.revision,
      };
      const record = await model()
        .findOne(filter)
        .select('_id +_managed')
        .read('primary')
        .lean<ChannelIdentityRecord & { _id: unknown; _managed: { incarnation: string } }>();
      if (!record?._managed) return false;
      const result = await model().updateOne(
        {
          ...filter,
          _id: record._id,
          '_managed.incarnation': record._managed.incarnation,
          '_managed.phase': 'published',
        },
        { $set: { state: 'revoked', revision } },
        { upsert: false, runValidators: true },
      );
      return result.matchedCount === 1;
    },

    async revokeChannelIdentities(tenantId, channelId, revision) {
      assertChannelTenant(tenantId);
      await model().updateMany(
        {
          tenantId,
          'identity.channelId': channelId,
          '_managed.phase': 'published',
          state: { $ne: 'revoked' },
        },
        { $set: { state: 'revoked', revision } },
        { upsert: false, runValidators: true },
      );
    },
  };
}
