import type { ChannelExternalIdentity } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import {
  assertChannelTenant,
  initializeChannelScope,
  touchChannelAuthority,
  lockChannelScope,
} from './channelScope';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { createChannelIndexGate } from './channelIndexes';
export type { ChannelIdentityRecord } from '~/models/channelIdentity';

export interface ChannelIdentityStorage {
  readChannelIdentity(identity: ChannelExternalIdentity): Promise<ChannelIdentityRecord | null>;
  readChannelTicket(tenantId: string, ticketHash: string): Promise<ChannelIdentityRecord | null>;
  readChannelLink(tenantId: string, linkId: string): Promise<ChannelIdentityRecord | null>;
  listChannelLinks(tenantId: string, userId: string): Promise<ChannelIdentityRecord[]>;
  /** Full private replacement; every state joins the open channel fence and exact identity CAS. */
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
      // This API replaces a complete private record; omitted optional fields are cleared.
      const fields: Omit<ChannelIdentityRecord, 'tenantId' | 'linkId'> = {
        identity: record.identity,
        revision: record.revision,
        state: record.state,
        ticketHash: record.ticketHash,
        ticketExpiresAtMs: record.ticketExpiresAtMs,
        expiresAtMs: record.expiresAtMs,
        ...(record.userId ? { userId: record.userId } : {}),
        ...(record.accountLabel != null ? { accountLabel: record.accountLabel } : {}),
      };
      const absent = {
        ...(!record.userId ? { userId: '' } : {}),
        ...(record.accountLabel == null ? { accountLabel: '' } : {}),
      };
      const persist = async (session: ClientSession): Promise<boolean> => {
        if (expectedRevision === null) {
          await model().create([{ tenantId: record.tenantId, linkId: record.linkId, ...fields }], {
            session,
          });
          return true;
        }
        const result = await model().updateOne(
          {
            tenantId: record.tenantId,
            linkId: record.linkId,
            revision: expectedRevision,
            'identity.tenantId': record.identity.tenantId,
            'identity.channelId': record.identity.channelId,
            'identity.teamId': record.identity.teamId,
            'identity.externalUserId': record.identity.externalUserId,
            'identity.agentId': record.identity.agentId,
          },
          { $set: fields, ...(Object.keys(absent).length ? { $unset: absent } : {}) },
          { session, runValidators: true },
        );
        return result.modifiedCount === 1;
      };
      try {
        // Every full save can create/replace private data, including revoked records.
        await initializeChannelScope(mongoose, record.tenantId, record.identity.channelId);
        const admit = record.userId
          ? await prepareChannelOwnerAdmission(mongoose, {
              userId: record.userId,
              tenantId: record.tenantId === '_' ? undefined : record.tenantId,
            })
          : undefined;
        const session = await mongoose.startSession();
        try {
          let saved = false;
          await session.withTransaction(async () => {
            if (admit && !(await admit(session))) {
              saved = false;
              return;
            }
            if (
              !(await touchChannelAuthority(
                mongoose,
                {
                  tenantId: record.tenantId,
                  channelId: record.identity.channelId,
                  agentId: record.identity.agentId,
                  channelRevision: record.identity.channelRevision,
                  teamId: record.identity.teamId,
                },
                session,
              ))
            ) {
              saved = false;
              return;
            }
            saved = await persist(session);
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

    async revokeChannelIdentity(owner, revision) {
      assertChannelTenant(owner.tenantId);
      if (
        ![owner.tenantId, owner.userId, owner.linkId, owner.revision, revision].every(
          (value) => typeof value === 'string' && value.length > 0,
        )
      )
        throw new TypeError('Channel identity revocation requires owner and revision');
      const filter = {
        tenantId: owner.tenantId,
        userId: owner.userId,
        linkId: owner.linkId,
        revision: owner.revision,
      };
      const record = await model().findOne(filter).select('identity.channelId').lean();
      if (!record) return false;
      await initializeChannelScope(mongoose, owner.tenantId, record.identity.channelId);
      const session = await mongoose.startSession();
      try {
        let matched = false;
        await session.withTransaction(async () => {
          await lockChannelScope(mongoose, owner.tenantId, record.identity.channelId, session);
          const result = await model().updateOne(
            filter,
            { $set: { state: 'revoked', revision } },
            { session, runValidators: true },
          );
          matched = result.matchedCount === 1;
        });
        return matched;
      } finally {
        await session.endSession();
      }
    },

    async revokeChannelIdentities(tenantId, channelId, revision) {
      assertChannelTenant(tenantId);
      await initializeChannelScope(mongoose, tenantId, channelId);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await lockChannelScope(mongoose, tenantId, channelId, session);
          await model().updateMany(
            { tenantId, 'identity.channelId': channelId, state: { $ne: 'revoked' } },
            { $set: { state: 'revoked', revision } },
            { session, runValidators: true },
          );
        });
      } finally {
        await session.endSession();
      }
    },
  };
}
