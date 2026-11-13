import type { ChannelReplyMapping, ChannelFeedbackVote } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
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
    ids: new Set(record.votes.map((vote) => vote.eventId)),
    slots: new Map(
      record.votes.map((vote) => [slotKey(vote.externalMessageKey, vote.reaction), { ...vote }]),
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
  set: { processed: true },
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
      { $inc: { receiptEpoch: 1 } },
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
      { $set: { processed: true }, $unset: { receiptExpiresAt: '' } },
      { session },
    );
  } else {
    await expireReceipts(
      mongoose,
      filter,
      new Date(Date.now() + CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS),
      session,
      { processed: true },
    );
  }
}
