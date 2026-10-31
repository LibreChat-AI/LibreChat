import type { ChannelRunStorage } from '@librechat/data-schemas';
import type { ChannelAuthority, ChannelAuthorityDependencies } from './authority';
import type { ChannelResponseCredentialDependencies } from './credentials';
import type { ChannelApplicationPolicy } from './applicationPolicy';
import { createChannelResponseCredentials } from './credentials';
import { checkRemoteAgentAccess } from '~/apiKeys/service';
import { createChannelAuthority } from './authority';

export interface ChannelApplicationAuthorityDependencies
  extends Omit<
    ChannelAuthorityDependencies,
    'getConfig' | 'getLifetimes' | 'getAgentPermissions' | 'publicBaseUrl'
  > {
  storage: ChannelRunStorage;
  policy: ChannelApplicationPolicy;
  publicBaseUrl?: string;
  access: Pick<
    Parameters<typeof checkRemoteAgentAccess>[0],
    'getAgent' | 'getEffectivePermissions'
  >;
  credentials: Omit<
    ChannelResponseCredentialDependencies,
    'storage' | 'getChannel' | 'resolvePrincipal' | 'lifetimeMs'
  >;
}
export interface ChannelApplicationAuthority {
  storage: ChannelRunStorage;
  policy: ChannelApplicationPolicy;
  authority: ChannelAuthority;
  responseCredentials: ReturnType<typeof createChannelResponseCredentials>;
  authorizeChannelResponseKeyRequest: ReturnType<
    typeof createChannelResponseCredentials
  >['authorizeRequest'];
  authorizeChannelResponseKeySource: ReturnType<
    typeof createChannelResponseCredentials
  >['authorizeSource'];
}

/** Both key validation and live participant authorization share the canonical authority instance. */
export function createChannelApplicationAuthority(
  deps: ChannelApplicationAuthorityDependencies,
): ChannelApplicationAuthority {
  const authority = createChannelAuthority({
    channels: deps.channels,
    identityStorage: deps.identityStorage,
    findUser: deps.findUser,
    getRole: deps.getRole,
    isPrincipalActive: deps.isPrincipalActive,
    enrollmentRequired: deps.enrollmentRequired,
    publicBaseUrl: deps.publicBaseUrl,
    getConfig: deps.policy.config,
    getLifetimes: deps.policy.config,
    getAgentPermissions: async (agentId, user) =>
      (await checkRemoteAgentAccess({ ...deps.access, agentId, userId: user.id, role: user.role }))
        .permissions,
  });
  const responseCredentials = createChannelResponseCredentials({
    ...deps.credentials,
    storage: deps.storage,
    getChannel: deps.channels.getAgentChannelMetadata,
    resolvePrincipal: authority.resolvePrincipal,
    lifetimeMs: async () => (await deps.policy.config()).responseCredentialLifetimeMs,
  });
  return {
    storage: deps.storage,
    policy: deps.policy,
    authority,
    responseCredentials,
    authorizeChannelResponseKeyRequest: responseCredentials.authorizeRequest,
    authorizeChannelResponseKeySource: responseCredentials.authorizeSource,
  };
}
