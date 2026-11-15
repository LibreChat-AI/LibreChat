import {
  Permissions,
  PermissionTypes,
  PermissionBits,
  channelConfigSchema,
  channelActorMatchesChannel,
  sameChannelExternalIdentity,
  sameChannelRunActor,
  channelRunAdmissionSchema,
  channelSnowflakeSchema,
} from 'librechat-data-provider';
import type {
  ChannelExternalIdentity,
  ChannelRunAdmission,
  ChannelRunPrincipal,
  ChannelConfig,
} from 'librechat-data-provider';
import type {
  IUser,
  IRole,
  AgentChannelMethods,
  ChannelIdentityStorage,
  DiscordDmStorage,
} from '@librechat/data-schemas';
import type { AgentChannelRecord } from '@librechat/data-schemas';
import type { ChannelIdentityDependencies } from './identity';
import { isTwoFactorEnrollmentRequired } from '~/auth/twoFactor';
import { createChannelIdentityService } from './identity';

export interface ChannelAuthorityDependencies {
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  getConfig: (user: IUser) => Promise<Pick<ChannelConfig, 'enabled'>>;
  enrollmentRequired?: typeof isTwoFactorEnrollmentRequired;
  identityStorage: ChannelIdentityStorage;
  discordDm?: Pick<DiscordDmStorage, 'reference'>;
  /** Canonical native reference check, separate from fresh external source grants. */
  authorizeDestination?: (
    channel: AgentChannelRecord,
    admission: ChannelRunAdmission,
    principal: ChannelRunPrincipal,
  ) => Promise<boolean>;
  findUser: (userId: string) => Promise<IUser | null>;
  getRole: (role: string) => Promise<IRole | null>;
  isPrincipalActive: (userId: string) => Promise<boolean>;
  getAgentPermissions: (agentId: string, user: { id: string; role: string }) => Promise<number>;
  /** Installed by the composition that supplies the link page. */
  publicBaseUrl?: string;
  getLifetimes?: ChannelIdentityDependencies['getLifetimes'];
  reply?: ChannelIdentityDependencies['reply'];
}

export function channelExternalIdentity(
  channel: AgentChannelRecord,
  externalUserId: string,
): ChannelExternalIdentity {
  if (channel.type === 'discord')
    return {
      tenantId: channel.tenantId || '_',
      channelId: channel.channelId,
      channelRevision: channel.revision,
      agentId: channel.agentId,
      provider: 'discord',
      applicationId: channel.discord.applicationId,
      guildId: channel.discord.guildId,
      externalUserId,
    };
  if (channel.type !== 'slack') throw new TypeError('Unsupported channel identity provider');
  return {
    tenantId: channel.tenantId || '_',
    channelId: channel.channelId,
    channelRevision: channel.revision,
    teamId: channel.slack?.teamId ?? '',
    externalUserId,
    agentId: channel.agentId,
  };
}

/** An external actor is never mapped from thread history or from an activator's exported API key. */
export interface ChannelAuthority {
  identity: ReturnType<typeof createChannelIdentityService>;
  resolvePrincipal(
    channel: AgentChannelRecord,
    actor: ChannelRunAdmission['actor'],
    admission?: ChannelRunAdmission,
  ): Promise<ChannelRunPrincipal | null>;
}

export function createChannelAuthority(deps: ChannelAuthorityDependencies): ChannelAuthority {
  const defaults = channelConfigSchema.parse({});
  async function current(identity: ChannelExternalIdentity) {
    const channel = await deps.channels.getAgentChannelMetadata(identity.channelId);
    return channel &&
      (channel.type === 'slack' || channel.type === 'discord') &&
      channel.status === 'active' &&
      (channel.tenantId || '_') === identity.tenantId &&
      channel.agentId === identity.agentId &&
      sameChannelExternalIdentity(
        channelExternalIdentity(channel, identity.externalUserId),
        identity,
      )
      ? channel
      : null;
  }
  const identity = createChannelIdentityService({
    storage: deps.identityStorage,
    reply: deps.reply,
    channelIsCurrent: async (actor) => Boolean(await current(actor)),
    canUse: async (actor, userId) => {
      const channel = await current(actor);
      if (!channel || (channel.credentialMode === 'shared' && channel.createdBy !== userId))
        return false;
      const user = await deps.findUser(userId);
      if (
        !user ||
        String(user._id) !== userId ||
        (user.tenantId || '_') !== actor.tenantId ||
        (deps.enrollmentRequired ?? isTwoFactorEnrollmentRequired)(user)
      )
        return false;
      if (!user.role) return false;
      const [role, config, active, permissions] = await Promise.all([
        deps.getRole(user.role),
        deps.getConfig(user),
        deps.isPrincipalActive(userId),
        deps.getAgentPermissions(channel.agentId, { id: userId, role: user.role }),
      ]);
      return Boolean(
        active &&
          config.enabled &&
          role?.permissions?.[PermissionTypes.REMOTE_AGENTS]?.[Permissions.USE] === true &&
          role?.permissions?.[PermissionTypes.AGENTS]?.[Permissions.USE] === true &&
          (permissions & PermissionBits.VIEW) === PermissionBits.VIEW,
      );
    },
    publicBaseUrl: deps.publicBaseUrl,
    ticketLifetimeMs: defaults.ticketLifetimeMs,
    linkLifetimeMs: defaults.linkLifetimeMs,
    getLifetimes: deps.getLifetimes,
  });
  async function resolvePrincipal(
    channel: AgentChannelRecord,
    actor: ChannelRunAdmission['actor'],
    admission?: ChannelRunAdmission,
  ): Promise<ChannelRunPrincipal | null> {
    if (actor.provider === 'discord' && actor.scope === 'dm') {
      if (
        !admission ||
        !channelRunAdmissionSchema.safeParse(admission).success ||
        !channelSnowflakeSchema.safeParse(admission.externalChannelId).success ||
        !sameChannelRunActor(actor, admission.actor) ||
        admission.discordDestination?.kind !== 'dm' ||
        !deps.discordDm ||
        !deps.authorizeDestination ||
        channel.type !== 'discord' ||
        channel.status !== 'active' ||
        actor.applicationId !== channel.discord.applicationId
      )
        return null;
      const selected = await deps.discordDm.reference(
        {
          applicationId: actor.applicationId,
          externalUserId: actor.externalUserId,
          dmChannelId: admission.externalChannelId,
          selectionId: actor.selectionId,
          revision: actor.selectionRevision,
        },
        Date.now(),
      );
      if (
        !selected ||
        selected.source.channelId !== channel.channelId ||
        selected.source.channelRevision !== channel.revision ||
        selected.source.agentId !== channel.agentId ||
        selected.source.guildId !== channel.discord.guildId ||
        selected.source.externalChannelId !== channel.discord.externalChannelId
      )
        return null;
      const linked = await identity.resolve(
        channelExternalIdentity(channel, actor.externalUserId),
        selected.source.linkRevision,
      );
      if (
        !linked.ok ||
        linked.value.linkId !== selected.source.linkId ||
        linked.value.userId !== selected.source.userId
      )
        return null;
      const principal: ChannelRunPrincipal = {
        userId: linked.value.userId,
        channelRevision: channel.revision,
        linkId: linked.value.linkId,
        linkRevision: linked.value.revision,
      };
      return (await deps.authorizeDestination(channel, admission, principal)) ? principal : null;
    }
    if (!channelActorMatchesChannel(channel, actor)) return null;
    const linked = await identity.resolve(channelExternalIdentity(channel, actor.externalUserId));
    if (!linked.ok) return null;
    const principal = {
      userId: linked.value.userId,
      channelRevision: channel.revision,
      linkId: linked.value.linkId,
      linkRevision: linked.value.revision,
    };
    if (admission) {
      if (
        channel.type === 'discord' &&
        !admission.discordDestination &&
        admission.externalChannelId !== channel.discord.externalChannelId
      )
        return null;
      if (
        admission.discordDestination &&
        (!deps.authorizeDestination ||
          !(await deps.authorizeDestination(channel, admission, principal)))
      )
        return null;
    }
    return principal;
  }
  return { identity, resolvePrincipal };
}
