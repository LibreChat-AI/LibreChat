import {
  channelExternalIdentitySchema,
  sameChannelExternalIdentity,
} from 'librechat-data-provider';
import type { ChannelExternalIdentity, DiscordInboxFence } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import {
  assertChannelTenant,
  initializeChannelScope,
  touchChannelAuthority,
  lockChannelScope,
} from './channelScope';
import { startRequiredTransactionSession } from '~/utils/transactions';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { createChannelIndexGate } from './channelIndexes';
import { channelIdentityScope } from './channelProvider';
import { touchDiscordInbox } from './discordInboxScope';
export type { ChannelIdentityRecord } from '~/models/channelIdentity';

export interface DiscordIdentityWrite {
  fence: DiscordInboxFence;
  now: number;
}
export interface ChannelIdentityStorage {
  readChannelIdentity(identity: ChannelExternalIdentity): Promise<ChannelIdentityRecord | null>;
  readChannelTicket(tenantId: string, ticketHash: string): Promise<ChannelIdentityRecord | null>;
  readChannelLink(tenantId: string, linkId: string): Promise<ChannelIdentityRecord | null>;
  listChannelLinks(tenantId: string, userId: string): Promise<ChannelIdentityRecord[]>;
  /** Attach only to the exact live ticket; no upserts or identity-state changes. */
  saveChannelIdentityReply(
    record: ChannelIdentityRecord,
    reply: NonNullable<ChannelIdentityRecord['slackReply']>,
  ): Promise<boolean>;
  claimChannelIdentityReply(
    record: ChannelIdentityRecord,
    reply: NonNullable<ChannelIdentityRecord['slackReply']>,
  ): Promise<boolean>;
  clearChannelIdentityReply(tenantId: string, linkId: string, attempt: string): Promise<void>;
  /** Full private replacement; every state joins the open channel fence and exact identity CAS. */
  saveChannelIdentity(
    record: ChannelIdentityRecord,
    expectedRevision: string | null,
    applicationRevision?: string,
    ingress?: DiscordIdentityWrite,
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
      channelExternalIdentitySchema.parse(identity);
      return model()
        .findOne({
          tenantId: identity.tenantId,
          'identity.channelId': identity.channelId,
          ...channelIdentityScope(identity),
          'identity.externalUserId': identity.externalUserId,
        })
        .select('+ticketHash +slackReply')
        .lean();
    },
    async readChannelTicket(tenantId, ticketHash) {
      assertChannelTenant(tenantId);
      return model().findOne({ tenantId, ticketHash }).select('+ticketHash +slackReply').lean();
    },
    async readChannelLink(tenantId, linkId) {
      assertChannelTenant(tenantId);
      return model().findOne({ tenantId, linkId }).select('+ticketHash +slackReply').lean();
    },
    async listChannelLinks(tenantId, userId) {
      assertChannelTenant(tenantId);
      return model().find({ tenantId, userId }).sort({ createdAt: -1 }).lean();
    },
    async saveChannelIdentityReply(record, reply) {
      assertChannelTenant(record.tenantId);
      if (record.identity.provider !== undefined) return false;
      if (reply.attempt !== record.ticketHash) throw new TypeError('Reply ticket mismatch');
      // Existing-row only: deletion cannot be followed by a callback upsert.
      const result = await model().updateOne(
        {
          tenantId: record.tenantId,
          linkId: record.linkId,
          ticketHash: reply.attempt,
          state: { $in: ['pending', 'accepted'] },
          identity: record.identity,
          slackReply: { $exists: false },
        },
        { $set: { slackReply: reply } },
        { runValidators: true },
      );
      return result.matchedCount === 1;
    },
    async claimChannelIdentityReply(record, reply) {
      assertChannelTenant(record.tenantId);
      if (record.identity.provider !== undefined) return false;
      const result = await model().updateOne(
        {
          tenantId: record.tenantId,
          linkId: record.linkId,
          revision: record.revision,
          state: 'accepted',
          ticketHash: reply.attempt,
          'slackReply.encryptedUrl': reply.encryptedUrl,
          'slackReply.attempt': reply.attempt,
          'slackReply.claimed': { $ne: true },
        },
        { $set: { 'slackReply.claimed': true } },
      );
      return result.modifiedCount === 1;
    },
    async clearChannelIdentityReply(tenantId, linkId, attempt) {
      assertChannelTenant(tenantId);
      await model().updateOne(
        { tenantId, linkId, 'slackReply.attempt': attempt },
        { $unset: { slackReply: '' } },
      );
    },
    async saveChannelIdentity(record, expectedRevision, applicationRevision, ingress) {
      assertChannelTenant(record.tenantId);
      channelExternalIdentitySchema.parse(record.identity);
      if (record.tenantId !== record.identity.tenantId)
        throw new TypeError('Channel identity tenant mismatch');
      if (typeof record.identity.channelRevision !== 'string' || !record.identity.channelRevision)
        throw new TypeError('Channel revision required');
      // Browser consent can advance an existing pending ticket without provider ingress.
      const browserConsent =
        record.identity.provider === 'discord' &&
        applicationRevision === undefined &&
        record.state === 'accepted' &&
        Boolean(expectedRevision);
      if (record.identity.provider === 'discord' && !applicationRevision && !browserConsent)
        return false;
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
        ...(['pending', 'revoked'].includes(record.state) ? { slackReply: '' } : {}),
        ...(!record.userId ? { userId: '' } : {}),
        ...(record.accountLabel == null ? { accountLabel: '' } : {}),
        ...(record.state !== 'active' || record.identity.provider !== 'discord'
          ? { discordActivatedAtMs: '' }
          : {}),
      };
      const persist = async (session: ClientSession): Promise<boolean> => {
        if (record.identity.provider === 'discord' && record.state === 'active') {
          // Never trust caller metadata or ordinary active saves to establish new consent.
          delete fields.discordActivatedAtMs;
          absent.discordActivatedAtMs = '';
          const previous =
            expectedRevision === null
              ? null
              : await model()
                  .findOne({
                    tenantId: record.tenantId,
                    linkId: record.linkId,
                    revision: expectedRevision,
                  })
                  .session(session)
                  .lean();
          if (
            previous &&
            previous.userId === record.userId &&
            sameChannelExternalIdentity(previous.identity, record.identity)
          ) {
            if (previous.state === 'accepted' && ingress) fields.discordActivatedAtMs = Date.now();
            else if (
              previous.state === 'active' &&
              previous.revision === record.revision &&
              Number.isSafeInteger(previous.discordActivatedAtMs) &&
              (previous.discordActivatedAtMs ?? 0) > 0
            )
              fields.discordActivatedAtMs = previous.discordActivatedAtMs;
          }
          if (fields.discordActivatedAtMs !== undefined) delete absent.discordActivatedAtMs;
        }

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
            ...(browserConsent ? { state: 'pending' } : {}),
            'identity.tenantId': record.identity.tenantId,
            'identity.channelId': record.identity.channelId,
            ...channelIdentityScope(record.identity),
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
        const session = await startRequiredTransactionSession(mongoose);
        try {
          let saved = false;
          await session.withTransaction(async () => {
            if (
              ingress &&
              (record.identity.provider !== 'discord' ||
                ingress.fence.applicationId !== record.identity.applicationId ||
                !applicationRevision ||
                !(await touchDiscordInbox(
                  mongoose,
                  {
                    tenantId: record.tenantId,
                    channelId: record.identity.channelId,
                    externalUserId: record.identity.externalUserId,
                    applicationRevision,
                  },
                  ingress.fence,
                  ingress.now,
                  session,
                )))
            ) {
              saved = false;
              return;
            }
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
                  provider: record.identity.provider,
                  applicationId: record.identity.applicationId,
                  applicationRevision,
                  guildId: record.identity.guildId,
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
      const session = await startRequiredTransactionSession(mongoose);
      try {
        let matched = false;
        await session.withTransaction(async () => {
          await lockChannelScope(mongoose, owner.tenantId, record.identity.channelId, session);
          const result = await model().updateOne(
            filter,
            {
              $set: { state: 'revoked', revision },
              $unset: { slackReply: '', discordActivatedAtMs: '' },
            },
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
      const session = await startRequiredTransactionSession(mongoose);
      try {
        await session.withTransaction(async () => {
          await lockChannelScope(mongoose, tenantId, channelId, session);
          await model().updateMany(
            { tenantId, 'identity.channelId': channelId, state: { $ne: 'revoked' } },
            {
              $set: { state: 'revoked', revision },
              $unset: { slackReply: '', discordActivatedAtMs: '' },
            },
            { session, runValidators: true },
          );
        });
      } finally {
        await session.endSession();
      }
    },
  };
}
