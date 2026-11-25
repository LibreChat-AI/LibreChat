import { Schema } from 'mongoose';
import type { Watch } from 'librechat-data-provider';
import type { Model, Types } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface WatchRecord extends Omit<Watch, 'user' | 'createdAt' | 'expiresAt'> {
  user: Types.ObjectId;
  createdAt: Date;
  /** Read by the TTL index: the server removes the watch once this time has passed. */
  expiresAt: Date;
}

/** Longest display label kept for a watched item, such as `owner/repo#123`. */
export const WATCH_LABEL_MAX_LENGTH = 256;
/** Longest stored page address of a watched item. */
export const WATCH_URL_MAX_LENGTH = 2048;

export function createAgentEventWatchModel(
  mongoose: typeof import('mongoose'),
): Model<WatchRecord> {
  const existing = mongoose.models.AgentEventWatch as Model<WatchRecord> | undefined;
  if (existing) return existing;
  const schema = new Schema<WatchRecord>(
    {
      id: { type: String, required: true },
      user: { type: Schema.Types.ObjectId, required: true },
      tenantId: String,
      conversationId: { type: String, required: true },
      agentId: { type: String, required: true },
      subscription: { type: String, required: true },
      connection: { type: String, required: true },
      item: { type: String, required: true },
      label: { type: String, required: true, maxlength: WATCH_LABEL_MAX_LENGTH },
      url: { type: String, maxlength: WATCH_URL_MAX_LENGTH },
      expiresAt: { type: Date, required: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
  );
  schema.index({ id: 1 }, { unique: true });
  // Routing: the watches on a connection that follow one item. Read for every routed event.
  schema.index({ connection: 1, item: 1 });
  // One watch per item in a conversation, and a conversation's watches for its owner.
  schema.index({ user: 1, conversationId: 1, item: 1 }, { unique: true });
  // A subscription's watches, removed with it.
  schema.index({ subscription: 1 });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  applyTenantIsolation(schema);
  return mongoose.model<WatchRecord>('AgentEventWatch', schema, 'agenteventwatches');
}
