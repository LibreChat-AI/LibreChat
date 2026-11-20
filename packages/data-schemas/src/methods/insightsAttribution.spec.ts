import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { resolveInsightsAttributions, insightsIdentityKey } from './insightsAttribution';
import { createTransactionModel } from '../models/transaction';
import { createConversationMethods } from './conversation';
import { createConversationModel } from '../models/convo';
import { createTransactionMethods } from './transaction';
import { createMessageModel } from '../models/message';
import { createAgentModel } from '../models/agent';
import { createInsightsMethods } from './insights';
import { createUserModel } from '../models/user';
import { createMessageMethods } from './message';

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

it('derives immutable root hints for writes, ignores forged hints, and keeps spend of a deleted conversation', async () => {
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
  await mongoose.models.Message.deleteMany({ conversationId });
  const deleted = await methods.getInsights({ agentIds: ['agent-a'], showDetails: false });
  expect(deleted.summary.totalResponses).toBe(0);
  expect(deleted.summary.spendUSD).toBeGreaterThan(0);
});

it('gives records saved before their conversation the hint once the conversation is created', async () => {
  const messages = createMessageMethods(mongoose);
  const conversations = createConversationMethods(mongoose, messages);
  const transactions = createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  });
  const hintOf = async (collection: 'Message' | 'Transaction', messageId: string) =>
    (await mongoose.models[collection].collection.findOne({ messageId }))?.insightsAgentId;

  await messages.saveMessage(
    { userId: owner.toString() },
    { conversationId, messageId: 'first-prompt', isCreatedByUser: true },
  );
  await transactions.bulkInsertTransactions([
    {
      user: owner.toString(),
      conversationId,
      messageId: 'first-prompt',
      tokenType: 'prompt',
      tokenValue: -1,
    },
  ]);
  expect(await hintOf('Message', 'first-prompt')).toBeUndefined();
  expect(await hintOf('Transaction', 'first-prompt')).toBeUndefined();
  await conversations.saveConvo(
    { userId: owner.toString() },
    { conversationId, endpoint: 'agents', agent_id: 'agent-a' },
    { initialAgentId: 'agent-a' },
  );
  expect(await hintOf('Message', 'first-prompt')).toBe('agent-a');
  expect(await hintOf('Transaction', 'first-prompt')).toBe('agent-a');

  await messages.saveMessage(
    { userId: owner.toString() },
    {
      conversationId: '22222222-2222-4222-8222-222222222222',
      messageId: 'plain-prompt',
      isCreatedByUser: true,
    },
  );
  await conversations.saveConvo(
    { userId: owner.toString() },
    { conversationId: '22222222-2222-4222-8222-222222222222', endpoint: 'openAI' },
  );
  expect(await hintOf('Message', 'plain-prompt')).toBe('');

  await mongoose.models.Message.collection.updateOne(
    { messageId: 'first-prompt' },
    { $set: { insightsAgentId: 'kept' } },
  );
  await conversations.saveConvo(
    { userId: owner.toString() },
    { conversationId, endpoint: 'agents', agent_id: 'agent-a', title: 'Renamed' },
  );
  expect(await hintOf('Message', 'first-prompt')).toBe('kept');
});

it('attributes replies and usage saved after the conversation exists', async () => {
  const messages = createMessageMethods(mongoose);
  const conversations = createConversationMethods(mongoose, messages);
  await conversations.saveConvo(
    { userId: owner.toString() },
    { conversationId, endpoint: 'agents', agent_id: 'agent-a' },
    { initialAgentId: 'agent-a' },
  );
  await messages.saveMessage(
    { userId: owner.toString() },
    { conversationId, messageId: 'chat-reply', isCreatedByUser: false },
  );
  await createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  }).bulkInsertTransactions([
    {
      user: owner.toString(),
      conversationId,
      messageId: 'chat-reply',
      tokenType: 'completion',
      tokenValue: -2,
    },
  ]);
  expect(
    (await mongoose.models.Message.collection.findOne({ messageId: 'chat-reply' }))
      ?.insightsAgentId,
  ).toBe('agent-a');
  expect(
    (await mongoose.models.Transaction.collection.findOne({ messageId: 'chat-reply' }))
      ?.insightsAgentId,
  ).toBe('agent-a');
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
    {
      conversationId: 'temporary',
      user: owner.toString(),
      initial_agent_id: 'agent-a',
      isTemporary: true,
    },
  ]);
  const identities = [
    { conversationId: 'shared', user: owner.toString(), tenantId: 'tenant-a' },
    { conversationId: 'shared', user: owner.toString(), tenantId: 'tenant-b' },
    { conversationId: 'shared', user: owner.toString() },
    { conversationId: 'shared', user: 'outsider', tenantId: 'tenant-a' },
    { conversationId: 'unattributed', user: owner.toString() },
    { conversationId: 'child', user: owner.toString() },
    { conversationId: 'temporary', user: owner.toString() },
  ];
  const hints = await resolveInsightsAttributions(mongoose, identities);
  expect(identities.map((identity) => hints.get(insightsIdentityKey(identity)))).toEqual([
    'agent-a',
    'agent-b',
    undefined,
    undefined,
    '',
    '',
    '',
  ]);
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
