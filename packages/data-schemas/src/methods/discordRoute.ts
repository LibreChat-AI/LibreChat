import { nanoid } from 'nanoid';
import { channelSnowflakeSchema } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordRouteRecord } from '~/models/discordRoute';
import { createDiscordApplicationModel, createDiscordGuildModel } from '~/models/discord';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { touchChannelScope, closeChannelScope } from './channelScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { createChannelScopeModel } from '~/models/channelScope';
import { createDiscordRouteModel } from '~/models/discordRoute';
import { withRequiredTransaction } from '~/utils/transactions';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { createAgentChannelModel } from '~/models/channel';
import { createChannelIndexGate } from './channelIndexes';
import { touchDiscordInstallation } from './discord';
import { createUserModel } from '~/models/user';

export type DiscordRouteError =
  | 'principal_unavailable'
  | 'installation_unavailable'
  | 'channel_unavailable'
  | 'route_changed';
export type DiscordRouteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: DiscordRouteError } };

export interface AssignDiscordRoute {
  actorId: string;
  installationId: string;
  installationRevision: string;
  applicationRevision: string;
  externalChannelId: string;
  channelId: string;
  channelRevision: string;
  expectedRevision?: string;
}

export interface DiscordRouteStorage {
  read(installationId: string, externalChannelId: string): Promise<DiscordRouteRecord | null>;
  assign(input: AssignDiscordRoute): Promise<DiscordRouteResult<DiscordRouteRecord>>;
  /** Authority reduction remains available when the installation or its owners are unavailable. */
  remove(input: {
    actorId: string;
    installationId: string;
    externalChannelId: string;
    expectedRevision: string;
  }): Promise<DiscordRouteResult<null>>;
}

const failure = (code: DiscordRouteError): { ok: false; error: { code: DiscordRouteError } } => ({
  ok: false,
  error: { code },
});

function identifier(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 256)
    throw new TypeError('Invalid Discord route identity');
}

/** The host checks current agent SHARE and installation-management rights before calling writes. */
export function createDiscordRouteStorage(
  mongoose: typeof import('mongoose'),
): DiscordRouteStorage {
  const routes = createDiscordRouteModel(mongoose);
  const channels = createAgentChannelModel(mongoose);
  const applications = createDiscordApplicationModel(mongoose);
  const users = createUserModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [
    routes,
    channels,
    applications,
    createDiscordGuildModel(mongoose),
    createChannelScopeModel(mongoose),
    createResponseScopeModel(mongoose),
    users,
  ]);
  function tenant(): string | undefined {
    const current = getTenantId();
    if (current === SYSTEM_TENANT_ID) throw new TypeError('Discord routes require a tenant scope');
    return current || undefined;
  }
  const slot = (installationId: string, externalChannelId: string) => ({
    tenantId: tenant() ?? null,
    installationId,
    externalChannelId,
  });

  async function mutate<T>(
    actorId: string,
    write: (session: ClientSession) => Promise<DiscordRouteResult<T>>,
  ): Promise<DiscordRouteResult<T>> {
    const tenantId = tenant();
    if (typeof actorId !== 'string' || !mongoose.isValidObjectId(actorId))
      return failure('principal_unavailable');
    const admit = await prepareChannelOwnerAdmission(mongoose, { userId: actorId, tenantId });
    return withRequiredTransaction(
      mongoose,
      async (session) => {
        if (
          !(await admit(session)) ||
          !(await users
            .exists({
              _id: actorId,
              tenantId: tenantId ?? null,
              agentTriggerDeletionStartedAt: { $exists: false },
            })
            .session(session))
        )
          return failure('principal_unavailable');
        return write(session);
      },
      ensureIndexes,
    );
  }

  async function retire(route: DiscordRouteRecord, session: ClientSession): Promise<void> {
    const previous = await channels
      .findOne({
        channelId: route.channelId,
        tenantId: route.tenantId ?? null,
      })
      .session(session)
      .lean();
    if (!previous) return;
    if (
      previous.type !== 'discord' ||
      previous.installationId !== route.installationId ||
      previous.discord?.externalChannelId !== route.externalChannelId
    )
      throw new TypeError('Discord route channel identity mismatch');
    await closeChannelScope(mongoose, route.tenantId, route.channelId, session);
    const result = await channels.updateOne(
      { channelId: route.channelId, tenantId: route.tenantId ?? null },
      { $set: { status: 'deleting' } },
      { session },
    );
    if (result.matchedCount !== 1) throw new Error('Discord route retirement did not persist');
  }

  return {
    async read(installationId, externalChannelId) {
      identifier(installationId);
      channelSnowflakeSchema.parse(externalChannelId);
      return routes.findOne(slot(installationId, externalChannelId)).read('primary').lean();
    },
    async assign(input) {
      for (const id of [
        input.installationId,
        input.installationRevision,
        input.applicationRevision,
        input.channelId,
        input.channelRevision,
      ])
        identifier(id);
      if (input.expectedRevision !== undefined) identifier(input.expectedRevision);
      channelSnowflakeSchema.parse(input.externalChannelId);
      return mutate(input.actorId, async (session) => {
        const filter = slot(input.installationId, input.externalChannelId);
        const current = await routes.findOne(filter).session(session).lean();
        if ((current?.revision ?? undefined) !== input.expectedRevision)
          return failure('route_changed');
        const candidate = await channels
          .findOne({
            tenantId: tenant() ?? null,
            channelId: input.channelId,
            createdBy: input.actorId,
            type: 'discord',
            status: 'pending_install',
            credentialMode: 'per_user',
            revision: input.channelRevision,
            installationId: input.installationId,
            installationRevision: input.installationRevision,
            'discord.externalChannelId': input.externalChannelId,
          })
          .session(session)
          .lean();
        if (!candidate || candidate.type !== 'discord' || !candidate.discord)
          return failure('channel_unavailable');
        if (
          !(await applications
            .exists({
              tenantId: tenant() ?? null,
              applicationId: candidate.discord.applicationId,
              botUserId: candidate.discord.botUserId,
              revision: input.applicationRevision,
            })
            .session(session)) ||
          !(await touchDiscordInstallation(
            mongoose,
            {
              tenantId: tenant(),
              installationId: input.installationId,
              applicationId: candidate.discord.applicationId,
              guildId: candidate.discord.guildId,
              expectedRevision: input.installationRevision,
              expectedApplicationRevision: input.applicationRevision,
            },
            session,
          ))
        )
          return failure('installation_unavailable');
        if (!(await touchChannelScope(mongoose, tenant(), candidate.channelId, session)))
          return failure('channel_unavailable');
        if (current) await retire(current, session);
        const route: DiscordRouteRecord = {
          tenantId: tenant(),
          installationId: input.installationId,
          externalChannelId: input.externalChannelId,
          channelId: candidate.channelId,
          revision: nanoid(),
          authorityWrites: current?.authorityWrites ?? 0,
        };
        if (current) {
          const result = await routes.updateOne(
            { ...filter, revision: current.revision },
            { $set: { channelId: route.channelId, revision: route.revision } },
            { session },
          );
          if (result.matchedCount !== 1)
            throw new Error('Discord route replacement did not persist');
        } else await routes.create([route], { session });
        const activated = await channels.updateOne(
          {
            channelId: candidate.channelId,
            tenantId: tenant() ?? null,
            status: 'pending_install',
            revision: input.channelRevision,
          },
          { $set: { status: 'active', revision: nanoid() } },
          { session },
        );
        if (activated.matchedCount !== 1)
          throw new Error('Discord route activation did not persist');
        return { ok: true, value: route };
      });
    },
    async remove(input) {
      identifier(input.installationId);
      identifier(input.expectedRevision);
      channelSnowflakeSchema.parse(input.externalChannelId);
      return mutate(input.actorId, async (session) => {
        const filter = {
          ...slot(input.installationId, input.externalChannelId),
          revision: input.expectedRevision,
        };
        const current = await routes.findOne(filter).session(session).lean();
        if (!current) return failure('route_changed');
        await retire(current, session);
        const result = await routes.deleteOne(filter, { session });
        if (result.deletedCount !== 1) throw new Error('Discord route removal did not persist');
        return { ok: true, value: null };
      });
    },
  };
}
