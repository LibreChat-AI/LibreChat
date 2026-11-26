import { z } from 'zod';
import type { TProductTrackingPolicy, TTelemetryConfig } from './config';
import { PRODUCT_TRACKING_SESSION_DEFAULTS } from './config';

/** Product events are off unless the deployment explicitly enables them. */
export function getProductTrackingConfig(telemetry?: TTelemetryConfig): TProductTrackingPolicy {
  const session = telemetry?.productTracking?.session;
  return {
    enabled: telemetry?.productTracking?.enabled === true,
    session: {
      shareAcrossTabs:
        session?.shareAcrossTabs ?? PRODUCT_TRACKING_SESSION_DEFAULTS.shareAcrossTabs,
      idleTimeoutMs: session?.idleTimeoutMs ?? PRODUCT_TRACKING_SESSION_DEFAULTS.idleTimeoutMs,
      activityIntervalMs:
        session?.activityIntervalMs ?? PRODUCT_TRACKING_SESSION_DEFAULTS.activityIntervalMs,
    },
  };
}

const id = z.string().min(1).max(128);

/** Browser observations never establish that a write or model execution succeeded. */
export const browserProductFactSchema = z.discriminatedUnion('name', [
  z.strictObject({
    name: z.literal('librechat.session.activity'),
    feature: z.literal('session'),
    sessionId: z.uuid(),
    startedAt: z.iso.datetime(),
    lastActivityAt: z.iso.datetime(),
  }),
]);

/** Server facts follow confirmed settings writes. */
export const serverProductFactSchema = z.discriminatedUnion('name', [
  z.strictObject({
    name: z.literal('librechat.langfuse.connection.updated'),
    enabled: z.boolean(),
    configured: z.boolean(),
  }),
  z.strictObject({
    name: z.literal('librechat.langfuse.promptSync.updated'),
    enabled: z.boolean(),
  }),
]);

export type BrowserProductFact = z.infer<typeof browserProductFactSchema>;
export type ServerProductFact = z.infer<typeof serverProductFactSchema>;
export type ProductFact = BrowserProductFact | ServerProductFact;

/**
 * Every fact name is `librechat.<component>.<action>`. The component is one segment; the action
 * can have more than one segment (`librechat.langfuse.connection.updated`).
 */
export const PRODUCT_FACT_NAME_PATTERN = /^librechat\.[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

export type ProductFactNameParts = {
  namespace: 'librechat';
  component: string;
  action: string;
};

/** Splits a fact name by the format in `PRODUCT_FACT_NAME_PATTERN`. */
export function splitProductFactName(name: ProductFact['name']): ProductFactNameParts {
  const [, component, ...action] = name.split('.');
  return { namespace: 'librechat', component, action: action.join('.') };
}

export const productIdentitySchema = z.strictObject({
  userId: id.optional(),
  tenantId: id.optional(),
});

export const productDeviceSchema = z.strictObject({
  type: z.enum(['phone', 'tablet', 'desktop', 'unknown']),
  browser: z.enum(['Edge', 'Opera', 'Chrome', 'Firefox', 'Safari', 'Samsung Internet', 'Other']),
  os: z.enum(['iOS', 'Android', 'ChromeOS', 'Windows', 'macOS', 'Linux', 'Other']),
});

export const productTrackingContextSchema = z.strictObject({
  sessionId: z.uuid().optional(),
  submissionId: z.uuid().optional(),
});

export type ProductTrackingContext = z.infer<typeof productTrackingContextSchema>;

export const PRODUCT_SESSION_HEADER = 'x-librechat-product-session-id';
export const PRODUCT_SUBMISSION_HEADER = 'x-librechat-product-submission-id';

/** Correlation headers convey no identity or authorization. */
export function getProductTrackingHeaders(
  context?: ProductTrackingContext,
): Record<string, string> {
  const parsed = productTrackingContextSchema.safeParse(context);
  if (!parsed.success) return {};
  return {
    ...(parsed.data.sessionId ? { [PRODUCT_SESSION_HEADER]: parsed.data.sessionId } : {}),
    ...(parsed.data.submissionId ? { [PRODUCT_SUBMISSION_HEADER]: parsed.data.submissionId } : {}),
  };
}

export const productEventBaseSchema = z.strictObject({
  version: z.literal(1),
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  identity: productIdentitySchema,
  context: productTrackingContextSchema.optional(),
});

export type ProductEventBase = z.infer<typeof productEventBaseSchema>;

export const productEventSchema = z.discriminatedUnion('producer', [
  productEventBaseSchema.extend({
    producer: z.literal('browser'),
    fact: browserProductFactSchema,
    device: productDeviceSchema.optional(),
  }),
  productEventBaseSchema.extend({
    producer: z.literal('server'),
    fact: serverProductFactSchema,
  }),
]);

export type ProductEvent = z.infer<typeof productEventSchema>;
export type BrowserProductEvent = Extract<ProductEvent, { producer: 'browser' }>;
export type ServerProductEvent = Extract<ProductEvent, { producer: 'server' }>;
export type ProductIdentity = z.infer<typeof productIdentitySchema>;
export type ProductDevice = z.infer<typeof productDeviceSchema>;

/** Keeps each identity ID that satisfies the event contract and omits the others. */
export function toProductIdentity(userId?: string, tenantId?: string): ProductIdentity {
  const user = id.safeParse(userId);
  const tenant = id.safeParse(tenantId);
  return {
    ...(user.success ? { userId: user.data } : {}),
    ...(tenant.success ? { tenantId: tenant.data } : {}),
  };
}

/** Why the browser asks its sink to send queued events now. */
export type ProductFlushReason =
  /** The page is hidden. It can be discarded without a later event. */
  | 'hidden'
  /** The page is unloading or entering the back-forward cache. */
  | 'pagehide'
  /** The session ended because the user, the tenant or the session settings changed. */
  | 'session'
  /** The provider unmounted. */
  | 'unmount';

/**
 * The host's browser delivery. LibreChat builds each event, including its identity and device,
 * and tells the sink when the page lifecycle requires a send. Every lifecycle call comes after
 * the final `librechat.session.activity` for that moment, so a sink can send its queue at once.
 */
export interface BrowserProductSink {
  deliver(event: BrowserProductEvent): void | Promise<void>;
  /** Send queued events now: the page may not run another task. */
  flush?(reason: ProductFlushReason): void;
  /** The page is visible again after `flush('hidden')` or `flush('pagehide')`. */
  resume?(): void;
  /** Tracking was turned off: drop queued events. No final checkpoint precedes this call. */
  discard?(): void;
}
export type ProductTracker<T = ProductFact> = (
  event: T,
  context?: ProductTrackingContext,
) => void | Promise<void>;

export const noopProductTracker: ProductTracker = () => {};

/** Delivery is best effort. A tracker failure must never change the product result. */
export function safelyTrack<T>(
  track: ProductTracker<T> | undefined,
  event: T,
  context?: ProductTrackingContext,
): void {
  try {
    void Promise.resolve(context ? track?.(event, context) : track?.(event)).catch(() => {});
  } catch {
    // Trackers are supplied by the host and must not interrupt product actions.
  }
}
