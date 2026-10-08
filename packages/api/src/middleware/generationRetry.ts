import { rateLimit } from 'express-rate-limit';
import { logger } from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { limiterCache } from '~/cache/cacheFactory';

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const confirmedGenerationRetry: unique symbol = Symbol('confirmedGenerationRetry');

export const GENERATION_RETRY_WINDOW_MS = 60_000;
export const GENERATION_RETRY_MAX = 10;
export const GENERATION_RETRY_PROBE_MAX = 60;

type GenerationRetryRequest = Request & {
  user?: { id?: string };
  [confirmedGenerationRetry]?: boolean;
};

function isGenerationRetryCandidate(req: GenerationRetryRequest): boolean {
  const clientRequestId = req.body?.clientRequestId;
  const normalizedPath = req.path.replace(/\/+$/, '').toLowerCase();
  return (
    req.method === 'POST' &&
    normalizedPath !== '/resume' &&
    typeof req.user?.id === 'string' &&
    typeof clientRequestId === 'string' &&
    CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)
  );
}

/**
 * Classifies only retries already represented by a durable generation claim.
 * The controller still owns the authoritative claim/read transition.
 */
export async function detectGenerationRetry(
  req: GenerationRetryRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isGenerationRetryCandidate(req)) {
    next();
    return;
  }

  const clientRequestId = req.body?.clientRequestId;
  const userId = req.user?.id;
  if (typeof userId !== 'string' || typeof clientRequestId !== 'string') {
    next();
    return;
  }

  try {
    req[confirmedGenerationRetry] = await GenerationJobManager.hasGenerationClaim(
      userId,
      clientRequestId,
    );
  } catch (error) {
    logger.warn('[GenerationIdempotency] Failed to inspect start-generation claim', {
      userId,
      clientRequestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  next();
}

export function isConfirmedGenerationRetry(req: Request): boolean {
  return (req as GenerationRetryRequest)[confirmedGenerationRetry] === true;
}

const retryAdmissionHandler: RequestHandler = (_req, res) => {
  res.status(503).type('application/json').json({
    code: 'SERVER_NOT_READY',
    error: 'Generation retry admission is temporarily busy. Please retry shortly.',
  });
};

/**
 * Bounds read-only claim probes before they touch the shared generation store.
 * The retryable response participates in the client's existing 120-second
 * readiness loop and express-rate-limit supplies its Retry-After header.
 */
export const generationRetryProbeLimiter: RequestHandler = rateLimit({
  windowMs: GENERATION_RETRY_WINDOW_MS,
  max: GENERATION_RETRY_PROBE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !isGenerationRetryCandidate(req as GenerationRetryRequest),
  keyGenerator: (req) => String((req as GenerationRetryRequest).user?.id),
  store: limiterCache('generation_retry_probe_limiter'),
  handler: retryAdmissionHandler,
});

/**
 * Confirmed retries bypass the ordinary message buckets so a lost response can
 * be recovered, but they still receive a small user-scoped allowance before
 * moderation and the rest of the request pipeline. This bounds replay costs
 * while leaving the authoritative generation claim unchanged.
 */
export const generationRetryLimiter: RequestHandler = rateLimit({
  windowMs: GENERATION_RETRY_WINDOW_MS,
  max: GENERATION_RETRY_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !isConfirmedGenerationRetry(req),
  keyGenerator: (req) => String((req as GenerationRetryRequest).user?.id),
  store: limiterCache('generation_retry_limiter'),
  handler: retryAdmissionHandler,
});
