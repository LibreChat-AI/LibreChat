import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import toolCallSchema, { IToolCallData } from '~/schema/toolCall';

export function createToolCallModel(mongoose: typeof import('mongoose')): Model<IToolCallData> {
  applyTenantIsolation(toolCallSchema);
  return mongoose.models.ToolCall || mongoose.model<IToolCallData>('ToolCall', toolCallSchema);
}
