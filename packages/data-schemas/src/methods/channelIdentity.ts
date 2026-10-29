import type { ChannelExternalIdentity } from 'librechat-data-provider';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import { createChannelIndexGate } from './channelIndexes';
export type { ChannelIdentityRecord } from '~/models/channelIdentity';

export interface ChannelIdentityStorage {
  readChannelIdentity(identity: ChannelExternalIdentity): Promise<ChannelIdentityRecord | null>;
  readChannelTicket(tenantId: string, ticketHash: string): Promise<ChannelIdentityRecord | null>;
  readChannelLink(tenantId: string, linkId: string): Promise<ChannelIdentityRecord | null>;
  listChannelLinks(tenantId: string, userId: string): Promise<ChannelIdentityRecord[]>;
  saveChannelIdentity(
    record: ChannelIdentityRecord,
    expectedRevision: string | null,
  ): Promise<boolean>;
  revokeChannelIdentities(tenantId: string, channelId: string, revision: string): Promise<void>;
}

export function createChannelIdentityStorage(
  mongoose: typeof import('mongoose'),
): ChannelIdentityStorage {
  const model = () => mongoose.model<ChannelIdentityRecord>('ChannelIdentity');
  const ensureIndexes = createChannelIndexGate(() => [model()]);
  return {
    async readChannelIdentity(identity) {
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
      return model().findOne({ tenantId, ticketHash }).select('+ticketHash').lean();
    },
    async readChannelLink(tenantId, linkId) {
      return model().findOne({ tenantId, linkId }).select('+ticketHash').lean();
    },
    async listChannelLinks(tenantId, userId) {
      return model().find({ tenantId, userId }).sort({ createdAt: -1 }).lean();
    },
    async saveChannelIdentity(record, expectedRevision) {
      await ensureIndexes();
      if (expectedRevision === null) {
        try {
          await model().create(record);
          return true;
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 11000)
            return false;
          throw error;
        }
      }
      const result = await model().updateOne(
        { tenantId: record.tenantId, linkId: record.linkId, revision: expectedRevision },
        {
          $set: {
            identity: record.identity,
            revision: record.revision,
            state: record.state,
            ticketHash: record.ticketHash,
            ticketExpiresAtMs: record.ticketExpiresAtMs,
            expiresAtMs: record.expiresAtMs,
            ...(record.userId ? { userId: record.userId, accountLabel: record.accountLabel } : {}),
          },
          ...(!record.userId ? { $unset: { userId: '', accountLabel: '' } } : {}),
        },
      );
      return result.modifiedCount === 1;
    },
    async revokeChannelIdentities(tenantId, channelId, revision) {
      await model().updateMany(
        { tenantId, 'identity.channelId': channelId, state: { $ne: 'revoked' } },
        { $set: { state: 'revoked', revision } },
      );
    },
  };
}
