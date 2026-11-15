import { createDiscordDmCodeModel, createDiscordDmSelectionModel } from '~/models/discordDm';
import { getTenantId, tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';

/** Called only after the owning account/channel/installation has closed admission. */
export async function eraseDiscordDmPersistence(
  mongoose: typeof import('mongoose'),
  scope: {
    tenantId?: string;
    userId?: string;
    channelId?: string;
    applicationId?: string;
    guildId?: string;
  },
): Promise<void> {
  const current = getTenantId();
  const tenantId = scope.tenantId || undefined;
  if (
    tenantId === SYSTEM_TENANT_ID ||
    (current !== SYSTEM_TENANT_ID && (current || undefined) !== tenantId) ||
    ![scope.userId, scope.channelId, scope.applicationId].some(
      (value) => typeof value === 'string' && value.length > 0,
    ) ||
    (scope.guildId && !scope.applicationId)
  )
    throw new TypeError('Invalid Discord DM erasure scope');
  if (current === SYSTEM_TENANT_ID)
    return tenantStorage.run({ tenantId }, () => eraseDiscordDmPersistence(mongoose, scope));
  for (const value of [scope.userId, scope.channelId, scope.applicationId, scope.guildId])
    if (value !== undefined && (typeof value !== 'string' || !value))
      throw new TypeError('Invalid Discord DM erasure identifier');
  const filter = {
    tenantId: tenantId || { $in: [null, ''] },
    ...(scope.userId ? { 'source.userId': scope.userId } : {}),
    ...(scope.channelId ? { 'source.channelId': scope.channelId } : {}),
    ...(scope.applicationId ? { applicationId: scope.applicationId } : {}),
    ...(scope.guildId ? { 'source.guildId': scope.guildId } : {}),
  };
  await createDiscordDmCodeModel(mongoose).deleteMany(filter);
  await createDiscordDmSelectionModel(mongoose).deleteMany(filter);
}
