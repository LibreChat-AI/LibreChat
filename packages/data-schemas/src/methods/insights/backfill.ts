import { Types } from 'mongoose';
import type { AnyBulkWriteOperation, Collection, Document } from 'mongodb';
import type { InsightsRecordIdentity } from './attribution';
import { resolveInsightsAttributions, insightsIdentityKey } from './attribution';
import { runAsSystem } from '~/config/tenantContext';

type IndexedRecord = InsightsRecordIdentity & { _id: Types.ObjectId; insightsAgentId?: string };
type BatchResult = { processed: number; updated: number; nextAfter?: string };

export type InsightsBackfillOptions = {
  /** Run `conversations` first: it gives legacy agent conversations a fixed root agent, which
   *  the message and transaction passes then copy onto their records. */
  collection: 'conversations' | 'messages' | 'transactions';
  after?: string;
  batchSize: number;
  apply?: boolean;
};

/** One resumable batch. Native collection reads deliberately cover every tenant. */
export async function backfillInsightsAttribution(
  mongoose: typeof import('mongoose'),
  options: InsightsBackfillOptions,
): Promise<BatchResult> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error('Insights backfill batchSize must be a positive integer');
  }
  if (options.after && !mongoose.Types.ObjectId.isValid(options.after)) {
    throw new Error('Insights backfill cursor must be an ObjectId');
  }
  const db = mongoose.connection.db;
  if (!db) throw new Error('Insights backfill requires a database connection');
  if (options.collection === 'conversations') {
    return backfillLegacyRootAgents(db, options);
  }
  const collection = db.collection<IndexedRecord>(options.collection);
  const records = await collection
    .find(options.after ? { _id: { $gt: new mongoose.Types.ObjectId(options.after) } } : {}, {
      projection: { _id: 1, conversationId: 1, user: 1, tenantId: 1, insightsAgentId: 1 },
    })
    .sort({ _id: 1 })
    .limit(options.batchSize)
    .toArray();
  const attributions = await runAsSystem(async () =>
    resolveInsightsAttributions(mongoose, records),
  );
  const operations: AnyBulkWriteOperation<IndexedRecord>[] = [];
  for (const record of records) {
    const hint = attributions.get(insightsIdentityKey(record));
    if (hint === record.insightsAgentId) continue;
    operations.push({
      updateOne: {
        filter: {
          _id: record._id,
          conversationId: record.conversationId ?? { $exists: false },
          user: record.user ?? { $exists: false },
          tenantId: record.tenantId ?? { $exists: false },
        },
        update:
          hint === undefined
            ? { $unset: { insightsAgentId: '' } }
            : { $set: { insightsAgentId: hint } },
      },
    });
  }
  return finishBatch(collection, records, operations, options);
}

type LegacyConversation = { _id: Types.ObjectId; agent_id?: unknown; initial_agent_id?: unknown };

/** Legacy agent conversations predate `initial_agent_id`; their root is their current agent. */
async function backfillLegacyRootAgents(
  db: NonNullable<(typeof import('mongoose'))['connection']['db']>,
  options: InsightsBackfillOptions,
): Promise<BatchResult> {
  const collection = db.collection<LegacyConversation>('conversations');
  const conversations = await collection
    .find(
      {
        ...(options.after && { _id: { $gt: new Types.ObjectId(options.after) } }),
        initial_agent_id: { $exists: false },
      },
      { projection: { _id: 1, agent_id: 1 } },
    )
    .sort({ _id: 1 })
    .limit(options.batchSize)
    .toArray();
  const operations: AnyBulkWriteOperation<LegacyConversation>[] = [];
  for (const conversation of conversations) {
    const agentId = conversation.agent_id;
    if (typeof agentId !== 'string' || agentId.trim() === '') continue;
    operations.push({
      updateOne: {
        filter: { _id: conversation._id, initial_agent_id: { $exists: false }, agent_id: agentId },
        update: { $set: { initial_agent_id: agentId } },
      },
    });
  }
  return finishBatch(collection, conversations, operations, options);
}

async function finishBatch<T extends Document>(
  collection: Collection<T>,
  documents: Array<{ _id: Types.ObjectId }>,
  operations: AnyBulkWriteOperation<T>[],
  options: InsightsBackfillOptions,
): Promise<BatchResult> {
  const result =
    options.apply && operations.length > 0
      ? // This explicit cross-tenant migration uses native records and identity-scoped filters.
        // eslint-disable-next-line no-restricted-syntax
        await collection.bulkWrite(operations, { ordered: false })
      : undefined;
  return {
    processed: documents.length,
    updated: result?.modifiedCount ?? operations.length,
    ...(documents.length === options.batchSize && {
      nextAfter: documents[documents.length - 1]?._id.toString(),
    }),
  };
}
