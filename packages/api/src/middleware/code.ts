import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { AugmentedRequest } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { limiterCache } from '~/cache/cacheFactory';

type AuthenticatedRequest = Request & { user?: { id?: string } };

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

const pairingWindowInMinutes = positiveInteger(
  process.env.CODE_ENVIRONMENT_PAIRING_USER_WINDOW,
  60,
);
export const codeEnvironmentPairingLimiter: RequestHandler = rateLimit({
  windowMs: pairingWindowInMinutes * 60 * 1000,
  max: positiveInteger(process.env.CODE_ENVIRONMENT_PAIRING_USER_MAX, 5),
  handler: (limitedReq, limitedRes) => {
    const resetAt = (limitedReq as AugmentedRequest).rateLimit?.resetTime?.getTime();
    const retryAfterSeconds =
      typeof resetAt === 'number' && Number.isFinite(resetAt)
        ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
        : Math.max(1, Math.ceil(pairingWindowInMinutes * 60));
    limitedRes.set('Retry-After', String(retryAfterSeconds));
    return limitedRes.status(429).json({
      error: {
        code: 'code_environment_pairing_rate_limited',
        message: 'Code environment pairing rate limit exceeded.',
        type: 'rate_limit_error',
      },
    });
  },
  keyGenerator: (limitedReq) => String((limitedReq as AuthenticatedRequest).user?.id ?? ''),
  store: limiterCache('code_environment_pairing_user_limiter'),
});

export const codeEnvironmentStatusLimiter: RequestHandler = rateLimit({
  windowMs: positiveInteger(process.env.CODE_ENVIRONMENT_STATUS_USER_WINDOW, 1) * 60 * 1000,
  max: positiveInteger(process.env.CODE_ENVIRONMENT_STATUS_USER_MAX, 120),
  handler: (_limitedReq, limitedRes) =>
    limitedRes.status(429).json({
      error: {
        code: 'code_environment_status_rate_limited',
        message: 'Code environment status rate limit exceeded.',
        type: 'rate_limit_error',
      },
    }),
  keyGenerator: (limitedReq) => String((limitedReq as AuthenticatedRequest).user?.id ?? ''),
  store: limiterCache('code_environment_status_user_limiter'),
});

export const codeEnvironmentStatusIpLimiter: RequestHandler = rateLimit({
  windowMs: positiveInteger(process.env.CODE_ENVIRONMENT_STATUS_IP_WINDOW, 1) * 60 * 1000,
  max: positiveInteger(process.env.CODE_ENVIRONMENT_STATUS_IP_MAX, 300),
  handler: (_limitedReq, limitedRes) =>
    limitedRes.status(429).json({
      error: {
        code: 'code_environment_status_rate_limited',
        message: 'Code environment status rate limit exceeded.',
        type: 'rate_limit_error',
      },
    }),
  keyGenerator: (limitedReq) => {
    const ip = limitedReq.ip ?? limitedReq.socket.remoteAddress;
    return ip == null ? 'unknown' : ipKeyGenerator(ip);
  },
  store: limiterCache('code_environment_status_ip_limiter'),
});
