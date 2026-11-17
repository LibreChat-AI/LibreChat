import { rateLimit } from 'express-rate-limit';
import { adminRefreshRateLimitSchema } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Store } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { createMemoizedConfigLoader } from '~/auth/openid/providerSession/config';

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
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many session renewal requests. Try again later.' },
    });
  });

  return async (req, res, next) => {
    const limiter = await getLimiter();
    return limiter(req, res, next);
  };
}
