import {
  confirmScheduleMCPConsentSchema,
  revokeScheduleMCPConsentSchema,
} from 'librechat-data-provider';
import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ScheduleMCPConsentService } from './service';
import type { ServerRequest } from '~/types';
import { ScheduleMCPConsentError } from './service';

export interface ScheduleMCPConsentHandlers {
  get: (req: ServerRequest, res: Response) => Promise<void>;
  confirm: (req: ServerRequest, res: Response) => Promise<void>;
  revoke: (req: ServerRequest, res: Response) => Promise<void>;
}

export function createScheduleMCPConsentHandlers(deps: {
  service: ScheduleMCPConsentService;
  resolveIdentity: (req: ServerRequest) => Promise<ScheduledMCPIdentity | null>;
}): ScheduleMCPConsentHandlers {
  const handler =
    (
      operation: (
        req: ServerRequest,
        res: Response,
        identity: ScheduledMCPIdentity,
      ) => Promise<void>,
    ) =>
    async (req: ServerRequest, res: Response): Promise<void> => {
      try {
        const identity = await deps.resolveIdentity(req);
        if (!identity) {
          res.status(404).json({ code: 'consent_not_found' });
          return;
        }
        await operation(req, res, identity);
      } catch (error) {
        const code = error instanceof ScheduleMCPConsentError ? error.code : 'consent_unavailable';
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
  return {
    get: handler(async (_req, res, identity) => {
      res.json(await deps.service.view(identity));
    }),
    confirm: handler(async (req, res, identity) => {
      const parsed = confirmScheduleMCPConsentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ code: 'consent_invalid' });
        return;
      }
      res.json(await deps.service.confirm(identity, parsed.data));
    }),
    revoke: handler(async (req, res, identity) => {
      const parsed = revokeScheduleMCPConsentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ code: 'consent_invalid' });
        return;
      }
      await deps.service.revoke(identity, parsed.data.expectedRevision);
      res.status(204).end();
    }),
  };
}
