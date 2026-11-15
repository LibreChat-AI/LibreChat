import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { resolveInsightsAttributions, insightsIdentityKey } from './attribution';
import { createTransactionModel } from '../../models/transaction';
import { createConversationModel } from '../../models/convo';
import { createMessageModel } from '../../models/message';
import { createTransactionMethods } from '../transaction';
import { backfillInsightsAttribution } from './backfill';
import { createAgentModel } from '../../models/agent';
import { createUserModel } from '../../models/user';
import { createInsightsMethods } from '../insights';
import { createMessageMethods } from '../message';

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

it('derives immutable root hints for writes, ignores forged hints, and validates a deleted conversation at read time', async () => {
  await mongoose.models.Conversation.collection.insertOne({
    conversationId,
    user: owner.toString(),
    initial_agent_id: 'agent-a',
    agent_id: 'agent-b',
    createdAt: new Date(),
  });
  const messages = createMessageMethods(mongoose);
  await messages.saveMessage(
    { userId: owner.toString() },
    {
      conversationId,
      messageId: 'reply',
      isCreatedByUser: false,
      tokenCount: 8,
      insightsAgentId: 'forged-agent',
    },
  );
  const transactions = createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  });
  await transactions.bulkInsertTransactions([
    {
      user: owner.toString(),
      conversationId,
      messageId: 'reply',
      tokenType: 'completion',
      tokenValue: -8,
      rawAmount: -8,
      model: 'model-a',
      ...{ insightsAgentId: 'forged-agent' },
    },
  ]);
  expect(
    (await mongoose.models.Message.collection.findOne({ messageId: 'reply' }))?.insightsAgentId,
  ).toBe('agent-a');
  expect(
    (await mongoose.models.Transaction.collection.findOne({ messageId: 'reply' }))?.insightsAgentId,
  ).toBe('agent-a');
  const methods = createInsightsMethods(mongoose);
  expect(
    (await methods.getInsights({ agentIds: ['agent-a'], showDetails: false })).summary
      .totalResponses,
  ).toBe(1);
  await mongoose.models.Conversation.deleteMany({});
  const deleted = await methods.getInsights({ agentIds: ['agent-a'], showDetails: false });
  expect(deleted.summary.totalResponses).toBe(0);
  expect(deleted.summary.spendUSD).toBeNull();
});

it('keeps legacy attribution live when a conversation switches agents', async () => {
  await mongoose.models.Conversation.collection.insertOne({
    conversationId,
    user: owner.toString(),
    agent_id: 'agent-a',
  });
  await createMessageMethods(mongoose).saveMessage(
    { userId: owner.toString() },
    {
      conversationId,
      messageId: 'legacy-reply',
      isCreatedByUser: false,
      insightsAgentId: 'forged-agent',
    },
  );
  expect(
    await mongoose.models.Message.collection.findOne({ messageId: 'legacy-reply' }),
  ).not.toHaveProperty('insightsAgentId');
  const methods = createInsightsMethods(mongoose);
  expect(
    (await methods.getInsights({ agentIds: ['agent-a'], showDetails: false })).summary
      .totalResponses,
  ).toBe(1);
  await mongoose.models.Conversation.updateOne(
    { conversationId },
    { $set: { agent_id: 'agent-b' } },
  );
  expect(
    (await methods.getInsights({ agentIds: ['agent-a'], showDetails: false })).summary
      .totalResponses,
  ).toBe(0);
  expect(
    (await methods.getInsights({ agentIds: ['agent-b'], showDetails: false })).summary
      .totalResponses,
  ).toBe(1);
});

it('reuses the trusted loaded conversation for message and batched usage writes', async () => {
  const conversation = { conversationId, user: owner.toString(), initial_agent_id: 'agent-a' };
  await mongoose.models.Conversation.collection.insertOne(conversation);
  const find = jest.spyOn(mongoose.models.Conversation.collection, 'find');
  await createMessageMethods(mongoose).saveMessage(
    {
      userId: owner.toString(),
      insightsConversation: conversation,
    },
    { conversationId, messageId: 'cached', isCreatedByUser: false },
  );
  await createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  }).bulkInsertTransactions([
    {
      user: owner.toString(),
      conversationId,
      messageId: 'cached',
      tokenType: 'prompt',
      tokenValue: -1,
      insightsConversation: conversation,
    },
    {
      user: owner.toString(),
      conversationId,
      messageId: 'cached',
      tokenType: 'completion',
      tokenValue: -2,
      insightsConversation: conversation,
    },
  ]);
  expect(find).not.toHaveBeenCalled();
  const transactions = await mongoose.models.Transaction.collection
    .find({ messageId: 'cached' })
    .toArray();
  expect(transactions).toHaveLength(2);
  for (const transaction of transactions) {
    expect(transaction.insightsAgentId).toBe('agent-a');
    expect(transaction).not.toHaveProperty('insightsConversation');
  }
});

it('resolves only matching tenant/owner identities and distinguishes unattributed from legacy records', async () => {
  await mongoose.models.Conversation.collection.insertMany([
    {
      conversationId: 'shared',
      user: owner.toString(),
      tenantId: 'tenant-a',
      initial_agent_id: 'agent-a',
    },
    {
      conversationId: 'shared',
      user: owner.toString(),
      tenantId: 'tenant-b',
      initial_agent_id: 'agent-b',
    },
    {
      conversationId: 'unattributed',
      user: owner.toString(),
      initial_agent_id: null,
      agent_id: 'agent-a',
    },
    {
      conversationId: 'child',
      user: owner.toString(),
      initial_agent_id: 'agent-a',
      subagentThread: null,
    },
  ]);
  const identities = [
    { conversationId: 'shared', user: owner.toString(), tenantId: 'tenant-a' },
    { conversationId: 'shared', user: owner.toString(), tenantId: 'tenant-b' },
    { conversationId: 'shared', user: owner.toString() },
    { conversationId: 'shared', user: 'outsider', tenantId: 'tenant-a' },
    { conversationId: 'unattributed', user: owner.toString() },
    { conversationId: 'child', user: owner.toString() },
  ];
  const hints = await resolveInsightsAttributions(mongoose, identities);
  expect(identities.map((identity) => hints.get(insightsIdentityKey(identity)))).toEqual([
    'agent-a',
    'agent-b',
    undefined,
    undefined,
    '',
    '',
  ]);
});

it('backfills in resumable batches without changing metrics and is idempotent', async () => {
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
  const before = await methods.getInsights(options);
  const dry = await backfillInsightsAttribution(mongoose, { collection: 'messages', batchSize: 2 });
  expect(dry.updated).toBe(2);
  expect(
    await mongoose.models.Message.collection.countDocuments({ insightsAgentId: { $exists: true } }),
  ).toBe(0);
  let after: string | undefined;
  do {
    const result = await backfillInsightsAttribution(mongoose, {
      collection: 'messages',
      batchSize: 2,
      after,
      apply: true,
    });
    after = result.nextAfter;
  } while (after);
  expect((await methods.getInsights(options)).summary).toEqual(before.summary);
  expect(
    await mongoose.models.Message.collection.countDocuments({ insightsAgentId: 'agent-a' }),
  ).toBe(2);
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
  expect(await mongoose.models.Message.collection.findOne({ messageId: 'c' })).not.toHaveProperty(
    'insightsAgentId',
  );
});

it('uses the root-period index without reading unrelated agents or old messages', async () => {
  const now = new Date();
  const history = new Date(now.getTime() - 365 * 86400000);
  await mongoose.models.Conversation.collection.insertMany([
    { conversationId, user: owner.toString(), initial_agent_id: 'agent-a', createdAt: history },
    {
      conversationId: 'other',
      user: owner.toString(),
      initial_agent_id: 'agent-b',
      createdAt: history,
    },
  ]);
  await mongoose.models.Message.collection.insertMany([
    {
      conversationId,
      user: owner.toString(),
      messageId: 'recent',
      isCreatedByUser: false,
      createdAt: now,
      insightsAgentId: 'agent-a',
    },
    ...Array.from({ length: 1000 }, (_, i) => ({
      conversationId,
      user: owner.toString(),
      messageId: `old-${i}`,
      createdAt: history,
      insightsAgentId: 'agent-a',
    })),
    ...Array.from({ length: 1000 }, (_, i) => ({
      conversationId,
      user: owner.toString(),
      messageId: `unindexed-old-${i}`,
      createdAt: history,
    })),
    ...Array.from({ length: 1000 }, (_, i) => ({
      conversationId: 'other',
      user: owner.toString(),
      messageId: `other-${i}`,
      createdAt: now,
      insightsAgentId: 'agent-b',
    })),
  ]);
  const spy = jest.spyOn(mongoose.models.Message, 'aggregate');
  const result = await createInsightsMethods(mongoose).getInsights({
    agentIds: ['agent-a'],
    showDetails: false,
  });
  expect(result.summary.totalMessages).toBe(1);
  const pipeline = spy.mock.calls[0][0];
  if (!pipeline) throw new Error('Missing message query');
  type ExecutionStats = { totalDocsExamined: number };
  const plan: {
    executionStats?: ExecutionStats;
    stages?: Array<{ $cursor?: { executionStats?: ExecutionStats } }>;
  } = await mongoose.models.Message.aggregate(pipeline).explain('executionStats');
  expect(JSON.stringify(plan)).toContain('insights_root_period');
  const examined =
    plan.executionStats?.totalDocsExamined ??
    plan.stages?.find((stage) => stage.$cursor)?.$cursor?.executionStats?.totalDocsExamined;
  expect(examined).toBeDefined();
  expect(examined).toBeLessThan(20);
});
