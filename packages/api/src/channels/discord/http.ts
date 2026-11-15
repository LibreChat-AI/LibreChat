import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getTenantId, tenantStorage } from '@librechat/data-schemas';
import {
  channelSnowflakeSchema,
  configureDiscordApplicationSchema,
  tenantIdSchema,
} from 'librechat-data-provider';
import type { DiscordBrowserSessionStorage } from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import type { DiscordManagementService, DiscordManagementPrincipal } from './service';
import type { SafeErrorMetadata } from '~/utils/errors';
import {
  setOAuthCsrfCookie,
  validateOAuthCsrf,
  validateOAuthSession,
  shouldUseSecureCookie,
  REFRESH_TOKEN_COOKIE,
  OAUTH_CSRF_COOKIE,
} from '~/oauth/csrf';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getOAuthCallbackUrl } from '~/oauth/url';
import { slackPublicURL } from '../workspaces';

export const DISCORD_MANAGEMENT_PATH = '/api/channels/discord';
export const DISCORD_CALLBACK_PATH: string = `${DISCORD_MANAGEMENT_PATH}/oauth/callback`;
export const DISCORD_FLOW_COOKIE = 'discord_oauth';
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const flowId = z.string().regex(/^[a-f\d]{64}$/);
const principalSchema = z.object({ id: z.string().min(1), tenantId: tenantIdSchema.nullish() });
const claimsSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
  sessionId: z.string().regex(/^[a-f\d]{24}$/i),
  tenantId: tenantIdSchema.optional(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  flowId,
});
const pageSchema = z.object({ cursor: identifier.optional() }).strict();
const callbackSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().max(2048).optional(),
  error: z.string().max(256).optional(),
  iss: z.string().max(256).optional(),
});
const issuer = 'librechat:discord:oauth';
const audience = 'discord-installation';

/** Cookie paths follow the public proxy prefix, with secure behavior shared with existing OAuth cookies. */
export function clearDiscordOAuthCookies(res: Response, publicBaseUrl: string): void {
  res.clearCookie(DISCORD_FLOW_COOKIE, {
    path: new URL(getOAuthCallbackUrl(publicBaseUrl, DISCORD_MANAGEMENT_PATH)).pathname,
  });
  res.clearCookie(OAUTH_CSRF_COOKIE, {
    path: new URL(getOAuthCallbackUrl(publicBaseUrl, DISCORD_CALLBACK_PATH)).pathname,
  });
}

export interface DiscordManagementHandlers {
  applications: RequestHandler;
  configure: RequestHandler;
  guilds: RequestHandler;
  connect: RequestHandler;
  cancel: RequestHandler;
  disconnect: RequestHandler;
  callback: RequestHandler;
}

/** JWT and same-origin middleware own browser authentication; callbacks restore only verified cookie scope. */
export function createDiscordManagementHandlers(deps: {
  service: DiscordManagementService;
  browserSessions: DiscordBrowserSessionStorage;
  sessionSecret: string;
  publicBaseUrl: string;
  clientBaseUrl: string;
  logError: (metadata: SafeErrorMetadata) => void;
}): DiscordManagementHandlers {
  if (!deps.sessionSecret) throw new TypeError('Discord OAuth requires a session signing secret');
  const cookiePath = new URL(getOAuthCallbackUrl(deps.publicBaseUrl, DISCORD_MANAGEMENT_PATH))
    .pathname;
  slackPublicURL(deps.publicBaseUrl);
  slackPublicURL(deps.clientBaseUrl);
  function claims(req: Request): z.infer<typeof claimsSchema> | null {
    const token = req.cookies?.[DISCORD_FLOW_COOKIE];
    if (typeof token !== 'string') return null;
    try {
      const decoded = jwt.verify(token, deps.sessionSecret, {
        algorithms: ['HS256'],
        issuer,
        audience,
      });
      const parsed = claimsSchema.safeParse(decoded);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  function clear(res: Response): void {
    clearDiscordOAuthCookies(res, deps.publicBaseUrl);
  }
  function send<T>(
    res: Response,
    result: { ok: true; value: T } | { ok: false; error: { code: string } },
    success = 200,
  ): void {
    if (result.ok) {
      res.status(success).json(result.value);
      return;
    }
    const code = result.error.code;
    const statuses: Readonly<Record<string, number>> = {
      forbidden: 403,
      not_configured: 404,
      invalid_input: 400,
      invalid_state: 400,
      unavailable: 503,
      provider_unavailable: 503,
      timeout: 503,
      rate_limited: 429,
    };
    const status = statuses[code] ?? 409;
    res.status(status).json(result);
  }
  const browser =
    (
      action: (req: Request, res: Response, principal: DiscordManagementPrincipal) => Promise<void>,
    ): RequestHandler =>
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const parsed = principalSchema.safeParse(req.user);
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
        await action(req, res, principal);
      } catch (error) {
        deps.logError(getSafeErrorMetadata(error));
        res.status(503).json({ ok: false, error: { code: 'unavailable' } });
      }
    };
  return {
    applications: browser(async (req, res, principal) => {
      const query = pageSchema.safeParse(req.query);
      if (!query.success) {
        res.sendStatus(400);
        return;
      }
      const result = await deps.service.applications(principal, query.data.cursor);
      if (!result.ok) {
        send(res, result);
        return;
      }
      send(res, {
        ok: true,
        value: {
          ...result.value,
          setup: {
            oauthCallbackUrl: getOAuthCallbackUrl(deps.publicBaseUrl, DISCORD_CALLBACK_PATH),
          },
        },
      });
    }),
    configure: browser(async (req, res, principal) => {
      const input = configureDiscordApplicationSchema.safeParse(req.body);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      send(res, await deps.service.configure(principal, input.data));
    }),
    guilds: browser(async (req, res, principal) => {
      const query = pageSchema.safeParse(req.query);
      if (!query.success) {
        res.sendStatus(400);
        return;
      }
      send(res, await deps.service.guilds(principal, query.data.cursor));
    }),
    connect: browser(async (req, res, principal) => {
      const input = z
        .object({ applicationId: channelSnowflakeSchema, installationId: identifier.optional() })
        .strict()
        .safeParse(req.body);
      if (!input.success) {
        res.sendStatus(400);
        return;
      }
      const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
      if (typeof refreshToken !== 'string' || !refreshToken) {
        res.sendStatus(401);
        return;
      }
      const session = await deps.browserSessions.read({ userId: principal.id, refreshToken });
      if (!session) {
        res.sendStatus(401);
        return;
      }
      const nonce = randomBytes(32).toString('base64url');
      const result = await deps.service.start(principal, input.data, nonce);
      if (!result.ok) {
        send(res, result);
        return;
      }
      const lifetimeMs = Math.min(
        result.value.expiresInSeconds * 1000,
        session.expiresAtMs - Date.now(),
      );
      if (lifetimeMs <= 0) {
        res.sendStatus(401);
        return;
      }
      const token = jwt.sign(
        {
          userId: principal.id,
          tenantId: principal.tenantId,
          sessionId: session.sessionId,
          nonce,
          flowId: result.value.flowId,
        },
        deps.sessionSecret,
        { algorithm: 'HS256', issuer, audience, expiresIn: Math.ceil(lifetimeMs / 1000) },
      );
      res.cookie(DISCORD_FLOW_COOKIE, token, {
        httpOnly: true,
        secure: shouldUseSecureCookie(),
        sameSite: 'lax',
        maxAge: lifetimeMs,
        path: cookiePath,
      });
      setOAuthCsrfCookie(res, result.value.flowId, DISCORD_CALLBACK_PATH, lifetimeMs);
      send(res, result);
    }),
    cancel: browser(async (req, res, principal) => {
      const parsed = flowId.safeParse(req.params.flowId);
      const current = claims(req);
      if (
        !parsed.success ||
        !current ||
        current.userId !== principal.id ||
        current.tenantId !== principal.tenantId ||
        current.flowId !== parsed.data
      ) {
        res.sendStatus(400);
        return;
      }
      const result = await deps.service.cancel(principal, parsed.data, current.nonce);
      clear(res);
      send(res, result);
    }),
    disconnect: browser(async (req, res, principal) => {
      const id = identifier.safeParse(req.params.installationId);
      const input = z.object({ revision: identifier }).strict().safeParse(req.body);
      if (!id.success || !input.success) {
        res.sendStatus(400);
        return;
      }
      send(res, await deps.service.disconnect(principal, id.data, input.data.revision));
    }),
    callback: (async (req, res) => {
      res.set('Cache-Control', 'no-store');
      let flow: string | undefined;
      const landing = (success: boolean, code?: string) => {
        const url = slackPublicURL(
          getOAuthCallbackUrl(deps.clientBaseUrl, success ? '/oauth/success' : '/oauth/error'),
        );
        if (success) url.searchParams.set('serverName', 'Discord');
        if (code) url.searchParams.set('error', `discord_${code}`);
        if (flow) url.searchParams.set('flow', flow);
        return url.toString();
      };
      const fail = (code: string) => {
        clear(res);
        res.redirect(landing(false, code));
      };
      try {
        const input = callbackSchema.safeParse(req.query);
        const current = claims(req);
        if (!input.success || !current) {
          fail('invalid_state');
          return;
        }
        flow = current.flowId;
        const tenantId = getTenantId() || undefined;
        const authenticated = principalSchema.safeParse(req.user);
        if (
          (tenantId && tenantId !== current.tenantId) ||
          (authenticated.success &&
            (authenticated.data.id !== current.userId ||
              (authenticated.data.tenantId || undefined) !== current.tenantId))
        ) {
          fail('invalid_state');
          return;
        }
        const inspected = await deps.service.inspect(input.data.state);
        if (!inspected.ok) {
          fail('unavailable');
          return;
        }
        const pending = inspected.value;
        if (
          !pending ||
          pending.stateHash !== current.flowId ||
          pending.userId !== current.userId ||
          (pending.tenantId || undefined) !== current.tenantId ||
          !validateOAuthSession(req, current.userId) ||
          !validateOAuthCsrf(req, res, current.flowId, DISCORD_CALLBACK_PATH)
        ) {
          fail('invalid_state');
          return;
        }
        clear(res);
        const result = await tenantStorage.run({ tenantId: current.tenantId }, async () => {
          const session = await deps.browserSessions.read({
            userId: current.userId,
            sessionId: current.sessionId,
          });
          if (!session) return { ok: false, error: { code: 'invalid_state' } } as const;
          return deps.service.finish(
            { id: current.userId, tenantId: current.tenantId },
            {
              state: input.data.state,
              code: input.data.error ? '' : (input.data.code ?? ''),
              issuer: input.data.iss ?? '',
            },
            current.nonce,
          );
        });
        if (!result.ok) {
          res.redirect(landing(false, result.error.code));
          return;
        }
        res.redirect(landing(true));
      } catch (error) {
        deps.logError(getSafeErrorMetadata(error));
        fail('unavailable');
      }
    }) as RequestHandler,
  };
}
