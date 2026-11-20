import { z } from 'zod';
import {
  getTenantId,
  runAsSystem,
  tenantStorage,
  TransactionUnavailableError,
} from '@librechat/data-schemas';
import {
  tenantIdSchema,
  sharedSlackRouteLookupSchema,
  channelGatewayWirePolicySchema,
  CHANNEL_GATEWAY_POLICY_VERSION,
} from 'librechat-data-provider';
import type {
  SlackWorkspaceStorage,
  SlackDispatchStorage,
  SlackRouteStorage,
  AgentChannelMethods,
} from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import type { SharedSlackRoute } from 'librechat-data-provider';
import type { createSlackWorkspaceSettingsReader } from './workspaceRuntime';
import type { SlackWorkspaceFetch } from './workspaces';
import { decryptCredential } from '~/crypto/credentials';
import { acceptsChannelServiceToken } from './service';
import { getSafeErrorMetadata } from '~/utils/errors';
import { readSlackJSON } from './workspaces';

const installation = sharedSlackRouteLookupSchema.shape;
const scopeInput = z.object({ tenantId: tenantIdSchema, appId: installation.appId });
const routeInput = sharedSlackRouteLookupSchema.safeExtend({ tenantId: tenantIdSchema });
const lifecycleInput = z
  .object({ tenantId: tenantIdSchema, appId: installation.appId, teamId: installation.teamId })
  .strict();
const credentialStatus = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  team_id: z.string().optional(),
  user_id: z.string().optional(),
});
const invalidCredentials = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
]);

/** Trusted gateway operations resolve a signed Slack installation before entering its tenant. */
export function createSlackDispatchHandlers(deps: {
  readSettings: ReturnType<typeof createSlackWorkspaceSettingsReader>;
  workspaces: SlackWorkspaceStorage;
  dispatch: SlackDispatchStorage;
  routes: SlackRouteStorage;
  channels: AgentChannelMethods;
  serviceToken: () => string | undefined;
  fetch: SlackWorkspaceFetch;
  logError: (metadata: ReturnType<typeof getSafeErrorMetadata>) => void;
}): {
  bootstrap: RequestHandler;
  app: RequestHandler;
  resolve: RequestHandler;
  discover: RequestHandler;
  lifecycle: RequestHandler;
} {
  type Settings = Awaited<ReturnType<typeof deps.readSettings>>;
  type AppSettings = Settings & { app: NonNullable<Settings['app']> };
  let readiness: Promise<void> | undefined;
  const prepare = () => {
    readiness ??= runAsSystem(() => deps.dispatch.ready()).catch((error) => {
      readiness = undefined;
      throw error;
    });
    return readiness;
  };
  const protect =
    (action: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken())) {
        res.status(401).json({ error: 'invalid_service_auth' });
        return;
      }
      try {
        await action(req, res);
      } catch (error) {
        deps.logError(getSafeErrorMetadata(error));
        res.status(503).json({
          error:
            error instanceof TransactionUnavailableError
              ? error.code
              : 'slack_dispatch_unavailable',
        });
      }
    };
  const enabled = (settings: Settings) =>
    settings.channels.enabled &&
    settings.channels.transport === 'webhook' &&
    settings.channels.slackApp?.enabled;
  const global = (action: (req: Request, res: Response, settings: Settings) => Promise<void>) =>
    protect(async (req, res) => {
      const settings = await deps.readSettings();
      if (!enabled(settings)) {
        res.sendStatus(404);
        return;
      }
      await action(req, res, settings);
    });
  const organization = (
    action: (req: Request, res: Response, settings: AppSettings) => Promise<void>,
  ) =>
    protect(async (req, res) => {
      const input = scopeInput.safeParse(req.body);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      await tenantStorage.run(
        { tenantId: input.data.tenantId === '_' ? undefined : input.data.tenantId },
        async () => {
          const settings = await deps.readSettings(input.data.appId);
          if (!enabled(settings) || !settings.app) {
            res.sendStatus(404);
            return;
          }
          await action(req, res, { ...settings, app: settings.app });
        },
      );
    });
  return {
    bootstrap: global(async (_req, res, { channels }) => {
      const workers = channels.slackApp?.gateway;
      if (!workers) {
        res.sendStatus(404);
        return;
      }
      await prepare();
      res.json({
        gateway: channelGatewayWirePolicySchema.parse({
          ...channels,
          version: CHANNEL_GATEWAY_POLICY_VERSION,
        }),
        workers: {
          ...workers,
          discoveryBatchSize: Math.min(workers.discoveryBatchSize, channels.maxMetadataPageSize),
        },
      });
    }),
    app: organization(async (_req, res, { app }) => {
      res.json({
        tenantId: getTenantId() || '_',
        appId: app.appId,
        signingSecret: app.signingSecret,
      });
    }),
    resolve: organization(async (req, res, { app }) => {
      const parsed = routeInput.safeParse(req.body);
      if (!parsed.success) {
        res.sendStatus(400);
        return;
      }
      const { appId, teamId, target } = parsed.data;
      if (appId !== app.appId) {
        res.sendStatus(404);
        return;
      }
      const workspace = await deps.workspaces.route(appId, teamId);
      if (!workspace || (workspace.tenantId || '_') !== parsed.data.tenantId) {
        res.sendStatus(404);
        return;
      }
      await tenantStorage.run({ tenantId: workspace.tenantId }, async () => {
        let channelId: string | null;
        let retiredThread = false;
        if (target.kind === 'thread') {
          channelId = await deps.dispatch.thread(
            workspace.workspaceId,
            target.actorId,
            target.externalThreadKey,
          );
          retiredThread = Boolean(channelId);
          if (!channelId)
            channelId =
              (await deps.routes.resolve(workspace.workspaceId, target.externalChannelId))
                ?.channelId ?? null;
        } else if (target.kind === 'run')
          channelId = await deps.dispatch.run(workspace.workspaceId, target.runId);
        else if (target.kind === 'link') channelId = await deps.dispatch.link(target.linkId);
        else
          channelId = await deps.dispatch.message(workspace.workspaceId, target.externalMessageKey);
        if (channelId) {
          const channel = await deps.channels.getAgentChannelMetadata(channelId);
          if (
            channel?.status === 'active' &&
            channel.workspaceId === workspace.workspaceId &&
            channel.credentialMode === 'per_user'
          ) {
            res.json({
              kind: 'bound',
              workspaceId: workspace.workspaceId,
              tenantId: workspace.tenantId || '_',
              channelId,
            } satisfies SharedSlackRoute);
            return;
          }
        }
        if (target.kind !== 'thread') {
          res.sendStatus(404);
          return;
        }
        const current = await deps.workspaces.read(workspace.workspaceId);
        if (current?.status !== 'active' || !current.encryptedBotToken) {
          res.sendStatus(404);
          return;
        }
        res.json({
          kind: retiredThread ? 'retired_thread' : 'unmapped',
          workspace,
          botToken: await decryptCredential(current.encryptedBotToken),
        } satisfies SharedSlackRoute);
      });
    }),
    discover: global(async (req, res, { channels }) => {
      const workers = channels.slackApp?.gateway;
      if (!workers) {
        res.sendStatus(404);
        return;
      }
      const input = z
        .object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(Math.min(workers.discoveryBatchSize, channels.maxMetadataPageSize)),
        })
        .strict()
        .safeParse(req.body);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      res.json(await runAsSystem(() => deps.dispatch.discover(input.data.limit, Date.now())));
    }),
    lifecycle: organization(async (req, res, { app }) => {
      const input = lifecycleInput.safeParse(req.body);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      if (input.data.appId !== app.appId) {
        res.sendStatus(404);
        return;
      }
      const workspace = await deps.workspaces.route(input.data.appId, input.data.teamId);
      if (!workspace || (workspace.tenantId || '_') !== input.data.tenantId) {
        res.sendStatus(204);
        return;
      }
      await tenantStorage.run({ tenantId: workspace.tenantId }, async () => {
        const current = await deps.workspaces.read(workspace.workspaceId);
        if (current?.status !== 'active' || !current.encryptedBotToken) return;
        const response = await deps.fetch('https://slack.com/api/auth.test', {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${await decryptCredential(current.encryptedBotToken)}`,
          },
          signal: AbortSignal.timeout(app.requestTimeoutMs),
        });
        if (!response.ok) throw new Error('Slack credential verification unavailable');
        const status = credentialStatus.parse(await readSlackJSON(response, app.maxResponseBytes));
        if (status.ok) {
          if (status.team_id !== current.teamId || status.user_id !== current.botUserId)
            throw new Error('Slack credential identity changed');
          return;
        }
        if (!status.error || !invalidCredentials.has(status.error))
          throw new Error('Slack credential verification unavailable');
        await deps.workspaces.disconnect(current.workspaceId, current.revision);
      });
      res.sendStatus(204);
    }),
  };
}
