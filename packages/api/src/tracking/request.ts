import { randomUUID } from 'crypto';
import { logger, getTenantId } from '@librechat/data-schemas';
import {
  safelyTrack,
  toProductIdentity,
  serverProductFactSchema,
  PRODUCT_SESSION_HEADER,
  PRODUCT_SUBMISSION_HEADER,
  getProductTrackingConfig,
  productTrackingContextSchema,
  PRODUCT_TRACKING_MAX_PENDING_DELIVERIES_DEFAULT,
} from 'librechat-data-provider';
import type {
  ServerProductFact,
  TTelemetryConfig,
  ServerProductEvent,
  ProductSinkDescriptor,
  ProductTrackingContext,
} from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types';

/**
 * The host's server delivery. LibreChat builds each event, including its identity; the host
 * adds only what delivery needs, such as its own credentials, through `resolveScope`.
 *
 * Both methods run inline on product paths, such as chat callbacks, so they must return at
 * once. LibreChat does not wait for a returned promise; while
 * `telemetry.productTracking.maxPendingDeliveries` promises are unsettled, it drops new facts.
 */
export interface ServerProductSink<Scope> {
  /**
   * Reads the delivery scope from the authenticated request. Called once for each tracked fact,
   * after `requireJwtAuth`. Return `undefined` to skip delivery of that fact.
   */
  resolveScope(req: ServerRequest): Scope | undefined;
  /** Enqueue the event, or start its send; a returned promise counts as pending until it settles. */
  deliver(event: ServerProductEvent, scope: Scope): void | Promise<void>;
}

export interface ProductTrackingMiddlewareOptions<Scope> {
  sink?: ServerProductSink<Scope>;
  /** Published unchanged as `productTracking.browserSink` while tracking is enabled. */
  browserSink?: ProductSinkDescriptor;
}

type ServerDelivery = (
  req: ServerRequest,
  fact: ServerProductFact,
  context?: ProductTrackingContext,
) => void | Promise<void>;

/** Delivers through the sink, and drops new facts while too many deliveries are unsettled. */
function createServerDelivery<Scope>(
  sink: ServerProductSink<Scope>,
  maxPending: number,
): ServerDelivery {
  let pending = 0;
  let dropped = 0;
  const settle = () => {
    pending -= 1;
    if (dropped > 0 && pending < maxPending) {
      logger.warn('[productTracking] The sink recovered after dropped server facts', { dropped });
      dropped = 0;
    }
  };
  return (req, fact, context) => {
    if (pending >= maxPending) {
      dropped += 1;
      if (dropped === 1) {
        logger.warn('[productTracking] The sink is saturated; dropping server facts', {
          maxPending,
        });
      }
      return;
    }
    const scope = sink.resolveScope(req);
    if (scope === undefined) {
      return;
    }
    const result = sink.deliver(
      {
        version: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        producer: 'server',
        identity: toProductIdentity(req.user?.id, getTenantId() ?? req.user?.tenantId),
        ...(context ? { context } : {}),
        fact,
      },
      scope,
    );
    if (!result) {
      return;
    }
    pending += 1;
    return result.finally(settle);
  };
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
 * supplies a `sink`; `GET /api/config` reports the same policy to the browser. Mount this
 * before the routes. It may run before `requireJwtAuth` because the sink resolves its scope
 * and LibreChat reads the identity only when a fact is tracked. The browser host must also
 * mount `TrackingProvider` to send the correlation headers and browser facts.
 *
 * The policy comes from the deployment config loaded at startup; requests do not read
 * config for tracking.
 */
export function createProductTrackingMiddleware<Scope>(
  telemetry?: TTelemetryConfig,
  { sink, browserSink }: ProductTrackingMiddlewareOptions<Scope> = {},
) {
  const resolved = getProductTrackingConfig(telemetry);
  const enabled = resolved.enabled && !!sink;
  if (resolved.enabled && !sink) {
    logger.warn(
      '[productTracking] `telemetry.productTracking.enabled` is true, but no host sink is installed; tracking stays off',
    );
  }
  const deliver = sink
    ? createServerDelivery(
        sink,
        telemetry?.productTracking?.maxPendingDeliveries ??
          PRODUCT_TRACKING_MAX_PENDING_DELIVERIES_DEFAULT,
      )
    : undefined;
  const policy = Object.freeze({
    ...resolved,
    enabled,
    ...(enabled && browserSink ? { browserSink: Object.freeze({ ...browserSink }) } : {}),
  });
  return (req: ServerRequest, _res: Response, next: NextFunction): void => {
    req.productTracking = policy;
    if (policy.enabled && deliver) {
      req.productTracker = (fact, context) => deliver(req, fact, context);
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
      if (parsed.success) {
        safelyTrack(req.productTracker, parsed.data, context);
        return;
      }
      /** Codes and paths only: values can carry IDs. Call sites drift from the strict schema. */
      logger.debug('[productTracking] Dropped a fact that does not match its schema', {
        name: input.name,
        issues: parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join('.'),
        })),
      });
    },
    fact,
    req.productTrackingContext,
  );
}
