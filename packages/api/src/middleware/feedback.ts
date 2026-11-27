import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types/http';

/**
 * Rejects message feedback writes when the deployment set `interface.feedback: false`,
 * so a deployment that hides the controls also stores no ratings. Requires the app
 * config to already be resolved onto the request.
 */
export function requireFeedbackEnabled(
  req: ServerRequest,
  res: Response,
  next: NextFunction,
): void {
  if (req.config?.interfaceConfig?.feedback === false) {
    res.status(403).json({ error: 'Feedback is disabled' });
    return;
  }
  next();
}
