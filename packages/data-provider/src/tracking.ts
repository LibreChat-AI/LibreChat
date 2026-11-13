import { z } from 'zod';
import type { TProductTrackingConfig, TTelemetryConfig } from './config';

/** Product events are off unless the deployment explicitly enables them. */
export function getProductTrackingConfig(telemetry?: TTelemetryConfig): TProductTrackingConfig {
  return { enabled: telemetry?.productTracking?.enabled === true };
}

const id = z.string().min(1).max(128);
const feature = z.enum(['skills', 'prompts']);

/** Browser observations never establish that a write or model execution succeeded. */
export const browserProductFactSchema = z.discriminatedUnion('name', [
  z.strictObject({
    name: z.literal('librechat.feature.observed'),
    feature,
    observation: z.enum(['available', 'opened']),
    entryPoint: z.enum(['sidebar', 'panel', 'settings', 'picker', 'route', 'chat']),
  }),
]);

/** Server facts follow confirmed settings writes. */
export const serverProductFactSchema = z.discriminatedUnion('name', [
  z.strictObject({
    name: z.literal('librechat.langfuse.connection.changed'),
    enabled: z.boolean(),
    configured: z.boolean(),
  }),
  z.strictObject({
    name: z.literal('librechat.langfuse.promptSync.changed'),
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

const envelope = {
  version: z.literal(1),
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  identity: productIdentitySchema,
};

export const productEventSchema = z.discriminatedUnion('producer', [
  z.strictObject({
    ...envelope,
    producer: z.literal('browser'),
    fact: browserProductFactSchema,
    device: productDeviceSchema.optional(),
  }),
  z.strictObject({
    ...envelope,
    producer: z.literal('server'),
    fact: serverProductFactSchema,
  }),
]);

export type ProductEvent = z.infer<typeof productEventSchema>;
export type ProductIdentity = z.infer<typeof productIdentitySchema>;
export type ProductDevice = z.infer<typeof productDeviceSchema>;
export type ProductTracker<T = ProductFact> = (event: T) => void | Promise<void>;

export const noopProductTracker: ProductTracker = () => {};

/** Delivery is best effort. A tracker failure must never change the product result. */
export function safelyTrack<T>(track: ProductTracker<T> | undefined, event: T): void {
  try {
    void Promise.resolve(track?.(event)).catch(() => {});
  } catch {
    // Trackers are supplied by the host and must not interrupt product actions.
  }
}
