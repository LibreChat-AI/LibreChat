import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** The back-channel logout route, parsed by its own route with a smaller, config-driven
 *  limit instead of the app-wide body parsers. */
export const BACKCHANNEL_LOGOUT_PATH = '/oauth/openid/backchannel-logout';

/** Express routes match case-insensitively and, by default, with an optional trailing slash;
 *  the bypass must match the same requests the route itself will handle. */
function isBackchannelLogoutPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized === BACKCHANNEL_LOGOUT_PATH || normalized === `${BACKCHANNEL_LOGOUT_PATH}/`;
}

/** Defer body parsing until the back-channel logout route applies its own config-driven limit. */
export function excludeBackchannelLogoutBodyParser(parser: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (isBackchannelLogoutPath(req.path)) {
      next();
      return;
    }
    parser(req, res, next);
  };
}

/** One `express.urlencoded` parser per distinct limit, built once and reused. */
const urlencodedParsers = new Map<string, RequestHandler>();

function getUrlencodedParser(limit: number | string): RequestHandler {
  const key = String(limit);
  let parser = urlencodedParsers.get(key);
  if (!parser) {
    parser = express.urlencoded({ extended: false, limit });
    urlencodedParsers.set(key, parser);
  }
  return parser;
}

function isEntityTooLarge(err: unknown): boolean {
  const typed = err as { status?: number; type?: string };
  return typed.status === 413 || typed.type === 'entity.too.large';
}

/** Parses the logout request body against the config-driven `maxBodyBytes`, read fresh from
 *  `req` on every call. Maps a parse failure to 400, an over-limit body to 413. */
export function createLogoutBodyParser(
  getMaxBodyBytes: (req: Request) => number,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const parser = getUrlencodedParser(getMaxBodyBytes(req));
    parser(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      res.status(isEntityTooLarge(err) ? 413 : 400).json({ error: 'invalid_request' });
    });
  };
}
