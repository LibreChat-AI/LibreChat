import { z } from 'zod';
import { nanoid } from 'nanoid';
import { tenantIdSchema } from 'librechat-data-provider';
import { getTenantId, TransactionUnavailableError } from '@librechat/data-schemas';
import type {
  AgentChannelMethods,
  AgentChannelRecord,
  SlackWorkspaceStorage,
  SlackRouteStorage,
} from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import type { createSlackWorkspaceSettingsReader } from './workspaceRuntime';
import type { SlackWorkspacePrincipal } from './workspaces';
import { getSafeErrorMetadata } from '~/utils/errors';
import { publicChannel } from './service';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const externalChannelId = z
  .string()
  .regex(/^[CDG][A-Z0-9]+$/)
  .max(128);
const createInput = z.object({ workspaceId: id }).strict();
const routeInput = z
  .object({
    externalChannelId: externalChannelId.optional(),
    expectedRevision: id.optional(),
    channelRevision: id,
  })
  .strict();
const removeInput = z
  .object({ externalChannelId: externalChannelId.optional(), expectedRevision: id })
  .strict();
const queryInput = z.union([
  z.object({ target: z.union([z.literal('default'), externalChannelId]) }).strict(),
  z
    .object({
      cursor: z
        .string()
        .regex(/^[a-f\d]{24}$/i)
        .optional(),
    })
    .strict(),
]);

/** Agent SHARE middleware and creator ownership authorize bindings; installation management stays separate. */
export function createSlackWorkspaceBindingHandlers(deps: {
  channels: AgentChannelMethods;
  workspaces: SlackWorkspaceStorage;
  routes: SlackRouteStorage;
  canManage: (principal: SlackWorkspacePrincipal) => Promise<boolean>;
  isPrincipalActive: (id: string) => Promise<boolean>;
  getAgentName: (
    id: string,
    tenantId: string | undefined,
    viewer: { userId: string },
  ) => Promise<string | undefined>;
  readSettings: ReturnType<typeof createSlackWorkspaceSettingsReader>;
  logError: (metadata: ReturnType<typeof getSafeErrorMetadata>) => void;
}): {
  create: RequestHandler;
  read: RequestHandler;
  assign: RequestHandler;
  remove: RequestHandler;
} {
  type Settings = Awaited<ReturnType<typeof deps.readSettings>>;
  const protect =
    (
      action: (
        req: Request,
        res: Response,
        principal: SlackWorkspacePrincipal,
        settings: Settings,
      ) => Promise<void>,
    ): RequestHandler =>
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const parsed = z.object({ id, tenantId: tenantIdSchema.nullish() }).safeParse(req.user);
      if (!parsed.success) {
        res.sendStatus(401);
        return;
      }
      const principal = { id: parsed.data.id, tenantId: parsed.data.tenantId || undefined };
      if ((getTenantId() || undefined) !== principal.tenantId) {
        res.sendStatus(403);
        return;
      }
      try {
        if (!(await deps.isPrincipalActive(principal.id))) {
          res.sendStatus(403);
          return;
        }
        const settings = await deps.readSettings();
        if (
          !settings.channels.enabled ||
          settings.channels.transport !== 'webhook' ||
          !settings.channels.slackApp?.enabled
        ) {
          res.sendStatus(404);
          return;
        }
        await action(req, res, principal, settings);
      } catch (error) {
        deps.logError(getSafeErrorMetadata(error));
        res.status(503).json({
          error:
            error instanceof TransactionUnavailableError
              ? error.code
              : 'workspace_binding_unavailable',
        });
      }
    };
  async function owned(
    req: Request,
    principal: SlackWorkspacePrincipal,
  ): Promise<AgentChannelRecord | null> {
    if (!id.safeParse(req.params.channelId).success) return null;
    const channel = await deps.channels.getAgentChannelMetadata(req.params.channelId);
    return channel?.workspaceId &&
      channel.agentId === req.params.agentId &&
      channel.createdBy === principal.id &&
      channel.status !== 'deleting'
      ? channel
      : null;
  }
  return {
    create: protect(async (req, res, principal) => {
      const input = createInput.safeParse(req.body);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      const workspace = await deps.workspaces.metadata(input.data.workspaceId, principal.id);
      if (workspace?.status !== 'active' || !(await deps.readSettings(workspace.appId)).app) {
        res.sendStatus(404);
        return;
      }
      if (!workspace.canManageBot && !(await deps.canManage(principal))) {
        res.status(403).json({ error: 'bot_access_required' });
        return;
      }
      const channel = await deps.channels.createAgentChannel({
        channelId: nanoid(),
        workspaceId: workspace.workspaceId,
        agentId: req.params.agentId,
        createdBy: principal.id,
        type: 'slack',
        status: 'pending_install',
        credentialMode: 'per_user',
        revision: nanoid(),
      });
      res.status(201).json(publicChannel(channel));
    }),
    read: protect(async (req, res, principal, { channels }) => {
      const channel = await owned(req, principal);
      if (!channel?.workspaceId) {
        res.sendStatus(404);
        return;
      }
      const input = queryInput.safeParse(req.query);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      if ('target' in input.data) {
        const route = await deps.routes.read(
          channel.workspaceId,
          input.data.target === 'default' ? undefined : input.data.target,
        );
        const previous =
          route && route.channelId !== channel.channelId
            ? await deps.channels.getAgentChannelMetadata(route.channelId)
            : null;
        const [canReplace, assignedAgentName] = await Promise.all([
          deps.workspaces
            .metadata(channel.workspaceId, principal.id)
            .then(
              async (workspace) =>
                workspace?.canManageBot === true || (await deps.canManage(principal)),
            ),
          previous
            ? deps.getAgentName(previous.agentId, principal.tenantId, { userId: principal.id })
            : undefined,
        ]);
        res.json({
          canReplace,
          assignedAgentName,
          occupied: Boolean(route),
          assignedToThisChannel: route?.channelId === channel.channelId,
          revision: route?.revision,
        });
      } else {
        res.json(
          await deps.routes.listForChannel(
            channel.channelId,
            input.data.cursor,
            channels.maxMetadataPageSize,
          ),
        );
      }
    }),
    assign: protect(async (req, res, principal) => {
      const channel = await owned(req, principal);
      if (!channel?.workspaceId) {
        res.sendStatus(404);
        return;
      }
      const input = routeInput.safeParse(req.body);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      if (input.data.channelRevision !== channel.revision) {
        res.status(409).json({ error: 'channel_changed' });
        return;
      }
      const [workspace, isBotAdmin] = await Promise.all([
        deps.workspaces.metadata(channel.workspaceId, principal.id),
        deps.canManage(principal),
      ]);
      if (workspace?.status !== 'active' || !(await deps.readSettings(workspace.appId)).app) {
        res.status(409).json({ error: 'workspace_unavailable' });
        return;
      }
      if (!workspace.canManageBot && !isBotAdmin) {
        res.status(403).json({ error: 'bot_access_required' });
        return;
      }
      const result = await deps.routes.assign({
        userId: principal.id,
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        channelRevision: input.data.channelRevision,
        externalChannelId: input.data.externalChannelId,
        expectedRevision: input.data.expectedRevision,
        isBotAdmin,
        activate: channel.status !== 'active',
      });
      if (!result.ok) {
        res.status(409).json({ error: result.code });
        return;
      }
      const active = await deps.channels.getAgentChannelMetadata(channel.channelId);
      if (!active) {
        res.sendStatus(404);
        return;
      }
      res.json(publicChannel(active));
    }),
    remove: protect(async (req, res, principal) => {
      const channel = await owned(req, principal);
      if (!channel?.workspaceId) {
        res.sendStatus(404);
        return;
      }
      const input = removeInput.safeParse(req.body);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      const result = await deps.routes.remove({
        userId: principal.id,
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        ...input.data,
      });
      if (!result.ok) res.status(409).json({ error: result.code });
      else res.sendStatus(204);
    }),
  };
}
