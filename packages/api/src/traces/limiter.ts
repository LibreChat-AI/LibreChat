import { rateLimit } from 'express-rate-limit';
import { resolveTraceViewerConfig } from 'librechat-data-provider';
import type { TTraceErrorResponse } from 'librechat-data-provider';
import type { Store } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { ServerRequest } from '~/types/http';

const WINDOW_MS = 60 * 1000;
const TENANTLESS = '~tenantless';

/**
 * Per-user limit on trace reads, which spend the tracing backend's own API
 * quota. The ceiling is read per request from `interface.traceViewer`, so a
 * config override applies without a restart; must run after config middleware.
 */
export function createTraceReadLimiter({
  store,
}: {
  /** Shared counter store (e.g. Redis) from the caller; omitted, counts stay in this process. */
  store?: Store;
} = {}): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: (req) =>
      resolveTraceViewerConfig((req as ServerRequest).config?.interfaceConfig?.traceViewer)
        .requestsPerMinute,
    handler: (_req, res) => {
      const body: TTraceErrorResponse = {
        error: 'Too many trace requests. Try again shortly.',
        errorCode: 'rate_limited',
      };
      res.status(429).json(body);
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
