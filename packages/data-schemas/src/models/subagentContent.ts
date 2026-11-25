import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface ISubagentContentChunk {
  _id: string;
  user: string;
  tenantId?: string;
  parentConversationId: string;
  conversationId: string;
  taskId: string;
  revision: number;
  /** -1 is the commit record, published only after every payload fragment exists. */
  fragment: number;
  fragments: number;
  fromSequence: number;
  throughSequence: number;
  digest: string;
  payload?: string;
  expiredAt?: Date;
}

export function createSubagentContentModel(
  mongoose: typeof import('mongoose'),
): Model<ISubagentContentChunk> {
  if (mongoose.models.SubagentContent != null) return mongoose.models.SubagentContent;
  const schema = new Schema<ISubagentContentChunk>(
    {
      _id: { type: String, required: true },
      user: { type: String, required: true },
      tenantId: String,
      parentConversationId: { type: String, required: true },
      conversationId: { type: String, required: true },
      taskId: { type: String, required: true },
      revision: { type: Number, required: true },
      fragment: { type: Number, required: true },
      fragments: { type: Number, required: true },
      fromSequence: { type: Number, required: true },
      throughSequence: { type: Number, required: true },
      digest: { type: String, required: true },
      payload: String,
      expiredAt: Date,
    },
    { versionKey: false },
  );
  schema.index(
    { tenantId: 1, user: 1, conversationId: 1, taskId: 1, revision: 1, fragment: 1 },
    { unique: true },
  );
  schema.index(
    {
      tenantId: 1,
      user: 1,
      parentConversationId: 1,
      conversationId: 1,
      taskId: 1,
      throughSequence: 1,
    },
    { name: 'subagent_content_sequence', partialFilterExpression: { fragment: -1 } },
  );
  schema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
  applyTenantIsolation(schema);
  return mongoose.model<ISubagentContentChunk>('SubagentContent', schema);
}
