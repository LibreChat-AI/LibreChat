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

/** Agent SHARE middleware and fresh tenant administration jointly authorize shared bot routing. */
export function createSlackWorkspaceBindingHandlers(deps: {
  channels: AgentChannelMethods;
  workspaces: SlackWorkspaceStorage;
  routes: SlackRouteStorage;
  canManage: (principal: SlackWorkspacePrincipal) => Promise<boolean>;
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
        if (!(await deps.canManage(principal))) {
          res.sendStatus(403);
          return;
        }
        const settings = await deps.readSettings();
        if (!settings.app) {
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
    create: protect(async (req, res, principal, { app }) => {
      const input = createInput.safeParse(req.body);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      const workspace = await deps.workspaces.read(input.data.workspaceId);
      if (workspace?.status !== 'active' || workspace.appId !== app?.appId) {
        res.sendStatus(404);
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
        res.json({
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
    assign: protect(async (req, res, principal, { app }) => {
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
      const workspace = await deps.workspaces.metadata(channel.workspaceId);
      if (workspace?.status !== 'active' || workspace.appId !== app?.appId) {
        res.status(409).json({ error: 'workspace_unavailable' });
        return;
      }
      const result = await deps.routes.assign({
        userId: principal.id,
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        channelRevision: input.data.channelRevision,
        externalChannelId: input.data.externalChannelId,
        expectedRevision: input.data.expectedRevision,
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
