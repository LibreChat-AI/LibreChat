import type { ChannelReplyMapping } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import { initializeResponseScopes, responseScopeKeys } from './responseScope';
import { assertChannelTenant, touchChannelAuthority } from './channelScope';
import { SERVER_AUTHORED_MESSAGE_FILTER } from '~/utils/authored';
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

/** Retention maintenance does not depend on whether channel feedback is currently enabled. */
export interface ChannelFeedbackSourceState {
  expiredAt: Date | null;
  sampled?: boolean;
  destinationIds?: string[];
  langfuseRunId?: string;
  centralTraceExportEnabled?: boolean;
}

export async function readChannelFeedbackSourceState(
  mongoose: typeof import('mongoose'),
  mapping: ChannelReplyMapping,
  session?: ClientSession,
): Promise<ChannelFeedbackSourceState> {
  assertChannelTenant(mapping.tenantId);
  const owner = {
    userId: mapping.principalId,
    tenantId: mapping.tenantId === '_' ? undefined : mapping.tenantId,
  };
  // MongoDB does not support parallel operations within one transaction session.
  const messageQuery = mongoose
    .model('Message')
    .findOne({
      user: mapping.principalId,
      tenantId: owner.tenantId ?? { $in: [null, ''] },
      conversationId: mapping.conversationId,
      messageId: mapping.messageId,
      ...SERVER_AUTHORED_MESSAGE_FILTER,
    })
    .select(
      'expiredAt langfuseSampled langfuseDestinationIds langfuseRunId langfuseCentralTraceExportEnabled',
    )
    .session(session ?? null)
    .lean<{
      expiredAt?: Date | null;
      langfuseSampled?: boolean;
      langfuseDestinationIds?: string[];
      langfuseRunId?: string;
      langfuseCentralTraceExportEnabled?: boolean;
    }>();
  const anchorsQuery = createResponseScopeModel(mongoose)
    .find({ _id: { $in: responseScopeKeys(owner, mapping.conversationId) } })
    .select('expiredAt closed')
    .session(session ?? null)
    .lean();
  const [message, anchors] = session
    ? ([await messageQuery, await anchorsQuery] as const)
    : await Promise.all([messageQuery, anchorsQuery]);
  if (!message || anchors.some((anchor) => anchor.closed))
    throw new ChannelFeedbackAuthorityError();
  const deadlines = [message, ...anchors].flatMap((item) =>
    item.expiredAt == null ? [] : [new Date(item.expiredAt).getTime()],
  );
  if (deadlines.some((deadline) => !Number.isFinite(deadline)))
    throw new ChannelFeedbackAuthorityError();
  return {
    expiredAt: deadlines.length ? new Date(Math.min(...deadlines)) : null,
    sampled: message.langfuseSampled,
    destinationIds: message.langfuseDestinationIds,
    langfuseRunId: message.langfuseRunId,
    centralTraceExportEnabled: message.langfuseCentralTraceExportEnabled,
  };
}

export async function readChannelFeedbackRetention(
  mongoose: typeof import('mongoose'),
  mapping: ChannelReplyMapping,
  session?: ClientSession,
): Promise<Date | null> {
  return (await readChannelFeedbackSourceState(mongoose, mapping, session)).expiredAt;
}

/** Every private feedback write serializes with account, conversation and channel retirement. */
export async function withChannelFeedbackAuthority<T>(
  mongoose: typeof import('mongoose'),
  mapping: ChannelReplyMapping,
  work: (
    session: ClientSession,
    expiredAt: Date | null,
    state: ChannelFeedbackSourceState,
  ) => Promise<T>,
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
      const state = await readChannelFeedbackSourceState(mongoose, mapping, session);
      const { expiredAt } = state;
      if (expiredAt && expiredAt.getTime() <= Date.now()) throw new ChannelFeedbackAuthorityError();
      value = await work(session, expiredAt, state);
      if (expiredAt && expiredAt.getTime() <= Date.now()) throw new ChannelFeedbackAuthorityError();
    });
    return value;
  } finally {
    await session.endSession();
  }
}
