import { nanoid } from 'nanoid';
import type { ChannelStorageConfig, DiscordGuild } from 'librechat-data-provider';
import type { ResponseOwner } from '~/models/response';
import { createDiscordApplicationModel, createDiscordGuildModel } from '~/models/discord';
import { getTenantId, SYSTEM_TENANT_ID, tenantStorage } from '~/config/tenantContext';
import { retireAgentChannel, lockExistingChannelScope } from './channelScope';
import { createDiscordGatewayCheckpointModel } from '~/models/discordGateway';
import { createDiscordReservationModel } from '~/models/discordReservation';
import { eraseChannelFeedbackForChannel } from './channelFeedbackErasure';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { createDiscordInstallModel } from '~/models/discordInstall';
import { createResponseScopeModel } from '~/models/responseScope';
import { eraseDiscordThreadRoutes } from './discordThreadErasure';
import { createResourceLockModel } from '~/models/resourceLock';
import { createDiscordRouteModel } from '~/models/discordRoute';
import { retireDiscordReservation } from './discordReservation';
import { withRequiredTransaction } from '~/utils/transactions';
import { eraseDiscordDmPersistence } from './discordDmErasure';
import { createDiscordInboxErasure } from './discordReceipt';
import { createChannelRunModel } from '~/models/channelRun';
import { createAgentChannelModel } from '~/models/channel';
import { createChannelIndexGate } from './channelIndexes';
import { responseScopeKeys } from './responseScope';
import { activeStates } from './channelProtocol';

/** Called only after account admission closes. Failures retain discoverable parents for retry. */
export async function eraseDiscordPersistenceForUser(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  options: Pick<Partial<ChannelStorageConfig>, 'erasureBatchSize'> = {},
): Promise<void> {
  const current = getTenantId();
  const tenantId = owner.tenantId || undefined;
  if (
    !owner.userId ||
    tenantId === SYSTEM_TENANT_ID ||
    (current !== SYSTEM_TENANT_ID && (current || undefined) !== tenantId)
  )
    throw new TypeError('Discord erasure requires the matching account tenant');
  if (current === SYSTEM_TENANT_ID)
    return tenantStorage.run({ tenantId }, async () =>
      eraseDiscordPersistenceForUser(mongoose, owner, options),
    );
  const [accountKey] = responseScopeKeys(owner, '');
  if (
    !(await createResponseScopeModel(mongoose)
      .exists({ _id: accountKey, closed: true })
      .read('primary'))
  )
    throw new Error('Discord account erasure admission fence unavailable');
  const partition = tenantId || { $in: [null, ''] };
  const applications = createDiscordApplicationModel(mongoose);
  const guilds = createDiscordGuildModel(mongoose);
  const channels = createAgentChannelModel(mongoose);
  const routes = createDiscordRouteModel(mongoose);
  const installs = createDiscordInstallModel(mongoose);
  const identities = createChannelIdentityModel(mongoose);
  const runs = createChannelRunModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [createDiscordReservationModel(mongoose)]);
  const erasure = createDiscordInboxErasure(mongoose, async (scope, session) => {
    await lockExistingChannelScope(mongoose, scope.tenantId, scope.channelId, session);
  });

  // Revoke before the watermark, retaining the owner reference until every private row is erased.
  const links = identities
    .find({ tenantId: tenantId || '_', userId: owner.userId, 'identity.provider': 'discord' })
    .select('identity')
    .read('primary')
    .lean()
    .cursor();
  try {
    for await (const link of links) {
      await withRequiredTransaction(mongoose, async (session) => {
        await lockExistingChannelScope(mongoose, tenantId, link.identity.channelId, session);
        await identities.updateOne(
          { _id: link._id, userId: owner.userId },
          { $set: { state: 'revoked', revision: nanoid() } },
          { session },
        );
        return true;
      });
      await erasure.erase(
        {
          kind: 'actor',
          tenantId,
          channelId: link.identity.channelId,
          externalUserId: link.identity.externalUserId,
          ...(link.identity.provider === 'discord'
            ? { applicationId: link.identity.applicationId, guildId: link.identity.guildId }
            : {}),
        },
        options.erasureBatchSize,
      );
      await identities.deleteOne({ _id: link._id, userId: owner.userId });
    }
  } finally {
    await links.close();
  }

  async function retireChannels(scope: { applicationId: string; guildId?: string }): Promise<void> {
    const bindings = channels
      .find({
        tenantId: partition,
        type: 'discord',
        'discord.applicationId': scope.applicationId,
        ...(scope.guildId ? { 'discord.guildId': scope.guildId } : {}),
      })
      .select('tenantId channelId createdBy')
      .read('primary')
      .lean()
      .cursor();
    try {
      for await (const binding of bindings) {
        await retireAgentChannel(mongoose, binding, true, options.erasureBatchSize);
        await eraseChannelFeedbackForChannel(mongoose, tenantId, binding.channelId);
        if (
          !(await runs
            .exists({
              tenantId: tenantId || '_',
              channelId: binding.channelId,
              state: { $in: activeStates },
            })
            .read('primary'))
        )
          await channels.deleteOne({ _id: binding._id, status: 'deleting' });
      }
    } finally {
      await bindings.close();
    }
  }

  async function purgeGuild(guild: DiscordGuild): Promise<void> {
    await retireChannels(guild);
    await eraseDiscordDmPersistence(mongoose, {
      tenantId,
      applicationId: guild.applicationId,
      guildId: guild.guildId,
    });
    await erasure.erase(
      { kind: 'guild', tenantId, applicationId: guild.applicationId, guildId: guild.guildId },
      options.erasureBatchSize,
    );
    await eraseDiscordThreadRoutes(mongoose, {
      kind: 'guild',
      tenantId,
      applicationId: guild.applicationId,
      guildId: guild.guildId,
    });
    await routes.deleteMany({ tenantId: partition, installationId: guild.installationId });
    await installs.deleteMany({
      tenantId: partition,
      $or: [
        { installationId: guild.installationId },
        { applicationId: guild.applicationId, guildId: guild.guildId },
      ],
    });
    // Private parents disappear last, so interrupted cleanup remains discoverable by its owner.
    await guilds.deleteOne({
      tenantId: partition,
      installationId: guild.installationId,
      status: 'disconnected',
    });
  }

  const ownedApplications = applications
    .find({ tenantId: partition, createdBy: owner.userId })
    .select('applicationId')
    .read('primary')
    .lean()
    .cursor();
  try {
    for await (const application of ownedApplications) {
      await withRequiredTransaction(
        mongoose,
        async (session) => {
          const retiring = await applications.updateOne(
            {
              tenantId: partition,
              applicationId: application.applicationId,
              createdBy: owner.userId,
            },
            { $set: { revision: nanoid() }, $inc: { authorityWrites: 1 } },
            { session },
          );
          if (retiring.matchedCount !== 1) throw new Error('Discord application erasure changed');
          await retireDiscordReservation(mongoose, application.applicationId, session);
          await guilds.updateMany(
            { tenantId: partition, applicationId: application.applicationId },
            { $set: { status: 'disconnected', revision: nanoid() }, $inc: { authorityWrites: 1 } },
            { session },
          );
          return true;
        },
        ensureIndexes,
      );
      // Include pending bindings and bindings created by other organization administrators.
      await retireChannels({ applicationId: application.applicationId });
      await erasure.erase(
        { kind: 'application', tenantId, applicationId: application.applicationId },
        options.erasureBatchSize,
      );
      const installations = guilds
        .find({ tenantId: partition, applicationId: application.applicationId })
        .read('primary')
        .lean()
        .cursor();
      try {
        for await (const guild of installations) await purgeGuild(guild);
      } finally {
        await installations.close();
      }
      await installs.deleteMany({ tenantId: partition, applicationId: application.applicationId });
      await eraseDiscordThreadRoutes(mongoose, {
        kind: 'application',
        tenantId,
        applicationId: application.applicationId,
      });
      await eraseDiscordDmPersistence(mongoose, {
        tenantId,
        applicationId: application.applicationId,
      });
      await createDiscordGatewayCheckpointModel(mongoose).deleteMany({
        tenantId: partition,
        applicationId: application.applicationId,
      });
      await createResourceLockModel(mongoose).deleteOne({
        key: `discord:gateway:${application.applicationId}`,
      });
      await applications.deleteOne({
        tenantId: partition,
        applicationId: application.applicationId,
        createdBy: owner.userId,
      });
    }
  } finally {
    await ownedApplications.close();
  }

  // An installer may own a guild whose application belongs to another active administrator.
  const ownedGuilds = guilds
    .find({ tenantId: partition, createdBy: owner.userId })
    .read('primary')
    .lean()
    .cursor();
  try {
    for await (const guild of ownedGuilds) {
      await withRequiredTransaction(mongoose, async (session) => {
        const retiring = await guilds.updateOne(
          { tenantId: partition, installationId: guild.installationId, createdBy: owner.userId },
          { $set: { status: 'disconnected', revision: nanoid() }, $inc: { authorityWrites: 1 } },
          { session },
        );
        if (retiring.matchedCount !== 1) throw new Error('Discord guild erasure changed');
        return true;
      });
      await purgeGuild(guild);
    }
  } finally {
    await ownedGuilds.close();
  }
}
