import { z } from 'zod';
import {
  channelSnowflakeSchema,
  discordChannelConfigSchema,
  discordIngressActionSchema,
  discordInboxFenceSchema,
} from 'librechat-data-provider';
import type {
  DiscordInboxFence,
  DiscordChannelConfig,
  DiscordIngressAction,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordInboxRecord } from '~/models/discordInbox';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordReceiptModel } from '~/models/discordReceipt';
import { createDiscordInboxModel } from '~/models/discordInbox';
import { withRequiredTransaction } from '~/utils/transactions';
import { createChannelIndexGate } from './channelIndexes';
import { touchChannelAuthority } from './channelScope';
import { digest } from './channelProtocol';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export interface SubmitDiscordInteraction {
  eventId: string;
  applicationId: string;
  applicationRevision: string;
  guildId: string;
  channelId: string;
  channelRevision: string;
  agentId: string;
  externalChannelId: string;
  externalUserId: string;
  action: DiscordIngressAction;
  encryptedToken: string;
  tokenHash: string;
  expiresAt: number;
}
const submission: z.ZodType<SubmitDiscordInteraction> = z
  .object({
    eventId: channelSnowflakeSchema,
    applicationId: channelSnowflakeSchema,
    applicationRevision: id,
    guildId: channelSnowflakeSchema,
    channelId: id,
    channelRevision: id,
    agentId: id,
    externalChannelId: channelSnowflakeSchema,
    externalUserId: channelSnowflakeSchema,
    action: discordIngressActionSchema,
    encryptedToken: z.string().min(1).max(16_384),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type DiscordInboxError =
  | 'authority_changed'
  | 'capacity'
  | 'event_conflict'
  | 'expired'
  | 'stale_fence';
export type DiscordInboxResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: DiscordInboxError } };
export interface DiscordInboxAdmission {
  eventId: string;
  state: DiscordInboxRecord['state'];
  duplicate: boolean;
}
export interface DiscordInboxStorage {
  submit(
    input: SubmitDiscordInteraction,
    now: number,
  ): Promise<DiscordInboxResult<DiscordInboxAdmission>>;
  claim(applicationId: string, owner: string, now: number): Promise<DiscordInboxRecord | null>;
  renew(fence: DiscordInboxFence, now: number): Promise<boolean>;
  prepareReply(
    fence: DiscordInboxFence,
    encryptedReply: string,
    now: number,
  ): Promise<DiscordInboxResult<DiscordInboxRecord>>;
  defer(fence: DiscordInboxFence, retryAt: number, now: number): Promise<boolean>;
  finish(
    fence: DiscordInboxFence,
    result: 'completed' | 'expired' | 'unavailable',
    now: number,
  ): Promise<boolean>;
}
const failure = (code: DiscordInboxError): { ok: false; error: { code: DiscordInboxError } } => ({
  ok: false,
  error: { code },
});
const privateFields = '+action +encryptedToken +encryptedReply';
const erase = {
  action: '',
  encryptedToken: '',
  encryptedReply: '',
  commandResult: '',
  leaseOwner: '',
};
const pending = ['queued', 'processing', 'reply'];

/** Persist before acknowledging Discord. Claim/reply writes are fenced and safely reclaimable. */
export function createDiscordInboxStorage(
  mongoose: typeof import('mongoose'),
  getPolicy: () => Promise<Partial<DiscordChannelConfig['inbox']>> = async () => ({}),
): DiscordInboxStorage {
  const inbox = createDiscordInboxModel(mongoose);
  const receipts = createDiscordReceiptModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [inbox, receipts]);
  const policy = async () => discordChannelConfigSchema.shape.inbox.parse(await getPolicy());
  const tenant = () => {
    const value = getTenantId();
    if (value === SYSTEM_TENANT_ID) throw new TypeError('Discord inbox requires a tenant scope');
    return value || undefined;
  };
  function clock(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid Discord inbox clock');
  }
  function owned(fence: DiscordInboxFence, now: number) {
    discordInboxFenceSchema.parse(fence);
    clock(now);
    return {
      tenantId: tenant() ?? null,
      applicationId: fence.applicationId,
      eventId: fence.eventId,
      leaseOwner: fence.owner,
      leaseEpoch: fence.epoch,
      leaseExpiresAt: { $gt: now },
      expiresAt: { $gt: now },
      state: { $in: ['processing', 'reply'] },
    };
  }
  async function current(
    record: Pick<
      DiscordInboxRecord,
      | 'tenantId'
      | 'channelId'
      | 'channelRevision'
      | 'agentId'
      | 'applicationId'
      | 'applicationRevision'
      | 'guildId'
      | 'externalUserId'
      | 'externalChannelId'
    >,
    session: ClientSession,
  ): Promise<boolean> {
    return touchChannelAuthority(mongoose, { ...record, provider: 'discord' }, session);
  }
  async function expire(
    record: DiscordInboxRecord,
    result: 'expired' | 'authority_changed',
    session: ClientSession,
  ) {
    await inbox.updateOne(
      {
        tenantId: record.tenantId ?? null,
        eventId: record.eventId,
        applicationId: record.applicationId,
      },
      {
        $set: { state: 'failed', result, leaseExpiresAt: 0 },
        $unset: erase,
      },
      { session },
    );
  }
  return {
    async submit(input, now) {
      const parsed = submission.parse(input);
      clock(now);
      // Discord interaction tokens have a fixed fifteen-minute platform lifetime.
      if (parsed.expiresAt <= now || parsed.expiresAt > now + 900_000) return failure('expired');
      const limits = await policy();
      const tenantId = tenant();
      const { encryptedToken, tokenHash, ...stable } = parsed;
      const fingerprint = digest({ ...stable, tokenHash, tenantId });
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          const previous = await inbox
            .findOne({
              tenantId: tenantId ?? null,
              applicationId: parsed.applicationId,
              eventId: parsed.eventId,
            })
            .session(session)
            .lean();
          if (previous)
            return previous.fingerprint === fingerprint
              ? {
                  ok: true,
                  value: { eventId: previous.eventId, state: previous.state, duplicate: true },
                }
              : failure('event_conflict');
          if (!(await current({ ...parsed, tenantId }, session)))
            return failure('authority_changed');
          const erased = await receipts
            .findOne({ applicationId: parsed.applicationId, eventId: parsed.eventId })
            .session(session)
            .lean();
          if (erased)
            return failure(erased.fingerprint === fingerprint ? 'expired' : 'event_conflict');
          const filter = {
            tenantId: tenantId ?? null,
            applicationId: parsed.applicationId,
            state: { $in: pending },
            expiresAt: { $gt: now },
          };
          const applicationCount = await inbox.countDocuments(filter).session(session);
          const actorCount = await inbox
            .countDocuments({ ...filter, externalUserId: parsed.externalUserId })
            .session(session);
          const channelCount = await inbox
            .countDocuments({
              ...filter,
              guildId: parsed.guildId,
              externalChannelId: parsed.externalChannelId,
            })
            .session(session);
          if (
            applicationCount >= limits.maxPendingPerApplication ||
            actorCount >= limits.maxPendingPerActor ||
            channelCount >= limits.maxPendingPerChannel
          )
            return failure('capacity');
          await inbox.create(
            [
              {
                ...stable,
                tenantId,
                fingerprint,
                encryptedToken,
                state: 'queued',
                receivedAt: now,
                purgeAt: new Date(now + limits.retentionMs),
                nextAttemptAt: now,
                leaseEpoch: 0,
                leaseExpiresAt: 0,
                authorityWrites: 0,
              },
            ],
            { session },
          );
          return {
            ok: true,
            value: { eventId: parsed.eventId, state: 'queued', duplicate: false },
          };
        },
        ensureIndexes,
      );
    },
    async claim(applicationId, owner, now) {
      channelSnowflakeSchema.parse(applicationId);
      id.parse(owner);
      clock(now);
      const limits = await policy();
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          const expired = await inbox
            .find({
              tenantId: tenant() ?? null,
              applicationId,
              state: { $in: pending },
              expiresAt: { $lte: now },
            })
            .select('eventId')
            .limit(limits.scanLimit)
            .session(session)
            .lean();
          if (expired.length)
            await inbox.updateMany(
              {
                tenantId: tenant() ?? null,
                applicationId,
                eventId: { $in: expired.map((record) => record.eventId) },
                expiresAt: { $lte: now },
                state: { $in: pending },
              },
              { $set: { state: 'failed', result: 'expired', leaseExpiresAt: 0 }, $unset: erase },
              { session },
            );
          const skipped: string[] = [];
          for (let scanned = 0; scanned < limits.scanLimit; scanned++) {
            const filter = {
              tenantId: tenant() ?? null,
              applicationId,
              state: { $in: pending },
              expiresAt: { $gt: now },
              nextAttemptAt: { $lte: now },
              leaseExpiresAt: { $lte: now },
              eventId: { $nin: skipped },
            };
            // Due effects retain receive order, including recovery of unfinished processing.
            const candidate = await inbox
              .findOne(filter)
              .sort({ receivedAt: 1, eventId: 1 })
              .select(privateFields)
              .session(session)
              .lean();
            if (!candidate) return null;
            if (!(await current(candidate, session))) {
              await expire(candidate, 'authority_changed', session);
              continue;
            }
            // current() joins the application fence before checking earlier unfinished effects.
            // Retry backoff keeps its FIFO position; prepared replies have committed their effects.
            if (
              candidate.state !== 'reply' &&
              (await inbox
                .exists({
                  tenantId: tenant() ?? null,
                  applicationId,
                  guildId: candidate.guildId,
                  externalChannelId: candidate.externalChannelId,
                  externalUserId: candidate.externalUserId,
                  eventId: { $ne: candidate.eventId },
                  state: { $in: ['queued', 'processing'] },
                  expiresAt: { $gt: now },
                  $or: [
                    { state: 'processing', leaseExpiresAt: { $gt: now } },
                    { receivedAt: { $lt: candidate.receivedAt } },
                    { receivedAt: candidate.receivedAt, eventId: { $lt: candidate.eventId } },
                  ],
                })
                .session(session))
            ) {
              skipped.push(candidate.eventId);
              continue;
            }
            const claimed = await inbox
              .findOneAndUpdate(
                {
                  tenantId: tenant() ?? null,
                  applicationId,
                  eventId: candidate.eventId,
                  leaseEpoch: candidate.leaseEpoch,
                },
                {
                  $set: {
                    state: candidate.state === 'reply' ? 'reply' : 'processing',
                    leaseOwner: owner,
                    leaseExpiresAt: Math.min(now + limits.leaseMs, candidate.expiresAt),
                  },
                  $inc: { leaseEpoch: 1 },
                },
                { new: true, session },
              )
              .select(privateFields)
              .lean();
            if (!claimed) throw new Error('Discord inbox claim did not persist');
            return claimed;
          }
          return null;
        },
        ensureIndexes,
      );
    },
    async renew(fence, now) {
      const limits = await policy();
      const record = await inbox
        .findOne(owned(fence, now))
        .select('expiresAt')
        .read('primary')
        .lean();
      if (!record) return false;
      const result = await inbox.updateOne(owned(fence, now), {
        $max: { leaseExpiresAt: Math.min(now + limits.leaseMs, record.expiresAt) },
      });
      return result.matchedCount === 1;
    },
    async prepareReply(fence, encryptedReply, now) {
      z.string().min(1).max(131_072).parse(encryptedReply);
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          const record = await inbox
            .findOne(owned(fence, now))
            .select(privateFields)
            .session(session)
            .lean();
          if (!record) return failure('stale_fence');
          if (!(await current(record, session))) return failure('authority_changed');
          if (record.state === 'reply') return { ok: true, value: record };
          const updated = await inbox
            .findOneAndUpdate(
              owned(fence, now),
              { $set: { state: 'reply', encryptedReply } },
              { new: true, session },
            )
            .select(privateFields)
            .lean();
          if (!updated) throw new Error('Discord inbox reply did not persist');
          return { ok: true, value: updated };
        },
        ensureIndexes,
      );
    },
    async defer(fence, retryAt, now) {
      clock(retryAt);
      if (retryAt <= now) throw new TypeError('Discord retry must be in the future');
      const record = await inbox
        .findOne(owned(fence, now))
        .select('expiresAt')
        .read('primary')
        .lean();
      if (!record) return false;
      const result = await inbox.updateOne(owned(fence, now), {
        $set: { nextAttemptAt: Math.min(retryAt, record.expiresAt), leaseExpiresAt: 0 },
        $unset: { leaseOwner: '' },
      });
      return result.matchedCount === 1;
    },
    async finish(fence, result, now) {
      const live = owned(fence, now);
      const filter =
        result === 'expired'
          ? {
              tenantId: live.tenantId,
              applicationId: fence.applicationId,
              eventId: fence.eventId,
              leaseOwner: fence.owner,
              leaseEpoch: fence.epoch,
              state: { $in: ['processing', 'reply'] },
              expiresAt: { $lte: now },
            }
          : { ...live, ...(result === 'completed' ? { state: 'reply' } : {}) };
      const matched = await inbox.updateOne(filter, {
        $set: { state: result === 'completed' ? 'done' : 'failed', result, leaseExpiresAt: 0 },
        $unset: erase,
      });
      return matched.matchedCount === 1;
    },
  };
}
