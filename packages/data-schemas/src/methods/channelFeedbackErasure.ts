import type { ClientSession } from 'mongoose';
import type { ResponseOwner } from '~/models/response';
import {
  createChannelReplyModel,
  createChannelFeedbackEventModel,
  createChannelFeedbackModel,
} from '~/models/channelFeedback';

/** Call only after the corresponding owner/conversation/channel admission fence is closed. */
export async function eraseChannelFeedbackForOwner(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: readonly string[],
): Promise<void> {
  const tenantId = owner.tenantId || '_';
  const conversations = conversationIds ? { conversationId: { $in: conversationIds } } : {};
  await createChannelReplyModel(mongoose).deleteMany({
    tenantId,
    principalId: owner.userId,
    ...conversations,
  });
  const mapped = {
    tenantId,
    'mapping.principalId': owner.userId,
    ...(conversationIds ? { 'mapping.conversationId': { $in: conversationIds } } : {}),
  };
  await createChannelFeedbackEventModel(mongoose).deleteMany(mapped);
  await createChannelFeedbackModel(mongoose).deleteMany(mapped);
}

export async function eraseChannelFeedbackForChannel(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  channelId: string,
): Promise<void> {
  const partition = tenantId || '_';
  await createChannelReplyModel(mongoose).deleteMany({ tenantId: partition, channelId });
  await createChannelFeedbackEventModel(mongoose).deleteMany({ tenantId: partition, channelId });
  await createChannelFeedbackModel(mongoose).deleteMany({
    tenantId: partition,
    'mapping.channelId': channelId,
  });
}

/** Retention only moves earlier and shares the canonical conversation write transaction. */
export async function retainChannelFeedbackForOwner(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string,
  expiredAt: Date,
  session?: ClientSession,
): Promise<void> {
  const tenantId = owner.tenantId || '_';
  const deadline = { $or: [{ expiredAt: null }, { expiredAt: { $gt: expiredAt } }] };
  await createChannelReplyModel(mongoose).updateMany(
    { tenantId, principalId: owner.userId, conversationId, ...deadline },
    { $set: { expiredAt } },
    { session },
  );
  const filter = {
    tenantId,
    'mapping.principalId': owner.userId,
    'mapping.conversationId': conversationId,
    ...deadline,
  };
  await createChannelFeedbackModel(mongoose).updateMany(
    filter,
    { $set: { expiredAt } },
    { session },
  );
  await createChannelFeedbackEventModel(mongoose).updateMany(
    filter,
    { $set: { expiredAt } },
    { session },
  );
}
