import { z } from 'zod';
import { getTenantId, tenantStorage, TransactionUnavailableError } from '@librechat/data-schemas';
import type { SlackWorkspaceStorage } from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import type { SlackWorkspaceService, SlackWorkspacePrincipal } from './workspaces';
import { setOAuthCsrfCookie, validateOAuthCsrf, validateOAuthSession } from '~/oauth/csrf';
import { SLACK_WORKSPACE_CALLBACK_PATH, slackPublicURL } from './workspaces';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getOAuthCallbackUrl } from '~/oauth/url';

const principalSchema = z.object({ id: z.string().min(1), tenantId: z.string().nullish() });
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const appId = z
  .string()
  .regex(/^A[A-Z0-9]+$/)
  .max(256);
const configureBody = z
  .object({
    appId,
    clientId: z
      .string()
      .regex(/^\d+\.\d+$/)
      .max(512),
    clientSecret: z.string().trim().min(1).max(512),
    signingSecret: z.string().trim().min(1).max(512),
    expectedRevision: identifier.optional(),
  })
  .strict();
const connectBody = z
  .object({ workspaceId: identifier.optional(), appId: appId.optional() })
  .strict();
const pageQuery = z.object({ cursor: identifier.optional() }).strict();

export interface SlackWorkspaceHandlers {
  apps: RequestHandler;
  configureApp: RequestHandler;
  removeApp: RequestHandler;
  list: RequestHandler;
  get: RequestHandler;
  connect: RequestHandler;
  disconnect: RequestHandler;
  cancel: RequestHandler;
  callback: RequestHandler;
}

/** Browser routes additionally require JWT auth and same-origin protection on writes. */
export function createSlackWorkspaceHandlers(deps: {
  service: SlackWorkspaceService;
  storage: SlackWorkspaceStorage;
  settings: () => Promise<{
    configured: boolean;
    pageSize: number;
    setup?: { redirectUri: string; eventsBaseUrl: string; interactionsBaseUrl: string };
  }>;
  canManage: (principal: SlackWorkspacePrincipal) => Promise<boolean>;
  clientBaseUrl: string;
  logError: (metadata: ReturnType<typeof getSafeErrorMetadata>) => void;
}): SlackWorkspaceHandlers {
  const browser =
    (
      action: (req: Request, res: Response, principal: SlackWorkspacePrincipal) => Promise<void>,
    ): RequestHandler =>
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const user = principalSchema.safeParse(req.user);
      if (!user.success) {
        res.status(401).json({ ok: false, error: { code: 'forbidden' } });
        return;
      }
      const principal = { id: user.data.id, tenantId: user.data.tenantId || undefined };
      if ((getTenantId() || undefined) !== principal.tenantId) {
        res.status(403).json({ ok: false, error: { code: 'forbidden' } });
        return;
      }
      try {
        await action(req, res, principal);
      } catch (error) {
        deps.logError(getSafeErrorMetadata(error));
        res.status(503).json({
          ok: false,
          error: {
            code: error instanceof TransactionUnavailableError ? error.code : 'unavailable',
          },
        });
      }
    };

  return {
    apps: browser(async (req, res, principal) => {
      const page = pageQuery.safeParse(req.query);
      if (!page.success) {
        res.sendStatus(400);
        return;
      }
      const [settings, canManage] = await Promise.all([deps.settings(), deps.canManage(principal)]);
      const apps = canManage
        ? await deps.storage.apps(page.data.cursor, settings.pageSize)
        : { apps: [] };
      res.json({ configured: settings.configured, canManage, setup: settings.setup, ...apps });
    }),
    configureApp: browser(async (req, res, principal) => {
      const input = configureBody.safeParse(req.body);
      if (!input.success) {
        res.status(400).json({ ok: false, error: { code: 'invalid_install' } });
        return;
      }
      if (!(await deps.settings()).configured) {
        res.sendStatus(404);
        return;
      }
      const result = await deps.service.configureApp(principal, input.data);
      if (!result.ok) res.status(result.error.code === 'forbidden' ? 403 : 409).json(result);
      else res.json(result.value);
    }),
    removeApp: browser(async (req, res, principal) => {
      const body = z.object({ revision: identifier }).strict().safeParse(req.body);
      const parsed = z.object({ appId, revision: identifier }).safeParse({
        appId: req.params.appId,
        revision: body.success ? body.data.revision : undefined,
      });
      if (!parsed.success) {
        res.sendStatus(400);
        return;
      }
      const result = await deps.service.removeApp(
        principal,
        parsed.data.appId,
        parsed.data.revision,
      );
      if (!result.ok) res.status(result.error.code === 'forbidden' ? 403 : 409).json(result);
      else res.sendStatus(204);
    }),
    get: browser(async (req, res, principal) => {
      const id = identifier.safeParse(req.params.workspaceId);
      if (!id.success) {
        res.sendStatus(400);
        return;
      }
      const [workspace, settings, canManage] = await Promise.all([
        deps.storage.metadata(id.data),
        deps.settings(),
        deps.canManage(principal),
      ]);
      if (!workspace) {
        res.sendStatus(404);
        return;
      }
      res.json({ configured: settings.configured, canManage, workspace });
    }),
    list: browser(async (req, res, principal) => {
      const page = pageQuery.safeParse(req.query);
      if (!page.success) {
        res.status(400).json({ ok: false, error: { code: 'invalid_page' } });
        return;
      }
      const settings = await deps.settings();
      const [workspaces, canManage] = await Promise.all([
        deps.storage.list(page.data.cursor, settings.pageSize),
        deps.canManage(principal),
      ]);
      res.json({
        configured: settings.configured,
        canManage,
        ...workspaces,
      });
    }),
    connect: browser(async (req, res, principal) => {
      const body = connectBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ ok: false, error: { code: 'invalid_install' } });
        return;
      }
      const result = await deps.service.start(principal, body.data.workspaceId, body.data.appId);
      if (!result.ok) {
        res.status(result.error.code === 'forbidden' ? 403 : 409).json(result);
        return;
      }
      setOAuthCsrfCookie(
        res,
        result.value.flowId,
        SLACK_WORKSPACE_CALLBACK_PATH,
        result.value.expiresInSeconds * 1000,
      );
      res.json(result.value);
    }),
    disconnect: browser(async (req, res, principal) => {
      const id = identifier.safeParse(req.params.workspaceId);
      if (!id.success) {
        res.status(400).json({ ok: false, error: { code: 'workspace_changed' } });
        return;
      }
      const result = await deps.service.disconnect(principal, id.data);
      if (!result.ok) res.status(403).json(result);
      else if (!result.value) res.sendStatus(404);
      else res.sendStatus(204);
    }),
    cancel: browser(async (req, res, principal) => {
      if (!/^[a-f0-9]{64}$/.test(req.params.flowId)) {
        res.status(400).json({ ok: false, error: { code: 'invalid_install' } });
        return;
      }
      const result = await deps.service.cancel(principal, req.params.flowId);
      if (!result.ok) res.status(403).json(result);
      else res.sendStatus(204);
    }),
    callback: (async (req, res) => {
      res.set('Cache-Control', 'no-store');
      let flowId: string | undefined;
      const landing = (path: string, params: Record<string, string | undefined>) => {
        const url = slackPublicURL(getOAuthCallbackUrl(deps.clientBaseUrl, path));
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) url.searchParams.set(key, value);
        }
        return url.toString();
      };
      const fail = (code = 'callback_failed') => {
        try {
          res.redirect(landing('/oauth/error', { error: code, flow: flowId }));
        } catch (error) {
          deps.logError(getSafeErrorMetadata(error));
          res.status(503).json({ ok: false, error: { code: 'unavailable' } });
        }
      };
      try {
        if (typeof req.query.state !== 'string') {
          fail('invalid_state');
          return;
        }
        const flow = await deps.service.flow(req.query.state);
        if (!flow) {
          fail('invalid_state');
          return;
        }
        const current = getTenantId();
        if (current && current !== flow.tenantId) {
          fail('invalid_state');
          return;
        }
        const bound =
          validateOAuthCsrf(req, res, flow.stateHash, SLACK_WORKSPACE_CALLBACK_PATH) ||
          validateOAuthSession(req, flow.userId);
        if (!bound) {
          fail('invalid_state');
          return;
        }
        const claimed = await tenantStorage.run({ tenantId: flow.tenantId }, () =>
          deps.service.claim(flow),
        );
        if (!claimed) {
          fail('invalid_state');
          return;
        }
        flowId = claimed.stateHash;
        const code = req.query.code;
        const result = await tenantStorage.run({ tenantId: flow.tenantId }, async () => {
          try {
            if (req.query.error || typeof code !== 'string')
              return { ok: false, error: { code: 'slack_refused' } } as const;
            return await deps.service.finish(claimed, code);
          } finally {
            await deps.service.retire(claimed);
          }
        });
        if (!result.ok) {
          fail(`slack_${result.error.code}`);
          return;
        }
        res.redirect(landing('/oauth/success', { serverName: 'Slack', flow: flowId }));
      } catch (error) {
        deps.logError(getSafeErrorMetadata(error));
        fail(
          error instanceof TransactionUnavailableError
            ? 'slack_transactions_unavailable'
            : undefined,
        );
      }
    }) as RequestHandler,
  };
}
