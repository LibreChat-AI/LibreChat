import type { ChannelReplyMapping, ChannelFeedbackActor } from 'librechat-data-provider';
import type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
import { createChannelIndexGate } from './channelIndexes';
export type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';

export interface ChannelFeedbackStorage {
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
  ): Promise<ChannelFeedbackEventRecord[]>;
  markChannelFeedbackEvent(record: ChannelFeedbackEventRecord): Promise<void>;
  ensureChannelFeedback(record: ChannelFeedbackLedger): Promise<ChannelFeedbackLedger>;
  getChannelFeedback(tenantId: string, key: string): Promise<ChannelFeedbackLedger | null>;
  saveChannelFeedback(record: ChannelFeedbackLedger, expectedRevision: number): Promise<boolean>;
  claimChannelFeedbackExport(
    tenantId: string,
    key: string,
    leaseId: string,
    now: number,
    leaseUntilMs: number,
  ): Promise<ChannelFeedbackLedger | null>;
  finishChannelFeedbackExport(
    record: ChannelFeedbackLedger,
    leaseId: string,
    success: boolean,
    retryAtMs: number,
  ): Promise<void>;
  pendingChannelFeedbackExports(
    tenantId: string,
    now: number,
    limit: number,
  ): Promise<ChannelFeedbackLedger[]>;
}

function duplicate(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 11000;
}

export function createChannelFeedbackStorage(
  mongoose: typeof import('mongoose'),
): ChannelFeedbackStorage {
  const replies = () => mongoose.model<ChannelReplyMapping>('ChannelReply');
  const events = () => mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  const ledger = () => mongoose.model<ChannelFeedbackLedger>('ChannelFeedback');
  const ensureIndexes = createChannelIndexGate(() => [replies(), events(), ledger()]);
  return {
    async putChannelReply(mapping) {
      await ensureIndexes();
      const filter = {
        tenantId: mapping.tenantId,
        channelId: mapping.channelId,
        teamId: mapping.teamId,
        externalMessageKey: mapping.externalMessageKey,
      };
      try {
        await replies().updateOne(filter, { $setOnInsert: mapping }, { upsert: true });
      } catch (error) {
        if (!duplicate(error)) throw error;
      }
      const stored = await replies().findOne(filter).lean();
      if (!stored) throw new Error('Channel reply disappeared during admission');
      return stored;
    },
    async getChannelReply(actor, externalMessageKey) {
      return replies()
        .findOne({
          tenantId: actor.tenantId,
          channelId: actor.channelId,
          teamId: actor.teamId,
          channelRevision: actor.channelRevision,
          agentId: actor.agentId,
          externalMessageKey,
        })
        .lean();
    },
    async admitChannelFeedbackEvent(record) {
      await ensureIndexes();
      const filter = {
        tenantId: record.tenantId,
        channelId: record.channelId,
        eventId: record.eventId,
      };
      try {
        await events().updateOne(filter, { $setOnInsert: record }, { upsert: true });
      } catch (error) {
        if (!duplicate(error)) throw error;
      }
      const stored = await events().findOne(filter).lean();
      if (!stored) throw new Error('Channel feedback event disappeared during admission');
      return stored;
    },
    async pendingChannelFeedbackEvents(tenantId, limit) {
      return events()
        .find({ tenantId, processed: false })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();
    },
    async markChannelFeedbackEvent(record) {
      await events().updateOne(
        {
          tenantId: record.tenantId,
          channelId: record.channelId,
          eventId: record.eventId,
          digest: record.digest,
        },
        { $set: { processed: true } },
      );
    },
    async ensureChannelFeedback(record) {
      await ensureIndexes();
      const filter = { tenantId: record.tenantId, key: record.key };
      try {
        await ledger().updateOne(filter, { $setOnInsert: record }, { upsert: true });
      } catch (error) {
        if (!duplicate(error)) throw error;
      }
      const stored = await ledger().findOne(filter).lean();
      if (!stored) throw new Error('Channel feedback ledger disappeared during admission');
      return stored;
    },
    async getChannelFeedback(tenantId, key) {
      return ledger().findOne({ tenantId, key }).lean();
    },
    async saveChannelFeedback(record, expectedRevision) {
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
      );
      return result.modifiedCount === 1;
    },
    async claimChannelFeedbackExport(tenantId, key, leaseId, now, leaseUntilMs) {
      return ledger()
        .findOneAndUpdate(
          {
            tenantId,
            key,
            exportStatus: 'pending',
            retryAtMs: { $lte: now },
            $or: [{ leaseUntilMs: { $exists: false } }, { leaseUntilMs: { $lte: now } }],
          },
          { $set: { leaseId, leaseUntilMs } },
          { new: true },
        )
        .lean();
    },
    async finishChannelFeedbackExport(record, leaseId, success, retryAtMs) {
      const finished = await ledger().updateOne(
        { tenantId: record.tenantId, key: record.key, revision: record.revision, leaseId },
        {
          $set: { exportStatus: success ? 'sent' : 'pending', retryAtMs },
          $unset: { leaseId: '', leaseUntilMs: '' },
        },
      );
      if (finished.matchedCount === 0) {
        await ledger().updateOne(
          { tenantId: record.tenantId, key: record.key, leaseId },
          { $unset: { leaseId: '', leaseUntilMs: '' } },
        );
      }
    },
    async pendingChannelFeedbackExports(tenantId, now, limit) {
      return ledger()
        .find({
          tenantId,
          exportStatus: 'pending',
          retryAtMs: { $lte: now },
          $or: [{ leaseUntilMs: { $exists: false } }, { leaseUntilMs: { $lte: now } }],
        })
        .sort({ updatedAt: 1 })
        .limit(limit)
        .lean();
    },
  };
}
