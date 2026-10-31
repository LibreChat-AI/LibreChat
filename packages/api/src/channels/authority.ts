import {
  Permissions,
  PermissionTypes,
  PermissionBits,
  channelConfigSchema,
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
  findUser: (userId: string) => Promise<IUser | null>;
  getRole: (role: string) => Promise<IRole | null>;
  isPrincipalActive: (userId: string) => Promise<boolean>;
  getAgentPermissions: (agentId: string, user: { id: string; role: string }) => Promise<number>;
  /** Installed by the composition that supplies the link page. */
  publicBaseUrl?: string;
  getLifetimes?: ChannelIdentityDependencies['getLifetimes'];
}

export function channelExternalIdentity(
  channel: AgentChannelRecord,
  externalUserId: string,
): ChannelExternalIdentity {
  return {
    tenantId: channel.tenantId || '_',
    channelId: channel.channelId,
    channelRevision: channel.revision ?? channel.channelId,
    teamId: channel.slack?.teamId ?? '',
    externalUserId,
    agentId: channel.agentId,
  };
}

/** A Slack actor is never mapped from thread history or from an activator's exported API key. */
export interface ChannelAuthority {
  identity: ReturnType<typeof createChannelIdentityService>;
  resolvePrincipal(
    channel: AgentChannelRecord,
    actor: ChannelRunAdmission['actor'],
  ): Promise<ChannelRunPrincipal | null>;
}

export function createChannelAuthority(deps: ChannelAuthorityDependencies): ChannelAuthority {
  const defaults = channelConfigSchema.parse({});
  async function current(identity: ChannelExternalIdentity) {
    const channel = await deps.channels.getAgentChannelMetadata(identity.channelId);
    return channel &&
      channel.status === 'active' &&
      (channel.tenantId || '_') === identity.tenantId &&
      channel.agentId === identity.agentId &&
      channel.slack?.teamId === identity.teamId &&
      (channel.revision ?? channel.channelId) === identity.channelRevision
      ? channel
      : null;
  }
  const identity = createChannelIdentityService({
    storage: deps.identityStorage,
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
  ): Promise<ChannelRunPrincipal | null> {
    if (actor.teamId !== channel.slack?.teamId || actor.appId !== channel.slack?.appId) return null;
    const linked = await identity.resolve(channelExternalIdentity(channel, actor.externalUserId));
    if (!linked.ok) return null;
    return {
      userId: linked.value.userId,
      channelRevision: channel.revision ?? channel.channelId,
      linkId: linked.value.linkId,
      linkRevision: linked.value.revision,
    };
  }
  return { identity, resolvePrincipal };
}
