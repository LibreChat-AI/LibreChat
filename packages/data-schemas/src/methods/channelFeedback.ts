import { CHANNEL_DELIVERY_PARTS_HARD_MAX } from 'librechat-data-provider';
import type {
  ChannelReplyMapping,
  ChannelFeedbackActor,
  ChannelFeedbackVote,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
import type { ChannelFeedbackReplySource } from './channelFeedbackSource';
import {
  withChannelFeedbackAuthority,
  sameFeedbackSource,
  readChannelFeedbackRetention,
  ChannelFeedbackAuthorityError,
} from './channelFeedbackScope';
import { readChannelFeedbackReplySource } from './channelFeedbackSource';
import { createChannelIndexGate } from './channelIndexes';
import { assertChannelTenant } from './channelScope';
export type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
export type { ChannelFeedbackReplySource } from './channelFeedbackSource';
export { ChannelFeedbackAuthorityError } from './channelFeedbackScope';

/** Two ratings, each with five supported skin tones plus the default emoji, per delivery part. */
export const CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX: number = CHANNEL_DELIVERY_PARTS_HARD_MAX * 12;
export interface ChannelFeedbackStorage {
  repairChannelFeedbackRetention(tenantId: string, limit: number): Promise<number>;
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
  readReplySource(
    actor: ChannelFeedbackActor,
    externalMessageKey: string,
  ): Promise<ChannelFeedbackReplySource | null>;
  rebuildVotes(
    tenantId: string,
    ledgerKey: string,
    requiredEventIds: string[],
  ): Promise<ChannelFeedbackVote[] | null>;
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
): ChannelFeedbackStorage {
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
  ): ChannelFeedbackStorage {
    async function guard<T>(
      mapping: ChannelReplyMapping,
      work: (session: ClientSession, expiredAt: Date | null) => Promise<T>,
    ): Promise<T> {
      await ensureIndexes();
      if (session && source) {
        if (!sameFeedbackSource(source, mapping)) throw new ChannelFeedbackAuthorityError();
        return work(session, sourceExpiry);
      }
      return withChannelFeedbackAuthority(mongoose, mapping, work);
    }
    function retainedInsert(record: object, expiredAt: Date | null) {
      const insert = { ...record } as Record<string, unknown>;
      delete insert.expiredAt;
      delete insert.retentionVersion;
      return {
        $setOnInsert: insert,
        $set: { retentionVersion: 1 },
        ...(expiredAt ? { $min: { expiredAt } } : {}),
      };
    }
    async function retainLegacyNull(
      name: string,
      filter: object,
      expiredAt: Date | null,
      active: ClientSession,
    ) {
      if (expiredAt)
        await mongoose
          .model(name)
          .updateOne({ ...filter, expiredAt: null }, { $set: { expiredAt } }, { session: active });
    }
    const storage: ChannelFeedbackStorage = {
      async repairChannelFeedbackRetention(tenantId, limit) {
        page(tenantId, limit);
        await ensureIndexes();
        let repaired = 0;
        const retention = new Map<string, Date | null>();
        for (const name of ['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback']) {
          const model = mongoose.model(name);
          const rows = await model
            .find({ tenantId, retentionVersion: { $ne: 1 } })
            .select(
              name === 'ChannelReply'
                ? 'tenantId principalId conversationId messageId'
                : 'mapping.tenantId mapping.principalId mapping.conversationId mapping.messageId',
            )
            .sort({ _id: 1 })
            .limit(limit)
            .lean();
          for (const row of rows) {
            const mapping = (name === 'ChannelReply' ? row : row.mapping) as ChannelReplyMapping;
            const key = JSON.stringify([
              mapping.tenantId,
              mapping.principalId,
              mapping.conversationId,
              mapping.messageId,
            ]);
            if (!retention.has(key)) {
              try {
                retention.set(key, await readChannelFeedbackRetention(mongoose, mapping));
              } catch (error) {
                if (!(error instanceof ChannelFeedbackAuthorityError)) throw error;
                retention.set(key, new Date(0));
              }
            }
            const expiredAt = retention.get(key)!;
            const filter = { _id: row._id, tenantId, retentionVersion: { $ne: 1 } };
            const result = await model.updateOne(
              {
                ...filter,
                ...(expiredAt
                  ? { $or: [{ expiredAt: null }, { expiredAt: { $gt: expiredAt } }] }
                  : {}),
              },
              { $set: { retentionVersion: 1, ...(expiredAt ? { expiredAt } : {}) } },
            );
            repaired += result.modifiedCount;
            if (expiredAt && !result.modifiedCount) {
              const retained = await model.updateOne(
                { ...filter, expiredAt: { $lte: expiredAt } },
                { $set: { retentionVersion: 1 } },
              );
              repaired += retained.modifiedCount;
            }
          }
        }
        return repaired;
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
        return guard(mapping, (active, expiredAt) =>
          work(createStorage(active, mapping, expiredAt)),
        );
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
      async rebuildVotes(tenantId, ledgerKey, requiredEventIds) {
        assertChannelTenant(tenantId);
        if (requiredEventIds.length > CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX)
          throw new TypeError('Invalid feedback vote footprint');
        const ids = [...new Set(requiredEventIds)];
        if (
          (await events()
            .countDocuments({ tenantId, ledgerKey, eventId: { $in: ids } })
            .session(session ?? null)) !== ids.length
        )
          return null;
        return events()
          .aggregate<ChannelFeedbackVote>([
            {
              $match: {
                tenantId,
                ledgerKey,
                'event.reaction': { $regex: '^(\\+1|thumbsup|-1|thumbsdown)(::skin-tone-[2-6])?$' },
              },
            },
            { $sort: { 'event.eventTimestampUs': -1, 'event.eventId': -1 } },
            {
              $addFields: {
                reaction: {
                  $replaceOne: {
                    input: {
                      $replaceOne: {
                        input: '$event.reaction',
                        find: '+1',
                        replacement: 'thumbsup',
                      },
                    },
                    find: '-1',
                    replacement: 'thumbsdown',
                  },
                },
              },
            },
            {
              $group: {
                _id: { externalMessageKey: '$event.externalMessageKey', reaction: '$reaction' },
                vote: {
                  $first: {
                    externalMessageKey: '$event.externalMessageKey',
                    reaction: '$reaction',
                    rating: '$rating',
                    active: { $eq: ['$event.action', 'added'] },
                    eventId: '$event.eventId',
                    eventTimestampUs: '$event.eventTimestampUs',
                  },
                },
              },
            },
            { $limit: CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX + 1 },
            { $replaceRoot: { newRoot: '$vote' } },
          ])
          .session(session ?? null);
      },
      async putChannelReply(mapping) {
        return guard(mapping, async (active, expiredAt) => {
          const filter = {
            tenantId: mapping.tenantId,
            channelId: mapping.channelId,
            teamId: mapping.teamId,
            externalMessageKey: mapping.externalMessageKey,
          };
          await replies().updateOne(filter, retainedInsert(mapping, expiredAt), {
            upsert: true,
            session: active,
          });
          await retainLegacyNull('ChannelReply', filter, expiredAt, active);
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
            teamId: actor.teamId,
            channelRevision: actor.channelRevision,
            agentId: actor.agentId,
            externalMessageKey,
          })
          .session(session ?? null)
          .lean();
      },
      async admitChannelFeedbackEvent(record) {
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
          await retainLegacyNull('ChannelFeedbackEvent', filter, expiredAt, active);
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
          await events().updateOne(
            {
              tenantId: record.tenantId,
              channelId: record.channelId,
              eventId: record.eventId,
              digest: record.digest,
            },
            { $set: { processed: true } },
            { session: active },
          );
        });
      },
      async ensureChannelFeedback(record) {
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
          await retainLegacyNull('ChannelFeedback', filter, expiredAt, active);
          const stored = await ledger().findOne(filter).session(active).lean();
          if (!stored) throw new Error('Channel feedback ledger disappeared during admission');
          return stored;
        });
      },
      async getChannelFeedback(tenantId, key) {
        assertChannelTenant(tenantId);
        return ledger()
          .findOne({ tenantId, key })
          .session(session ?? null)
          .lean();
      },
      async saveChannelFeedback(record, expectedRevision) {
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
          return result.modifiedCount === 1;
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
          if (!candidate.scoreTimestamp) {
            const scoreTimestamp = candidate.createdAt ?? new Date();
            if (!Number.isFinite(scoreTimestamp.getTime()))
              throw new TypeError('Invalid feedback score timestamp');
            await ledger().updateOne(
              {
                tenantId: candidate.tenantId,
                key: candidate.key,
                scoreTimestamp: null,
              },
              { $set: { scoreTimestamp } },
              { session: active, timestamps: false },
            );
          }
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
