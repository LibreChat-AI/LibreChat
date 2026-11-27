import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import mongoMeili from '~/models/plugins/mongoMeili';
import convoSchema from '~/schema/convo';

export function createConversationModel(
  mongoose: typeof import('mongoose'),
): Model<t.IConversation> {
  applyTenantIsolation(convoSchema);
  if (process.env.MEILI_HOST && process.env.MEILI_MASTER_KEY) {
    convoSchema.plugin(mongoMeili, {
      mongoose,
      host: process.env.MEILI_HOST,
      apiKey: process.env.MEILI_MASTER_KEY,
      /** Note: Will get created automatically if it doesn't exist already */
      indexName: 'convos',
      primaryKey: 'conversationId',
      excludeFromIndexPath: 'subagentThread',
    });
  }
  return (
    mongoose.models.Conversation || mongoose.model<t.IConversation>('Conversation', convoSchema)
  );
}
