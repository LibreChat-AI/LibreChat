import { Model } from 'mongoose';
import type { IChatProjectDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import chatProjectSchema from '~/schema/chatProject';

export function createChatProjectModel(
  mongoose: typeof import('mongoose'),
): Model<IChatProjectDocument> {
  applyTenantIsolation(chatProjectSchema);
  return (
    mongoose.models.ChatProject ||
    mongoose.model<IChatProjectDocument>('ChatProject', chatProjectSchema, 'chatprojects')
  );
}
