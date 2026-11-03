import type { ChannelReplyMapping } from 'librechat-data-provider';
import type { ChannelFeedbackSourceRef } from '~/models/channelFeedback';
import type { ChannelOwnership } from './channelRegistry';
import { SERVER_AUTHORED_MESSAGE_FILTER } from '~/utils/authored';
import { createResponseScopeModel } from '~/models/responseScope';
import { readChannelAuthority } from './channelRegistry';
import { assertChannelTenant } from './channelScope';
import { responseScopeKeys } from './responseScope';
import { digest } from './channelProtocol';

export class ChannelFeedbackAuthorityError extends Error {
  constructor() {
    super('Channel feedback authority unavailable');
    this.name = 'ChannelFeedbackAuthorityError';
  }
}

export type ChannelFeedbackSourceIdentity = Pick<
  ChannelReplyMapping,
  | 'tenantId'
  | 'channelId'
  | 'channelRevision'
  | 'teamId'
  | 'agentId'
  | 'runId'
  | 'responseId'
  | 'messageId'
  | 'conversationId'
  | 'principalId'
>;
const identityFields: readonly (keyof ChannelFeedbackSourceIdentity)[] = [
  'tenantId',
  'channelId',
  'channelRevision',
  'teamId',
  'agentId',
  'runId',
  'responseId',
  'messageId',
  'conversationId',
  'principalId',
];
export function sameFeedbackSource(
  left: ChannelFeedbackSourceIdentity,
  right: ChannelFeedbackSourceIdentity,
): boolean {
  return identityFields.every((key) => left[key] === right[key]);
}

export interface ChannelFeedbackSourceState {
  expiredAt: Date | null;
  sampled?: boolean;
  destinationIds?: string[];
  langfuseRunId?: string;
  centralTraceExportEnabled?: boolean;
}
export interface ChannelFeedbackAuthority {
  source: ChannelFeedbackSourceRef;
  roles: ChannelOwnership;
  state: ChannelFeedbackSourceState;
}

/** Capture current canonical authority and one physical authored Message; never load answer text. */
export async function readChannelFeedbackAuthority(
  mongoose: typeof import('mongoose'),
  mapping: ChannelReplyMapping,
  expected?: ChannelFeedbackSourceRef,
): Promise<ChannelFeedbackAuthority> {
  assertChannelTenant(mapping.tenantId);
  if (
    [
      mapping.principalId,
      mapping.conversationId,
      mapping.messageId,
      mapping.channelId,
      mapping.channelRevision,
      mapping.agentId,
      mapping.teamId,
    ].some((value) => typeof value !== 'string' || !value) ||
    mapping.messageId !== mapping.responseId ||
    (expected && !/^[a-f\d]{24}$/.test(expected.messageTargetId))
  )
    throw new ChannelFeedbackAuthorityError();
  const owner = {
    userId: mapping.principalId,
    ...(mapping.tenantId !== '_' && { tenantId: mapping.tenantId }),
  };
  const [channel, message, anchors] = await Promise.all([
    readChannelAuthority(mongoose, mapping),
    mongoose
      .model('Message')
      .findOne({
        user: owner.userId,
        tenantId: owner.tenantId || { $in: [null, ''] },
        conversationId: mapping.conversationId,
        messageId: mapping.messageId,
        ...SERVER_AUTHORED_MESSAGE_FILTER,
        ...(expected && { _id: new mongoose.Types.ObjectId(expected.messageTargetId) }),
        ...(expected?.messageIncarnation && {
          '_managed.incarnation': expected.messageIncarnation,
        }),
      })
      .select(
        '_id expiredAt langfuseSampled langfuseDestinationIds langfuseRunId langfuseCentralTraceExportEnabled _managed',
      )
      .read('primary')
      .lean<{
        _id: { toString(): string };
        expiredAt?: Date | null;
        _managed?: { incarnation?: string };
        langfuseSampled?: boolean;
        langfuseDestinationIds?: string[];
        langfuseRunId?: string;
        langfuseCentralTraceExportEnabled?: boolean;
      } | null>(),
    createResponseScopeModel(mongoose)
      .find({ _id: { $in: responseScopeKeys(owner, mapping.conversationId) } })
      .select('expiredAt closed')
      .read('primary')
      .lean(),
  ]);
  if (
    !channel ||
    !message ||
    anchors.some((anchor) => anchor.closed) ||
    (expected && digest(expected.channelTarget) !== digest(channel.target))
  )
    throw new ChannelFeedbackAuthorityError();
  if (channel.createdBy !== owner.userId) {
    const creator = await createResponseScopeModel(mongoose)
      .findById(responseScopeKeys({ ...owner, userId: channel.createdBy }, '')[0])
      .select('expiredAt closed')
      .read('primary')
      .lean();
    if (creator?.closed) throw new ChannelFeedbackAuthorityError();
    if (creator) anchors.push(creator);
  }
  const deadlines = [message, ...anchors].flatMap((item) =>
    item.expiredAt == null ? [] : [new Date(item.expiredAt).getTime()],
  );
  if (deadlines.some((deadline) => !Number.isFinite(deadline) || deadline <= Date.now()))
    throw new ChannelFeedbackAuthorityError();
  return {
    source: {
      messageTargetId: String(message._id),
      channelTarget: channel.target,
      ...(message._managed?.incarnation && { messageIncarnation: message._managed.incarnation }),
    },
    roles: {
      creator: { ...owner, userId: channel.createdBy },
      owner,
      channel,
      conversationId: mapping.conversationId,
    },
    state: {
      expiredAt: deadlines.length ? new Date(Math.min(...deadlines)) : null,
      sampled: message.langfuseSampled,
      destinationIds: message.langfuseDestinationIds,
      langfuseRunId: message.langfuseRunId,
      centralTraceExportEnabled: message.langfuseCentralTraceExportEnabled,
    },
  };
}

export async function readChannelFeedbackSourceState(
  mongoose: typeof import('mongoose'),
  mapping: ChannelReplyMapping,
  expected?: ChannelFeedbackSourceRef,
): Promise<ChannelFeedbackSourceState> {
  return (await readChannelFeedbackAuthority(mongoose, mapping, expected)).state;
}
export async function readChannelFeedbackRetention(
  mongoose: typeof import('mongoose'),
  mapping: ChannelReplyMapping,
): Promise<Date | null> {
  return (await readChannelFeedbackSourceState(mongoose, mapping)).expiredAt;
}

/** Request-local authority only; every callback's result is checked again before disclosure. */
export async function withChannelFeedbackAuthority<T>(
  mongoose: typeof import('mongoose'),
  mapping: ChannelReplyMapping,
  work: (authority: ChannelFeedbackAuthority) => Promise<T>,
  expected?: ChannelFeedbackSourceRef,
): Promise<T> {
  const authority = await readChannelFeedbackAuthority(mongoose, mapping, expected);
  const result = await work(authority);
  await readChannelFeedbackAuthority(mongoose, mapping, authority.source);
  return result;
}
