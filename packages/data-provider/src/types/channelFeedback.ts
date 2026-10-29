import type { ChannelExternalIdentity } from './channelIdentity';

export type ChannelRating = 'thumbsUp' | 'thumbsDown';

export interface ChannelReactionEvent {
  eventId: string;
  /** Exact Slack event timestamp in microseconds; a safe integer, not rounded milliseconds. */
  eventTimestampUs: number;
  externalMessageKey: string;
  externalUserId: string;
  reaction: string;
  action: 'added' | 'removed';
}

export interface ChannelReplyMapping {
  tenantId: string;
  channelId: string;
  channelRevision: string;
  teamId: string;
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

export interface ChannelFeedbackVote {
  externalMessageKey: string;
  rating: ChannelRating;
  active: boolean;
  eventTimestampUs: number;
  eventId: string;
}

export interface ChannelFeedbackView {
  messageId: string;
  conversationId: string;
  feedback: { rating: ChannelRating } | null;
  ignored: boolean;
}

export type ChannelFeedbackActor = Omit<ChannelExternalIdentity, 'externalUserId'>;

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
