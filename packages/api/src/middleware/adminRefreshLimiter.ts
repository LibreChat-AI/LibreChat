import { logger } from '@librechat/data-schemas';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { adminRefreshRateLimitSchema } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Store } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { createMemoizedConfigLoader } from '~/auth/openid/providerSession/config';
import { removePorts } from '~/utils/ports';

/** Token renewal uses a separate IP budget so page loads cannot exhaust sign-in attempts. */
export function createAdminRefreshLimiter({
  getAppConfig,
  store,
}: {
  getAppConfig: () => Promise<AppConfig>;
  store?: Store;
}): RequestHandler {
  const getLimiter = createMemoizedConfigLoader(async () => {
    const config = await getAppConfig();
    const { windowMs, max } = adminRefreshRateLimitSchema.parse(
      config.config?.rateLimits?.adminRefresh ?? {},
    );
    return rateLimit({
      windowMs,
      max,
      store,
      keyGenerator: (req) =>
        ipKeyGenerator(removePorts(req) ?? req.socket.remoteAddress ?? 'unknown'),
      standardHeaders: true,
      legacyHeaders: false,
      /** The route has no authenticated user, so `logViolation` (which counts per user) cannot
       *  record this; the warning is how an operator sees repeated renewals from one address. */
      handler: (req, res) => {
        logger.warn('[adminRefreshLimiter] Admin token renewal rate limit exceeded', {
          ip: removePorts(req) ?? req.socket.remoteAddress,
          windowMs,
          max,
        });
        res.status(429).json({ message: 'Too many session renewal requests. Try again later.' });
      },
    });
  });

  return async (req, res, next) => {
    const limiter = await getLimiter();
    return limiter(req, res, next);
  };
}
