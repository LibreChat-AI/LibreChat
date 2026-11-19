import type {
  SlackChannelExternalIdentity,
  DiscordChannelExternalIdentity,
} from './channelIdentity';

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

export type SlackChannelReplyMapping = ChannelReplyMappingBase & {
  provider?: never;
  teamId: string;
  applicationId?: never;
  guildId?: never;
  externalChannelId?: never;
  externalUserId?: never;
  linkId?: never;
  linkRevision?: never;
};
export type DiscordChannelReplyMapping = ChannelReplyMappingBase & {
  provider: 'discord';
  teamId?: never;
  applicationId: string;
  guildId: string;
  externalChannelId: string;
  externalUserId: string;
  linkId: string;
  linkRevision: string;
};
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
  | Omit<SlackChannelExternalIdentity, 'externalUserId'>
  | Omit<DiscordChannelExternalIdentity, 'externalUserId'>;

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
