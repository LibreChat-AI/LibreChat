import {
  safelyTrack,
  serverProductFactSchema,
  PRODUCT_SESSION_HEADER,
  PRODUCT_SUBMISSION_HEADER,
  getProductTrackingConfig,
  productTrackingContextSchema,
} from 'librechat-data-provider';
import type {
  ProductTracker,
  ServerProductFact,
  TTelemetryConfig,
  ProductTrackingContext,
} from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types';

export type ProductTrackerFactory = (req: ServerRequest) => ProductTracker<ServerProductFact>;

export interface ProductTrackingMiddlewareOptions {
  /**
   * Creates the host tracker for one tracked fact. The middleware calls it when a route
   * tracks a fact, not when the request arrives, so `req.user` is already set by
   * `requireJwtAuth`. The tracker builds the event envelope, including `identity`, from
   * the authenticated request. Correlation headers never supply identity.
   */
  createTracker?: ProductTrackerFactory;
}

function readContextHeader(
  req: ServerRequest,
  header: string,
  field: keyof ProductTrackingContext,
): ProductTrackingContext {
  const parsed = productTrackingContextSchema.safeParse({ [field]: req.headers?.[header] });
  return parsed.success ? parsed.data : {};
}

/**
 * Sets the deployment policy and the request tracker on each request.
 *
 * Tracking is enabled only when `telemetry.productTracking.enabled` is true and the host
 * supplies `createTracker`; `GET /api/config` reports the same policy to the browser.
 * Mount this before the routes. It may run before `requireJwtAuth` because it does not
 * read `req.user`. The browser host must also mount `TrackingProvider` to send the
 * correlation headers and browser facts.
 *
 * The policy comes from the deployment config loaded at startup; requests do not read
 * config for tracking.
 */
export function createProductTrackingMiddleware(
  telemetry?: TTelemetryConfig,
  { createTracker }: ProductTrackingMiddlewareOptions = {},
) {
  const resolved = getProductTrackingConfig(telemetry);
  const policy = Object.freeze({ ...resolved, enabled: resolved.enabled && !!createTracker });
  return (req: ServerRequest, _res: Response, next: NextFunction): void => {
    req.productTracking = policy;
    if (policy.enabled && createTracker) {
      req.productTracker = (fact, context) => createTracker(req)(fact, context);
      const context = {
        ...readContextHeader(req, PRODUCT_SESSION_HEADER, 'sessionId'),
        ...readContextHeader(req, PRODUCT_SUBMISSION_HEADER, 'submissionId'),
      };
      if (context.sessionId || context.submissionId) {
        req.productTrackingContext = context;
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
