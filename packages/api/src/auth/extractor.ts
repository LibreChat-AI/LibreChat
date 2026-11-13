import { logger } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { IncomingHttpHeaders } from 'node:http';

export type JwtRequest = { headers: IncomingHttpHeaders };

export type JwtExtractor = (req: JwtRequest) => string | null;

const bearerScheme = /^bearer\s+/i;

/** RFC 9110 field-name characters, matching the `sessionToken.header` schema. */
const fieldName = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

const readHeaderToken = (headers: IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name];
  /**
   * Node joins a repeated header into one comma-separated string, and a JWT never contains a
   * comma, so a comma means the header arrived more than once.
   */
  if (typeof value !== 'string' || value.includes(',')) {
    return null;
  }
  const token = value.replace(bearerScheme, '').trim();
  if (!token) {
    return null;
  }
  return token;
};

/**
 * Picks the header the session JWT is read from: `sessionToken.header` in yaml wins over
 * `JWT_AUTH_HEADER`, and with neither set only `Authorization` is read, as before. Resolved once
 * when the strategy is built, so a change takes effect on restart; the strategy is process-wide,
 * so callers pass the base config rather than a tenant-scoped one.
 */
export const resolveJwtAuthHeader = (
  config?: TCustomConfig['sessionToken'],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const name = (config?.header ?? env.JWT_AUTH_HEADER)?.trim();
  if (!name) {
    return undefined;
  }
  if (!fieldName.test(name)) {
    logger.warn(`[jwtExtractor] Ignoring invalid session JWT header name '${name}'.`);
    return undefined;
  }
  return name;
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
 * - a header sent more than once is ignored rather than guessed, leaving `fallback` to decide.
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
