import { z } from 'zod';
import { discordChannelConfigSchema } from 'librechat-data-provider';
import type {
  AppConfig,
  DiscordBrowserSessionStorage,
  DiscordInstallationStorage,
  DiscordInstallStorage,
} from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { SlackWorkspaceAdminDependencies } from '../workspaceRuntime';
import type { GetAppConfigOptions } from '~/app/service';
import type { DiscordManagementHandlers } from './http';
import type { SafeErrorMetadata } from '~/utils/errors';
import {
  createDiscordManagementHandlers,
  clearDiscordOAuthCookies,
  DISCORD_CALLBACK_PATH,
} from './http';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createSlackWorkspaceAdminGuard } from '../workspaceRuntime';
import { createDiscordManagementService } from './service';
import { createDiscordProviderClient } from './client';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getOAuthCallbackUrl } from '~/oauth/url';
import { slackPublicURL } from '../workspaces';

/** Pick of the operator's Discord policy; shared schema defaults are applied by getAppConfig. */
export interface DiscordHttpConfig {
  enabled: boolean;
  publicUrl?: string;
  flowLifetimeMs: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  botPermissions: string;
}
const policySchema = z.object({
  enabled: z.boolean(),
  publicUrl: discordChannelConfigSchema.shape.publicUrl,
  flowLifetimeMs: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive(),
  botPermissions: z.string().min(1),
});

export function createDiscordManagementSettingsReader(deps: {
  readAppConfig: (options?: GetAppConfigOptions) => Promise<Pick<AppConfig, 'endpoints'>>;
}): () => Promise<DiscordHttpConfig | undefined> {
  return async () => {
    const config = await deps.readAppConfig({ baseOnly: true, failClosed: true });
    const channels = z
      .object({ enabled: z.boolean().optional(), discord: z.unknown().optional() })
      .parse(config.endpoints?.agents?.channels ?? {});
    const discord = discordChannelConfigSchema.parse(channels.discord ?? {});
    return policySchema.parse({
      ...discord,
      enabled: channels.enabled === true && discord.enabled,
    });
  };
}

export function createDiscordManagementRuntime(
  deps: SlackWorkspaceAdminDependencies & {
    installations: DiscordInstallationStorage;
    states: DiscordInstallStorage;
    browserSessions: DiscordBrowserSessionStorage;
    readSettings: () => Promise<DiscordHttpConfig | undefined>;
    sessionSecret: string;
    publicBaseUrl?: string;
    clientBaseUrl?: string;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    logError: (metadata: SafeErrorMetadata) => void;
  },
): DiscordManagementHandlers {
  const publicBaseUrl = deps.publicBaseUrl || 'http://localhost:3080';
  const clientBaseUrl = deps.clientBaseUrl || publicBaseUrl;
  slackPublicURL(publicBaseUrl);
  slackPublicURL(clientBaseUrl);
  const canManage = createSlackWorkspaceAdminGuard(deps);
  const handle =
    (method: keyof DiscordManagementHandlers): RequestHandler =>
    async (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      try {
        const config = (await deps.readSettings()) ?? discordChannelConfigSchema.parse({});
        const cleanup = ['applications', 'guilds', 'cancel', 'disconnect'].includes(method);
        if (!config.enabled && !cleanup) {
          if (method === 'callback') {
            clearDiscordOAuthCookies(res, publicBaseUrl);
            res.redirect(
              getOAuthCallbackUrl(clientBaseUrl, '/oauth/error?error=discord_not_configured'),
            );
          } else res.sendStatus(404);
          return;
        }
        const provider = createDiscordProviderClient({
          fetch: deps.fetch,
          config: {
            ...config,
            redirectUri: getOAuthCallbackUrl(publicBaseUrl, DISCORD_CALLBACK_PATH),
          },
        });
        const service = createDiscordManagementService({
          ...deps,
          provider,
          canManage,
          encrypt: encryptCredential,
          decrypt: decryptCredential,
          settings: async () => {
            const current = await deps.readSettings();
            return {
              enabled: current?.enabled === true,
              flowLifetimeMs: current?.flowLifetimeMs ?? config.flowLifetimeMs,
            };
          },
        });
        const handlers = createDiscordManagementHandlers({
          ...deps,
          service,
          publicBaseUrl,
          clientBaseUrl,
          interactionBaseUrl: config.publicUrl
            ? getOAuthCallbackUrl(config.publicUrl, '/discord/')
            : undefined,
        });
        await handlers[method](req, res, next);
      } catch (error) {
        deps.logError(getSafeErrorMetadata(error));
        if (method === 'callback') {
          clearDiscordOAuthCookies(res, publicBaseUrl);
          res.redirect(
            getOAuthCallbackUrl(clientBaseUrl, '/oauth/error?error=discord_unavailable'),
          );
        } else res.status(503).json({ ok: false, error: { code: 'unavailable' } });
      }
    };
  return {
    applications: handle('applications'),
    configure: handle('configure'),
    register: handle('register'),
    guilds: handle('guilds'),
    connect: handle('connect'),
    cancel: handle('cancel'),
    disconnect: handle('disconnect'),
    callback: handle('callback'),
  };
}
