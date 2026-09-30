import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '@librechat/data-schemas';
import type { Store } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { ServerRequest } from '~/types/http';

/** One admission budget across all authenticated factor checks, including concurrent requests.
 * Count successes too: resetting on success would let setup/verification replenish the budget.
 * The five-minute window matches the existing login verification limiter. */
export function createTwoFactorManagementLimiter({
  getAppConfig,
  store,
}: {
  getAppConfig: () => Promise<AppConfig>;
  store?: Store;
}): RequestHandler {
  const limiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: async () =>
      (await getAppConfig()).config?.rateLimits?.twoFactorManagement?.requestsPerFiveMinutes ?? 7,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const user = (req as ServerRequest).user;
      return JSON.stringify([user?.tenantId ?? null, user?.id ?? user?._id?.toString()]);
    },
    handler: (_req, res) => {
      res.status(429).json({
        code: 'TWO_FACTOR_RATE_LIMITED',
        message: 'Too many verification attempts. Try again later.',
      });
    },
    store,
  });
  return (req, res, next) => {
    const user = (req as ServerRequest).user;
    if (!user?.id && !user?._id) {
      res.sendStatus(401);
      return;
    }
    return limiter(req, res, next);
  };
}
