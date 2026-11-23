import { rateLimit } from 'express-rate-limit';
import type { Store } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { ServerRequest } from '~/types/http';
import { recordRumProxyRequest } from '~/app/metrics';
import { getRumProxyEndpoint } from './proxy';

const DEFAULT_USER_MAX = 240;
const DEFAULT_USER_WINDOW_MINUTES = 1;
const TENANTLESS = '~tenantless';

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value != null && value.trim() !== '' && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
}

export function getRumProxyUserMax(): number {
  const max = Math.floor(positiveNumber(process.env.RUM_PROXY_USER_MAX, DEFAULT_USER_MAX));
  return max >= 1 ? max : DEFAULT_USER_MAX;
}

export function getRumProxyUserWindowMs(): number {
  return positiveNumber(process.env.RUM_PROXY_USER_WINDOW, DEFAULT_USER_WINDOW_MINUTES) * 60 * 1000;
}

/**
 * Per-user budget for browser telemetry sent through the RUM proxy, shared by traces and logs.
 * Runs after session auth so every bucket belongs to an authenticated user; over budget the
 * request is answered 429 (OTLP clients back off) without reaching the collector.
 */
export function createRumProxyLimiter({
  store,
}: {
  /** Shared counter store (e.g. Redis) from the caller; omitted, counts stay in this process. */
  store?: Store;
} = {}): RequestHandler {
  return rateLimit({
    windowMs: getRumProxyUserWindowMs(),
    limit: getRumProxyUserMax(),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      recordRumProxyRequest(getRumProxyEndpoint(req.path), 'rate_limited');
      res.status(429).json({ message: 'Too many RUM telemetry requests' });
    },
    /** Tenants can share one store, so a user's bucket is named within their tenant. */
    keyGenerator: (req) => {
      const user = (req as ServerRequest).user;
      const userId = String(user?.id ?? user?._id?.toString() ?? '');
      return `${user?.tenantId || TENANTLESS}:${userId}`;
    },
    store,
  });
}
