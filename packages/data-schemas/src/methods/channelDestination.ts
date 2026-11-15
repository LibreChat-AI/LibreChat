import {
  channelRunAdmissionSchema,
  channelSnowflakeSchema,
  discordNativeAuthoritySchema,
  discordGuildTextActorUsable,
} from 'librechat-data-provider';
import type {
  ChannelRunAdmission,
  ChannelRunPrincipal,
  DiscordNativeAuthority,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import { authorizeDiscordDmDestination, touchDiscordDmDestination } from './discordDm';
import { touchDiscordThreadBinding, touchDiscordThreadRoute } from './discordThread';
import { createDiscordApplicationModel } from '~/models/discord';
import { touchDiscordGatewayOwner } from './discordGateway';
import { touchChannelAuthority } from './channelScope';

export interface ChannelDestinationScope {
  tenantId?: string;
  channelId: string;
  agentId: string;
  principal: ChannelRunPrincipal;
  admission: ChannelRunAdmission;
  applicationRevision?: string;
}
export interface ChannelRunAuthorityScope extends ChannelDestinationScope {
  applicationRevision?: string;
  discordAuthority?: DiscordNativeAuthority;
  now: number;
  newAdmission?: boolean;
  promptEventAtMs?: number;
}

/** Canonical reference checks for private continuation/projection, never an external permission grant. */
export async function touchChannelDestinationBinding(
  mongoose: typeof import('mongoose'),
  scope: ChannelDestinationScope,
  now: number,
  session: ClientSession,
): Promise<boolean> {
  const tenantId = scope.tenantId === '_' ? undefined : scope.tenantId;
  const admission: ChannelRunAdmission = channelRunAdmissionSchema.parse(scope.admission);
  const actor = admission.actor;
  const destination = admission.discordDestination;
  if (!destination) {
    if (actor.provider !== 'discord') return true;
    if (actor.scope === 'dm') return false;
    return touchChannelAuthority(
      mongoose,
      {
        tenantId,
        channelId: scope.channelId,
        agentId: scope.agentId,
        channelRevision: scope.principal.channelRevision,
        principal: scope.principal,
        provider: 'discord',
        applicationId: actor.applicationId,
        guildId: actor.guildId,
        applicationRevision: scope.applicationRevision,
        externalUserId: actor.externalUserId,
        externalChannelId: admission.externalChannelId,
        now,
      },
      session,
    );
  }
  if (destination.kind === 'dm') {
    if (actor.provider !== 'discord' || actor.scope !== 'dm') return false;
    const applicationRevision =
      scope.applicationRevision ??
      (
        await createDiscordApplicationModel(mongoose)
          .findOne({ tenantId: tenantId ?? null, applicationId: actor.applicationId })
          .select('revision')
          .session(session)
          .lean()
      )?.revision;
    return Boolean(
      applicationRevision &&
        (await touchDiscordDmDestination(
          mongoose,
          {
            ...scope,
            tenantId,
            applicationRevision,
            now,
          },
          session,
        )),
    );
  }
  if (destination.kind !== 'guild_thread' || actor.provider !== 'discord' || actor.scope === 'dm')
    return false;
  return (
    (await touchDiscordThreadBinding(
      mongoose,
      {
        tenantId,
        applicationId: actor.applicationId,
        applicationRevision: scope.applicationRevision,
        channelId: scope.channelId,
        channelRevision: scope.principal.channelRevision,
        externalChannelId: admission.externalChannelId,
        thread: destination,
      },
      session,
    )) &&
    (await touchChannelAuthority(
      mongoose,
      {
        tenantId,
        channelId: scope.channelId,
        agentId: scope.agentId,
        channelRevision: scope.principal.channelRevision,
        principal: scope.principal,
        provider: 'discord',
        applicationId: actor.applicationId,
        guildId: actor.guildId,
        applicationRevision: scope.applicationRevision,
        externalUserId: actor.externalUserId,
        externalChannelId: destination.parentChannelId,
        now,
      },
      session,
    ))
  );
}

/** New effects join actual native destination, current owner and fresh actor-specific observations. */
export async function touchChannelRunAuthority(
  mongoose: typeof import('mongoose'),
  scope: ChannelRunAuthorityScope,
  session: ClientSession,
): Promise<boolean> {
  const tenantId = scope.tenantId === '_' ? undefined : scope.tenantId;
  const admission: ChannelRunAdmission = channelRunAdmissionSchema.parse(scope.admission);
  const actor = admission.actor;
  const destination = admission.discordDestination;
  if (
    scope.newAdmission &&
    actor.provider === 'discord' &&
    (!channelSnowflakeSchema.safeParse(admission.eventId).success ||
      Number(BigInt(admission.eventId) >> BigInt(22)) + 1420070400000 !== scope.promptEventAtMs)
  )
    return false;
  const parsed =
    scope.discordAuthority === undefined
      ? undefined
      : discordNativeAuthoritySchema.safeParse(scope.discordAuthority);
  if (parsed && !parsed.success) return false;
  const native = parsed?.success ? parsed.data : undefined;
  if (actor.provider !== 'discord' && (native || destination)) return false;
  if (actor.provider === 'discord' && actor.scope === 'dm') {
    if (native?.kind !== 'dm' || !scope.applicationRevision) return false;
    return authorizeDiscordDmDestination(
      mongoose,
      {
        ...scope,
        tenantId,
        applicationRevision: scope.applicationRevision,
      },
      native,
      session,
    );
  }
  let externalChannelId = admission.externalChannelId;
  let botUserId: string | undefined;
  if (actor.provider === 'discord') {
    if (!scope.applicationRevision) return false;
    if (
      native &&
      (native.owner.applicationId !== actor.applicationId ||
        native.owner.applicationRevision !== scope.applicationRevision)
    )
      return false;
    if (destination?.kind === 'guild_thread') {
      if (native?.kind !== 'guild_thread') return false;
      const source = native.source;
      if (
        source.applicationId !== actor.applicationId ||
        source.guildId !== actor.guildId ||
        source.authorId !== actor.externalUserId ||
        source.threadChannelId !== admission.externalChannelId ||
        source.parentChannelId !== destination.parentChannelId ||
        !(await touchDiscordThreadRoute(
          mongoose,
          {
            tenantId,
            owner: native.owner,
            channelId: scope.channelId,
            channelRevision: scope.principal.channelRevision,
            mappingRevision: destination.mappingRevision,
            externalChannelId: admission.externalChannelId,
            externalUserId: actor.externalUserId,
            source,
          },
          session,
        ))
      )
        return false;
      externalChannelId = destination.parentChannelId;
      botUserId = source.botUserId;
    } else {
      if (destination || native?.kind !== 'guild_text') return false;
      if (native?.kind === 'guild_text') {
        const source = native.source;
        if (
          !discordGuildTextActorUsable(source) ||
          source.applicationId !== actor.applicationId ||
          source.guildId !== actor.guildId ||
          source.channelId !== admission.externalChannelId ||
          source.authorId !== actor.externalUserId ||
          !(await touchDiscordGatewayOwner(mongoose, { ...native.owner, tenantId }, session))
        )
          return false;
        botUserId = source.botUserId;
      }
    }
  }
  return touchChannelAuthority(
    mongoose,
    {
      tenantId,
      channelId: scope.channelId,
      agentId: scope.agentId,
      channelRevision: scope.principal.channelRevision,
      principal: scope.principal,
      provider: actor.provider,
      applicationId: actor.applicationId,
      guildId: actor.guildId,
      teamId: actor.teamId,
      appId: actor.appId,
      externalUserId: actor.externalUserId,
      externalChannelId,
      applicationRevision: scope.applicationRevision,
      botUserId,
      now: scope.now,
      promptEventAtMs: scope.promptEventAtMs,
    },
    session,
  );
}
