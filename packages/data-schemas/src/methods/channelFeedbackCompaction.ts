import type { ChannelReplyMapping, ChannelFeedbackVote } from 'librechat-data-provider';
import type { ClientSession, Types } from 'mongoose';
import type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
import {
  CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS,
  CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX,
  channelFeedbackReactionIdentity,
  isLaterChannelFeedbackEvent,
} from './channelFeedbackProtocol';
import { sameFeedbackSource, ChannelFeedbackAuthorityError } from './channelFeedbackScope';

export interface FeedbackCheckpoint {
  key: string;
  revision: number;
  mapping: ChannelReplyMapping;
  canonical: boolean;
  ids: Set<string>;
  slots: Map<string, ChannelFeedbackVote>;
}
const slotKey = (message: string, reaction: string) =>
  JSON.stringify([message, channelFeedbackReactionIdentity(reaction)]);

/** A transaction-local snapshot, never retained by the shared storage instance. */
export function feedbackCheckpoint(record: ChannelFeedbackLedger): FeedbackCheckpoint {
  if (record.votes.length > CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX)
    throw new TypeError('Invalid feedback checkpoint footprint');
  return {
    key: record.key,
    revision: record.revision,
    mapping: { ...record.mapping },
    canonical: record.votes.every((vote) => Boolean(vote.reaction)),
    ids: new Set(record.votes.map((vote) => vote.eventId)),
    slots: new Map(
      record.votes
        .filter((vote) => vote.reaction)
        .map((vote) => [slotKey(vote.externalMessageKey, vote.reaction!), { ...vote }]),
    ),
  };
}

/** Only rows already classified as pinned can be superseded inline: this is bounded by vote slots. */
export async function pinFeedbackCheckpoint(
  mongoose: typeof import('mongoose'),
  record: ChannelFeedbackLedger,
  session: ClientSession,
): Promise<void> {
  const checkpoint = feedbackCheckpoint(record);
  if (!checkpoint.canonical) return;
  const model = mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  const filter = { tenantId: record.tenantId, ledgerKey: record.key, processed: true };
  await model.updateMany(
    { ...filter, eventId: { $in: [...checkpoint.ids] }, receiptExpiresAt: { $exists: true } },
    { $unset: { receiptExpiresAt: '' } },
    { session, timestamps: false },
  );
  await model.updateMany(
    {
      ...filter,
      receiptCompacted: true,
      receiptExpiresAt: null,
      eventId: { $nin: [...checkpoint.ids] },
    },
    { $set: { receiptExpiresAt: new Date(Date.now() + CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS) } },
    { session, timestamps: false },
  );
}

async function expireReceipts(
  mongoose: typeof import('mongoose'),
  filter: object,
  expiresAt: Date,
  session: ClientSession,
  set: { processed?: boolean; receiptCompacted: true },
): Promise<number> {
  const model = mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  const first = await model.updateMany(
    { ...filter, $or: [{ receiptExpiresAt: null }, { receiptExpiresAt: { $gt: expiresAt } }] },
    { $set: { ...set, receiptExpiresAt: expiresAt } },
    { session, timestamps: false },
  );
  const earlier = await model.updateMany(
    { ...filter, receiptExpiresAt: { $lte: expiresAt } },
    { $set: set },
    { session, timestamps: false },
  );
  return first.modifiedCount + earlier.modifiedCount;
}

/** Checkpoint and receipt acknowledgement share one transaction and ledger serialization anchor. */
export async function acknowledgeFeedbackReceipt(
  mongoose: typeof import('mongoose'),
  record: ChannelFeedbackEventRecord,
  checkpoint: FeedbackCheckpoint,
  session: ClientSession,
): Promise<void> {
  if (
    record.tenantId !== record.mapping.tenantId ||
    record.channelId !== record.mapping.channelId ||
    checkpoint.key !== record.ledgerKey ||
    !sameFeedbackSource(checkpoint.mapping, record.mapping)
  )
    throw new ChannelFeedbackAuthorityError();
  const anchored = await mongoose
    .model<ChannelFeedbackLedger>('ChannelFeedback')
    .updateOne(
      { tenantId: record.tenantId, key: checkpoint.key, revision: checkpoint.revision },
      { $inc: { receiptCompactionEpoch: 1 } },
      { session, timestamps: false },
    );
  if (!anchored.matchedCount) throw new Error('Feedback checkpoint changed before acknowledgement');
  const filter = {
    tenantId: record.tenantId,
    channelId: record.channelId,
    eventId: record.eventId,
    digest: record.digest,
  };
  const model = mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  if (!checkpoint.canonical) {
    await model.updateOne(
      filter,
      { $set: { processed: true, receiptCompacted: false } },
      { session },
    );
    return;
  }
  const current = checkpoint.slots.get(
    slotKey(record.event.externalMessageKey, record.event.reaction),
  );
  if (
    !current ||
    (current.eventId !== record.eventId && !isLaterChannelFeedbackEvent(current, record.event))
  )
    throw new Error('Feedback acknowledgement precedes its canonical checkpoint');
  if (current.eventId === record.eventId) {
    await model.updateOne(
      filter,
      { $set: { processed: true, receiptCompacted: true }, $unset: { receiptExpiresAt: '' } },
      { session },
    );
  } else {
    await expireReceipts(
      mongoose,
      filter,
      new Date(Date.now() + CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS),
      session,
      { processed: true, receiptCompacted: true },
    );
  }
}

type ReceiptPage = {
  _id: Types.ObjectId;
  ledgerKey: string;
};

/** Legacy history is compacted in bounded pages, independently of recording/export authority. */
export async function compactFeedbackReceipts(
  mongoose: typeof import('mongoose'),
  tenantId: string,
  limit: number,
  now: number,
  retryMs: number,
  rebuild: (key: string, session: ClientSession) => Promise<ChannelFeedbackVote[] | null>,
): Promise<number> {
  const events = mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  const ledgers = mongoose.model<ChannelFeedbackLedger>('ChannelFeedback');
  const rows = await events
    .find({
      tenantId,
      processed: true,
      receiptCompacted: { $ne: true },
      $or: [{ compactionRetryAtMs: { $exists: false } }, { compactionRetryAtMs: { $lte: now } }],
    })
    .select('_id ledgerKey')
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit)
    .lean<ReceiptPage[]>();
  const groups = new Map<string, ReceiptPage[]>();
  for (const row of rows) {
    const group = groups.get(row.ledgerKey) ?? [];
    group.push(row);
    groups.set(row.ledgerKey, group);
  }
  let completed = 0;
  for (const [key, page] of groups) {
    const ids = page.map((row) => row._id);
    const filter = {
      tenantId,
      ledgerKey: key,
      _id: { $in: ids },
      processed: true,
      receiptCompacted: { $ne: true },
    };
    const session = await mongoose.startSession();
    try {
      let changed = 0;
      await session.withTransaction(async () => {
        changed = 0;
        const record = await ledgers
          .findOneAndUpdate(
            { tenantId, key },
            { $inc: { receiptCompactionEpoch: 1 } },
            { new: true, session, timestamps: false },
          )
          .select('key revision mapping votes receiptCheckpointRevision')
          .lean();
        let protectedIds: Set<string>;
        if (record && record.votes.every((vote) => Boolean(vote.reaction))) {
          protectedIds = feedbackCheckpoint(record).ids;
        } else if (record && record.receiptCheckpointRevision === record.revision) {
          // Scheduling rows may predate another compactor's cache write. Read membership
          // after taking the ledger anchor, within this transaction's snapshot.
          const protectedRows = await events
            .find({ ...filter, receiptCheckpointRevision: record.revision })
            .select('eventId')
            .session(session)
            .lean();
          protectedIds = new Set(protectedRows.map((row) => row.eventId));
        } else {
          const votes = await rebuild(key, session);
          if (!votes || votes.length > CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX)
            throw new Error('Legacy feedback checkpoint unavailable');
          protectedIds = new Set([
            ...(record?.votes.map((vote) => vote.eventId) ?? []),
            ...votes.map((vote) => vote.eventId),
          ]);
          if (protectedIds.size > CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX * 2)
            throw new Error('Legacy feedback checkpoint footprint exceeded');
          if (record) {
            await events.updateMany(
              { tenantId, ledgerKey: key, processed: true, eventId: { $in: [...protectedIds] } },
              {
                $set: { receiptCheckpointRevision: record.revision },
                $unset: { receiptExpiresAt: '' },
              },
              { session, timestamps: false },
            );
            await ledgers.updateOne(
              { tenantId, key, revision: record.revision },
              { $set: { receiptCheckpointRevision: record.revision } },
              { session, timestamps: false },
            );
          }
        }
        const pinned = await events.updateMany(
          { ...filter, eventId: { $in: [...protectedIds] } },
          { $set: { receiptCompacted: true }, $unset: { receiptExpiresAt: '' } },
          { session, timestamps: false },
        );
        changed += pinned.modifiedCount;
        changed += await expireReceipts(
          mongoose,
          { ...filter, eventId: { $nin: [...protectedIds] } },
          new Date(now + CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS),
          session,
          { receiptCompacted: true },
        );
      });
      completed += changed;
    } catch (error) {
      // Failed metadata work rotates too, so it cannot poison the maintenance head page.
      await events.updateMany(filter, { $max: { compactionRetryAtMs: now + retryMs } });
      throw error;
    } finally {
      await session.endSession();
    }
  }
  return completed;
}
