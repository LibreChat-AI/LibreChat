import { CHANNEL_DELIVERY_PARTS_HARD_MAX, channelSnowflakeSchema } from 'librechat-data-provider';
import type { ChannelFeedbackVote, ChannelFeedbackActor } from 'librechat-data-provider';

export const CHANNEL_FEEDBACK_VOTE_SLOTS_HARD_MAX: number = CHANNEL_DELIVERY_PARTS_HARD_MAX * 12;
/** Obsolete receipts retain a seven-day conflict/idempotency window; current checkpoints stay pinned. */
export const CHANNEL_FEEDBACK_RECEIPT_RETENTION_MS: number = 7 * 24 * 60 * 60 * 1000;

export function channelFeedbackReactionIdentity(reaction: string): string {
  return reaction.replace(/^\+1(?=::|$)/, 'thumbsup').replace(/^-1(?=::|$)/, 'thumbsdown');
}

export function isLaterChannelFeedbackEvent(
  a: Pick<ChannelFeedbackVote, 'provider' | 'eventTimestampUs' | 'eventId'>,
  b: Pick<ChannelFeedbackVote, 'provider' | 'eventTimestampUs' | 'eventId'>,
): boolean {
  if (a.provider === 'discord' || b.provider === 'discord') {
    if (a.provider !== b.provider) throw new TypeError('Mixed feedback event ordering');
    channelSnowflakeSchema.parse(a.eventId);
    channelSnowflakeSchema.parse(b.eventId);
    return (
      a.eventId.length > b.eventId.length ||
      (a.eventId.length === b.eventId.length && a.eventId > b.eventId)
    );
  }
  if (a.eventTimestampUs === undefined || b.eventTimestampUs === undefined)
    throw new TypeError('Missing Slack feedback occurrence order');
  return (
    a.eventTimestampUs > b.eventTimestampUs ||
    (a.eventTimestampUs === b.eventTimestampUs && a.eventId > b.eventId)
  );
}

/** A Discord button replaces the actor's single vote across all confirmed delivery parts. */
export function channelFeedbackSlot(
  event: Pick<ChannelFeedbackVote, 'provider' | 'externalMessageKey' | 'reaction'>,
): string {
  return event.provider === 'discord'
    ? 'discord:button'
    : JSON.stringify([event.externalMessageKey, channelFeedbackReactionIdentity(event.reaction)]);
}

/** Explicit absence isolates legacy Slack rows from Discord and future providers. */
export function channelFeedbackProviderFilter(
  actor: ChannelFeedbackActor,
  prefix = '',
): Record<string, string | { $exists: false }> {
  if (actor.provider === 'discord' && actor.scope === 'dm')
    return {
      [`${prefix}provider`]: 'discord',
      [`${prefix}scope`]: 'dm',
      [`${prefix}selectionId`]: actor.selectionId,
      [`${prefix}selectionRevision`]: actor.selectionRevision,
      [`${prefix}applicationId`]: actor.applicationId,
      [`${prefix}externalUserId`]: actor.externalUserId,
      [`${prefix}guildId`]: { $exists: false },
      [`${prefix}teamId`]: { $exists: false },
      ...(prefix
        ? { [`${prefix}appId`]: { $exists: false as const } }
        : {
            sourceGuildId: actor.sourceGuildId,
            parentChannelId: actor.parentChannelId,
            confirmationEventId: actor.confirmationEventId,
          }),
    };
  const runScope = prefix
    ? {
        [`${prefix}scope`]: { $exists: false as const },
        [`${prefix}selectionId`]: { $exists: false as const },
        [`${prefix}selectionRevision`]: { $exists: false as const },
      }
    : {};
  if (actor.provider === 'discord')
    return {
      ...runScope,
      [`${prefix}provider`]: 'discord',
      [`${prefix}applicationId`]: actor.applicationId,
      [`${prefix}guildId`]: actor.guildId,
      [`${prefix}teamId`]: { $exists: false },
      ...(prefix ? { [`${prefix}appId`]: { $exists: false as const } } : {}),
    };
  if (actor.provider !== undefined) throw new TypeError('Unknown channel feedback provider');
  return {
    ...runScope,
    [`${prefix}provider`]: { $exists: false },
    [`${prefix}applicationId`]: { $exists: false },
    [`${prefix}guildId`]: { $exists: false },
    [`${prefix}teamId`]: actor.teamId,
  };
}
