import { channelConfigSchema } from 'librechat-data-provider';
import type { ChannelRunStorage } from '@librechat/data-schemas';
import type { ChannelAuthority, ChannelAuthorityDependencies } from './authority';
import type { ChannelResponseCredentialDependencies } from './credentials';
import type { ChannelApplicationPolicy } from './applicationPolicy';
import { createChannelResponseCredentials } from './credentials';
import { checkRemoteAgentAccess } from '~/apiKeys/service';
import { createChannelAuthority } from './authority';
import { updateSlackLinkReply } from './linkReply';

export interface ChannelApplicationAuthorityDependencies
  extends Omit<
    ChannelAuthorityDependencies,
    'getConfig' | 'getLifetimes' | 'getAgentPermissions' | 'publicBaseUrl'
  > {
  storage: ChannelRunStorage;
  policy: ChannelApplicationPolicy;
  publicBaseUrl?: string;
  onLinkReplyError?: () => void;
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
  const defaultSlackTimeoutMs = channelConfigSchema.shape.slackApp
    .unwrap()
    .parse({}).requestTimeoutMs;
  const authority = createChannelAuthority({
    channels: deps.channels,
    identityStorage: deps.identityStorage,
    reply: deps.reply ?? {
      encrypt: deps.credentials.encrypt,
      decrypt: deps.credentials.decrypt,
      update: async (url, view) =>
        updateSlackLinkReply(
          url,
          view,
          (await deps.policy.config()).slackApp?.requestTimeoutMs ?? defaultSlackTimeoutMs,
        ),
      onError: deps.onLinkReplyError ?? (() => {}),
    },
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
