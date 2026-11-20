import { rateLimit } from 'express-rate-limit';
import type { RequestHandler, Request } from 'express';
import type { RedisStore } from 'rate-limit-redis';
import { createMemoizedConfigLoader } from '~/auth/openid/providerSession/config';

export interface BackchannelLogoutLimiterConfig {
  rateLimit: { windowMs: number; max: number };
}

export interface CreateBackchannelLogoutLimiterDeps {
  getConfig: () => Promise<BackchannelLogoutLimiterConfig>;
  removePorts: (req: Request) => string | undefined;
  limiterCache: (prefix: string) => RedisStore | undefined;
}

/** Counts only rejected requests (status 400 or more): a provider sends every notification from
 *  a small set of addresses, so counting valid deliveries would limit a mass sign-out. */
function buildLimiter(
  deps: Pick<CreateBackchannelLogoutLimiterDeps, 'removePorts' | 'limiterCache'>,
  config: BackchannelLogoutLimiterConfig,
): RequestHandler {
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    skipSuccessfulRequests: true,
    keyGenerator: deps.removePorts as (req: Request) => string,
    store: deps.limiterCache('backchannel_logout_limiter'),
  });
}

/** Builds the limiter once config loads, since `express-rate-limit` fixes `windowMs` at
 *  construction; a failed load is never cached, so the next request retries. */
export function createBackchannelLogoutLimiter(
  deps: CreateBackchannelLogoutLimiterDeps,
): RequestHandler {
  const getLimiter = createMemoizedConfigLoader(() =>
    deps.getConfig().then((config) => buildLimiter(deps, config)),
  );

  return async (req, res, next) => {
    const limiter = await getLimiter();
    limiter(req, res, next);
  };
}
