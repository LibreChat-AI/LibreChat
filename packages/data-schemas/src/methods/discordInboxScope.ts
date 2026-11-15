import { discordInboxFenceSchema } from 'librechat-data-provider';
import type { DiscordInboxFence } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import { createDiscordInboxModel } from '~/models/discordInbox';

import { assertChannelTenant } from './channelScope';

/** Join an ingress action to the same row as lease reclamation and reply preparation. */
export async function touchDiscordInbox(
  mongoose: typeof import('mongoose'),
  scope: {
    tenantId?: string;
    channelId: string;
    externalUserId: string;
    applicationRevision: string;
  },
  fence: DiscordInboxFence,
  now: number,
  session: ClientSession,
): Promise<boolean> {
  assertChannelTenant(scope.tenantId);
  discordInboxFenceSchema.parse(fence);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid Discord inbox clock');
  const result = await createDiscordInboxModel(mongoose).updateOne(
    {
      tenantId: !scope.tenantId || scope.tenantId === '_' ? null : scope.tenantId,
      channelId: scope.channelId,
      externalUserId: scope.externalUserId,
      applicationRevision: scope.applicationRevision,
      applicationId: fence.applicationId,
      eventId: fence.eventId,
      leaseOwner: fence.owner,
      leaseEpoch: fence.epoch,
      leaseExpiresAt: { $gt: now },
      expiresAt: { $gt: now },
      state: 'processing',
    },
    { $inc: { authorityWrites: 1 } },
    { session },
  );
  return result.matchedCount === 1;
}
