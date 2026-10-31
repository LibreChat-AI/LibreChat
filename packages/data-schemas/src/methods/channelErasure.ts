import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';
import type { ResponseOwner } from '~/models/response';
import { createChannelRunModel, createChannelLaneModel } from '~/models/channelRun';
import { eraseChannelFeedbackForChannel } from './channelFeedbackErasure';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { createAgentApiKeyModel } from '~/models/agentApiKey';
import { createAgentChannelModel } from '~/models/channel';
import { createIndexesWithRetry } from '~/utils/retry';
import { retireAgentChannel } from './channelScope';

/** Validate operation configuration before the caller closes irreversible admission fences. */
export function resolveChannelErasureConfig(
  options: Partial<ChannelStorageConfig> = {},
): ChannelStorageConfig {
  return channelStorageConfigSchema.parse(options);
}

/** The caller closes the response owner admission anchor before entering this cascade. */
export async function eraseChannelPersistenceForUser(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  options: Pick<Partial<ChannelStorageConfig>, 'erasureBatchSize'> = {},
): Promise<void> {
  resolveChannelErasureConfig(options);
  const tenantId = owner.tenantId || '_';
  await createAgentApiKeyModel(mongoose).deleteMany({
    userId: owner.userId,
    tenantId: owner.tenantId || { $in: [null, ''] },
  });
  const runs = createChannelRunModel(mongoose);
  const lanes = createChannelLaneModel(mongoose);
  const filter = { tenantId, 'principal.userId': owner.userId };
  await lanes.deleteMany({ tenantId, userId: owner.userId });
  await runs.deleteMany(filter);
  await createChannelIdentityModel(mongoose).deleteMany({ tenantId, userId: owner.userId });
  const channels = createAgentChannelModel(mongoose);
  await createIndexesWithRetry(channels);
  const partition = owner.tenantId || { $in: [null, ''] };
  const connections = channels
    .find({ createdBy: owner.userId, tenantId: partition })
    .select('channelId tenantId')
    .lean()
    .cursor();
  try {
    for await (const connection of connections) {
      // Keep redacted deletion metadata while other principals' runs drain. The
      // deleted owner's credentials are erased immediately.
      await retireAgentChannel(mongoose, { ...connection, createdBy: owner.userId }, true);
      await eraseChannelFeedbackForChannel(mongoose, connection.tenantId, connection.channelId);
      if (
        !(await runs.exists({
          channelId: connection.channelId,
          tenantId,
          state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
        }))
      )
        await channels.deleteOne({ _id: connection._id, status: 'deleting' });
    }
  } finally {
    await connections.close();
  }
}
