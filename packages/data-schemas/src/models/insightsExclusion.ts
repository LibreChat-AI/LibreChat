import { Schema } from 'mongoose';
import type { Model } from 'mongoose';

export interface InsightsExclusion {
  conversationId: string;
  user: string;
  tenantId?: string;
  createdAt: Date;
}

export function createInsightsExclusionModel(
  mongoose: typeof import('mongoose'),
): Model<InsightsExclusion> {
  if (mongoose.models.InsightsExclusion) {
    return mongoose.model<InsightsExclusion>('InsightsExclusion');
  }
  const schema = new Schema<InsightsExclusion>(
    {
      conversationId: { type: String, required: true },
      user: { type: String, required: true },
      tenantId: { type: String },
      createdAt: { type: Date, required: true },
    },
    { versionKey: false },
  );
  schema.index(
    { conversationId: 1, user: 1, tenantId: 1 },
    { unique: true, name: 'insights_exclusion' },
  );
  schema.index({ tenantId: 1, createdAt: 1 }, { name: 'insights_exclusion_period' });
  return mongoose.model<InsightsExclusion>('InsightsExclusion', schema);
}
