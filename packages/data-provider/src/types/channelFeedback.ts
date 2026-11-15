import { z } from 'zod';
import type {
  SlackChannelExternalIdentity,
  DiscordChannelExternalIdentity,
} from './channelIdentity';
import { channelSnowflakeSchema } from '../channelProvider';
import { discordDmFenceSchema } from './discordDm';

export type ChannelRating = 'thumbsUp' | 'thumbsDown';

export interface ChannelReactionEvent {
  provider?: never;
  eventId: string;
  /** Exact Slack event timestamp in microseconds; a safe integer, not rounded milliseconds. */
  eventTimestampUs: number;
  externalMessageKey: string;
  externalUserId: string;
  reaction: string;
  action: 'added' | 'removed';
}

interface ChannelReplyMappingBase {
  tenantId: string;
  channelId: string;
  channelRevision: string;
  agentId: string;
  externalMessageKey: string;
  runId: string;
  responseId: string;
  messageId: string;
  conversationId: string;
  principalId: string;
  traceId: string;
  /** Stored message provenance; absence on older mappings must not imply a permanent chat. */
  isTemporary?: boolean;
  sampled?: boolean;
  destinationIds?: string[];
  centralTraceExportEnabled: boolean;
}

export const discordDmFeedbackScopeSchema = z
  .object({
    scope: z.literal('dm'),
    selectionId: discordDmFenceSchema.shape.selectionId,
    selectionRevision: discordDmFenceSchema.shape.revision,
    sourceGuildId: channelSnowflakeSchema,
    parentChannelId: channelSnowflakeSchema,
    confirmationEventId: channelSnowflakeSchema,
  })
  .strict();
export function isDiscordFeedbackScope(
  value: Partial<z.infer<typeof discordDmFeedbackScopeSchema>> & {
    guildId?: string;
    teamId?: string;
  },
): boolean {
  if (value.teamId !== undefined) return false;
  const fields = {
    scope: value.scope,
    selectionId: value.selectionId,
    selectionRevision: value.selectionRevision,
    sourceGuildId: value.sourceGuildId,
    parentChannelId: value.parentChannelId,
    confirmationEventId: value.confirmationEventId,
  };
  return value.scope === 'dm'
    ? value.guildId === undefined && discordDmFeedbackScopeSchema.safeParse(fields).success
    : Object.values(fields).every((field) => field === undefined) &&
        channelSnowflakeSchema.safeParse(value.guildId).success;
}
export type DiscordDmFeedbackScope = z.infer<typeof discordDmFeedbackScopeSchema>;
type GuildFeedbackScope = { guildId: string } & { [K in keyof DiscordDmFeedbackScope]?: never };
type DmFeedbackScope = DiscordDmFeedbackScope & { guildId?: never };
export type SlackChannelReplyMapping = ChannelReplyMappingBase & {
  provider?: never;
  scope?: never;
  selectionId?: never;
  selectionRevision?: never;
  sourceGuildId?: never;
  parentChannelId?: never;
  confirmationEventId?: never;
  teamId: string;
  applicationId?: never;
  guildId?: never;
  externalChannelId?: never;
  externalUserId?: never;
  linkId?: never;
  linkRevision?: never;
};
type DiscordReplyMappingBase = ChannelReplyMappingBase & {
  provider: 'discord';
  teamId?: never;
  applicationId: string;
  externalChannelId: string;
  externalUserId: string;
  linkId: string;
  linkRevision: string;
};
export type DiscordChannelReplyMapping = DiscordReplyMappingBase &
  (GuildFeedbackScope | DmFeedbackScope);
export type ChannelReplyMapping = SlackChannelReplyMapping | DiscordChannelReplyMapping;

export interface DiscordFeedbackEvent {
  provider: 'discord';
  /** The interaction snowflake is the occurrence order. Never coerce it into Slack microseconds. */
  eventId: string;
  eventTimestampUs?: never;
  externalMessageKey: string;
  externalUserId: string;
  reaction: 'discord-button';
  action: 'replaced';
}
export type ChannelFeedbackEvent = ChannelReactionEvent | DiscordFeedbackEvent;

interface ChannelFeedbackVoteBase {
  /** Canonical Slack emoji alias or the single Discord button slot. */
  reaction: string;
  externalMessageKey: string;
  rating: ChannelRating;
  active: boolean;
  eventId: string;
}
export type ChannelFeedbackVote = ChannelFeedbackVoteBase &
  (
    | { provider?: never; eventTimestampUs: number }
    | { provider: 'discord'; eventTimestampUs?: never }
  );

export interface ChannelFeedbackView {
  messageId: string;
  conversationId: string;
  feedback: { rating: ChannelRating } | null;
  ignored: boolean;
}

export type ChannelFeedbackActor =
  | (Omit<SlackChannelExternalIdentity, 'externalUserId'> & { scope?: never })
  | (Omit<DiscordChannelExternalIdentity, 'externalUserId'> & GuildFeedbackScope)
  | (Omit<DiscordChannelExternalIdentity, 'externalUserId' | 'guildId'> &
      DmFeedbackScope & {
        externalChannelId: string;
        externalUserId: string;
        principalId: string;
        linkId: string;
        linkRevision: string;
      });

export type ChannelFeedbackError =
  | 'invalid_reaction'
  | 'mapping_not_found'
  | 'forbidden'
  | 'event_conflict'
  | 'changed'
  | 'capacity';

export type ChannelFeedbackResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ChannelFeedbackError } };
