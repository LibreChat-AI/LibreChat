import type {
  DurableStorageConfig,
  ChannelReplyMapping,
  ChannelFeedbackActor,
} from 'librechat-data-provider';
import type {
  ChannelFeedbackLedger,
  ChannelFeedbackEventRecord,
  ChannelReplyRecord,
  ChannelFeedbackSourceRef,
} from '~/models/channelFeedback';
import type { ChannelFeedbackAuthority, ChannelFeedbackSourceState } from './channelFeedbackScope';
import type { ChannelFeedbackReplySource } from './channelFeedbackSource';
import {
  acknowledgeFeedbackReceipt,
  assertFeedbackProgress,
  bindFeedbackLedger,
  recoverFeedbackReceipts,
} from './channelFeedbackCheckpoint';
import {
  withChannelFeedbackAuthority,
  sameFeedbackSource,
  ChannelFeedbackAuthorityError,
} from './channelFeedbackScope';
import { createFeedbackRecord, writeFeedbackLedger, feedbackFilter } from './channelFeedbackWrite';
import { readChannelFeedbackReplySource } from './channelFeedbackSource';
import { createChannelIndexGate } from './channelIndexes';
import { assertChannelTenant } from './channelScope';
import { managedTargetFilter } from './managed';
import { digest } from './channelProtocol';
export type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
export type { ChannelFeedbackReplySource } from './channelFeedbackSource';
export { ChannelFeedbackAuthorityError } from './channelFeedbackScope';
export {
  CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX,
  CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS,
  channelFeedbackReactionIdentity,
  isLaterChannelFeedbackEvent,
} from './channelFeedbackProtocol';
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
  readChannelReplyTrace(
    mapping: ChannelReplyMapping,
    source?: ChannelFeedbackSourceRef,
  ): Promise<ChannelFeedbackSourceState | null>;
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
  saveChannelFeedback(
    record: ChannelFeedbackLedger,
    expectedRevision: number,
    event: ChannelFeedbackEventRecord,
  ): Promise<boolean>;
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
  getDurableStorageConfig: () => Promise<Partial<DurableStorageConfig>> = async () => ({}),
): ChannelFeedbackStorage {
  const replies = () => mongoose.model<ChannelReplyRecord>('ChannelReply');
  const events = () => mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  const ledger = () => mongoose.model<ChannelFeedbackLedger>('ChannelFeedback');
  const ensureIndexes = createChannelIndexGate(() => [replies(), events(), ledger()]);
  const unexpired = () => ({ $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] });
  function page(tenantId: string, limit: number) {
    assertChannelTenant(tenantId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('Invalid feedback metadata page');
  }
  function createStorage(context?: {
    mapping: ChannelReplyMapping;
    authority: ChannelFeedbackAuthority;
  }): ChannelFeedbackStorage {
    // Only this callback's isolated storage remembers a checkpoint. The shared store retains none.
    let checkpoint: ChannelFeedbackLedger | undefined;
    async function guard<T>(
      mapping: ChannelReplyMapping,
      work: (authority: ChannelFeedbackAuthority) => Promise<T>,
      source?: ChannelFeedbackSourceRef,
    ): Promise<T> {
      await ensureIndexes();
      if (context) {
        if (
          !sameFeedbackSource(context.mapping, mapping) ||
          (source && digest(source) !== digest(context.authority.source))
        )
          throw new ChannelFeedbackAuthorityError();
        return work(context.authority);
      }
      let expected = source;
      if (!expected) {
        const reply = await replies()
          .findOne({
            tenantId: mapping.tenantId,
            channelId: mapping.channelId,
            teamId: mapping.teamId,
            externalMessageKey: mapping.externalMessageKey,
            '_managed.phase': 'published',
          })
          .read('primary')
          .lean();
        if (reply && sameFeedbackSource(reply, mapping)) {
          if (!reply.source) throw new ChannelFeedbackAuthorityError();
          expected = reply.source;
        }
      }
      return withChannelFeedbackAuthority(mongoose, mapping, work, expected);
    }
    function remember(record: ChannelFeedbackLedger) {
      if (context) {
        if (
          !sameFeedbackSource(context.mapping, record.mapping) ||
          digest(record.source ?? {}) !== digest(context.authority.source)
        )
          throw new ChannelFeedbackAuthorityError();
        checkpoint = record;
      }
    }
    const storage: ChannelFeedbackStorage = {
      async deferChannelFeedbackEvent(record, retryAtMs) {
        assertChannelTenant(record.tenantId);
        if (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0)
          throw new TypeError('Invalid feedback retry deadline');
        await events().updateOne(
          { ...feedbackFilter(mongoose, record, 'channelFeedbackEvent'), processed: false },
          { $max: { retryAtMs }, $inc: { __v: 1 } },
          { upsert: false },
        );
      },
      async deferChannelFeedbackExport(record, now, retryAtMs) {
        assertChannelTenant(record.tenantId);
        if (!Number.isSafeInteger(now) || !Number.isSafeInteger(retryAtMs) || retryAtMs < now)
          throw new TypeError('Invalid feedback retry deadline');
        await ledger().updateOne(
          {
            ...feedbackFilter(mongoose, record, 'channelFeedback'),
            revision: record.revision,
            exportStatus: 'pending',
            $or: [{ leaseUntilMs: { $exists: false } }, { leaseUntilMs: { $lte: now } }],
          },
          { $max: { retryAtMs }, $inc: { __v: 1 } },
          { upsert: false },
        );
      },
      withAuthority: (mapping, work) =>
        guard(mapping, (authority) => work(createStorage({ mapping, authority }))),
      async readChannelReplyTrace(mapping, source) {
        try {
          return await guard(mapping, async (authority) => authority.state, source);
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
      putChannelReply: (mapping) =>
        guard(mapping, async (authority) =>
          createFeedbackRecord(
            mongoose,
            'channelReply',
            mapping,
            authority,
            await getDurableStorageConfig(),
          ),
        ),
      async getChannelReply(actor, externalMessageKey) {
        assertChannelTenant(actor.tenantId);
        const record = await replies()
          .findOne({
            tenantId: actor.tenantId,
            channelId: actor.channelId,
            teamId: actor.teamId,
            channelRevision: actor.channelRevision,
            agentId: actor.agentId,
            externalMessageKey,
            ...unexpired(),
            '_managed.phase': 'published',
          })
          .select('+_managed')
          .read('primary')
          .lean();
        if (!record) return null;
        try {
          feedbackFilter(mongoose, record, 'channelReply');
          return await guard(record, async () => record, record.source);
        } catch (error) {
          if (error instanceof ChannelFeedbackAuthorityError) return null;
          throw error;
        }
      },
      admitChannelFeedbackEvent: (record) =>
        guard(record.mapping, async (authority) => {
          if (
            record.processed ||
            record.receiptExpiresAt ||
            record.ledgerTarget ||
            record.eventId !== record.event.eventId
          )
            throw new TypeError('Invalid initial feedback receipt');
          return createFeedbackRecord(
            mongoose,
            'channelFeedbackEvent',
            record,
            authority,
            await getDurableStorageConfig(),
          );
        }),
      async pendingChannelFeedbackEvents(tenantId, limit, now = Date.now()) {
        page(tenantId, limit);
        await recoverFeedbackReceipts(mongoose, tenantId, limit);
        return events()
          .find({
            tenantId,
            processed: false,
            '_managed.phase': 'published',
            $and: [
              { $or: [{ retryAtMs: { $exists: false } }, { retryAtMs: { $lte: now } }] },
              unexpired(),
            ],
          })
          .sort({ updatedAt: 1, _id: 1 })
          .limit(limit)
          .select('+_managed')
          .read('primary')
          .lean();
      },
      async markChannelFeedbackEvent(record) {
        await guard(
          record.mapping,
          async () => {
            let current = checkpoint;
            if (!current || current.key !== record.ledgerKey) {
              const receipt = await events()
                .findOne(feedbackFilter(mongoose, record, 'channelFeedbackEvent'))
                .select('ledgerTarget')
                .read('primary')
                .lean();
              current =
                (await ledger()
                  .findOne({
                    ...(receipt?.ledgerTarget
                      ? managedTargetFilter(mongoose, receipt.ledgerTarget)
                      : { tenantId: record.tenantId, key: record.ledgerKey }),
                    '_managed.phase': 'published',
                  })
                  .select('+_managed')
                  .read('primary')
                  .lean()) ?? undefined;
            }
            if (!current) throw new ChannelFeedbackAuthorityError();
            await acknowledgeFeedbackReceipt(mongoose, record, current);
          },
          record.source,
        );
      },
      ensureChannelFeedback: (record) =>
        guard(record.mapping, async (authority) => {
          const stored = await createFeedbackRecord(
            mongoose,
            'channelFeedback',
            {
              ...record,
              scoreTimestamp: record.scoreTimestamp ?? new Date(),
            },
            authority,
            await getDurableStorageConfig(),
          );
          remember(stored);
          return stored;
        }),
      async getChannelFeedback(tenantId, key) {
        assertChannelTenant(tenantId);
        const stored = await ledger()
          .findOne({
            ...(checkpoint?.key === key
              ? feedbackFilter(mongoose, checkpoint, 'channelFeedback')
              : { tenantId, key, '_managed.phase': 'published' }),
            ...unexpired(),
          })
          .select('+_managed')
          .read('primary')
          .lean();
        if (!stored) {
          if (checkpoint?.key === key) throw new ChannelFeedbackAuthorityError();
          return null;
        }
        feedbackFilter(mongoose, stored, 'channelFeedback');
        try {
          return await guard(
            stored.mapping,
            async () => {
              remember(stored);
              return stored;
            },
            stored.source,
          );
        } catch (error) {
          if (error instanceof ChannelFeedbackAuthorityError) return null;
          throw error;
        }
      },
      async saveChannelFeedback(record, expectedRevision, event) {
        return guard(
          record.mapping,
          async () => {
            const current = await ledger()
              .findOne({
                ...feedbackFilter(mongoose, record, 'channelFeedback'),
                revision: expectedRevision,
              })
              .select('+_managed')
              .read('primary')
              .lean();
            if (!current) return false;
            assertFeedbackProgress(current, record, event);
            await bindFeedbackLedger(mongoose, event, current);
            const saved = await writeFeedbackLedger(
              mongoose,
              current,
              {
                votes: record.votes,
                rating: record.rating,
                revision: record.revision,
                exportStatus: 'pending',
                retryAtMs: 0,
              },
              { revision: expectedRevision },
            );
            if (!saved) return false;
            remember(saved);
            await recoverFeedbackReceipts(mongoose, record.tenantId, 100, saved);
            return true;
          },
          record.source,
        );
      },
      async claimChannelFeedbackExport(candidate, leaseId, now, leaseUntilMs) {
        if (
          !leaseId ||
          !Number.isSafeInteger(now) ||
          !Number.isSafeInteger(leaseUntilMs) ||
          leaseUntilMs <= now
        )
          throw new TypeError('Invalid feedback lease');
        return guard(
          candidate.mapping,
          async () => {
            if (!candidate.scoreTimestamp || !Number.isFinite(candidate.scoreTimestamp.getTime()))
              throw new TypeError('Invalid feedback score timestamp');
            const current = await ledger()
              .findOne({
                ...feedbackFilter(mongoose, candidate, 'channelFeedback'),
                revision: candidate.revision,
                exportStatus: 'pending',
                retryAtMs: { $lte: now },
                $or: [{ leaseUntilMs: { $exists: false } }, { leaseUntilMs: { $lte: now } }],
              })
              .select('+_managed')
              .read('primary')
              .lean();
            return current
              ? writeFeedbackLedger(mongoose, current, { leaseId, leaseUntilMs })
              : null;
          },
          candidate.source,
        );
      },
      async finishChannelFeedbackExport(record, leaseId, success, retryAtMs, finishedAt) {
        await guard(
          record.mapping,
          async () => {
            const current = await ledger()
              .findOne({
                ...feedbackFilter(mongoose, record, 'channelFeedback'),
                leaseId,
                leaseUntilMs: record.leaseUntilMs,
              })
              .select('+_managed')
              .read('primary')
              .lean();
            if (!current) return;
            const patch: Parameters<typeof writeFeedbackLedger>[2] =
              current.revision === record.revision
                ? {
                    exportStatus:
                      success && record.leaseUntilMs != null && record.leaseUntilMs > finishedAt
                        ? 'sent'
                        : 'pending',
                    retryAtMs,
                  }
                : {};
            await writeFeedbackLedger(
              mongoose,
              current,
              patch,
              { leaseId, leaseUntilMs: record.leaseUntilMs },
              { leaseId: '', leaseUntilMs: '' },
            );
          },
          record.source,
        );
      },
      async pendingChannelFeedbackExports(tenantId, now, limit) {
        page(tenantId, limit);
        return ledger()
          .find({
            tenantId,
            '_managed.phase': 'published',
            exportStatus: 'pending',
            retryAtMs: { $lte: now },
            $and: [
              { $or: [{ leaseUntilMs: { $exists: false } }, { leaseUntilMs: { $lte: now } }] },
              unexpired(),
            ],
          })
          .sort({ updatedAt: 1, _id: 1 })
          .limit(limit)
          .select('+_managed')
          .read('primary')
          .lean();
      },
    };
    return storage;
  }
  return createStorage();
}
