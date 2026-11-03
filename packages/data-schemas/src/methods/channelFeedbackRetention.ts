import type { ClientSession } from 'mongoose';
import {
  createChannelReplyModel,
  createChannelFeedbackEventModel,
  createChannelFeedbackModel,
} from '~/models/channelFeedback';

/** Indexed lineage exists before registration; a late publisher can only shorten this deadline. */
export async function retainChannelFeedbackForScope(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  expiredAt: Date,
  key: string,
  session?: ClientSession,
): Promise<void> {
  if (!/^[a-f\d]{64}$/.test(key)) throw new TypeError('Invalid feedback retention scope');
  createChannelReplyModel(mongoose);
  createChannelFeedbackEventModel(mongoose);
  createChannelFeedbackModel(mongoose);
  for (const name of ['ChannelReply', 'ChannelFeedback', 'ChannelFeedbackEvent']) {
    const model = mongoose.model(name);
    await model.updateMany(
      { tenantId: tenantId || '_', '_managed.scopeKeys': key },
      { $min: { expiredAt, '_managed.expiredAt': expiredAt }, $inc: { __v: 1 } },
      { session, upsert: false },
    );
  }
}
