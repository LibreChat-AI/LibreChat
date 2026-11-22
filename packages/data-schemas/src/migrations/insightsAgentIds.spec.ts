import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { backfillInsightsAttribution } from './insightsAgentIds';
import { createTransactionModel } from '~/models/transaction';
import { createInsightsMethods } from '~/methods/insights';
import { createConversationModel } from '~/models/convo';
import { createMessageModel } from '~/models/message';
import { createAgentModel } from '~/models/agent';
import { createUserModel } from '~/models/user';

const conversationId = '11111111-1111-4111-8111-111111111111';
const owner = new mongoose.Types.ObjectId();
let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all([
    createConversationModel(mongoose).init(),
    createMessageModel(mongoose).init(),
    createTransactionModel(mongoose).init(),
    createAgentModel(mongoose).init(),
    createUserModel(mongoose).init(),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
});

it('backfills in resumable batches, fixes legacy roots and is idempotent', async () => {
  const now = new Date();
  await mongoose.models.Conversation.collection.insertMany([
    { conversationId, user: owner.toString(), initial_agent_id: 'agent-a', createdAt: now },
    { conversationId: 'legacy', user: owner.toString(), agent_id: 'agent-a', createdAt: now },
  ]);
  await mongoose.models.Message.collection.insertMany([
    {
      conversationId,
      user: owner.toString(),
      messageId: 'a',
      isCreatedByUser: false,
      createdAt: now,
      tokenCount: 4,
    },
    {
      conversationId,
      user: owner.toString(),
      messageId: 'b',
      isCreatedByUser: true,
      createdAt: now,
      tokenCount: 5,
    },
    {
      conversationId: 'legacy',
      user: owner.toString(),
      messageId: 'c',
      isCreatedByUser: false,
      createdAt: now,
    },
  ]);
  const methods = createInsightsMethods(mongoose);
  const options = { agentIds: ['agent-a'], showDetails: false as const };
  expect((await methods.getInsights(options)).summary.totalMessages).toBe(0);
  const dry = await backfillInsightsAttribution(mongoose, {
    collection: 'conversations',
    batchSize: 2,
  });
  expect(dry.updated).toBe(1);
  expect(
    await mongoose.models.Conversation.collection.countDocuments({
      initial_agent_id: { $exists: true },
    }),
  ).toBe(1);
  for (const collection of ['conversations', 'messages'] as const) {
    let after: string | undefined;
    do {
      const result = await backfillInsightsAttribution(mongoose, {
        collection,
        batchSize: 2,
        after,
        apply: true,
      });
      after = result.nextAfter;
    } while (after);
  }
  const summary = (await methods.getInsights(options)).summary;
  expect(summary.totalMessages).toBe(3);
  expect(summary.totalResponses).toBe(2);
  expect(
    await mongoose.models.Message.collection.countDocuments({ insightsAgentId: 'agent-a' }),
  ).toBe(3);
  expect(
    (
      await backfillInsightsAttribution(mongoose, {
        collection: 'messages',
        batchSize: 10,
        apply: true,
      })
    ).updated,
  ).toBe(0);
  await mongoose.models.Message.collection.updateOne(
    { messageId: 'c' },
    { $set: { insightsAgentId: 'stale-agent' } },
  );
  await backfillInsightsAttribution(mongoose, {
    collection: 'messages',
    batchSize: 10,
    apply: true,
  });
  expect(
    (await mongoose.models.Message.collection.findOne({ messageId: 'c' }))?.insightsAgentId,
  ).toBe('agent-a');

  await mongoose.models.Conversation.updateOne(
    { conversationId: 'legacy' },
    { $set: { agent_id: 'agent-b' } },
  );
  for (const collection of ['conversations', 'messages'] as const) {
    await backfillInsightsAttribution(mongoose, { collection, batchSize: 10, apply: true });
  }
  expect((await methods.getInsights(options)).summary.totalMessages).toBe(3);
});

it('keeps the spend of a deleted conversation when the backfill runs again', async () => {
  await mongoose.models.Transaction.collection.insertOne({
    user: owner,
    conversationId,
    messageId: 'reply',
    tokenType: 'completion',
    tokenValue: -8,
    createdAt: new Date(),
    insightsAgentId: 'agent-a',
  });
  await backfillInsightsAttribution(mongoose, {
    collection: 'transactions',
    batchSize: 10,
    apply: true,
  });
  const { summary } = await createInsightsMethods(mongoose).getInsights({
    agentIds: ['agent-a'],
    showDetails: false,
  });
  expect(summary.spendUSD).toBeGreaterThan(0);
});
