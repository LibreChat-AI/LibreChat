import { z } from 'zod';
import { getTenantId } from '@librechat/data-schemas';
import {
  discordDmIssueSchema,
  discordDmConsumeSchema,
  discordDmRevokeSchema,
  tenantIdSchema,
} from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { DiscordManagementPrincipal } from './service';
import type { DiscordDmService } from './dm';
import { acceptsChannelServiceToken } from '../service';

/** Browser mutations require JWT and same-origin middleware at the route mount. */
export function createDiscordDmHandlers(deps: {
  service: DiscordDmService;
  serviceToken: () => string | undefined;
}): Record<'issue' | 'list' | 'revoke' | 'select', RequestHandler> {
  const principalSchema = z.object({ id: z.string().min(1), tenantId: tenantIdSchema.nullish() });
  function handler(
    action: (
      req: Parameters<RequestHandler>[0],
      principal: DiscordManagementPrincipal | undefined,
    ) => Promise<{ ok: boolean; error?: { code: string } }>,
    privateService = false,
  ): RequestHandler {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const principal = principalSchema.safeParse(req.user);
      if (
        privateService
          ? !acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken())
          : !principal.success
      )
        return void res.sendStatus(401);
      if (
        !privateService &&
        principal.success &&
        (principal.data.tenantId || '_') !== (getTenantId() || '_')
      )
        return void res.sendStatus(403);
      try {
        const result = await action(
          req,
          principal.success
            ? { id: principal.data.id, tenantId: principal.data.tenantId || undefined }
            : undefined,
        );
        const statuses: Record<string, number> = {
          invalid_input: 400,
          forbidden: 403,
          disabled: 404,
          capacity: 429,
        };
        res.status(result.ok ? 200 : (statuses[result.error?.code || ''] ?? 409)).json(result);
      } catch {
        res.status(503).json({ ok: false, error: { code: 'unavailable' } });
      }
    };
  }
  const invalid = { ok: false, error: { code: 'invalid_input' } };
  return {
    issue: handler(async (req, principal) => {
      const input = discordDmIssueSchema.safeParse(req.body);
      return input.success && principal ? deps.service.issue(principal, input.data) : invalid;
    }),
    list: handler(async (req, principal) => {
      const input = z
        .object({
          cursor: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[\w-]+$/)
            .optional(),
        })
        .strict()
        .safeParse(req.query);
      return input.success && principal ? deps.service.list(principal, input.data.cursor) : invalid;
    }),
    revoke: handler(async (req, principal) => {
      const input = discordDmRevokeSchema.safeParse({
        ...req.body,
        selectionId: req.params.selectionId,
      });
      return input.success && principal ? deps.service.revoke(principal, input.data) : invalid;
    }),
    select: handler(async (req) => {
      const input = discordDmConsumeSchema.safeParse(req.body);
      return input.success ? deps.service.select(input.data) : invalid;
    }, true),
  };
}
