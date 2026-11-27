import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import type { Request, RequestHandler } from 'express';

const SAME_ORIGIN_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);
const MAX_LOGGED_HEADER_LENGTH = 200;
/** The `Origin` header is attacker-set on a non-browser request; strip ASCII control
 * characters (CR, LF, NUL and the rest) so a rejected request cannot forge a log line. */
// eslint-disable-next-line no-control-regex
const UNSAFE_LOG_CHARS = new RegExp('[\x00-\x1f\x7f]', 'g');

export interface SameOriginGuardOptions {
  /** Origins allowed to submit from another origin, such as `DOMAIN_CLIENT` and `DOMAIN_SERVER`. */
  trustedOrigins: ReadonlyArray<string | undefined>;
}

function toOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const { origin } = new URL(value);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** The request's own origin: its scheme (honoring `trust proxy`) and the `Host` it was sent to. */
function matchesRequestOrigin(origin: string, req: Request): boolean {
  const host = req.get('host');
  return host != null && toOrigin(`${req.protocol}://${host}`) === origin;
}

/**
 * A browser labels every request with `Sec-Fetch-Site`, which a page cannot set. Browsers
 * predating it still send `Origin` on a form POST, compared here against the request's own
 * scheme and host. A request carrying neither header did not come from a browser page and passes.
 */
function isCrossSiteRequest(req: Request, trustedOrigins: ReadonlySet<string>): boolean {
  const originHeader = req.get('origin');
  const origin = toOrigin(originHeader);
  if (origin && trustedOrigins.has(origin)) {
    return false;
  }

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite) {
    return !SAME_ORIGIN_FETCH_SITES.has(fetchSite);
  }
  if (!originHeader) {
    return false;
  }
  return !origin || !matchesRequestOrigin(origin, req);
}

const sanitize = (value: string | undefined): string | undefined =>
  value?.replace(UNSAFE_LOG_CHARS, '_').slice(0, MAX_LOGGED_HEADER_LENGTH);

/**
 * Accepts a request only when the browser sent it from this application's own origin (or a
 * trusted one). Login endpoints set session cookies, so they should only honor submissions made
 * by the application's own pages.
 */
export function createSameOriginGuard({ trustedOrigins }: SameOriginGuardOptions): RequestHandler {
  const trusted: ReadonlySet<string> = new Set(
    trustedOrigins.flatMap((value) => toOrigin(value) ?? []),
  );

  return (req, res, next) => {
    if (!isCrossSiteRequest(req, trusted)) {
      next();
      return;
    }

    logger.warn('[requireSameOrigin] Rejected cross-site request', {
      method: req.method,
      path: sanitize(`${req.baseUrl}${req.path}`),
      fetch_site: sanitize(req.get('sec-fetch-site')),
      origin: sanitize(req.get('origin')),
    });
    res.status(403).json({
      message: 'Cross-site request rejected',
      code: ErrorTypes.AUTH_CROSS_ORIGIN,
    });
  };
}
