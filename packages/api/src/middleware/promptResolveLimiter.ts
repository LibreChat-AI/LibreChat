import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { limiterCache } from '~/cache/cacheFactory';

type PromptResolveRequest = { user?: { id?: string } };

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/** The window in minutes, converted to milliseconds. `userWindowInMinutes` in the
 *  config schema allows any positive number, not just an integer, so this parses
 *  a fractional value instead of flooring it to the 1-minute fallback. */
export function windowMsFromMinutes(value: string | undefined, fallbackMinutes: number): number {
  const parsed = Number(value);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMinutes;
  return Math.round(minutes * 60_000);
}

/**
 * Builds the per-user limiter for `GET /prompts/groups/:groupId/resolve`.
 * `librechat.yaml`'s `rateLimits.promptResolve` relays onto
 * PROMPT_RESOLVE_USER_MAX / PROMPT_RESOLVE_USER_WINDOW at startup (see
 * `handleRateLimits`), the same way the file upload, import, TTS and STT
 * limiters pick up their overrides. The caller builds this after that relay
 * has run. With no override, the defaults below apply: 60 requests per
 * minute per user.
 */
export function createPromptResolveLimiter(): RequestHandler {
  return rateLimit({
    windowMs: windowMsFromMinutes(process.env.PROMPT_RESOLVE_USER_WINDOW, 1),
    max: positiveInteger(process.env.PROMPT_RESOLVE_USER_MAX, 60),
    keyGenerator: (req) => String((req as PromptResolveRequest).user?.id ?? ''),
    store: limiterCache('prompt_resolve_limiter'),
    handler: (_req, res) => {
      res.status(429).json({ message: 'Too many prompt resolve requests. Try again later' });
    },
  });
}
