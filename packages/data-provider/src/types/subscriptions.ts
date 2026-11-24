import { z } from 'zod';
import { partialWithoutDefaults } from '../zod';

/** Where a subscription's turn lands: a new conversation for each delivery. */
export const subscriptionTargets = ['new'] as const;
export type SubscriptionTarget = (typeof subscriptionTargets)[number];

/**
 * Whose events may start a run: accounts linked to a user here, accounts with write access
 * to the item's repository, or anyone.
 */
export const subscriptionActors = ['linked', 'write', 'any'] as const;
export type SubscriptionActors = (typeof subscriptionActors)[number];

/**
 * Bounds on what one subscription stores. They keep a row and its index entries small; the
 * limits an operator sets on run volume are applied where runs are admitted.
 */
export const SUBSCRIPTION_ID_MAX_LENGTH = 256;
export const SUBSCRIPTION_EVENTS_MAX = 32;
export const SUBSCRIPTION_EVENT_MAX_LENGTH = 128;
export const SUBSCRIPTION_FILTER_MAX = 50;
export const SUBSCRIPTION_FILTER_MAX_LENGTH = 256;
export const SUBSCRIPTION_PROMPT_MAX_LENGTH = 32000;
export const SUBSCRIPTION_CAP_MAX = 1000;
export const SUBSCRIPTION_WINDOW_MAX_MS = 60 * 60 * 1000;

const unique = (values: string[]): string[] => Array.from(new Set(values));

const subscriptionFilterSchema = z
  .array(z.string().trim().min(1).max(SUBSCRIPTION_FILTER_MAX_LENGTH))
  .min(1)
  .max(SUBSCRIPTION_FILTER_MAX)
  .transform(unique);

/**
 * Narrows the events a subscription acts on. A dimension left out does not narrow; one that
 * is given matches an event whose value is any of its entries.
 */
export const subscriptionFiltersSchema = z
  .object({
    repositories: subscriptionFilterSchema.optional(),
    branches: subscriptionFilterSchema.optional(),
    labels: subscriptionFilterSchema.optional(),
  })
  .strict();
export type SubscriptionFilters = z.infer<typeof subscriptionFiltersSchema>;

/** Event types, as the provider's catalog names them. */
export const subscriptionEventsSchema = z
  .array(z.string().trim().min(1).max(SUBSCRIPTION_EVENT_MAX_LENGTH))
  .min(1)
  .max(SUBSCRIPTION_EVENTS_MAX)
  .transform(unique);

/** Most runs the subscription may start in an hour. */
export const subscriptionCapSchema = z
  .object({ perHour: z.number().int().min(1).max(SUBSCRIPTION_CAP_MAX) })
  .strict();
export type SubscriptionCap = z.infer<typeof subscriptionCapSchema>;

/** How long deliveries about one item are gathered into a single turn. */
export const subscriptionWindowSchema = z
  .object({ ms: z.number().int().min(0).max(SUBSCRIPTION_WINDOW_MAX_MS) })
  .strict();
export type SubscriptionWindow = z.infer<typeof subscriptionWindowSchema>;

export const subscriptionCreateSchema = z
  .object({
    connection: z.string().trim().min(1).max(SUBSCRIPTION_ID_MAX_LENGTH),
    agentId: z.string().trim().min(1).max(SUBSCRIPTION_ID_MAX_LENGTH),
    /** Whether each is a type the connection's provider sends is for the caller to check. */
    events: subscriptionEventsSchema,
    filters: subscriptionFiltersSchema.optional(),
    target: z.enum(subscriptionTargets).default('new'),
    prompt: z.string().trim().min(1).max(SUBSCRIPTION_PROMPT_MAX_LENGTH),
    /** Left out, the deployment's rule is stored with the subscription. */
    actors: z.enum(subscriptionActors).optional(),
    /** Whether an event caused by a bot account may start a run. */
    bots: z.boolean().default(false),
    cap: subscriptionCapSchema.optional(),
    window: subscriptionWindowSchema.optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type SubscriptionCreate = z.infer<typeof subscriptionCreateSchema>;
/** What a client sends to create one: fields with a default may be left out. */
export type SubscriptionCreateInput = z.input<typeof subscriptionCreateSchema>;

/**
 * An edit. A subscription stays on the connection and agent it was created for. `null`
 * clears a field that may be left out, and the deployment's value then applies.
 */
export const subscriptionUpdateSchema = partialWithoutDefaults(
  subscriptionCreateSchema.omit({ connection: true, agentId: true }),
)
  .extend({
    filters: subscriptionFiltersSchema.nullable().optional(),
    cap: subscriptionCapSchema.nullable().optional(),
    window: subscriptionWindowSchema.nullable().optional(),
    /** The revision the edit was made from. A newer one on the server refuses the edit. */
    expectedRevision: z.number().int().min(0).optional(),
  })
  /** The fence alone changes nothing, so it is not an edit. Nor is a field sent as undefined. */
  .refine((input) =>
    Object.entries(input).some(([key, value]) => key !== 'expectedRevision' && value !== undefined),
  );
export type SubscriptionUpdate = z.infer<typeof subscriptionUpdateSchema>;
export type SubscriptionUpdateInput = z.input<typeof subscriptionUpdateSchema>;

/** A standing instruction: when these events arrive on a connection, run this agent. */
export interface Subscription {
  id: string;
  /** The user who created it. Its runs act as this user. */
  user: string;
  tenantId?: string;
  /** The connection whose deliveries it listens to. */
  connection: string;
  agentId: string;
  events: string[];
  filters?: SubscriptionFilters;
  target: SubscriptionTarget;
  prompt: string;
  actors: SubscriptionActors;
  bots: boolean;
  cap?: SubscriptionCap;
  window?: SubscriptionWindow;
  enabled: boolean;
  /** Moves forward with every edit, so a run can tell it started under an older one. */
  revision: number;
}

export interface SubscriptionsResponse {
  subscriptions: Subscription[];
}
