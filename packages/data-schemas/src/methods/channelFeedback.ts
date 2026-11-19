import type {
  ChannelReplyMapping,
  ChannelFeedbackActor,
  DiscordChannelReplyMapping,
  ChannelFeedbackResult,
  ChannelFeedbackView,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
import type { ChannelFeedbackReplySource } from './channelFeedbackSource';
import type { ChannelFeedbackSourceState } from './channelFeedbackScope';
import type { FeedbackCheckpoint } from './channelFeedbackCheckpoint';
import type { DiscordCommandScope } from './discordCommands';
import type { ChannelRunRecord } from '~/models/channelRun';
import {
  withChannelFeedbackAuthority,
  sameFeedbackSource,
  readChannelFeedbackSourceState,
  ChannelFeedbackAuthorityError,
} from './channelFeedbackScope';
import {
  feedbackCheckpoint,
  pinFeedbackCheckpoint,
  acknowledgeFeedbackReceipt,
} from './channelFeedbackCheckpoint';
import { channelFeedbackProviderFilter } from './channelFeedbackProtocol';
import { readChannelFeedbackReplySource } from './channelFeedbackSource';
import { createDiscordFeedbackRecorder } from './discordFeedback';
import { createChannelIndexGate } from './channelIndexes';
import { assertChannelTenant } from './channelScope';
export type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
export type { ChannelFeedbackReplySource } from './channelFeedbackSource';
export { ChannelFeedbackAuthorityError } from './channelFeedbackScope';

/** Two ratings, each with five supported skin tones plus the default emoji, per delivery part. */
export {
  CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX,
  CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS,
  channelFeedbackReactionIdentity,
  isLaterChannelFeedbackEvent,
} from './channelFeedbackProtocol';
export interface DiscordFeedbackStorage {
  /** Metadata only, before delivery; the service checks current channel/link authority on both sides. */
  readDiscordFeedbackRunSource(run: ChannelRunRecord): Promise<ChannelFeedbackSourceState | null>;
  /** The canonical inbox action chooses the rating and referenced run. Vote and receipt commit atomically. */
  recordDiscordFeedback(
    scope: DiscordCommandScope,
    mapping: DiscordChannelReplyMapping,
    now: number,
  ): Promise<ChannelFeedbackResult<ChannelFeedbackView>>;
}
export interface ChannelFeedbackStorage {
  deferChannelFeedbackEvent(record: ChannelFeedbackEventRecord, retryAtMs: number): Promise<void>;
  deferChannelFeedbackExport(
    record: ChannelFeedbackLedger,
    now: number,
    retryAtMs: number,
  ): Promise<void>;
  withAuthority<T>(
    mapping: ChannelReplyMapping,
    work: (storage: ChannelFeedbackStorage) => Promise<T>,
  ): Promise<T>;
  isAuthorityCurrent(mapping: ChannelReplyMapping): Promise<boolean>;
  /** Ineligible sources return null; database/operational failures throw. */
  readChannelReplyTrace(mapping: ChannelReplyMapping): Promise<ChannelFeedbackSourceState | null>;
  readReplySource(
    actor: ChannelFeedbackActor,
    externalMessageKey: string,
  ): Promise<ChannelFeedbackReplySource | null>;
  putChannelReply(mapping: ChannelReplyMapping): Promise<ChannelReplyMapping>;
  getChannelReply(
    actor: ChannelFeedbackActor,
    externalMessageKey: string,
  ): Promise<ChannelReplyMapping | null>;
  admitChannelFeedbackEvent(
    record: ChannelFeedbackEventRecord,
  ): Promise<ChannelFeedbackEventRecord>;
  pendingChannelFeedbackEvents(
    tenantId: string,
    limit: number,
    now?: number,
  ): Promise<ChannelFeedbackEventRecord[]>;
  markChannelFeedbackEvent(record: ChannelFeedbackEventRecord): Promise<void>;
  ensureChannelFeedback(record: ChannelFeedbackLedger): Promise<ChannelFeedbackLedger>;
  getChannelFeedback(tenantId: string, key: string): Promise<ChannelFeedbackLedger | null>;
  saveChannelFeedback(record: ChannelFeedbackLedger, expectedRevision: number): Promise<boolean>;
  claimChannelFeedbackExport(
    candidate: ChannelFeedbackLedger,
    leaseId: string,
    now: number,
    leaseUntilMs: number,
  ): Promise<ChannelFeedbackLedger | null>;
  finishChannelFeedbackExport(
    record: ChannelFeedbackLedger,
    leaseId: string,
    success: boolean,
    retryAtMs: number,
    finishedAt: number,
  ): Promise<void>;
  pendingChannelFeedbackExports(
    tenantId: string,
    now: number,
    limit: number,
  ): Promise<ChannelFeedbackLedger[]>;
}

export function createChannelFeedbackStorage(
  mongoose: typeof import('mongoose'),
): ChannelFeedbackStorage & DiscordFeedbackStorage {
  const recordDiscordFeedback = createDiscordFeedbackRecorder(mongoose);
  const replies = () => mongoose.model<ChannelReplyMapping>('ChannelReply');
  const events = () => mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  const ledger = () => mongoose.model<ChannelFeedbackLedger>('ChannelFeedback');
  const ensureIndexes = createChannelIndexGate(() => [replies(), events(), ledger()]);
  function page(tenantId: string, limit: number) {
    assertChannelTenant(tenantId);
    // Same structural maximum as the existing feedback worker batch schema.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('Invalid feedback metadata page');
  }
  function createStorage(
    session?: ClientSession,
    source?: ChannelReplyMapping,
    sourceExpiry: Date | null = null,
    sourceState?: ChannelFeedbackSourceState,
  ): ChannelFeedbackStorage & DiscordFeedbackStorage {
    let checkpoint: FeedbackCheckpoint | undefined;
    function remember(record: ChannelFeedbackLedger) {
      if (session && source && sameFeedbackSource(source, record.mapping))
        checkpoint = feedbackCheckpoint(record);
    }
    async function guard<T>(
      mapping: ChannelReplyMapping,
      work: (
        session: ClientSession,
        expiredAt: Date | null,
        state: ChannelFeedbackSourceState,
      ) => Promise<T>,
    ): Promise<T> {
      await ensureIndexes();
      if (session && source) {
        if (!sameFeedbackSource(source, mapping) || !sourceState)
          throw new ChannelFeedbackAuthorityError();
        return work(session, sourceExpiry, sourceState);
      }
      return withChannelFeedbackAuthority(mongoose, mapping, work);
    }
    function retainedInsert(record: object, expiredAt: Date | null) {
      const insert = { ...record } as Record<string, unknown>;
      delete insert.expiredAt;
      return {
        $setOnInsert: insert,
        ...(expiredAt ? { $min: { expiredAt } } : {}),
      };
    }
    const storage: ChannelFeedbackStorage & DiscordFeedbackStorage = {
      recordDiscordFeedback,
      async readDiscordFeedbackRunSource(run) {
        const actor = run.admission.actor;
        if (
          actor.provider !== 'discord' ||
          !run.principal.linkId ||
          !run.principal.linkRevision ||
          run.snapshot?.status !== 'completed' ||
          !run.snapshot.responseId ||
          run.execution?.protocol !== 'responses' ||
          run.execution.responseId !== run.snapshot.responseId ||
          !['delivering', 'delivered'].includes(run.state)
        )
          return null;
        assertChannelTenant(run.tenantId);
        const current = await mongoose.model('ChannelRun').exists({
          tenantId: run.tenantId,
          channelId: run.channelId,
          agentId: run.agentId,
          runId: run.runId,
          state: { $in: ['delivering', 'delivered'] },
          'principal.userId': run.principal.userId,
          'principal.channelRevision': run.principal.channelRevision,
          'principal.linkId': run.principal.linkId,
          'principal.linkRevision': run.principal.linkRevision,
          ...channelFeedbackProviderFilter(
            {
              ...actor,
              tenantId: run.tenantId,
              channelId: run.channelId,
              channelRevision: run.principal.channelRevision,
              agentId: run.agentId,
            },
            'admission.actor.',
          ),
          'admission.actor.externalUserId': actor.externalUserId,
          'admission.externalChannelId': run.admission.externalChannelId,
          'snapshot.status': 'completed',
          'snapshot.responseId': run.snapshot.responseId,
          'execution.protocol': 'responses',
          'execution.responseId': run.snapshot.responseId,
          'execution.conversationId': run.execution.conversationId,
        });
        if (!current) return null;
        try {
          const source = await readChannelFeedbackSourceState(mongoose, {
            tenantId: run.tenantId,
            principalId: run.principal.userId,
            conversationId: run.execution.conversationId,
            messageId: run.snapshot.responseId,
          });
          return source.expiredAt && source.expiredAt.getTime() <= Date.now() ? null : source;
        } catch (error) {
          if (error instanceof ChannelFeedbackAuthorityError) return null;
          throw error;
        }
      },
      async deferChannelFeedbackEvent(record, retryAtMs) {
        assertChannelTenant(record.tenantId);
        if (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0)
          throw new TypeError('Invalid feedback retry deadline');
        await events().updateOne(
          {
            tenantId: record.tenantId,
            channelId: record.channelId,
            eventId: record.eventId,
            digest: record.digest,
            processed: false,
          },
          { $max: { retryAtMs } },
        );
      },
      async deferChannelFeedbackExport(record, now, retryAtMs) {
        assertChannelTenant(record.tenantId);
        if (!Number.isSafeInteger(now) || !Number.isSafeInteger(retryAtMs) || retryAtMs < now)
          throw new TypeError('Invalid feedback retry deadline');
        await ledger().updateOne(
          {
            tenantId: record.tenantId,
            key: record.key,
            revision: record.revision,
            exportStatus: 'pending',
            $or: [{ leaseUntilMs: { $exists: false } }, { leaseUntilMs: { $lte: now } }],
          },
          { $max: { retryAtMs } },
        );
      },
      async withAuthority<T>(
        mapping: ChannelReplyMapping,
        work: (storage: ChannelFeedbackStorage) => Promise<T>,
      ): Promise<T> {
        return guard(mapping, (active, expiredAt, state) =>
          work(createStorage(active, mapping, expiredAt, state)),
        );
      },
      async readChannelReplyTrace(mapping) {
        try {
          return await guard(mapping, async (_active, _expiry, state) => state);
        } catch (error) {
          if (error instanceof ChannelFeedbackAuthorityError) return null;
          throw error;
        }
      },
      async isAuthorityCurrent(mapping) {
        try {
          await guard(mapping, async () => undefined);
          return true;
        } catch (error) {
          if (error instanceof ChannelFeedbackAuthorityError) return false;
          throw error;
        }
      },
      readReplySource: (actor, key) => readChannelFeedbackReplySource(mongoose, actor, key),
      async putChannelReply(mapping) {
        return guard(mapping, async (active, expiredAt) => {
          const filter = {
            tenantId: mapping.tenantId,
            channelId: mapping.channelId,
            ...channelFeedbackProviderFilter(mapping),
            externalMessageKey: mapping.externalMessageKey,
          };
          await replies().updateOne(filter, retainedInsert(mapping, expiredAt), {
            upsert: true,
            session: active,
          });

          const stored = await replies().findOne(filter).session(active).lean();
          if (!stored) throw new Error('Channel reply disappeared during admission');
          return stored;
        });
      },
      async getChannelReply(actor, externalMessageKey) {
        assertChannelTenant(actor.tenantId);
        return replies()
          .findOne({
            tenantId: actor.tenantId,
            channelId: actor.channelId,
            ...channelFeedbackProviderFilter(actor),
            channelRevision: actor.channelRevision,
            agentId: actor.agentId,
            externalMessageKey,
          })
          .session(session ?? null)
          .lean();
      },
      async admitChannelFeedbackEvent(record) {
        if (
          record.mapping.provider === 'discord' ||
          record.event.provider !== record.mapping.provider
        )
          throw new ChannelFeedbackAuthorityError();
        return guard(record.mapping, async (active, expiredAt) => {
          const filter = {
            tenantId: record.tenantId,
            channelId: record.channelId,
            eventId: record.eventId,
          };
          await events().updateOne(filter, retainedInsert(record, expiredAt), {
            upsert: true,
            session: active,
          });

          const stored = await events().findOne(filter).session(active).lean();
          if (!stored) throw new Error('Channel feedback event disappeared during admission');
          return stored;
        });
      },
      async pendingChannelFeedbackEvents(tenantId, limit, now = Date.now()) {
        page(tenantId, limit);
        // Rotation must remain fair even when the retry delay expires between scans.
        return events()
          .find({
            tenantId,
            processed: false,
            $and: [
              { $or: [{ retryAtMs: { $exists: false } }, { retryAtMs: { $lte: now } }] },
              { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] },
            ],
          })
          .sort({ updatedAt: 1, _id: 1 })
          .limit(limit)
          .session(session ?? null)
          .lean();
      },
      async markChannelFeedbackEvent(record) {
        await guard(record.mapping, async (active) => {
          let current = checkpoint;
          if (
            !current ||
            current.key !== record.ledgerKey ||
            !sameFeedbackSource(current.mapping, record.mapping)
          ) {
            const stored = await ledger()
              .findOne({ tenantId: record.tenantId, key: record.ledgerKey })
              .session(active)
              .lean();
            if (!stored || !sameFeedbackSource(stored.mapping, record.mapping))
              throw new ChannelFeedbackAuthorityError();
            current = feedbackCheckpoint(stored);
          }
          await acknowledgeFeedbackReceipt(mongoose, record, current, active);
        });
      },
      async ensureChannelFeedback(record) {
        if (record.mapping.provider === 'discord') throw new ChannelFeedbackAuthorityError();
        return guard(record.mapping, async (active, expiredAt) => {
          const filter = { tenantId: record.tenantId, key: record.key };
          await ledger().updateOne(
            filter,
            retainedInsert(
              { ...record, scoreTimestamp: record.scoreTimestamp ?? new Date() },
              expiredAt,
            ),
            { upsert: true, session: active },
          );

          const stored = await ledger().findOne(filter).session(active).lean();
          if (!stored) throw new Error('Channel feedback ledger disappeared during admission');
          remember(stored);
          return stored;
        });
      },
      async getChannelFeedback(tenantId, key) {
        assertChannelTenant(tenantId);
        const stored = await ledger()
          .findOne({ tenantId, key })
          .session(session ?? null)
          .lean();
        if (stored) remember(stored);
        return stored;
      },
      async saveChannelFeedback(record, expectedRevision) {
        if (record.mapping.provider === 'discord') throw new ChannelFeedbackAuthorityError();
        return guard(record.mapping, async (active) => {
          const result = await ledger().updateOne(
            { tenantId: record.tenantId, key: record.key, revision: expectedRevision },
            {
              $set: {
                votes: record.votes,
                rating: record.rating,
                revision: record.revision,
                exportStatus: 'pending',
                retryAtMs: 0,
              },
            },
            { session: active },
          );
          if (result.modifiedCount !== 1) return false;
          remember(record);
          await pinFeedbackCheckpoint(mongoose, record, active);
          return true;
        });
      },
      async claimChannelFeedbackExport(candidate, leaseId, now, leaseUntilMs) {
        if (
          !leaseId ||
          !Number.isSafeInteger(now) ||
          !Number.isSafeInteger(leaseUntilMs) ||
          leaseUntilMs <= now
        )
          throw new TypeError('Invalid feedback lease');
        return guard(candidate.mapping, async (active) => {
          if (!candidate.scoreTimestamp || !Number.isFinite(candidate.scoreTimestamp.getTime()))
            throw new TypeError('Invalid feedback score timestamp');
          return ledger()
            .findOneAndUpdate(
              {
                tenantId: candidate.tenantId,
                key: candidate.key,
                revision: candidate.revision,
                exportStatus: 'pending',
                retryAtMs: { $lte: now },
                $or: [{ leaseUntilMs: { $exists: false } }, { leaseUntilMs: { $lte: now } }],
              },
              { $set: { leaseId, leaseUntilMs } },
              { new: true, session: active },
            )
            .lean();
        });
      },
      async finishChannelFeedbackExport(record, leaseId, success, retryAtMs, finishedAt) {
        await guard(record.mapping, async (active) => {
          const valid = success && record.leaseUntilMs != null && record.leaseUntilMs > finishedAt;
          const finished = await ledger().updateOne(
            {
              tenantId: record.tenantId,
              key: record.key,
              revision: record.revision,
              leaseId,
              leaseUntilMs: record.leaseUntilMs,
            },
            {
              $set: { exportStatus: valid ? 'sent' : 'pending', retryAtMs },
              $unset: { leaseId: '', leaseUntilMs: '' },
            },
            { session: active },
          );
          if (!finished.matchedCount)
            await ledger().updateOne(
              {
                tenantId: record.tenantId,
                key: record.key,
                leaseId,
                leaseUntilMs: record.leaseUntilMs,
              },
              { $unset: { leaseId: '', leaseUntilMs: '' } },
              { session: active },
            );
        });
      },
      async pendingChannelFeedbackExports(tenantId, now, limit) {
        page(tenantId, limit);
        return ledger()
          .find({
            tenantId,
            exportStatus: 'pending',
            retryAtMs: { $lte: now },
            $or: [{ leaseUntilMs: { $exists: false } }, { leaseUntilMs: { $lte: now } }],
          })
          .sort({ updatedAt: 1 })
          .limit(limit)
          .session(session ?? null)
          .lean();
      },
    };
    return storage;
  }
  return createStorage();
}
