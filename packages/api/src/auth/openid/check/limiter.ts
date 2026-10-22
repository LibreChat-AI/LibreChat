import { rateLimit } from 'express-rate-limit';
import { rateLimitSchema, OPENID_CHECK_RECEIPT } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { RequestHandler, Request } from 'express';
import type { Store } from 'express-rate-limit';
import type { OpenIDRequest } from '../types';

/** Automatic checks share a browser budget without consuming interactive login attempts. */
export function createOpenIDCheckLimiter(deps: {
  getConfig: () => Promise<Pick<AppConfig, 'config'>>;
  store?: Store;
  removePorts: (req: Request) => string | undefined;
  clientDomain: string;
}): RequestHandler {
  return rateLimit({
    windowMs: 5 * 60 * 1000,
    max: async () =>
      rateLimitSchema.shape.openidSessionCheck
        .unwrap()
        .parse((await deps.getConfig()).config?.rateLimits?.openidSessionCheck ?? {})
        .requestsPerFiveMinutes,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
      (req as OpenIDRequest).session?.openidTokens
        ? `session:${req.sessionID}`
        : `ip:${deps.removePorts(req)}`,
    handler: (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (req.method === 'GET') {
        const target = new URL(deps.clientDomain);
        target.searchParams.set(OPENID_CHECK_RECEIPT, 'invalid');
        res.redirect(target.href);
        return;
      }
      res.status(429).json({ status: 'unavailable' });
    },
    store: deps.store,
  });
}
