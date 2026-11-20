import { z } from 'zod';
import type { TProductTrackingPolicy, TTelemetryConfig } from './config';
import { chatBrowserFacts, chatServerFacts } from './tracking/chat';
import { PRODUCT_TRACKING_SESSION_DEFAULTS } from './config';

export type { ChatSubmissionKind, ChatBrowserFact, ChatServerFact } from './tracking/chat';

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
  ...chatBrowserFacts,
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
  ...chatServerFacts,
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
export type ProductIdentity = z.infer<typeof productIdentitySchema>;
export type ProductDevice = z.infer<typeof productDeviceSchema>;
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
