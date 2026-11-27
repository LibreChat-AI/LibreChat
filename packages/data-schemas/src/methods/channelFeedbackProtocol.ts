import { CHANNEL_DELIVERY_PARTS_HARD_MAX } from 'librechat-data-provider';
import type { ChannelFeedbackVote } from 'librechat-data-provider';

export const CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX: number = CHANNEL_DELIVERY_PARTS_HARD_MAX * 12;
/** Obsolete receipts retain a seven-day conflict/idempotency window; current checkpoints stay pinned. */
export const CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS: number = 7 * 24 * 60 * 60 * 1000;

export function channelFeedbackReactionIdentity(reaction: string): string {
  return reaction.replace(/^\+1(?=::|$)/, 'thumbsup').replace(/^-1(?=::|$)/, 'thumbsdown');
}

export function isLaterChannelFeedbackEvent(
  a: Pick<ChannelFeedbackVote, 'eventTimestampUs' | 'eventId'>,
  b: Pick<ChannelFeedbackVote, 'eventTimestampUs' | 'eventId'>,
): boolean {
  return (
    a.eventTimestampUs > b.eventTimestampUs ||
    (a.eventTimestampUs === b.eventTimestampUs && a.eventId > b.eventId)
  );
}
