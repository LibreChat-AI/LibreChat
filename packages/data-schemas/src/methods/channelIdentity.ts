import type { ChannelExternalIdentity } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { createChannelIndexGate } from './channelIndexes';
import { assertChannelTenant } from './channelScope';
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
      await ensureIndexes();
      if (
        (!record.userId && record.accountLabel) ||
        (['accepted', 'active'].includes(record.state) && !record.userId)
      )
        throw new TypeError('Channel account identity required');
      const persist = async (session?: ClientSession): Promise<boolean> => {
        if (expectedRevision === null) {
          await model().create([record], session ? { session } : {});
          return true;
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
              ...(record.userId
                ? { userId: record.userId, accountLabel: record.accountLabel }
                : {}),
            },
            ...(!record.userId ? { $unset: { userId: '', accountLabel: '' } } : {}),
          },
          session ? { session } : {},
        );
        return result.modifiedCount === 1;
      };
      try {
        if (!record.userId) return await persist();
        const admit = await prepareChannelOwnerAdmission(mongoose, {
          userId: record.userId,
          tenantId: record.tenantId === '_' ? undefined : record.tenantId,
        });
        const session = await mongoose.startSession();
        try {
          let saved = false;
          await session.withTransaction(async () => {
            saved = (await admit(session)) ? await persist(session) : false;
          });
          return saved;
        } finally {
          await session.endSession();
        }
      } catch (error) {
        if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) return false;
        throw error;
      }
    },

    async revokeChannelIdentities(tenantId, channelId, revision) {
      assertChannelTenant(tenantId);
      await model().updateMany(
        { tenantId, 'identity.channelId': channelId, state: { $ne: 'revoked' } },
        { $set: { state: 'revoked', revision } },
      );
    },
  };
}
