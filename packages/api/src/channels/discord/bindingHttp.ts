import { z } from 'zod';
import { getTenantId } from '@librechat/data-schemas';
import { channelSnowflakeSchema, tenantIdSchema } from 'librechat-data-provider';
import type { Request, Response, RequestHandler } from 'express';
import type { DiscordBindingService, DiscordBindingResult } from './bindings';
import type { DiscordManagementPrincipal } from './service';
import type { DiscordRouteResolver } from './routes';
import {
  bindDiscordChannelSchema,
  discordBindingTargetSchema,
  removeDiscordBindingSchema,
} from './bindings';
import { acceptsChannelServiceToken } from '../service';

function status(code: string): number {
  if (code === 'forbidden' || code === 'principal_unavailable') return 403;
  if (code === 'invalid_input') return 400;
  if (code === 'not_configured') return 404;
  if (code === 'rate_limited') return 429;
  if (
    code === 'unavailable' ||
    code === 'transactions_unavailable' ||
    code === 'binding_uncertain' ||
    code === 'provider_unavailable' ||
    code === 'timeout'
  )
    return 503;
  return 409;
}

/** The host mounts browser handlers behind JWT and same-origin mutation middleware. */
export function createDiscordBindingHandlers(
  service: DiscordBindingService,
): Record<'status' | 'bind' | 'remove', RequestHandler> {
  const principalSchema = z.object({ id: z.string().min(1), tenantId: tenantIdSchema.nullish() });
  function browser<T, U>(
    schema: z.ZodType<T>,
    action: (principal: DiscordManagementPrincipal, input: T) => Promise<DiscordBindingResult<U>>,
    query = false,
  ): RequestHandler {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const principal = principalSchema.safeParse(req.user);
      if (!principal.success) return void res.sendStatus(401);
      if ((principal.data.tenantId || '_') !== (getTenantId() || '_'))
        return void res.sendStatus(403);
      const parsed = schema.safeParse({
        ...(query ? req.query : req.body),
        agentId: req.params.agentId,
      });
      if (!parsed.success)
        return void res.status(400).json({ ok: false, error: { code: 'invalid_input' } });
      const result = await action(
        { id: principal.data.id, tenantId: principal.data.tenantId || undefined },
        parsed.data,
      );
      res.status(result.ok ? 200 : status(result.error.code)).json(result);
    };
  }
  return {
    status: browser(discordBindingTargetSchema, service.status, true),
    bind: browser(bindDiscordChannelSchema, service.bind),
    remove: browser(removeDiscordBindingSchema, service.remove),
  };
}

/** Service token protection is mandatory even for public-key lookup. */
export function createDiscordRouteHandlers(deps: {
  resolver: DiscordRouteResolver;
  serviceToken: () => string | undefined;
}): Record<'security' | 'resolve', RequestHandler> {
  const resolveSchema = z
    .object({
      applicationId: channelSnowflakeSchema,
      guildId: channelSnowflakeSchema,
      externalChannelId: channelSnowflakeSchema,
      expectedApplicationRevision: z.string().min(1).max(128),
    })
    .strict();
  const protect =
    (action: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken()))
        return void res.sendStatus(401);
      try {
        await action(req, res);
      } catch {
        res.status(503).json({ error: 'discord_route_unavailable' });
      }
    };
  return {
    security: protect(async (req, res) => {
      if (!channelSnowflakeSchema.safeParse(req.params.applicationId).success)
        return void res.sendStatus(400);
      const result = await deps.resolver.security(req.params.applicationId);
      if (!result) return void res.sendStatus(404);
      res.json(result);
    }),
    resolve: protect(async (req, res) => {
      const input = resolveSchema.safeParse(req.body);
      if (!input.success) return void res.sendStatus(400);
      const result = await deps.resolver.resolve(input.data);
      if (!result) return void res.sendStatus(404);
      res.json(result);
    }),
  };
}
