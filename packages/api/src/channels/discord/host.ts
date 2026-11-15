import {
  PermissionBits,
  ResourceType,
  hasPermissions,
  channelConfigSchema,
  discordChannelConfigSchema,
} from 'librechat-data-provider';
import type {
  AgentChannelMethods,
  AppConfig,
  DiscordInstallationStorage,
  DiscordRouteStorage,
  DiscordInboxStorage,
  DiscordCommandStorage,
} from '@librechat/data-schemas';
import type { DiscordChannelConfig } from 'librechat-data-provider';
import type { ChannelApplicationAuthorityDependencies } from '../applicationAuthority';
import type { ChannelApplicationAuthority } from '../applicationAuthority';
import type { SlackWorkspaceAdminDependencies } from '../workspaceRuntime';
import type { DiscordManagementPrincipal } from './service';
import type { GetAppConfigOptions } from '~/app/service';
import type { SafeErrorMetadata } from '~/utils/errors';
import { createDiscordBindingHandlers, createDiscordRouteHandlers } from './bindingHttp';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createSlackWorkspaceAdminGuard } from '../workspaceRuntime';
import { createDiscordCommandExecutor } from './commands';
import { createDiscordBindingService } from './bindings';
import { createDiscordInboxHandlers } from './inboxHttp';
import { createDiscordProviderClient } from './client';
import { createDiscordRouteResolver } from './routes';
import { createDiscordInboxService } from './inbox';
import { getOAuthCallbackUrl } from '~/oauth/url';
import { DISCORD_CALLBACK_PATH } from './http';

export interface DiscordPolicyReader {
  read(): Promise<DiscordChannelConfig>;
  inbox(): Promise<DiscordChannelConfig['inbox']>;
}
export interface DiscordChannelRuntime {
  bindings: ReturnType<typeof createDiscordBindingHandlers>;
  routes: ReturnType<typeof createDiscordRouteHandlers>;
  inbox: ReturnType<typeof createDiscordInboxHandlers>;
}

/** Read the canonical tenant policy on each authorization boundary, including disabled teardown. */
export function createDiscordPolicyReader(
  readAppConfig: (options?: GetAppConfigOptions) => Promise<Pick<AppConfig, 'endpoints'>>,
): DiscordPolicyReader {
  const read = async () => {
    const app = await readAppConfig({ baseOnly: true, failClosed: true });
    const channels = channelConfigSchema.parse(app.endpoints?.agents?.channels ?? {});
    const discord = discordChannelConfigSchema.parse(channels.discord ?? {});
    return { ...discord, enabled: channels.enabled && discord.enabled };
  };
  return { read, inbox: async () => (await read()).inbox };
}

/** Compose existing services around the same authority used by channel workers and account links. */
export function createDiscordChannelRuntime(
  deps: SlackWorkspaceAdminDependencies & {
    channels: AgentChannelMethods;
    installations: DiscordInstallationStorage;
    routes: DiscordRouteStorage;
    inbox: DiscordInboxStorage;
    commands: DiscordCommandStorage;
    application: Pick<ChannelApplicationAuthority, 'authority' | 'storage'>;
    access: ChannelApplicationAuthorityDependencies['access'];
    policy: ReturnType<typeof createDiscordPolicyReader>;
    serviceToken: () => string | undefined;
    publicBaseUrl?: string;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    logError: (metadata: SafeErrorMetadata) => void;
  },
): DiscordChannelRuntime {
  const enabled = async () => (await deps.policy.read()).enabled;
  const canManage = createSlackWorkspaceAdminGuard(deps);
  async function agentAccess(principal: DiscordManagementPrincipal, agentId: string, bit: number) {
    const [user, active, agent] = await Promise.all([
      deps.findUser(principal.id),
      deps.isPrincipalActive(principal.id),
      deps.access.getAgent({ id: agentId }),
    ]);
    if (!user || !active || !agent || (user.tenantId || undefined) !== principal.tenantId)
      return null;
    const permissions = await deps.access.getEffectivePermissions({
      userId: principal.id,
      role: user.role || undefined,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
    });
    return hasPermissions(permissions, bit) ? agent : null;
  }
  const binding = createDiscordBindingService({
    ...deps,
    enabled,
    canEditAgent: async (principal, agentId) =>
      Boolean(await agentAccess(principal, agentId, PermissionBits.SHARE)),
    canManageInstallation: (principal) => canManage(principal),
    getAgentName: async (principal, agentId) => {
      const agent = await agentAccess(principal, agentId, PermissionBits.VIEW);
      return typeof agent?.name === 'string' ? agent.name : undefined;
    },
    decrypt: decryptCredential,
    provider: {
      inspectChannel: async (input) => {
        const config = await deps.policy.read();
        if (!config.enabled) return { ok: false, error: { code: 'provider_unavailable' } };
        return createDiscordProviderClient({
          fetch: deps.fetch,
          config: {
            ...config,
            redirectUri: getOAuthCallbackUrl(
              deps.publicBaseUrl || 'http://localhost:3080',
              DISCORD_CALLBACK_PATH,
            ),
          },
        }).inspectChannel(input);
      },
    },
  });
  const resolver = createDiscordRouteResolver({ ...deps, enabled });
  const execute = createDiscordCommandExecutor({
    ...deps,
    authority: deps.application.authority,
    publicBaseUrl: deps.publicBaseUrl || 'http://localhost:3080',
    runs: deps.application.storage,
    enabled,
  });
  const inbox = createDiscordInboxService({
    storage: deps.inbox,
    resolver,
    execute,
    encrypt: encryptCredential,
    decrypt: decryptCredential,
    retryDelayMs: async () => (await deps.policy.read()).inbox.retryDelayMs,
  });
  return {
    bindings: createDiscordBindingHandlers(binding),
    routes: createDiscordRouteHandlers({ resolver, serviceToken: deps.serviceToken }),
    inbox: createDiscordInboxHandlers({ service: inbox, serviceToken: deps.serviceToken }),
  };
}
