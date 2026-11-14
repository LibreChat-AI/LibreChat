import { safelyTrack, getProductTrackingConfig } from 'librechat-data-provider';
import type { ServerProductFact, TTelemetryConfig } from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types';

/** Reuses the deployment config loaded at startup; requests do not read config for tracking. */
export function createProductTrackingMiddleware(telemetry?: TTelemetryConfig) {
  const policy = Object.freeze(getProductTrackingConfig(telemetry));
  return (req: ServerRequest, _res: Response, next: NextFunction): void => {
    req.productTracking = policy;
    next();
  };
}

export function trackRequestProductFact(
  req: Pick<ServerRequest, 'productTracker' | 'productTracking'>,
  fact: ServerProductFact,
): void {
  if (req.productTracking?.enabled !== true) {
    return;
  }
  safelyTrack(req.productTracker, fact);
}
