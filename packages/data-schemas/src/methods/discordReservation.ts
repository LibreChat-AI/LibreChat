import type { ClientSession } from 'mongoose';
import { createDiscordApplicationModel, createDiscordGuildModel } from '~/models/discord';
import { createDiscordReservationModel } from '~/models/discordReservation';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createAgentChannelModel } from '~/models/channel';

function tenant(): string | undefined {
  const tenantId = getTenantId();
  if (tenantId === SYSTEM_TENANT_ID)
    throw new TypeError('Discord reservations require a tenant scope');
  return tenantId || undefined;
}

/** A conflicting global application ID aborts the transaction; callers map duplicate ownership safely. */
export async function reserveDiscordApplication(
  mongoose: typeof import('mongoose'),
  applicationId: string,
  session: ClientSession,
): Promise<boolean> {
  const tenantId = tenant();
  const reservations = createDiscordReservationModel(mongoose);
  const record = await reservations
    .findOneAndUpdate(
      { applicationId, tenantId: tenantId || { $in: [null, ''] } },
      {
        $setOnInsert: { tenantId, retiring: false },
        $inc: { authorityWrites: 1 },
      },
      { upsert: true, new: true, session },
    )
    .lean();
  if (!record) throw new Error('Discord application reservation unavailable');
  if (!record.retiring) return true;
  const remainingApplication = await createDiscordApplicationModel(mongoose)
    .exists({ applicationId, tenantId: tenantId || { $in: [null, ''] } })
    .session(session);
  const remainingChannels = await createAgentChannelModel(mongoose)
    .exists({
      type: 'discord',
      tenantId: tenantId || { $in: [null, ''] },
      'discord.applicationId': applicationId,
    })
    .session(session);
  const remainingGuilds = await createDiscordGuildModel(mongoose)
    .exists({ applicationId, tenantId: tenantId || { $in: [null, ''] } })
    .session(session);
  if (remainingApplication || remainingChannels || remainingGuilds) return false;
  const updated = await reservations.updateOne(
    { applicationId, tenantId: tenantId || { $in: [null, ''] }, retiring: true },
    { $set: { retiring: false } },
    { session },
  );
  if (updated.matchedCount !== 1) throw new Error('Discord application recovery changed');
  return true;
}

/** Join the existing application fence before retiring private records and dependent channels. */
export async function retireDiscordReservation(
  mongoose: typeof import('mongoose'),
  applicationId: string,
  session: ClientSession,
): Promise<void> {
  const tenantId = tenant();
  await createDiscordReservationModel(mongoose).updateOne(
    { applicationId, tenantId: tenantId || { $in: [null, ''] } },
    {
      $setOnInsert: { tenantId },
      $set: { retiring: true },
      $inc: { authorityWrites: 1 },
    },
    { upsert: true, session },
  );
}
