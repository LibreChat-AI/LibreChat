import { ViolationTypes } from 'librechat-data-provider';
import type { Request, Response, RequestHandler } from 'express';
import type { MessageRateLimitError } from '~/middleware/limiters';
import type { MediaEnvironment } from './credentials';
import { MediaServiceError } from './errors';
import { isEnabled } from '~/utils/common';

export interface MediaAdmissionPolicy {
  admitToolGeneration?(request: Request): Promise<void>;
  recordCapacityViolation?(req: Request, res: Response): Promise<void>;
  checkBan: RequestHandler;
  generationLimiters: readonly RequestHandler[];
  uploadLimiters: readonly RequestHandler[];
}
export interface MediaAdmissionDependencies {
  logViolation?(
    req: Request,
    res: Response,
    type: string,
    error: { type: string; message: string } | MessageRateLimitError,
    score?: string,
  ): Promise<unknown>;
  checkBan: RequestHandler;
  messageIpLimiter: RequestHandler;
  messageUserLimiter: RequestHandler;
  consumeMessageLimit?(
    req: Request,
    kind: 'ip' | 'user',
  ): Promise<MessageRateLimitError | undefined>;
  createFileLimiters(options: { onLimit: (req: Request, res: Response) => void }): {
    fileUploadIpLimiter: RequestHandler;
    fileUploadUserLimiter: RequestHandler;
  };
}

export function createMediaAdmissionPolicy(
  deps: MediaAdmissionDependencies,
  environment: MediaEnvironment,
): MediaAdmissionPolicy {
  const uploads = deps.createFileLimiters({
    onLimit: (_req, res) => {
      res.status(429).json({ error: { code: 'quota_exceeded' } });
    },
  });
  return {
    admitToolGeneration: async (req) => {
      if (!deps.consumeMessageLimit) {
        throw new MediaServiceError('not_ready', 503, 'Media tool admission is not configured.');
      }
      for (const kind of ['ip', 'user'] as const) {
        if (!isEnabled(environment[`LIMIT_MESSAGE_${kind.toUpperCase()}`])) continue;
        const denied = await deps.consumeMessageLimit(req, kind);
        if (!denied) continue;
        if (req.res) {
          await deps.logViolation?.(
            req,
            req.res,
            denied.type,
            denied,
            environment.MESSAGE_VIOLATION_SCORE,
          );
        }
        throw new MediaServiceError('quota_exceeded', 429, 'Media generation rate limit exceeded.');
      }
    },
    recordCapacityViolation: async (req, res) => {
      await deps.logViolation?.(
        req,
        res,
        ViolationTypes.CONCURRENT,
        { type: ViolationTypes.CONCURRENT, message: 'Media queue capacity exceeded.' },
        environment.CONCURRENT_VIOLATION_SCORE,
      );
    },
    checkBan: deps.checkBan,
    generationLimiters: [
      ...(isEnabled(environment.LIMIT_MESSAGE_IP) ? [deps.messageIpLimiter] : []),
      ...(isEnabled(environment.LIMIT_MESSAGE_USER) ? [deps.messageUserLimiter] : []),
    ],
    uploadLimiters: [uploads.fileUploadIpLimiter, uploads.fileUploadUserLimiter],
  };
}
