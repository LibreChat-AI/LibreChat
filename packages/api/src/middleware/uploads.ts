import { ViolationTypes } from 'librechat-data-provider';
import type { Request, Response, RequestHandler } from 'express';
import type { Store, RateLimitInfo } from 'express-rate-limit';
import type rateLimit from 'express-rate-limit';
import type { FileUploadRateLimitError, RateLimitResponseLocals } from './limiters';
import { getRateLimitReset } from '../utils/limiter';
import { removePorts } from '../utils/ports';

/** All upload routes share lazy buckets, including the in-memory fallback. */
export function createUploadLimiters({
  factory,
  createStore,
  environment,
  logViolation,
}: {
  factory: typeof rateLimit;
  createStore(prefix: string): Store | undefined;
  environment: Record<string, string | undefined>;
  logViolation(
    req: Request,
    res: Response,
    type: string,
    error: FileUploadRateLimitError,
    score?: string,
  ): Promise<unknown>;
}): {
  createFileLimiters(options?: { onLimit?: (req: Request, res: Response) => void }): {
    fileUploadIpLimiter: RequestHandler;
    fileUploadUserLimiter: RequestHandler;
  };
  createFileUsageLimiter(): RequestHandler;
} {
  const create = (kind: 'ip' | 'user', usage = false): RequestHandler => {
    const key = usage ? 'FILE_USAGE_USER' : `FILE_UPLOAD_${kind.toUpperCase()}`;
    const uploadMax = { ip: 100, user: 50 };
    const max = parseInt(environment[`${key}_MAX`] ?? '', 10) || (usage ? 120 : uploadMax[kind]);
    const windowInMinutes = parseInt(environment[`${key}_WINDOW`] ?? '', 10) || 15;
    const windowMs = windowInMinutes * 60_000;
    return factory({
      windowMs,
      max,
      // These three lazily initialized instances live for the lifetime of the host.
      validate: { creationStack: false },
      store: createStore(usage ? 'file_usage_user_limiter' : `file_upload_${kind}_limiter`),
      keyGenerator:
        kind === 'ip'
          ? (req) => removePorts(req) ?? ''
          : (req) => String((req as Request & { user?: Express.User & { id?: string } }).user?.id),
      handler: async (
        req,
        res: Response<
          unknown,
          RateLimitResponseLocals & { uploadLimitError?: (req: Request, res: Response) => void }
        >,
      ) => {
        const error: FileUploadRateLimitError = {
          type: ViolationTypes.FILE_UPLOAD_LIMIT,
          max,
          limiter: kind,
          windowInMinutes,
          ...getRateLimitReset(
            (req as Request & { rateLimit?: RateLimitInfo }).rateLimit,
            windowMs,
          ),
        };
        await logViolation(req, res, error.type, error, environment.FILE_UPLOAD_VIOLATION_SCORE);
        if (res.locals.rateLimitError) return res.locals.rateLimitError(error);
        if (res.locals.uploadLimitError) return res.locals.uploadLimitError(req, res);
        res.status(429).json({
          message: usage
            ? 'Too many file usage requests. Try again later'
            : 'Too many file upload requests. Try again later',
        });
      },
    });
  };
  let ip: RequestHandler | undefined;
  let user: RequestHandler | undefined;
  let usage: RequestHandler | undefined;
  return {
    createFileLimiters: ({ onLimit } = {}) => ({
      fileUploadIpLimiter: (req, res, next) => {
        res.locals.uploadLimitError = onLimit;
        ip ??= create('ip');
        return ip(req, res, next);
      },
      fileUploadUserLimiter: (req, res, next) => {
        res.locals.uploadLimitError = onLimit;
        user ??= create('user');
        return user(req, res, next);
      },
    }),
    createFileUsageLimiter: () => (req, res, next) => {
      usage ??= create('user', true);
      return usage(req, res, next);
    },
  };
}
