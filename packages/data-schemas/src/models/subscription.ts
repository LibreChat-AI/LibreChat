import { Schema } from 'mongoose';
import {
  subscriptionActors,
  subscriptionTargets,
  subscriptionCapSchema,
  subscriptionEventsSchema,
  subscriptionWindowSchema,
  subscriptionFiltersSchema,
  SUBSCRIPTION_PROMPT_MAX_LENGTH,
} from 'librechat-data-provider';
import type { Subscription } from 'librechat-data-provider';
import type { Model, Types } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface SubscriptionRecord extends Omit<Subscription, 'user'> {
  user: Types.ObjectId;
}

type Check = { safeParse: (value: unknown) => { success: boolean } };

/** Holds a write that bypasses the request schemas to the same bounds. */
const within = (schema: Check) => (value: unknown) => schema.safeParse(value).success;

export function createAgentEventSubscriptionModel(
  mongoose: typeof import('mongoose'),
): Model<SubscriptionRecord> {
  const existing = mongoose.models.AgentEventSubscription as Model<SubscriptionRecord> | undefined;
  if (existing) return existing;
  const schema = new Schema<SubscriptionRecord>(
    {
      id: { type: String, required: true },
      user: { type: Schema.Types.ObjectId, required: true },
      tenantId: String,
      connection: { type: String, required: true },
      agentId: { type: String, required: true },
      events: { type: [String], required: true, validate: within(subscriptionEventsSchema) },
      filters: {
        type: Schema.Types.Mixed,
        default: undefined,
        validate: within(subscriptionFiltersSchema),
      },
      target: { type: String, enum: subscriptionTargets, required: true },
      prompt: { type: String, required: true, maxlength: SUBSCRIPTION_PROMPT_MAX_LENGTH },
      actors: { type: String, enum: subscriptionActors, required: true },
      bots: { type: Boolean, required: true },
      cap: {
        type: Schema.Types.Mixed,
        default: undefined,
        validate: within(subscriptionCapSchema),
      },
      window: {
        type: Schema.Types.Mixed,
        default: undefined,
        validate: within(subscriptionWindowSchema),
      },
      enabled: { type: Boolean, required: true },
      /** Moved only by an owner's edit, so a run can tell it started under an older one. */
      revision: { type: Number, required: true },
    },
    { timestamps: true },
  );
  schema.index({ id: 1 }, { unique: true });
  // Routing: the enabled subscriptions on a connection that listen for one event type.
  schema.index({ connection: 1, enabled: 1, events: 1 });
  // An owner's subscriptions, for one agent or for all of them.
  schema.index({ user: 1, agentId: 1 });
  applyTenantIsolation(schema);
  return mongoose.model<SubscriptionRecord>('AgentEventSubscription', schema);
}
