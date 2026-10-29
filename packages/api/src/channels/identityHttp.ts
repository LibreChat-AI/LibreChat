import { z } from 'zod';
import { getTenantId } from '@librechat/data-schemas';
import type { ChannelExternalIdentity } from 'librechat-data-provider';
import type { Request, Response, RequestHandler } from 'express';
import type { createChannelIdentityService, ChannelLinkPrincipal } from './identity';
import type { ChannelServiceGuard } from './types';

export interface ChannelIdentityHttpDependencies {
  identity: ReturnType<typeof createChannelIdentityService>;
  guard: ChannelServiceGuard;
}

export interface ChannelIdentityHandlers {
  preview: RequestHandler;
  accept: RequestHandler;
  list: RequestHandler;
  revoke: RequestHandler;
  inspectActor: RequestHandler;
  issue: RequestHandler;
  confirm: RequestHandler;
}

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const revision = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const previewBody = z.object({ ticket: token }).strict();
const acceptBody = previewBody.extend({ revision }).strict();
const confirmBody = z.object({ linkId: revision, revision }).strict();
const revisionBody = z.object({ revision }).strict();

/** Browser handlers must additionally be mounted behind JWT and same-origin middleware. */
export function createChannelIdentityHandlers(
  deps: ChannelIdentityHttpDependencies,
): ChannelIdentityHandlers {
  const browser =
    (
      handler: (req: Request, res: Response, principal: ChannelLinkPrincipal) => Promise<void>,
    ): RequestHandler =>
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const parsedUser = z
        .object({
          id: z.string().min(1),
          tenantId: z.string().nullish(),
          name: z.string().nullish(),
        })
        .safeParse(req.user);
      if (!parsedUser.success) {
        res.status(401).json({ ok: false, error: { code: 'forbidden' } });
        return;
      }
      const user = parsedUser.data;
      const tenantId = getTenantId() ?? '_';
      if ((user.tenantId ?? '_') !== tenantId) {
        res.status(403).json({ ok: false, error: { code: 'forbidden' } });
        return;
      }
      // Slack confirmation shows a display label, never the browser account's email.
      const name = typeof user.name === 'string' ? user.name.trim() : '';
      const safeName =
        name &&
        !name.includes('@') &&
        [...name].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
      const accountLabel = safeName ? name.slice(0, 200) : `Account ${user.id}`;
      try {
        await handler(req, res, { userId: user.id, tenantId, accountLabel });
      } catch {
        res.status(503).json({ ok: false, error: { code: 'unavailable' } });
      }
    };
  const actor = (
    handler: (req: Request, res: Response, identity: ChannelExternalIdentity) => Promise<void>,
  ): RequestHandler =>
    deps.guard(async (req, res, channel) => {
      res.set('Cache-Control', 'no-store');
      const externalUserId = z
        .string()
        .regex(/^[UW][A-Z0-9]{1,127}$/)
        .safeParse(req.params.externalUserId);
      if (
        !externalUserId.success ||
        !channel.revision ||
        !channel.slack?.teamId ||
        !channel.slack.appId
      ) {
        res.status(400).json({ ok: false, error: { code: 'forbidden' } });
        return;
      }
      await handler(req, res, {
        tenantId: channel.tenantId ?? '_',
        channelId: channel.channelId,
        channelRevision: channel.revision,
        agentId: channel.agentId,
        teamId: channel.slack.teamId,
        externalUserId: externalUserId.data,
      });
    });
  return {
    preview: browser(async (req, res, principal) => {
      const parsed = previewBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: { code: 'invalid_ticket' } });
        return;
      }
      res.json(await deps.identity.preview(principal, parsed.data.ticket));
    }),
    accept: browser(async (req, res, principal) => {
      const parsed = acceptBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: { code: 'invalid_ticket' } });
        return;
      }
      res.json(await deps.identity.accept(principal, parsed.data.ticket, parsed.data.revision));
    }),
    list: browser(async (_req, res, principal) => {
      res.json(await deps.identity.list(principal));
    }),
    revoke: browser(async (req, res, principal) => {
      const parsed = revisionBody.safeParse(req.body);
      const linkId = revision.safeParse(req.params.linkId);
      if (!parsed.success || !linkId.success) {
        res.status(400).json({ ok: false, error: { code: 'changed' } });
        return;
      }
      res.json(await deps.identity.revoke(principal, linkId.data, parsed.data.revision));
    }),
    inspectActor: actor(async (_req, res, identity) => {
      res.json(await deps.identity.inspectActor(identity));
    }),
    issue: actor(async (req, res, identity) => {
      if (
        !z
          .object({})
          .strict()
          .safeParse(req.body ?? {}).success
      ) {
        res.status(400).json({ ok: false, error: { code: 'forbidden' } });
        return;
      }
      res.json(await deps.identity.issue(identity));
    }),
    confirm: actor(async (req, res, identity) => {
      const parsed = confirmBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: { code: 'changed' } });
        return;
      }
      const result = await deps.identity.confirm(
        identity,
        parsed.data.linkId,
        parsed.data.revision,
      );
      // A gateway only needs the confirmed state, never an internal principal or credential.
      res.json(result.ok ? await deps.identity.inspectActor(identity) : result);
    }),
  };
}
