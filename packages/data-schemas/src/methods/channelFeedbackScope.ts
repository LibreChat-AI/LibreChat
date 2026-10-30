import type { ChannelReplyMapping } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import { initializeResponseScopes, responseScopeKeys } from './responseScope';
import { assertChannelTenant, touchChannelAuthority } from './channelScope';
import { createResponseScopeModel } from '~/models/responseScope';

export class ChannelFeedbackAuthorityError extends Error {
  constructor() {
    super('Channel feedback authority unavailable');
    this.name = 'ChannelFeedbackAuthorityError';
  }
}

export function sameFeedbackSource(left: ChannelReplyMapping, right: ChannelReplyMapping): boolean {
  return [
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
  ].every(
    (key) => left[key as keyof ChannelReplyMapping] === right[key as keyof ChannelReplyMapping],
  );
}

/** Every private feedback write serializes with account, conversation and channel retirement. */
export async function withChannelFeedbackAuthority<T>(
  mongoose: typeof import('mongoose'),
  mapping: ChannelReplyMapping,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
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
    mapping.messageId !== mapping.responseId
  )
    throw new ChannelFeedbackAuthorityError();
  const owner = {
    userId: mapping.principalId,
    tenantId: mapping.tenantId === '_' ? undefined : mapping.tenantId,
  };
  const keys = responseScopeKeys(owner, mapping.conversationId);
  await initializeResponseScopes(mongoose, keys);
  const session = await mongoose.startSession();
  try {
    let value!: T;
    await session.withTransaction(async () => {
      const at = new Date();
      const admitted = await createResponseScopeModel(mongoose).updateMany(
        {
          _id: { $in: keys },
          closed: false,
          $or: [{ expiredAt: null }, { expiredAt: { $gt: at } }],
        },
        { $inc: { revision: 1 } },
        { session },
      );
      if (
        admitted.matchedCount !== keys.length ||
        !(await touchChannelAuthority(
          mongoose,
          {
            tenantId: mapping.tenantId,
            channelId: mapping.channelId,
            agentId: mapping.agentId,
            channelRevision: mapping.channelRevision,
            teamId: mapping.teamId,
          },
          session,
        ))
      )
        throw new ChannelFeedbackAuthorityError();
      const message = await mongoose
        .model('Message')
        .findOne({
          user: mapping.principalId,
          tenantId: owner.tenantId ?? { $in: [null, ''] },
          conversationId: mapping.conversationId,
          messageId: mapping.messageId,
          isCreatedByUser: false,
          $or: [{ expiredAt: null }, { expiredAt: { $gt: at } }],
        })
        .select('expiredAt')
        .session(session)
        .lean<{ expiredAt?: Date | null }>();
      if (!message) throw new ChannelFeedbackAuthorityError();
      const anchors = await createResponseScopeModel(mongoose)
        .find({ _id: { $in: keys } })
        .select('expiredAt')
        .session(session)
        .lean();
      const deadlines = [message, ...anchors].flatMap((item) =>
        item.expiredAt == null ? [] : [new Date(item.expiredAt).getTime()],
      );
      if (deadlines.some((deadline) => !Number.isFinite(deadline)))
        throw new ChannelFeedbackAuthorityError();
      value = await work(session);
      if (deadlines.some((deadline) => deadline <= Date.now()))
        throw new ChannelFeedbackAuthorityError();
    });
    return value;
  } finally {
    await session.endSession();
  }
}
