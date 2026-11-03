import type { ChannelFeedbackVote } from 'librechat-data-provider';
import type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
import type { ChannelFeedbackSourceIdentity } from './channelFeedbackScope';
import {
  channelFeedbackReactionIdentity,
  isLaterChannelFeedbackEvent,
  CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS,
  CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX,
} from './channelFeedbackProtocol';
import { sameFeedbackSource, ChannelFeedbackAuthorityError } from './channelFeedbackScope';
import { feedbackFilter, feedbackTarget } from './channelFeedbackWrite';
import { managedTargetFilter } from './managed';
import { digest } from './channelProtocol';

type FeedbackCheckpoint = Pick<
  ChannelFeedbackLedger,
  'tenantId' | 'key' | 'source' | '_managed' | 'votes'
> & { mapping: ChannelFeedbackSourceIdentity };
type FeedbackReceipt = Pick<
  ChannelFeedbackEventRecord,
  | 'tenantId'
  | 'channelId'
  | 'eventId'
  | 'digest'
  | 'ledgerKey'
  | 'event'
  | 'rating'
  | 'source'
  | '_managed'
  | 'ledgerTarget'
> & { mapping: ChannelFeedbackSourceIdentity };
const mappingProjection =
  'mapping.tenantId mapping.channelId mapping.channelRevision mapping.teamId mapping.agentId mapping.runId mapping.responseId mapping.messageId mapping.conversationId mapping.principalId';
const checkpointProjection = `tenantId key source _managed votes ${mappingProjection}`;
const receiptProjection = `tenantId channelId eventId digest ledgerKey event rating source _managed ledgerTarget ${mappingProjection}`;

export const feedbackSlot = (message: string, reaction: string): string =>
  JSON.stringify([message, channelFeedbackReactionIdentity(reaction)]);
export function feedbackSlots(
  record: Pick<ChannelFeedbackLedger, 'votes'>,
): Map<string, ChannelFeedbackVote> {
  if (record.votes.length > CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX)
    throw new TypeError('Invalid feedback checkpoint footprint');
  const slots = new Map(
    record.votes.map((vote) => [feedbackSlot(vote.externalMessageKey, vote.reaction), vote]),
  );
  if (slots.size !== record.votes.length) throw new TypeError('Duplicate feedback vote slot');
  return slots;
}

/** The only private vote mutation preserves every old slot and advances exactly one canonical event. */
export function assertFeedbackProgress(
  current: ChannelFeedbackLedger,
  next: ChannelFeedbackLedger,
  event: ChannelFeedbackEventRecord,
): void {
  const old = feedbackSlots(current);
  const votes = feedbackSlots(next);
  if (
    !Number.isSafeInteger(next.revision) ||
    next.revision !== current.revision + 1 ||
    current.key !== event.ledgerKey ||
    current.externalUserId !== event.event.externalUserId ||
    !sameFeedbackSource(current.mapping, event.mapping)
  )
    throw new ChannelFeedbackAuthorityError();
  for (const [slot, before] of old) {
    const after = votes.get(slot);
    if (!after || (digest(before) !== digest(after) && !isLaterChannelFeedbackEvent(after, before)))
      throw new ChannelFeedbackAuthorityError();
  }
  const changed = [...votes].filter(([slot, vote]) => digest(old.get(slot) ?? {}) !== digest(vote));
  if (changed.length !== 1) throw new ChannelFeedbackAuthorityError();
  const [slot, vote] = changed[0];
  if (
    slot !== feedbackSlot(event.event.externalMessageKey, event.event.reaction) ||
    vote.eventId !== event.eventId ||
    vote.eventTimestampUs !== event.event.eventTimestampUs ||
    vote.reaction !== channelFeedbackReactionIdentity(event.event.reaction) ||
    vote.rating !== event.rating ||
    vote.active !== (event.event.action === 'added')
  )
    throw new ChannelFeedbackAuthorityError();
  let latest: ChannelFeedbackVote | undefined;
  for (const entry of votes.values())
    if (entry.active && (!latest || isLaterChannelFeedbackEvent(entry, latest))) latest = entry;
  if (next.rating !== (latest?.rating ?? null)) throw new ChannelFeedbackAuthorityError();
}

/** Event-to-ledger association is durable before a vote; a later retry cannot adopt a replacement. */
export async function bindFeedbackLedger(
  mongoose: typeof import('mongoose'),
  record: FeedbackReceipt,
  ledger: FeedbackCheckpoint,
): Promise<void> {
  if (
    record.ledgerKey !== ledger.key ||
    !sameFeedbackSource(record.mapping, ledger.mapping) ||
    digest(record.source ?? {}) !== digest(ledger.source ?? {})
  )
    throw new ChannelFeedbackAuthorityError();
  const target = feedbackTarget(ledger, 'channelFeedback');
  const model = mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  const filter = {
    ...feedbackFilter(mongoose, record, 'channelFeedbackEvent'),
    eventId: record.eventId,
    digest: record.digest,
    ledgerKey: record.ledgerKey,
    rating: record.rating,
    ...Object.fromEntries(
      (
        [
          'eventId',
          'eventTimestampUs',
          'externalMessageKey',
          'externalUserId',
          'reaction',
          'action',
        ] as const
      ).map((field) => [`event.${field}`, record.event[field]]),
    ),
  };
  const bound = await model.updateOne(
    { ...filter, ledgerTarget: { $exists: false } },
    { $set: { ledgerTarget: target }, $inc: { __v: 1 } },
    { upsert: false, overwriteImmutable: true },
  );
  if (bound.matchedCount) return;
  const current = await model.findOne(filter).select('ledgerTarget').read('primary').lean();
  if (!current?.ledgerTarget || digest(current.ledgerTarget) !== digest(target))
    throw new ChannelFeedbackAuthorityError();
}

/** Monotonic slot evidence remains true after newer ledger CASes, without a multi-record transaction. */
export async function acknowledgeFeedbackReceipt(
  mongoose: typeof import('mongoose'),
  record: FeedbackReceipt,
  ledger: FeedbackCheckpoint,
): Promise<void> {
  await bindFeedbackLedger(mongoose, record, ledger);
  const current = feedbackSlots(ledger).get(
    feedbackSlot(record.event.externalMessageKey, record.event.reaction),
  );
  if (
    !current ||
    (current.eventId !== record.eventId && !isLaterChannelFeedbackEvent(current, record.event)) ||
    (current.eventId === record.eventId &&
      current.eventTimestampUs !== record.event.eventTimestampUs)
  )
    throw new ChannelFeedbackAuthorityError();
  const model = mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  const filter = {
    ...feedbackFilter(mongoose, record, 'channelFeedbackEvent'),
    eventId: record.eventId,
    digest: record.digest,
    'ledgerTarget.id': feedbackTarget(ledger, 'channelFeedback').id,
    'ledgerTarget.incarnation': feedbackTarget(ledger, 'channelFeedback').incarnation,
  };
  // Never unpin an expiry proved by a newer checkpoint, even if this worker read an older one.
  const updated = await model.updateOne(
    filter,
    {
      $set: { processed: true },
      $inc: { __v: 1 },
      ...(current.eventId !== record.eventId && {
        $min: { receiptExpiresAt: new Date(Date.now() + CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS) },
      }),
    },
    { upsert: false },
  );
  if (!updated.matchedCount) throw new ChannelFeedbackAuthorityError();
}

/** Bounded metadata recovery rotates current receipts, so pinned obsolete rows cannot starve. */
export async function recoverFeedbackReceipts(
  mongoose: typeof import('mongoose'),
  tenantId: string,
  limit: number,
  ledger?: FeedbackCheckpoint,
): Promise<void> {
  const model = mongoose.model<ChannelFeedbackEventRecord>('ChannelFeedbackEvent');
  const rows = await model
    .find({
      tenantId,
      processed: true,
      receiptExpiresAt: null,
      $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
      ...(ledger && {
        ledgerKey: ledger.key,
        eventId: { $nin: ledger.votes.map((vote) => vote.eventId) },
      }),
    })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit)
    .select(receiptProjection)
    .read('primary')
    .lean<FeedbackReceipt[]>();
  const targets = rows.flatMap((row) => (row.ledgerTarget ? [row.ledgerTarget] : []));
  const ledgers = targets.length
    ? await mongoose
        .model<ChannelFeedbackLedger>('ChannelFeedback')
        .find({
          $or: targets.map((target) => ({
            ...managedTargetFilter(mongoose, target),
            '_managed.phase': 'published',
          })),
        })
        .select(checkpointProjection)
        .read('primary')
        .lean<FeedbackCheckpoint[]>()
    : [];
  for (const row of rows) {
    const target = row.ledgerTarget;
    const checkpoint =
      ledger ??
      ledgers.find(
        (item) =>
          item._managed?.parentId === target?.id &&
          item._managed?.incarnation === target?.incarnation,
      );
    if (
      !checkpoint ||
      !target ||
      digest(target) !== digest(feedbackTarget(checkpoint, 'channelFeedback'))
    ) {
      // No canonical checkpoint is not permission to expire a pinned receipt.
      await model.updateOne(
        feedbackFilter(mongoose, row, 'channelFeedbackEvent'),
        { $inc: { __v: 1 } },
        { upsert: false },
      );
      continue;
    }
    await acknowledgeFeedbackReceipt(mongoose, row, checkpoint);
  }
}
