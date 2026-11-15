import { channelSnowflakeSchema } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordRouteModel } from '~/models/discordRoute';

/** Serialize admission with destination replacement and removal. */
export async function touchDiscordRoute(
  mongoose: typeof import('mongoose'),
  scope: {
    tenantId?: string;
    installationId: string;
    externalChannelId: string;
    channelId: string;
  },
  session: ClientSession,
): Promise<boolean> {
  const tenantId = getTenantId();
  if (tenantId === SYSTEM_TENANT_ID || (scope.tenantId || undefined) !== (tenantId || undefined))
    throw new TypeError('Discord route tenant does not match authenticated scope');
  if (
    typeof scope.installationId !== 'string' ||
    !scope.installationId ||
    typeof scope.channelId !== 'string' ||
    !scope.channelId ||
    !channelSnowflakeSchema.safeParse(scope.externalChannelId).success
  )
    return false;
  const result = await createDiscordRouteModel(mongoose).updateOne(
    {
      tenantId: scope.tenantId ?? null,
      installationId: scope.installationId,
      externalChannelId: scope.externalChannelId,
      channelId: scope.channelId,
    },
    { $inc: { authorityWrites: 1 } },
    { session },
  );
  return result.matchedCount === 1;
}
