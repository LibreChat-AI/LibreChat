import { logger } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';

/** Path of the loader script host pages include with a cross-origin `<script src>`. */
export const EMBED_LOADER_PATH = '/embed.js';

/**
 * Returns the environment `createCspPolicy` should read so that, when CSP is enabled, the shell's
 * `frame-ancestors` also admits the embed origins. Without embed origins it returns `env` as is.
 */
export function withEmbedFrameAncestors(
  env: NodeJS.ProcessEnv,
  frameAncestors: string[],
): NodeJS.ProcessEnv {
  if (frameAncestors.length === 0) {
    return env;
  }
  const configured = (env.CSP_FRAME_ANCESTORS ?? '').split(/\s+/).filter(Boolean);
  const base = configured.length > 0 ? configured : ["'self'"];
  const merged = [...new Set([...base, ...frameAncestors])];
  return { ...env, CSP_FRAME_ANCESTORS: merged.join(' ') };
}

/**
 * Lets the embed apps' origins frame LibreChat, and lets any page load the loader script.
 *
 * `X-Frame-Options` cannot name another origin, so it is replaced by a `frame-ancestors`
 * directive listing this origin and the embed origins; every other origin is refused. A
 * full CSP, when enabled, is set later on the shell and carries the same list (see
 * {@link withEmbedFrameAncestors}). The loader is served with `Cross-Origin-Resource-Policy:
 * cross-origin` because the default `same-origin` policy would stop host pages from loading it.
 *
 * The allowed origins can frame every page, not only the embed entry: the shell is one document
 * for all routes. An `X_FRAME_OPTIONS` the operator set is overridden, which is logged.
 *
 * Returns `null` when no embed origin is configured, so the default headers stay untouched.
 */
export function createEmbedFramingMiddleware(
  frameAncestors: string[],
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler | null {
  if (frameAncestors.length === 0) {
    return null;
  }
  if (env.X_FRAME_OPTIONS?.trim()) {
    logger.warn(
      `[embed] X_FRAME_OPTIONS="${env.X_FRAME_OPTIONS}" is ignored: embed apps are enabled, so framing is limited by frame-ancestors to their allowed origins instead.`,
    );
  }
  const directive = `frame-ancestors 'self' ${frameAncestors.join(' ')}`;

  return (req, res, next) => {
    if (req.path === EMBED_LOADER_PATH) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      return next();
    }
    res.removeHeader('X-Frame-Options');
    if (!res.getHeader('Content-Security-Policy')) {
      res.setHeader('Content-Security-Policy', directive);
    }
    next();
  };
}
