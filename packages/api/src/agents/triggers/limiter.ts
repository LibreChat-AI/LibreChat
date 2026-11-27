import { rateLimit } from 'express-rate-limit';
import type { AugmentedRequest, Store } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { getRateLimitReset } from '~/utils/limiter';

type EventRequest = { apiKeyId?: string; user?: { id?: string } };

export interface AgentEventLimiterOptions {
  /** Admissions per window, as `AGENT_EVENT_USER_MAX` carries it; defaults to 40. */
  max?: string;
  /** Window length in minutes, as `AGENT_EVENT_USER_WINDOW` carries it; defaults to 1. */
  window?: string;
  /** Shared counter store (e.g. Redis) from the caller; omitted, counts stay in this process. */
  store?: Store;
}

/**
 * Admission limit for agent events, one bucket per API key (or user without one). It is separate
 * from the message-user limiter because the durable worker charges that bucket when it delivers
 * the event, so sharing it would count every event twice. Over budget, the caller gets a JSON 429
 * with `Retry-After` and no violation is recorded. Build it at startup, after `rateLimits` from
 * librechat.yaml has reached the environment: express-rate-limit rejects limiters created while a
 * request is being handled.
 */
export function createAgentEventLimiter({
  max,
  window,
  store,
}: AgentEventLimiterOptions = {}): RequestHandler {
  const windowMs = Number(window ?? 1) * 60 * 1000;
  return rateLimit({
    windowMs,
    max: Number(max ?? 40),
    handler: (req, res) => {
      const { retryAfterSeconds } = getRateLimitReset(
        (req as AugmentedRequest).rateLimit,
        windowMs,
      );
      res.set('Retry-After', String(retryAfterSeconds));
      res
        .status(429)
        .type('application/json')
        .json({
          error: {
            code: 'agent_event_rate_limited',
            message: 'Agent event admission rate limit exceeded.',
            type: 'rate_limit_error',
          },
        });
    },
    keyGenerator: (req) => {
      const { apiKeyId, user } = req as EventRequest;
      return String(apiKeyId ?? user?.id);
    },
    store,
  });
}
