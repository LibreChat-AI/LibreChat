import { z } from 'zod';
import type { TProductTrackingConfig, TTelemetryConfig } from './config';
import { featureBrowserFacts, featureServerFacts } from './tracking/features';
import { promptBrowserFacts, promptServerFacts } from './tracking/prompts';
import { skillBrowserFacts, skillServerFacts } from './tracking/skills';
import { chatBrowserFacts, chatServerFacts } from './tracking/chat';

export { productBuiltinToolNameSchema } from './tracking/privacy';
export type { ProductBuiltinToolName } from './tracking/privacy';

export type { ProductPromptReference } from './tracking/prompts';
export type { ChatSubmissionKind, ChatBrowserFact, ChatServerFact } from './tracking/chat';
export type { SkillServerFact, SkillSyncFact } from './tracking/skills';

/** Product events are off unless the deployment explicitly enables them. */
export function getProductTrackingConfig(telemetry?: TTelemetryConfig): TProductTrackingConfig {
  return {
    enabled: telemetry?.productTracking?.enabled === true,
    session: {
      shareAcrossTabs: telemetry?.productTracking?.session?.shareAcrossTabs ?? true,
      idleTimeoutMs: telemetry?.productTracking?.session?.idleTimeoutMs ?? 1800000,
      activityIntervalMs: telemetry?.productTracking?.session?.activityIntervalMs ?? 60000,
    },
  };
}

const id = z.string().min(1).max(128);
const feature = z.enum(['skills', 'prompts']);

/** Browser observations never establish that a write or model execution succeeded. */
export const browserProductFactSchema = z.discriminatedUnion('name', [
  ...promptBrowserFacts,
  ...skillBrowserFacts,
  ...chatBrowserFacts,
  ...featureBrowserFacts,
  z.strictObject({
    name: z.literal('librechat.session.activity'),
    feature: z.literal('session'),
    sessionId: z.uuid(),
    startedAt: z.iso.datetime(),
    lastActivityAt: z.iso.datetime(),
  }),
  z.strictObject({
    name: z.literal('librechat.feature.observed'),
    feature,
    observation: z.enum(['available', 'opened']),
    entryPoint: z.enum(['sidebar', 'panel', 'settings', 'picker', 'route', 'chat']),
  }),
]);

/** Server facts follow confirmed settings writes. */
export const serverProductFactSchema = z.discriminatedUnion('name', [
  ...promptServerFacts,
  ...skillServerFacts,
  ...chatServerFacts,
  ...featureServerFacts,
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
