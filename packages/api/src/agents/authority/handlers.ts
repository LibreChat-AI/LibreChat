import { confirmRunGrantSchema, revokeRunGrantSchema } from 'librechat-data-provider';
import type { RunGrantIdentity, ScheduledMCPIdentity } from 'librechat-data-provider';
import type { Response } from 'express';
import type { RunGrantService } from './service';
import type { ServerRequest } from '~/types';
import { RunGrantError } from './service';

export interface RunGrantHandlers {
  /** The offer for a subject that is not stored yet. Absent where there is no such thing. */
  draft?: (req: ServerRequest, res: Response) => Promise<void>;
  get: (req: ServerRequest, res: Response) => Promise<void>;
  confirm: (req: ServerRequest, res: Response) => Promise<void>;
  revoke: (req: ServerRequest, res: Response) => Promise<void>;
}

export function createRunGrantHandlers<
  Identity extends RunGrantIdentity = ScheduledMCPIdentity,
>(deps: {
  service: RunGrantService<Identity>;
  resolveIdentity: (req: ServerRequest) => Promise<Identity | null>;
  /** Who a subject being created would act for, from the request that asks about it. */
  resolveDraft?: (req: ServerRequest) => Promise<Identity | null>;
}): RunGrantHandlers {
  const handler =
    (
      operation: (req: ServerRequest, res: Response, identity: Identity) => Promise<void>,
      resolve = deps.resolveIdentity,
    ) =>
    async (req: ServerRequest, res: Response): Promise<void> => {
      try {
        const identity = await resolve(req);
        if (!identity) {
          res.status(404).json({ code: 'consent_not_found' });
          return;
        }
        await operation(req, res, identity);
      } catch (error) {
        const code = error instanceof RunGrantError ? error.code : 'consent_unavailable';
        const statuses = {
          consent_not_found: 404,
          consent_forbidden: 403,
          consent_changed: 409,
          consent_invalid: 400,
          consent_unavailable: 503,
        };
        const status = statuses[code];
        res.status(status).json({ code });
      }
    };
  const { resolveDraft } = deps;
  return {
    ...(resolveDraft && {
      draft: handler(async (_req, res, identity) => {
        res.json(await deps.service.draft(identity));
      }, resolveDraft),
    }),
    get: handler(async (_req, res, identity) => {
      res.json(await deps.service.view(identity));
    }),
    confirm: handler(async (req, res, identity) => {
      const parsed = confirmRunGrantSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ code: 'consent_invalid' });
        return;
      }
      res.json(await deps.service.confirm(identity, parsed.data));
    }),
    revoke: handler(async (req, res, identity) => {
      const parsed = revokeRunGrantSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ code: 'consent_invalid' });
        return;
      }
      await deps.service.revoke(identity, parsed.data.expectedRevision);
      res.status(204).end();
    }),
  };
}
