import { logger } from '@librechat/data-schemas';
import type { IncomingHttpHeaders } from 'node:http';

export type JwtRequest = { headers: IncomingHttpHeaders };

export type JwtExtractor = (req: JwtRequest) => string | null;

const bearerScheme = /^bearer\s+/i;

const readHeaderToken = (headers: IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name];
  if (typeof value !== 'string') {
    return null;
  }
  const token = value.replace(bearerScheme, '').trim();
  if (!token) {
    return null;
  }
  return token;
};

/**
 * Reads the session JWT from `headerName`, falling back to `fallback` when it yields nothing.
 *
 * Returns `fallback` unchanged when no header name is configured, so the default behaviour is
 * untouched. Three details are load-bearing:
 * - the name is lowercased, because Node exposes incoming header keys in lowercase while the
 *   lookup is literal, so a capitalised configuration would silently never match;
 * - the value may carry the `Bearer ` scheme, because that is the form LibreChat sends
 *   `Authorization` in and a proxy copying it verbatim would otherwise be rejected;
 * - a header sent more than once arrives as an array and is refused rather than guessed.
 */
export const createJwtExtractor = (
  headerName: string | undefined,
  fallback: JwtExtractor,
): JwtExtractor => {
  const name = headerName?.trim().toLowerCase();
  if (!name) {
    return fallback;
  }

  logger.info(`[jwtExtractor] Session JWT will be read from the '${name}' header first.`);

  return (req: JwtRequest) => readHeaderToken(req.headers, name) ?? fallback(req);
};
