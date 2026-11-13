import {
  safelyTrack,
  serverProductFactSchema,
  PRODUCT_SESSION_HEADER,
  PRODUCT_SUBMISSION_HEADER,
  getProductTrackingConfig,
  productTrackingContextSchema,
} from 'librechat-data-provider';
import type { ServerProductFact, TTelemetryConfig } from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types';

/** Reuses the deployment config loaded at startup; requests do not read config for tracking. */
export function createProductTrackingMiddleware(telemetry?: TTelemetryConfig) {
  const policy = Object.freeze(getProductTrackingConfig(telemetry));
  return (req: ServerRequest, _res: Response, next: NextFunction): void => {
    req.productTracking = policy;
    if (policy.enabled) {
      const parsed = productTrackingContextSchema.safeParse({
        sessionId: req.headers?.[PRODUCT_SESSION_HEADER],
        submissionId: req.headers?.[PRODUCT_SUBMISSION_HEADER],
      });
      if (parsed.success && (parsed.data.sessionId || parsed.data.submissionId)) {
        req.productTrackingContext = parsed.data;
      }
    }
    next();
  };
}

/** Joins a queued turn after body validation without extending its original browser session. */
export function bindProductSubmissionContext(
  req: Pick<ServerRequest, 'productTracking' | 'productTrackingContext'>,
  clientRequestId: string | undefined,
): void {
  if (!req.productTracking?.enabled || req.productTrackingContext?.submissionId) {
    return;
  }
  const parsed = productTrackingContextSchema.safeParse({ submissionId: clientRequestId });
  if (parsed.success && parsed.data.submissionId) {
    req.productTrackingContext = { ...req.productTrackingContext, ...parsed.data };
  }
}

export function trackRequestProductFact(
  req: Pick<ServerRequest, 'productTracker' | 'productTracking' | 'productTrackingContext'>,
  fact: ServerProductFact,
): void {
  if (req.productTracking?.enabled !== true) {
    return;
  }
  safelyTrack(
    (input, context) => {
      const parsed = serverProductFactSchema.safeParse(input);
      if (parsed.success) safelyTrack(req.productTracker, parsed.data, context);
    },
    fact,
    req.productTrackingContext,
  );
}
