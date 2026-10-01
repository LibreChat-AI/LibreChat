import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import mongoMeili from '~/models/plugins/mongoMeili';
import messageSchema from '~/schema/message';

export function createMessageModel(mongoose: typeof import('mongoose')): Model<t.IMessage> {
  applyTenantIsolation(messageSchema);
  const csfleEnabled = (process.env.CSFLE_ENABLED ?? '').trim().toLowerCase() === 'true';
  if (process.env.MEILI_HOST && process.env.MEILI_MASTER_KEY && !csfleEnabled) {
    messageSchema.plugin(mongoMeili, {
      mongoose,
      host: process.env.MEILI_HOST,
      apiKey: process.env.MEILI_MASTER_KEY,
      indexName: 'messages',
      primaryKey: 'messageId',
      excludeFromIndexPath: 'subagentTask',
    });
  }

  return mongoose.models.Message || mongoose.model<t.IMessage>('Message', messageSchema);
}
