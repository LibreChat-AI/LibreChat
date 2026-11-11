import { SystemCapabilities } from '@librechat/data-schemas';
import { channelConfigSchema } from 'librechat-data-provider';
import type { AppConfig, SlackWorkspaceStorage } from '@librechat/data-schemas';
import type { ChannelConfig } from 'librechat-data-provider';
import type { SlackWorkspacePrincipal, SlackWorkspaceFetch } from './workspaces';
import type { SlackWorkspaceHandlers } from './workspaceHttp';
import type { GetAppConfigOptions } from '~/app/service';
import type { SlackWorkspaceApp } from './workspaces';
import {
  createSlackWorkspaceService,
  resolveSlackWorkspaceApp,
  slackPublicURL,
  SLACK_WORKSPACE_CALLBACK_PATH,
} from './workspaces';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createSlackWorkspaceHandlers } from './workspaceHttp';
import { capabilityStore } from '~/middleware/capabilities';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getOAuthCallbackUrl } from '~/oauth/url';

interface WorkspaceAdmin {
  role?: string | null;
  tenantId?: string | null;
  idOnTheSource?: string | null;
}

export function createSlackWorkspaceSettingsReader(deps: {
  storage: SlackWorkspaceStorage;
  readAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
  publicBaseUrl: string;
  clientBaseUrl: string;
}): (appId?: string) => Promise<{ channels: ChannelConfig; app: SlackWorkspaceApp | undefined }> {
  const redirectUri = getOAuthCallbackUrl(deps.publicBaseUrl, SLACK_WORKSPACE_CALLBACK_PATH);
  return async (appId?: string) => {
    const config = await deps.readAppConfig({ baseOnly: true, failClosed: true });
    const channels = channelConfigSchema.parse(config.endpoints?.agents?.channels ?? {});
    let app: SlackWorkspaceApp | undefined;
    if (appId && channels.enabled && channels.slackApp?.enabled) {
      const registration = await deps.storage.app(appId);
      if (
        registration?.clientId &&
        registration.encryptedClientSecret &&
        registration.encryptedSigningSecret
      ) {
        const [clientSecret, signingSecret] = await Promise.all([
          decryptCredential(registration.encryptedClientSecret),
          decryptCredential(registration.encryptedSigningSecret),
        ]);
        app = resolveSlackWorkspaceApp(channels, redirectUri, {
          appId,
          clientId: registration.clientId,
          clientSecret,
          signingSecret,
        });
      }
    }
    if (app) slackPublicURL(deps.clientBaseUrl);
    return { channels, app };
  };
}

export interface SlackWorkspaceAdminDependencies {
  findUser: (id: string) => Promise<WorkspaceAdmin | null>;
  isPrincipalActive: (id: string) => Promise<boolean>;
  hasCapability: (
    user: { id: string; role: string; tenantId?: string; idOnTheSource: string | null },
    capability: typeof SystemCapabilities.ACCESS_ADMIN | typeof SystemCapabilities.MANAGE_AGENTS,
  ) => Promise<boolean>;
}

export function createSlackWorkspaceAdminGuard(
  deps: SlackWorkspaceAdminDependencies,
): (principal: SlackWorkspacePrincipal) => Promise<boolean> {
  return async (principal: SlackWorkspacePrincipal) => {
    const [user, active] = await Promise.all([
      deps.findUser(principal.id),
      deps.isPrincipalActive(principal.id),
    ]);
    if (!user || !active || (user.tenantId || undefined) !== principal.tenantId) return false;
    const subject = {
      id: principal.id,
      role: user.role || '',
      tenantId: principal.tenantId,
      idOnTheSource: user.idOnTheSource ?? null,
    };
    const permissions = await capabilityStore.run(
      { principals: new Map(), results: new Map() },
      () =>
        Promise.all([
          deps.hasCapability(subject, SystemCapabilities.ACCESS_ADMIN),
          deps.hasCapability(subject, SystemCapabilities.MANAGE_AGENTS),
        ]),
    );
    return permissions.every(Boolean);
  };
}

export function createSlackWorkspaceRuntime(
  deps: SlackWorkspaceAdminDependencies & {
    storage: SlackWorkspaceStorage;
    readAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
    publicBaseUrl: string;
    clientBaseUrl: string;
    fetch: SlackWorkspaceFetch;
    logError: (metadata: ReturnType<typeof getSafeErrorMetadata>) => void;
  },
): SlackWorkspaceHandlers {
  const readSettings = createSlackWorkspaceSettingsReader(deps);
  const config = async (appId?: string) => (await readSettings(appId)).app;
  const canManage = createSlackWorkspaceAdminGuard(deps);
  const service = createSlackWorkspaceService({
    ...deps,
    config,
    canManage,
    encrypt: encryptCredential,
  });
  return createSlackWorkspaceHandlers({
    ...deps,
    service,
    canManage,
    settings: async () => {
      const { channels } = await readSettings();
      return {
        configured:
          channels.enabled &&
          channels.transport === 'webhook' &&
          channels.slackApp?.enabled === true,
        setup: {
          redirectUri: getOAuthCallbackUrl(deps.publicBaseUrl, SLACK_WORKSPACE_CALLBACK_PATH),
          eventsBaseUrl: getOAuthCallbackUrl(
            channels.gatewayUrl || deps.publicBaseUrl,
            '/slack/events',
          ),
          interactionsBaseUrl: getOAuthCallbackUrl(
            channels.gatewayUrl || deps.publicBaseUrl,
            '/slack/interactions',
          ),
        },
        pageSize: channels.maxMetadataPageSize,
        maxBotManagers: channels.maxBotManagers,
      };
    },
  });
}
