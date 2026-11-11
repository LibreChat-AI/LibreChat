import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** The parts of `express-mongo-sanitize` the request sanitizer uses; the caller supplies it. */
export interface MongoSanitizer {
  (): RequestHandler;
  sanitize: <T extends Record<string, unknown> | unknown[]>(target: T) => T;
}

/**
 * Admin config writes carry config keys verbatim, and record keys legitimately hold dots (model
 * names such as `gpt-4.1`, Bedrock inference profiles, MIME types). Matched case-insensitively
 * on the raw path, as Express routes it, so an encoded path Express would not route to the
 * admin config router stays strict.
 */
const ADMIN_CONFIG_PATH = /^\/api\/admin\/config(?:\/|$)/i;

/**
 * App-level request sanitizer: strict `express-mongo-sanitize` everywhere, except that admin
 * config bodies keep their keys. Their `$`-prefixed and prototype keys are rejected after auth
 * by {@link rejectUnsafeConfigKeys} instead, so an unauthenticated caller still gets a 401.
 */
export function createRequestSanitizer(mongoSanitize: MongoSanitizer): RequestHandler {
  const strict = mongoSanitize();
  return function sanitizeRequest(req: Request, res: Response, next: NextFunction): void {
    if (!ADMIN_CONFIG_PATH.test(req.path)) {
      strict(req, res, next);
      return;
    }
    req.headers = mongoSanitize.sanitize(req.headers);
    req.query = mongoSanitize.sanitize(req.query);
    next();
  };
}

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isUnsafeKey(key: string): boolean {
  return key.startsWith('$') || PROTOTYPE_KEYS.has(key);
}

/** Whether any key in `value`, at any depth, is a `$` operator or names an object prototype. */
function hasUnsafeConfigKey(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const item of node) {
        pending.push(item);
      }
    } else if (node != null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (isUnsafeKey(key)) {
          return true;
        }
        pending.push(child);
      }
    }
  }
  return false;
}

/**
 * Admin config route guard, mounted after authentication: answers 400 `CONFIG_UNSAFE_KEY` for a
 * body key the database would read as an operator (`$set`, `$where`) or that names an object
 * prototype, instead of silently dropping it. The key is not echoed back.
 */
export function rejectUnsafeConfigKeys(req: Request, res: Response, next: NextFunction): void {
  if (!hasUnsafeConfigKey(req.body)) {
    next();
    return;
  }
  res.status(400).json({
    error: 'Config keys cannot start with "$" or name an object prototype',
    code: 'CONFIG_UNSAFE_KEY',
  });
}
