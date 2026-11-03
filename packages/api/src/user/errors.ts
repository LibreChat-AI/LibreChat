import { ResponseErasurePendingError } from '@librechat/data-schemas';
import type { Response } from 'express';

/** Keep pending erasure retryable without exposing storage or provider diagnostics. */
export function sendErasureError(
  res: Response,
  error: unknown,
  fallback: string | { message: string } | { error: string },
): Response {
  if (error instanceof ResponseErasurePendingError) {
    return res.status(503).json({
      code: 'response_erasure_pending',
      message: 'Deletion is still finishing. Please try again shortly.',
    });
  }
  return typeof fallback === 'string'
    ? res.status(500).send(fallback)
    : res.status(500).json(fallback);
}
