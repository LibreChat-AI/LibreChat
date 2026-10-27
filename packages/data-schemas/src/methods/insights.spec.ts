import mongoose from 'mongoose';
import { FEEDBACK_TAGS } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TFeedbackTagKey } from 'librechat-data-provider';
import { createTransactionModel } from '../models/transaction';
import { createConversationModel } from '../models/convo';
import { createMessageModel } from '../models/message';
import { createInsightsMethods } from './insights';
import { createUserModel } from '../models/user';

let mongoServer: MongoMemoryServer;
const selectedAgents = [{ id: 'agent-a', name: 'Agent A' }];
const feedbackCounts = (
  thumbsUp = 0,
  thumbsDown = 0,
  counts: Partial<Record<TFeedbackTagKey, number>> = {},
) => ({
  thumbsUp,
  thumbsDown,
  categories: FEEDBACK_TAGS.map(({ key }) => ({ key, count: counts[key] ?? 0 })),
});
const noResponses = {
  responses: 0,
  completedResponses: 0,
  failedResponses: 0,
  interruptedResponses: 0,
  feedback: feedbackCounts(),
  spendUSD: null,
};

const fixtures = {
  conversations: {
    insertOne: (document: Record<string, unknown>) =>
      mongoose.models.Conversation.collection.insertOne({ agent_id: 'agent-a', ...document }),
    insertMany: (documents: Array<Record<string, unknown>>) =>
      mongoose.models.Conversation.collection.insertMany(
        documents.map((document) => ({ agent_id: 'agent-a', ...document })),
      ),
  },
  messages: {
    insertOne: (document: Record<string, unknown>) =>
      mongoose.models.Message.collection.insertOne({
        ...(document.isCreatedByUser === false ? { model: 'agent-a' } : {}),
        ...document,
      }),
    insertMany: (documents: Array<Record<string, unknown>>) =>
      mongoose.models.Message.collection.insertMany(
        documents.map((document) => ({
          ...(document.isCreatedByUser === false ? { model: 'agent-a' } : {}),
          ...document,
        })),
      ),
  },
};

function createScopedInsightsMethods() {
  const methods = createInsightsMethods(mongoose);
  return {
    getInsights: (options: Parameters<typeof methods.getInsights>[0]) =>
      methods.getInsights({
        ...options,
        showDetails: true,
        agents: selectedAgents,
        agentIds: ['agent-a'],
      }),
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const models = [
    createConversationModel(mongoose),
    createMessageModel(mongoose),
    createUserModel(mongoose),
    createTransactionModel(mongoose),
  ];
  await Promise.all(models.map((model) => model.init()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await Promise.all([
    mongoose.models.Conversation.deleteMany({}),
    mongoose.models.Message.deleteMany({}),
    mongoose.models.User.deleteMany({}),
    mongoose.models.Transaction.deleteMany({}),
  ]);
});

describe('Insights methods', () => {
  it.each([
    ['valid root', {}, [], 1, 1],
    ['legacy root', { agent_id: 'agent-a' }, ['initial_agent_id'], 1, 1],
    ['older conversation', { createdAt: new Date('2026-09-01T12:00:00Z') }, [], 0, 1],
    ['temporary conversation', { isTemporary: true }, [], 0, 0],
    ['subagent thread', { subagentThread: { parentConversationId: 'parent' } }, [], 0, 0],
    ['explicit null thread field', { subagentThread: null }, [], 0, 0],
    ['foreign tenant', { tenantId: 'tenant-b' }, [], 0, 0],
    ['missing tenant', {}, ['tenantId'], 0, 0],
    ['missing owner', {}, ['user'], 0, 0],
    ['null owner', { user: null }, [], 0, 0],
    ['empty owner', { user: '' }, [], 0, 0],
    ['missing conversation ID', {}, ['conversationId'], 0, 0],
    ['null conversation ID', { conversationId: null }, [], 0, 0],
    ['empty conversation ID', { conversationId: '' }, [], 0, 0],
    ['null initial attribution', { initial_agent_id: null, agent_id: 'agent-a' }, [], 0, 0],
    ['empty initial attribution', { initial_agent_id: '', agent_id: 'agent-a' }, [], 0, 0],
    ['another root agent', { initial_agent_id: 'agent-b', agent_id: 'agent-a' }, [], 0, 0],
    ['missing attribution', {}, ['initial_agent_id', 'agent_id'], 0, 0],
  ] as const)(
    'uses one conversation eligibility rule across counts, messages and spend: %s',
    async (_name, overrides, omitted, conversations, activityCount) => {
      const user = new mongoose.Types.ObjectId();
      const activity = new Date('2026-10-03T12:00:00Z');
      const conversation: Record<string, unknown> = {
        conversationId: 'shared-eligibility',
        user: user.toString(),
        tenantId: 'tenant-a',
        initial_agent_id: 'agent-a',
        agent_id: 'agent-b',
        createdAt: activity,
        updatedAt: new Date('2026-10-15T12:00:00Z'),
        ...overrides,
      };
      for (const field of omitted) delete conversation[field];
      // Native inserts deliberately exercise missing bindings that schema validation rejects.
      await mongoose.models.Conversation.collection.insertOne(conversation);
      const message = {
        conversationId: conversation.conversationId,
        user: user.toString(),
        tenantId: 'tenant-a',
        createdAt: activity,
      };
      await fixtures.messages.insertMany([
        { ...message, messageId: 'scope-prompt', isCreatedByUser: true, tokenCount: 5 },
        {
          ...message,
          messageId: 'scope-response',
          isCreatedByUser: false,
          model: 'agent-b',
          tokenCount: 7,
          error: true,
          feedback: { rating: 'thumbsDown', tag: 'inaccurate' },
        },
      ]);
      await mongoose.models.Transaction.collection.insertOne({
        conversationId: conversation.conversationId,
        user,
        tenantId: 'tenant-a',
        createdAt: activity,
        tokenType: 'completion',
        tokenValue: -250_000,
      });
      const result = await createInsightsMethods(mongoose).getInsights({
        tenantId: 'tenant-a',
        agentIds: ['agent-a'],
        showDetails: false,
        range: 'custom',
        fromTimestamp: '2026-10-01T00:00:00Z',
        toTimestamp: '2026-10-07T23:59:59Z',
      });
      expect(result.summary).toEqual({
        totalConversations: conversations,
        totalMessages: activityCount * 2,
        totalUsers: activityCount,
        totalTokens: activityCount * 12,
        totalResponses: activityCount,
        completedResponses: 0,
        failedResponses: activityCount,
        interruptedResponses: 0,
        lastUsed: activityCount ? activity.toISOString() : null,
        feedback: feedbackCounts(0, activityCount, { inaccurate: activityCount }),
        spendUSD: activityCount ? 0.25 : null,
      });
      expect(result.daily.find((day) => day.date === '2026-10-03')).toEqual({
        date: '2026-10-03',
        conversations,
        messages: activityCount * 2,
        users: activityCount,
        totalTokens: activityCount * 12,
        responses: activityCount,
        completedResponses: 0,
        failedResponses: activityCount,
        interruptedResponses: 0,
        feedback: feedbackCounts(0, activityCount, { inaccurate: activityCount }),
        spendUSD: activityCount ? 0.25 : null,
      });
      expect(Object.keys(result).sort()).toEqual(['agents', 'daily', 'summary']);
    },
  );

  it.each(['message-owner', 'message-tenant', 'transaction-owner', 'transaction-tenant'] as const)(
    'retains the record-specific ownership and tenant check: %s',
    async (mismatch) => {
      const user = new mongoose.Types.ObjectId();
      const outsider = new mongoose.Types.ObjectId();
      const activity = new Date('2026-10-03T12:00:00Z');
      await fixtures.conversations.insertOne({
        conversationId: 'record-isolation',
        user: user.toString(),
        tenantId: 'tenant-a',
        initial_agent_id: 'agent-a',
        createdAt: activity,
      });
      await fixtures.messages.insertOne({
        messageId: 'record-response',
        conversationId: 'record-isolation',
        createdAt: activity,
        user: mismatch === 'message-owner' ? outsider.toString() : user.toString(),
        tenantId: mismatch === 'message-tenant' ? 'tenant-b' : 'tenant-a',
        isCreatedByUser: false,
        tokenCount: 5,
      });
      await mongoose.models.Transaction.collection.insertOne({
        conversationId: 'record-isolation',
        createdAt: activity,
        user: mismatch === 'transaction-owner' ? outsider : user,
        tenantId: mismatch === 'transaction-tenant' ? 'tenant-b' : 'tenant-a',
        tokenType: 'completion',
        tokenValue: -250_000,
      });
      const result = await createInsightsMethods(mongoose).getInsights({
        tenantId: 'tenant-a',
        agentIds: ['agent-a'],
        showDetails: false,
        range: 'custom',
        fromTimestamp: '2026-10-01T00:00:00Z',
        toTimestamp: '2026-10-07T23:59:59Z',
      });
      expect(result.summary.totalConversations).toBe(1);
      expect(result.summary.totalMessages).toBe(mismatch.startsWith('message') ? 0 : 1);
      expect(result.summary.totalTokens).toBe(mismatch.startsWith('message') ? 0 : 5);
      expect(result.summary.spendUSD).toBe(mismatch.startsWith('transaction') ? null : 0.25);
    },
  );

  it.each([
    [
      'initial agent takes precedence',
      { initial_agent_id: 'agent-a', agent_id: 'agent-b' },
      'agent-a',
    ],
    ['initial agent works without a current agent', { initial_agent_id: 'agent-a' }, 'agent-a'],
    [
      'initial agent works with a cleared current agent',
      { initial_agent_id: 'agent-a', agent_id: null },
      'agent-a',
    ],
    ['legacy agent A', { agent_id: 'agent-a' }, 'agent-a'],
    ['legacy agent B', { agent_id: 'agent-b' }, 'agent-b'],
    [
      'initial agent B takes precedence',
      { initial_agent_id: 'agent-b', agent_id: 'agent-a' },
      'agent-b',
    ],
    ['explicit null initial agent', { initial_agent_id: null, agent_id: 'agent-a' }, null],
    ['explicit empty initial agent', { initial_agent_id: '', agent_id: 'agent-a' }, null],
    ['missing attribution', {}, null],
    ['null legacy agent', { agent_id: null }, null],
    ['empty legacy agent', { agent_id: '' }, null],
  ] as const)(
    'attributes conversations, prompts and responses to the root: %s',
    async (_name, attribution, root) => {
      const now = new Date();
      const user = new mongoose.Types.ObjectId().toString();
      const conversation = {
        _id: new mongoose.Types.ObjectId(),
        conversationId: 'root-selection',
        tenantId: 'tenant-a',
        user,
        createdAt: now,
        updatedAt: now,
        isTemporary: false,
        ...attribution,
      };
      // Bypass the fixture's legacy-agent default so missing fields really remain absent.
      await mongoose.models.Conversation.collection.insertOne(conversation);
      await fixtures.messages.insertOne({
        messageId: 'root-prompt',
        conversationId: conversation.conversationId,
        tenantId: 'tenant-a',
        user,
        createdAt: now,
        isCreatedByUser: true,
        isTemporary: false,
        tokenCount: 5,
      });
      await fixtures.messages.insertOne({
        messageId: 'root-response',
        conversationId: conversation.conversationId,
        tenantId: 'tenant-a',
        user,
        createdAt: now,
        isCreatedByUser: false,
        isTemporary: false,
        model: 'agent-unrelated',
        tokenCount: 7,
        feedback: { rating: 'thumbsUp', tag: 'accurate_reliable' },
      });
      await mongoose.models.Transaction.collection.insertOne({
        conversationId: conversation.conversationId,
        tenantId: 'tenant-a',
        user: new mongoose.Types.ObjectId(user),
        tokenType: 'completion',
        tokenValue: -250_000,
        createdAt: now,
      });
      const methods = createInsightsMethods(mongoose);
      for (const agentId of ['agent-a', 'agent-b']) {
        const result = await methods.getInsights({
          showDetails: false,
          tenantId: 'tenant-a',
          range: '7d',
          agentIds: [agentId],
          agents: [{ id: agentId, name: agentId }],
        });
        const count = root === agentId ? 1 : 0;
        expect(result.summary).toEqual({
          totalConversations: count,
          totalMessages: count * 2,
          totalUsers: count,
          totalTokens: count * 12,
          totalResponses: count,
          completedResponses: count,
          failedResponses: 0,
          interruptedResponses: 0,
          lastUsed: count ? now.toISOString() : null,
          feedback: feedbackCounts(count, 0, { accurate_reliable: count }),
          spendUSD: count ? 0.25 : null,
        });
      }
      expect(
        await mongoose.models.Conversation.collection.findOne({ _id: conversation._id }),
      ).toEqual(conversation);
    },
  );

  it('returns the same aggregate totals without querying detail, identities or first-message text', async () => {
    const now = new Date();
    const userId = new mongoose.Types.ObjectId();
    const privateValue = 'private-content-sentinel';
    await mongoose.models.User.collection.insertOne({
      _id: userId,
      tenantId: 'tenant-a',
      name: privateValue,
      email: `${privateValue}@example.com`,
    });
    await fixtures.conversations.insertOne({
      conversationId: privateValue,
      user: userId.toString(),
      tenantId: 'tenant-a',
      initial_agent_id: 'agent-a',
      createdAt: now,
      updatedAt: now,
      isTemporary: false,
    });
    await fixtures.messages.insertMany([
      {
        messageId: 'prompt',
        conversationId: privateValue,
        user: userId.toString(),
        tenantId: 'tenant-a',
        createdAt: now,
        isCreatedByUser: true,
        isTemporary: false,
        text: privateValue,
        tokenCount: 3,
      },
      {
        messageId: 'response',
        model: 'agent-b',
        conversationId: privateValue,
        user: userId.toString(),
        tenantId: 'tenant-a',
        createdAt: now,
        isCreatedByUser: false,
        isTemporary: false,
        text: privateValue,
        tokenCount: 5,
        feedback: {
          rating: 'thumbsDown',
          tag: { key: 'inaccurate', label: privateValue, icon: privateValue },
          text: privateValue,
        },
      },
    ]);
    const methods = createInsightsMethods(mongoose);
    const options = {
      tenantId: 'tenant-a',
      range: '7d' as const,
      agents: selectedAgents,
      agentIds: ['agent-a'],
    };
    await mongoose.models.Transaction.collection.insertOne({
      conversationId: privateValue,
      user: userId,
      tenantId: 'tenant-a',
      messageId: privateValue,
      model: privateValue,
      tokenType: 'prompt',
      tokenValue: -1_250_000,
      createdAt: now,
    });
    const detailed = await methods.getInsights({ ...options, showDetails: true });
    const userFind = jest.spyOn(mongoose.models.User, 'find');
    const conversationAggregate = jest.spyOn(mongoose.models.Conversation, 'aggregate');
    const messageAggregate = jest.spyOn(mongoose.models.Message, 'aggregate');
    const aggregate = await methods.getInsights({
      ...options,
      showDetails: false,
      search: privateValue,
      page: 50,
      pageSize: 50,
    });
    expect(aggregate).toEqual({
      agents: detailed.agents,
      summary: detailed.summary,
      daily: detailed.daily,
    });
    expect(aggregate.summary).toEqual({
      totalUsers: 1,
      totalConversations: 1,
      totalMessages: 2,
      totalTokens: 8,
      totalResponses: 1,
      completedResponses: 1,
      failedResponses: 0,
      interruptedResponses: 0,
      lastUsed: now.toISOString(),
      feedback: feedbackCounts(0, 1, { inaccurate: 1 }),
      spendUSD: 1.25,
    });
    expect(Object.keys(aggregate).sort()).toEqual(['agents', 'daily', 'summary']);
    expect(JSON.stringify(aggregate)).not.toContain(privateValue);
    expect(userFind).not.toHaveBeenCalled();
    expect(conversationAggregate).toHaveBeenCalledTimes(2);
    expect(messageAggregate).toHaveBeenCalledTimes(3);
    const pipelines = [...conversationAggregate.mock.calls, ...messageAggregate.mock.calls];
    const serialized = JSON.stringify(pipelines);
    expect(serialized).not.toContain('matchedIdentity');
    expect(serialized).not.toContain('firstMessage');
    expect(serialized).not.toContain('"$first"');
    expect(serialized).not.toContain('"$limit"');
  });

  it('omits detail sections for an empty aggregate result', async () => {
    const result = await createInsightsMethods(mongoose).getInsights({
      showDetails: false,
      tenantId: 'tenant-a',
      agentIds: ['agent-a'],
    });
    expect(result.summary).toEqual({
      totalUsers: 0,
      totalConversations: 0,
      totalMessages: 0,
      totalTokens: 0,
      totalResponses: 0,
      completedResponses: 0,
      failedResponses: 0,
      interruptedResponses: 0,
      lastUsed: null,
      feedback: feedbackCounts(),
      spendUSD: null,
    });
    expect(result).not.toHaveProperty('topUsers');
    expect(result).not.toHaveProperty('churnedUsers');
    expect(result).not.toHaveProperty('latest');
  });

  it.each([false, true])(
    'derives response outcomes and period activity without exposing content (showDetails=%s)',
    async (showDetails) => {
      const user = new mongoose.Types.ObjectId().toString();
      const privateValue = 'private-response-text';
      const createdAt = new Date('2026-09-01T12:00:00Z');
      await fixtures.conversations.insertOne({
        conversationId: 'outcomes',
        tenantId: 'tenant-a',
        user,
        initial_agent_id: 'agent-a',
        agent_id: 'agent-b',
        createdAt,
        updatedAt: new Date('2026-10-15T12:00:00Z'),
      });
      const firstDay = new Date('2026-10-02T12:00:00Z');
      const secondDay = new Date('2026-10-03T12:00:00Z');
      const latestPrompt = new Date('2026-10-04T12:00:00Z');
      const base = {
        conversationId: 'outcomes',
        tenantId: 'tenant-a',
        user,
        isCreatedByUser: false,
        model: 'agent-b',
        text: privateValue,
      };
      await mongoose.models.Message.collection.insertMany([
        { ...base, messageId: 'completed', createdAt: firstDay, error: false, unfinished: false },
        { ...base, messageId: 'legacy-completed', createdAt: firstDay },
        { ...base, messageId: 'failed', createdAt: firstDay, error: true, unfinished: false },
        {
          ...base,
          messageId: 'failed-overlap',
          createdAt: secondDay,
          error: true,
          unfinished: true,
        },
        { ...base, messageId: 'partial', createdAt: secondDay, error: false, unfinished: true },
        {
          ...base,
          messageId: 'tool-limit',
          createdAt: secondDay,
          unfinished: true,
          finish_reason: 'tool_call_limit',
        },
        { ...base, messageId: 'legacy-partial', createdAt: secondDay, unfinished: true },
        {
          ...base,
          messageId: 'prompt-with-flags',
          createdAt: firstDay,
          isCreatedByUser: true,
          error: true,
          unfinished: true,
        },
        { ...base, messageId: 'latest-prompt', createdAt: latestPrompt, isCreatedByUser: true },
        {
          conversationId: 'outcomes',
          tenantId: 'tenant-a',
          user,
          messageId: 'unknown-role',
          createdAt: firstDay,
        },
        { ...base, messageId: 'before-period', createdAt, error: true },
        { ...base, messageId: 'after-period', createdAt: new Date('2026-10-08T00:00:00Z') },
      ]);
      const methods = createInsightsMethods(mongoose);
      const options = {
        showDetails,
        tenantId: 'tenant-a',
        range: 'custom' as const,
        fromTimestamp: '2026-10-01T00:00:00Z',
        toTimestamp: '2026-10-07T23:59:59Z',
      };
      const root = await methods.getInsights({ ...options, agentIds: ['agent-a'] });
      const combined = await methods.getInsights({ ...options, agentIds: ['agent-a', 'agent-b'] });
      expect(root.summary).toEqual({
        totalUsers: 1,
        totalConversations: 0,
        totalMessages: 10,
        totalTokens: 0,
        totalResponses: 7,
        completedResponses: 2,
        failedResponses: 2,
        interruptedResponses: 3,
        lastUsed: latestPrompt.toISOString(),
        feedback: feedbackCounts(),
        spendUSD: null,
      });
      expect(combined.summary).toEqual(root.summary);
      expect(combined.daily).toEqual(root.daily);
      expect(root.daily.find((day) => day.date === '2026-10-02')).toEqual({
        date: '2026-10-02',
        conversations: 0,
        users: 1,
        messages: 5,
        totalTokens: 0,
        responses: 3,
        completedResponses: 2,
        failedResponses: 1,
        interruptedResponses: 0,
        feedback: feedbackCounts(),
        spendUSD: null,
      });
      expect(root.daily.find((day) => day.date === '2026-10-03')).toEqual({
        date: '2026-10-03',
        conversations: 0,
        users: 1,
        messages: 4,
        totalTokens: 0,
        responses: 4,
        completedResponses: 0,
        failedResponses: 1,
        interruptedResponses: 3,
        feedback: feedbackCounts(),
        spendUSD: null,
      });
      expect(root.daily.find((day) => day.date === '2026-10-04')).toEqual(
        expect.objectContaining({ messages: 1, responses: 0 }),
      );
      for (const day of root.daily) {
        expect(day.responses).toBe(
          day.completedResponses + day.failedResponses + day.interruptedResponses,
        );
      }
      const answeringAgent = await methods.getInsights({ ...options, agentIds: ['agent-b'] });
      expect(answeringAgent.summary).toEqual(
        expect.objectContaining({ totalResponses: 0, lastUsed: null }),
      );
      expect(JSON.stringify(root)).not.toContain(privateValue);
      if (!showDetails) {
        expect(Object.keys(root).sort()).toEqual(['agents', 'daily', 'summary']);
      }
    },
  );

  it.each([false, true])(
    'counts registered feedback on root-attributed responses by message date (showDetails=%s)',
    async (showDetails) => {
      const user = new mongoose.Types.ObjectId().toString();
      const privateValue = 'private-feedback-sentinel';
      const createdAt = new Date('2026-09-01T12:00:00Z');
      const firstDay = new Date('2026-10-02T12:00:00Z');
      const secondDay = new Date('2026-10-03T12:00:00Z');
      await fixtures.conversations.insertOne({
        conversationId: 'historical-feedback',
        user,
        tenantId: 'tenant-a',
        initial_agent_id: 'agent-a',
        agent_id: 'agent-b',
        createdAt,
        updatedAt: new Date('2026-10-15T12:00:00Z'),
      });
      const base = {
        conversationId: 'historical-feedback',
        user,
        tenantId: 'tenant-a',
        model: 'agent-b',
        isCreatedByUser: false,
        createdAt: secondDay,
        text: privateValue,
      };
      await fixtures.messages.insertMany([
        ...FEEDBACK_TAGS.map(({ key, direction }) => ({
          ...base,
          messageId: key,
          createdAt: firstDay,
          feedback: { rating: direction, tag: key, text: privateValue },
        })),
        {
          ...base,
          messageId: 'object-tag',
          error: true,
          feedback: {
            rating: 'thumbsDown',
            tag: {
              key: 'inaccurate',
              label: privateValue,
              icon: privateValue,
              direction: 'thumbsUp',
            },
            text: privateValue,
          },
        },
        { ...base, messageId: 'rating-only', feedback: { rating: 'thumbsUp' } },
        {
          ...base,
          messageId: 'unknown-tag',
          feedback: { rating: 'thumbsDown', tag: privateValue, text: privateValue },
        },
        {
          ...base,
          messageId: 'mismatched-tag',
          feedback: { rating: 'thumbsUp', tag: 'inaccurate' },
        },
        {
          ...base,
          messageId: 'unknown-rating',
          feedback: { rating: privateValue, tag: 'inaccurate' },
        },
        { ...base, messageId: 'removed-feedback', feedback: null },
        { ...base, messageId: 'no-feedback' },
        {
          ...base,
          messageId: 'prompt-feedback',
          isCreatedByUser: true,
          feedback: { rating: 'thumbsUp', tag: 'accurate_reliable' },
        },
        {
          ...base,
          messageId: 'before-range-feedback',
          createdAt,
          updatedAt: secondDay,
          feedback: { rating: 'thumbsDown', tag: 'inaccurate' },
        },
        {
          ...base,
          messageId: 'after-range-feedback',
          createdAt: new Date('2026-10-08T00:00:00Z'),
          feedback: { rating: 'thumbsDown', tag: 'inaccurate' },
        },
      ]);
      const methods = createInsightsMethods(mongoose);
      const options = {
        showDetails,
        tenantId: 'tenant-a',
        range: 'custom' as const,
        fromTimestamp: '2026-10-01T00:00:00Z',
        toTimestamp: '2026-10-07T23:59:59Z',
      };
      const root = await methods.getInsights({ ...options, agentIds: ['agent-a'] });
      expect(root.summary.totalConversations).toBe(0);
      expect(root.summary.feedback).toEqual({
        thumbsUp: 6,
        thumbsDown: 9,
        categories: FEEDBACK_TAGS.map(({ key }) => ({ key, count: key === 'inaccurate' ? 2 : 1 })),
      });
      expect(root.daily.find((day) => day.date === '2026-10-02')?.feedback).toEqual({
        thumbsUp: 4,
        thumbsDown: 7,
        categories: FEEDBACK_TAGS.map(({ key }) => ({ key, count: 1 })),
      });
      expect(root.daily.find((day) => day.date === '2026-10-03')?.feedback).toEqual(
        feedbackCounts(2, 2, { inaccurate: 1 }),
      );
      expect(root.daily.find((day) => day.date === '2026-10-01')?.feedback).toEqual(
        feedbackCounts(),
      );
      const answeringAgent = await methods.getInsights({ ...options, agentIds: ['agent-b'] });
      expect(answeringAgent.summary.feedback).toEqual(feedbackCounts());
      const combined = await methods.getInsights({ ...options, agentIds: ['agent-a', 'agent-b'] });
      expect(combined.summary.feedback).toEqual(root.summary.feedback);
      expect(combined.daily).toEqual(root.daily);
      expect(JSON.stringify(root)).not.toContain(privateValue);
      if (!showDetails) expect(Object.keys(root).sort()).toEqual(['agents', 'daily', 'summary']);
    },
  );

  it('ignores malformed category values without discarding recognized ratings', async () => {
    const now = new Date();
    const user = new mongoose.Types.ObjectId().toString();
    await fixtures.conversations.insertOne({
      conversationId: 'malformed-feedback',
      user,
      tenantId: 'tenant-a',
      createdAt: now,
    });
    const tags = [
      null,
      123,
      {},
      { key: 123 },
      ['accurate_reliable'],
      [{ key: 'accurate_reliable' }],
      { key: ['accurate_reliable'] },
    ];
    await fixtures.messages.insertMany(
      tags.map((tag, index) => ({
        messageId: `malformed-${index}`,
        conversationId: 'malformed-feedback',
        user,
        tenantId: 'tenant-a',
        createdAt: now,
        isCreatedByUser: false,
        feedback: { rating: 'thumbsUp', tag },
      })),
    );
    const result = await createInsightsMethods(mongoose).getInsights({
      tenantId: 'tenant-a',
      agentIds: ['agent-a'],
      showDetails: false,
    });
    expect(result.summary.feedback).toEqual(feedbackCounts(7));
  });

  it('reflects changed and removed feedback on responses created in the selected period', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    const createdAt = new Date('2026-10-03T12:00:00Z');
    await fixtures.conversations.insertOne({
      conversationId: 'updated-feedback',
      user,
      tenantId: 'tenant-a',
      createdAt,
    });
    await fixtures.messages.insertOne({
      messageId: 'updated-feedback-response',
      conversationId: 'updated-feedback',
      user,
      tenantId: 'tenant-a',
      createdAt,
      isCreatedByUser: false,
      feedback: { rating: 'thumbsUp', tag: 'accurate_reliable' },
    });
    const methods = createInsightsMethods(mongoose);
    const options = {
      tenantId: 'tenant-a',
      agentIds: ['agent-a'],
      showDetails: false as const,
      range: 'custom' as const,
      fromTimestamp: '2026-10-01T00:00:00Z',
      toTimestamp: '2026-10-07T23:59:59Z',
    };
    expect((await methods.getInsights(options)).summary.feedback).toEqual(
      feedbackCounts(1, 0, { accurate_reliable: 1 }),
    );
    await mongoose.models.Message.collection.updateOne(
      { messageId: 'updated-feedback-response', user },
      {
        $set: {
          feedback: { rating: 'thumbsDown', tag: 'inaccurate', text: 'private feedback' },
          updatedAt: new Date('2026-10-15T12:00:00Z'),
        },
      },
    );
    expect((await methods.getInsights(options)).summary.feedback).toEqual(
      feedbackCounts(0, 1, { inaccurate: 1 }),
    );
    await mongoose.models.Message.collection.updateOne(
      { messageId: 'updated-feedback-response', user },
      { $set: { feedback: null } },
    );
    expect((await methods.getInsights(options)).summary.feedback).toEqual(feedbackCounts());
  });

  it.each([false, true])(
    'counts recorded spend by root and transaction date without requiring recent messages (showDetails=%s)',
    async (showDetails) => {
      const user = new mongoose.Types.ObjectId();
      const privateValue = 'private-transaction-sentinel';
      await fixtures.conversations.insertOne({
        conversationId: 'historical-spend',
        user: user.toString(),
        tenantId: 'tenant-a',
        initial_agent_id: 'agent-a',
        agent_id: 'agent-b',
        createdAt: new Date('2026-09-01T12:00:00Z'),
        updatedAt: new Date('2026-10-15T12:00:00Z'),
      });
      await fixtures.messages.insertOne({
        messageId: 'old-response',
        conversationId: 'historical-spend',
        user: user.toString(),
        tenantId: 'tenant-a',
        isCreatedByUser: false,
        model: 'agent-b',
        tokenCount: 1_000,
        createdAt: new Date('2026-09-30T12:00:00Z'),
      });
      const base = {
        conversationId: 'historical-spend',
        user,
        tenantId: 'tenant-a',
        messageId: 'old-response',
        model: privateValue,
        context: privateValue,
        tokenType: 'completion',
        tokenValue: -100_000_000,
        createdAt: new Date('2026-10-03T07:30:00Z'),
      };
      await mongoose.models.Transaction.collection.insertMany([
        { ...base, tokenValue: -500_000, createdAt: new Date('2026-10-01T07:00:00Z') },
        {
          ...base,
          tokenType: 'prompt',
          tokenValue: -1_250_000,
          rawAmount: -1,
          rate: 999,
          createdAt: new Date('2026-10-03T06:30:00Z'),
        },
        {
          ...base,
          tokenType: 'prompt',
          tokenValue: -2_750_000,
          inputTokens: -100,
          writeTokens: -50,
          readTokens: -50,
        },
        { ...base, tokenValue: -250_000, context: 'incomplete', rawAmount: -1_000, rate: 200 },
        {
          ...base,
          tokenValue: 0,
          messageId: 'deleted-message',
          createdAt: new Date('2026-10-04T12:00:00Z'),
        },
        { ...base, tokenValue: -125_000, createdAt: new Date('2026-10-08T06:59:59Z') },
        { ...base, createdAt: new Date('2026-10-01T06:59:59Z') },
        { ...base, createdAt: new Date('2026-10-08T07:00:00Z') },
        { ...base, tokenType: 'credits', tokenValue: 100_000_000 },
        { ...base, tokenType: 'credits', context: 'balanceReset' },
        { ...base, tokenValue: 100_000_000 },
        { ...base, tokenType: 'unknown' },
        { ...base, tokenType: ['prompt', 'credits'] },
        { ...base, tokenType: null },
        { ...base, tokenValue: privateValue },
        { ...base, tokenValue: '-100000000' },
        { ...base, tokenValue: [-100_000_000] },
        { ...base, tokenValue: { amount: -100_000_000 } },
        { ...base, tokenValue: null },
        { ...base, tokenValue: Number.NaN },
        { ...base, tokenValue: Number.NEGATIVE_INFINITY },
        { ...base, tokenValue: Number.POSITIVE_INFINITY },
      ]);
      const methods = createInsightsMethods(mongoose);
      const options = {
        showDetails,
        tenantId: 'tenant-a',
        range: 'custom' as const,
        fromTimestamp: '2026-10-01T07:00:00Z',
        toTimestamp: '2026-10-08T06:59:59Z',
        timeZone: 'America/Los_Angeles',
      };
      const root = await methods.getInsights({ ...options, agentIds: ['agent-a'] });
      expect(root.summary).toEqual(
        expect.objectContaining({
          totalConversations: 0,
          totalMessages: 0,
          totalTokens: 0,
          lastUsed: null,
          spendUSD: 4.875,
        }),
      );
      expect(root.daily.map(({ date, spendUSD }) => ({ date, spendUSD }))).toEqual([
        { date: '2026-10-01', spendUSD: 0.5 },
        { date: '2026-10-02', spendUSD: 1.25 },
        { date: '2026-10-03', spendUSD: 3 },
        { date: '2026-10-04', spendUSD: 0 },
        { date: '2026-10-05', spendUSD: null },
        { date: '2026-10-06', spendUSD: null },
        { date: '2026-10-07', spendUSD: 0.125 },
      ]);
      const answeringAgent = await methods.getInsights({ ...options, agentIds: ['agent-b'] });
      expect(answeringAgent.summary.spendUSD).toBeNull();
      const combined = await methods.getInsights({
        ...options,
        agentIds: ['agent-a', 'agent-b', 'agent-a'],
      });
      expect(combined.summary.spendUSD).toBe(root.summary.spendUSD);
      expect(combined.daily).toEqual(root.daily);
      expect(JSON.stringify(root)).not.toContain(privateValue);
      if (!showDetails) expect(Object.keys(root).sort()).toEqual(['agents', 'daily', 'summary']);
    },
  );

  it.each([
    ['absent', [], null],
    ['credits only', [{ tokenType: 'credits', tokenValue: -100_000 }], null],
    ['unpriced', [{ tokenType: 'prompt' }, { tokenType: 'completion', tokenValue: null }], null],
    ['free', [{ tokenType: 'prompt', tokenValue: 0 }], 0],
  ] as const)(
    'distinguishes unavailable from recorded zero spend: %s',
    async (_name, rows, expected) => {
      const now = new Date();
      const user = new mongoose.Types.ObjectId();
      await fixtures.conversations.insertOne({
        conversationId: 'spend-availability',
        user: user.toString(),
        tenantId: 'tenant-a',
        createdAt: now,
      });
      if (rows.length)
        await mongoose.models.Transaction.collection.insertMany(
          rows.map((row) => ({
            conversationId: 'spend-availability',
            user,
            tenantId: 'tenant-a',
            createdAt: now,
            ...row,
          })),
        );
      const result = await createInsightsMethods(mongoose).getInsights({
        tenantId: 'tenant-a',
        agentIds: ['agent-a'],
        showDetails: false,
      });
      expect(result.summary.spendUSD).toBe(expected);
      expect(
        result.daily.find((day) => day.date === now.toISOString().slice(0, 10))?.spendUSD,
      ).toBe(expected);
    },
  );

  it('isolates spend by conversation owner, tenant and eligibility before combining agents', async () => {
    const now = new Date();
    const first = new mongoose.Types.ObjectId();
    const second = new mongoose.Types.ObjectId();
    const outsider = new mongoose.Types.ObjectId();
    const base = {
      user: first.toString(),
      tenantId: 'tenant-a',
      createdAt: now,
      initial_agent_id: 'agent-a',
    };
    await fixtures.conversations.insertMany([
      { ...base, conversationId: 'shared-spend', agent_id: 'agent-b' },
      {
        ...base,
        conversationId: 'shared-spend',
        user: second.toString(),
        initial_agent_id: 'agent-b',
      },
      { ...base, conversationId: 'shared-spend', tenantId: 'tenant-b' },
      { ...base, conversationId: 'foreign-spend', tenantId: 'tenant-b' },
      { ...base, conversationId: 'temporary-spend', isTemporary: true },
      {
        ...base,
        conversationId: 'thread-spend',
        subagentThread: { parentConversationId: 'shared-spend' },
      },
      { ...base, conversationId: 'null-spend', initial_agent_id: null },
      { ...base, conversationId: 'empty-spend', initial_agent_id: '' },
      { ...base, conversationId: 'other-root-spend', initial_agent_id: 'agent-c' },
    ]);
    await fixtures.conversations.insertOne({
      conversationId: 'legacy-spend',
      user: first.toString(),
      createdAt: now,
      initial_agent_id: 'agent-a',
    });
    const usage = {
      conversationId: 'shared-spend',
      user: first,
      tenantId: 'tenant-a',
      createdAt: now,
      tokenType: 'completion',
      tokenValue: -100_000_000,
    };
    await mongoose.models.Transaction.collection.insertMany([
      { ...usage, tokenValue: -1_000_000 },
      { ...usage, user: second, tokenValue: -2_000_000 },
      { ...usage, user: outsider },
      { ...usage, user: null },
      { ...usage, user: { invalid: true } },
      { ...usage, tenantId: 'tenant-b', tokenValue: -50_000_000 },
      { ...usage, tenantId: null },
      { ...usage, conversationId: 'foreign-spend' },
      { ...usage, conversationId: 'temporary-spend' },
      { ...usage, conversationId: 'thread-spend' },
      { ...usage, conversationId: 'null-spend' },
      { ...usage, conversationId: 'empty-spend' },
      { ...usage, conversationId: 'other-root-spend' },
      { ...usage, conversationId: 'missing-spend' },
      { ...usage, conversationId: 'legacy-spend' },
      {
        conversationId: 'legacy-spend',
        user: first,
        createdAt: now,
        tokenType: 'prompt',
        tokenValue: -500_000,
      },
    ]);
    const methods = createInsightsMethods(mongoose);
    const options = { tenantId: 'tenant-a', showDetails: false as const };
    expect(
      (await methods.getInsights({ ...options, agentIds: ['agent-a'] })).summary.spendUSD,
    ).toBe(1);
    expect(
      (await methods.getInsights({ ...options, agentIds: ['agent-b'] })).summary.spendUSD,
    ).toBe(2);
    expect(
      (await methods.getInsights({ ...options, agentIds: ['agent-a', 'agent-b'] })).summary
        .spendUSD,
    ).toBe(3);
    expect(
      (
        await methods.getInsights({
          tenantId: 'tenant-b',
          agentIds: ['agent-a'],
          showDetails: false,
        })
      ).summary.spendUSD,
    ).toBe(50);
    expect(
      (await methods.getInsights({ agentIds: ['agent-a'], showDetails: false })).summary.spendUSD,
    ).toBe(0.5);
  });

  it('counts active users from prompts and all messages for top users within the tenant', async () => {
    const now = new Date();
    const activeAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oldConversationAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const activeUserId = new mongoose.Types.ObjectId();
    const newUserId = new mongoose.Types.ObjectId();
    const otherTenantUserId = new mongoose.Types.ObjectId();

    await mongoose.models.User.collection.insertMany([
      {
        _id: activeUserId,
        tenantId: 'tenant-a',
        name: 'Active Existing User',
        email: 'active@example.com',
      },
      {
        _id: newUserId,
        tenantId: 'tenant-a',
        name: 'New User',
        email: 'new@example.com',
      },
      {
        _id: otherTenantUserId,
        tenantId: 'tenant-b',
        name: 'Other Tenant User',
        email: 'other@example.com',
      },
    ]);

    await fixtures.conversations.insertMany([
      {
        conversationId: 'old-conversation',
        tenantId: 'tenant-a',
        user: activeUserId.toString(),
        createdAt: oldConversationAt,
        updatedAt: activeAt,
        isTemporary: false,
      },
      {
        conversationId: 'new-conversation',
        tenantId: 'tenant-a',
        user: newUserId.toString(),
        createdAt: activeAt,
        updatedAt: activeAt,
        isTemporary: false,
      },
      {
        conversationId: 'other-conversation',
        tenantId: 'tenant-b',
        user: otherTenantUserId.toString(),
        createdAt: activeAt,
        updatedAt: activeAt,
        isTemporary: false,
      },
    ]);

    const messages = [
      ['old-user', 'old-conversation', activeUserId, true],
      ['old-assistant', 'old-conversation', activeUserId, false],
      ['new-user', 'new-conversation', newUserId, true],
      ['new-assistant', 'new-conversation', newUserId, false],
      ['other-user', 'other-conversation', otherTenantUserId, true],
      ['other-assistant', 'other-conversation', otherTenantUserId, false],
    ] as const;

    await fixtures.messages.insertMany([
      ...messages.map(([messageId, conversationId, userId, isCreatedByUser]) => ({
        messageId,
        conversationId,
        tenantId: conversationId === 'other-conversation' ? 'tenant-b' : 'tenant-a',
        user: userId.toString(),
        createdAt: activeAt,
        updatedAt: activeAt,
        isCreatedByUser,
        isTemporary: false,
        text: messageId,
        tokenCount: 10,
      })),
      {
        messageId: 'unattributed-null',
        conversationId: 'old-conversation',
        tenantId: 'tenant-a',
        user: null,
        createdAt: activeAt,
        updatedAt: activeAt,
        isCreatedByUser: false,
        isTemporary: false,
        text: 'Unattributed message',
        tokenCount: 10,
      },
      {
        messageId: 'unattributed-empty',
        conversationId: 'old-conversation',
        tenantId: 'tenant-a',
        user: '',
        createdAt: activeAt,
        updatedAt: activeAt,
        isCreatedByUser: false,
        isTemporary: false,
        text: 'Unattributed message',
        tokenCount: 10,
      },
    ]);

    const result = await createScopedInsightsMethods().getInsights({
      tenantId: 'tenant-a',
      range: '7d',
    });

    expect(result.summary).toEqual(
      expect.objectContaining({
        totalUsers: 2,
        totalConversations: 1,
        totalMessages: 4,
        totalTokens: 40,
      }),
    );
    expect(result.daily).toContainEqual(
      expect.objectContaining({ conversations: 1, users: 2, messages: 4, totalTokens: 40 }),
    );
    expect(result.topUsers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: activeUserId.toString(),
          messages: 2,
          conversations: 1,
        }),
        expect.objectContaining({
          userId: newUserId.toString(),
          messages: 2,
          conversations: 1,
        }),
      ]),
    );
    expect(result.topUsers).toHaveLength(2);
  });

  it('lists users whose 28-day inactivity threshold falls within the selected range', async () => {
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);
    const churnedUserId = new mongoose.Types.ObjectId();
    const previouslyChurnedUserId = new mongoose.Types.ObjectId();
    const activeUserId = new mongoose.Types.ObjectId();
    const otherTenantUserId = new mongoose.Types.ObjectId();

    await mongoose.models.User.collection.insertMany([
      {
        _id: churnedUserId,
        tenantId: 'tenant-a',
        name: 'Churned User',
        email: 'churned@example.com',
      },
      {
        _id: previouslyChurnedUserId,
        tenantId: 'tenant-a',
        name: 'Previously Churned User',
        email: 'previously-churned@example.com',
      },
      {
        _id: activeUserId,
        tenantId: 'tenant-a',
        name: 'Active User',
        email: 'active@example.com',
      },
      {
        _id: otherTenantUserId,
        tenantId: 'tenant-b',
        name: 'Other Tenant User',
        email: 'other@example.com',
      },
    ]);

    await fixtures.conversations.insertMany([
      {
        conversationId: 'churned-conversation-1',
        tenantId: 'tenant-a',
        user: churnedUserId.toString(),
        createdAt: daysAgo(60),
        isTemporary: false,
      },
      {
        conversationId: 'churned-conversation-2',
        tenantId: 'tenant-a',
        user: churnedUserId.toString(),
        createdAt: daysAgo(29),
        isTemporary: false,
      },
      {
        conversationId: 'previously-churned-conversation',
        tenantId: 'tenant-a',
        user: previouslyChurnedUserId.toString(),
        createdAt: daysAgo(40),
        isTemporary: false,
      },
      {
        conversationId: 'active-conversation',
        tenantId: 'tenant-a',
        user: activeUserId.toString(),
        createdAt: daysAgo(27),
        isTemporary: false,
      },
      {
        conversationId: 'other-conversation',
        tenantId: 'tenant-b',
        user: otherTenantUserId.toString(),
        createdAt: daysAgo(35),
        isTemporary: false,
      },
    ]);

    await fixtures.messages.insertMany([
      {
        messageId: 'churned-first-prompt',
        conversationId: 'churned-conversation-1',
        tenantId: 'tenant-a',
        user: churnedUserId.toString(),
        createdAt: daysAgo(60),
        updatedAt: daysAgo(60),
        isCreatedByUser: true,
        isTemporary: false,
      },
      {
        messageId: 'churned-second-prompt',
        conversationId: 'churned-conversation-1',
        tenantId: 'tenant-a',
        user: churnedUserId.toString(),
        createdAt: daysAgo(45),
        updatedAt: daysAgo(45),
        isCreatedByUser: true,
        isTemporary: false,
      },
      {
        messageId: 'churned-last-prompt',
        conversationId: 'churned-conversation-2',
        tenantId: 'tenant-a',
        user: churnedUserId.toString(),
        createdAt: daysAgo(29),
        updatedAt: daysAgo(29),
        isCreatedByUser: true,
        isTemporary: false,
      },
      {
        messageId: 'recent-assistant-response',
        conversationId: 'churned-conversation-2',
        tenantId: 'tenant-a',
        user: churnedUserId.toString(),
        createdAt: daysAgo(1),
        updatedAt: daysAgo(1),
        isCreatedByUser: false,
        isTemporary: false,
      },
      {
        messageId: 'previously-churned-prompt',
        conversationId: 'previously-churned-conversation',
        tenantId: 'tenant-a',
        user: previouslyChurnedUserId.toString(),
        createdAt: daysAgo(40),
        updatedAt: daysAgo(40),
        isCreatedByUser: true,
        isTemporary: false,
      },
      {
        messageId: 'active-prompt',
        conversationId: 'active-conversation',
        tenantId: 'tenant-a',
        user: activeUserId.toString(),
        createdAt: daysAgo(27),
        updatedAt: daysAgo(27),
        isCreatedByUser: true,
        isTemporary: false,
      },
      {
        messageId: 'other-tenant-old-prompt',
        conversationId: 'other-conversation',
        tenantId: 'tenant-b',
        user: otherTenantUserId.toString(),
        createdAt: daysAgo(35),
        updatedAt: daysAgo(35),
        isCreatedByUser: true,
        isTemporary: false,
      },
    ]);

    const result = await createScopedInsightsMethods().getInsights({
      tenantId: 'tenant-a',
      range: '7d',
    });

    expect(result.churnedUsers).toEqual([
      {
        userId: churnedUserId.toString(),
        name: 'Churned User',
        email: 'churned@example.com',
        conversations: 2,
        messages: 3,
        firstSeen: daysAgo(60).toISOString(),
        lastSeen: daysAgo(29).toISOString(),
      },
    ]);
    expect(result.summary).not.toHaveProperty('churnedUsers');
  });

  it('keeps duplicate conversation IDs isolated by owner', async () => {
    const now = new Date();
    const firstUserId = new mongoose.Types.ObjectId();
    const secondUserId = new mongoose.Types.ObjectId();
    await mongoose.models.User.collection.insertMany([
      {
        _id: firstUserId,
        tenantId: 'tenant-a',
        name: 'First User',
        email: 'first@example.com',
      },
      {
        _id: secondUserId,
        tenantId: 'tenant-a',
        name: 'Second User',
        email: 'second@example.com',
      },
    ]);
    await fixtures.conversations.insertMany([
      {
        conversationId: 'shared-client-id',
        tenantId: 'tenant-a',
        user: firstUserId.toString(),
        title: 'First conversation',
        createdAt: now,
        updatedAt: now,
        isTemporary: false,
      },
      {
        conversationId: 'shared-client-id',
        tenantId: 'tenant-a',
        user: secondUserId.toString(),
        title: 'Second conversation',
        createdAt: new Date(now.getTime() - 1),
        updatedAt: now,
        isTemporary: false,
      },
    ]);
    await fixtures.messages.insertMany([
      {
        messageId: 'first-prompt',
        conversationId: 'shared-client-id',
        tenantId: 'tenant-a',
        user: firstUserId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: true,
        isTemporary: false,
        text: 'First owner private prompt',
        tokenCount: 10,
      },
      {
        messageId: 'first-response',
        conversationId: 'shared-client-id',
        tenantId: 'tenant-a',
        user: firstUserId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: false,
        isTemporary: false,
        endpoint: 'agents',
        sender: 'First Agent',
        text: 'First response',
        tokenCount: 20,
      },
      {
        messageId: 'second-prompt',
        conversationId: 'shared-client-id',
        tenantId: 'tenant-a',
        user: secondUserId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: true,
        isTemporary: false,
        text: 'Second owner private prompt',
        tokenCount: 30,
      },
      {
        messageId: 'second-response',
        conversationId: 'shared-client-id',
        tenantId: 'tenant-a',
        user: secondUserId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: false,
        isTemporary: false,
        endpoint: 'agents',
        sender: 'Second Agent',
        text: 'Second response',
        tokenCount: 40,
      },
    ]);

    const methods = createScopedInsightsMethods();
    const insights = await methods.getInsights({ tenantId: 'tenant-a', range: '7d' });
    const byUser = new Map(insights.latest.conversations.map((row) => [row.userId, row]));

    expect(byUser.get(firstUserId.toString())).toEqual(
      expect.objectContaining({
        firstMessage: 'First owner private prompt',
        messages: 2,
        totalTokens: 30,
      }),
    );
    expect(byUser.get(secondUserId.toString())).toEqual(
      expect.objectContaining({
        firstMessage: 'Second owner private prompt',
        messages: 2,
        totalTokens: 70,
      }),
    );

    const search = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      search: 'first@example.com',
    });
    expect(search.latest.conversations).toEqual([
      expect.objectContaining({ userId: firstUserId.toString() }),
    ]);
  });

  it('attributes conversations, prompts, responses and tokens to the immutable root agent', async () => {
    const now = new Date();
    const userId = new mongoose.Types.ObjectId();
    await mongoose.models.User.collection.insertOne({
      _id: userId,
      tenantId: 'tenant-a',
      name: 'Mixed Agent User',
      email: 'mixed@example.com',
    });
    await fixtures.conversations.insertMany([
      {
        conversationId: 'legacy-agent-a',
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt: now,
        updatedAt: now,
        isTemporary: false,
      },
      {
        conversationId: 'primary-agent-a',
        tenantId: 'tenant-a',
        user: userId.toString(),
        initial_agent_id: 'agent-a',
        agent_id: 'agent-b',
        createdAt: now,
        updatedAt: now,
        isTemporary: false,
      },
      {
        conversationId: 'explicitly-unattributed',
        tenantId: 'tenant-a',
        user: userId.toString(),
        initial_agent_id: null,
        agent_id: 'agent-a',
        createdAt: now,
        updatedAt: now,
        isTemporary: false,
      },
      {
        conversationId: 'subagent-thread',
        tenantId: 'tenant-a',
        user: userId.toString(),
        initial_agent_id: 'agent-a',
        subagentThread: { parentConversationId: 'primary-agent-a' },
        createdAt: now,
        updatedAt: now,
        isTemporary: false,
      },
    ]);
    await fixtures.messages.insertMany([
      {
        messageId: 'primary-user',
        conversationId: 'primary-agent-a',
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: true,
        isTemporary: false,
        text: 'Use the primary agent',
        tokenCount: 5,
      },
      {
        messageId: 'secondary-assistant',
        conversationId: 'primary-agent-a',
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: false,
        isTemporary: false,
        model: 'agent-b',
        text: 'Answered by a secondary agent',
        tokenCount: 7,
      },
      {
        messageId: 'unattributed-assistant',
        conversationId: 'explicitly-unattributed',
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: false,
        isTemporary: false,
        model: 'agent-a',
        text: 'Must remain unattributed',
        tokenCount: 13,
      },
      {
        messageId: 'subagent-assistant',
        conversationId: 'subagent-thread',
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: false,
        isTemporary: false,
        model: 'agent-a',
        text: 'Nested work',
        tokenCount: 11,
      },
    ]);

    const methods = createInsightsMethods(mongoose);
    const agentAInsights = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      agents: selectedAgents,
      agentIds: ['agent-a'],
    });
    const agentBInsights = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      agents: [{ id: 'agent-b', name: 'Agent B' }],
      agentIds: ['agent-b'],
    });

    expect(agentAInsights.summary).toEqual(
      expect.objectContaining({
        totalConversations: 2,
        totalMessages: 2,
        totalTokens: 12,
        totalUsers: 1,
      }),
    );
    expect(agentAInsights.agents).toEqual(selectedAgents);
    expect(agentBInsights.summary).toEqual(
      expect.objectContaining({
        totalConversations: 0,
        totalMessages: 0,
        totalTokens: 0,
        totalUsers: 0,
      }),
    );
    expect(
      agentAInsights.daily.find((point) => point.date === now.toISOString().slice(0, 10)),
    ).toEqual({
      date: now.toISOString().slice(0, 10),
      conversations: 2,
      messages: 2,
      users: 1,
      totalTokens: 12,
      responses: 1,
      completedResponses: 1,
      failedResponses: 0,
      interruptedResponses: 0,
      feedback: feedbackCounts(),
      spendUSD: null,
    });
    expect(agentAInsights.topUsers).toEqual([
      expect.objectContaining({
        userId: userId.toString(),
        conversations: 1,
        messages: 2,
      }),
    ]);
    expect(agentAInsights.latest.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: 'primary-agent-a',
          agentId: 'agent-a',
          messages: 2,
          totalTokens: 12,
        }),
      ]),
    );
    expect(agentBInsights.latest.conversations).toEqual([]);
    const combined = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      agentIds: ['agent-a', 'agent-b'],
    });
    expect(combined.summary).toEqual(agentAInsights.summary);
  });

  it('counts response-only activity in an older conversation by root and message date', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    const created = new Date('2026-09-01T12:00:00Z');
    const active = new Date('2026-10-03T12:00:00Z');
    const later = new Date('2026-10-15T12:00:00Z');
    await fixtures.conversations.insertOne({
      conversationId: 'old-root-a',
      user,
      tenantId: 'tenant-a',
      initial_agent_id: 'agent-a',
      agent_id: 'agent-b',
      createdAt: created,
      updatedAt: later,
    });
    // Use the native collection so the missing response model is not filled by the fixture.
    await mongoose.models.Message.collection.insertMany([
      {
        messageId: 'old-prompt',
        conversationId: 'old-root-a',
        user,
        tenantId: 'tenant-a',
        createdAt: created,
        isCreatedByUser: true,
        tokenCount: 100,
      },
      {
        messageId: 'switched-response',
        conversationId: 'old-root-a',
        user,
        tenantId: 'tenant-a',
        createdAt: active,
        isCreatedByUser: false,
        model: 'agent-b',
        tokenCount: 7,
      },
      {
        messageId: 'model-less-response',
        conversationId: 'old-root-a',
        user,
        tenantId: 'tenant-a',
        createdAt: active,
        isCreatedByUser: false,
        tokenCount: 11,
      },
      {
        messageId: 'later-response',
        conversationId: 'old-root-a',
        user,
        tenantId: 'tenant-a',
        createdAt: later,
        isCreatedByUser: false,
        model: 'agent-a',
        tokenCount: 100,
      },
    ]);
    const methods = createInsightsMethods(mongoose);
    const options = {
      showDetails: false as const,
      tenantId: 'tenant-a',
      range: 'custom' as const,
      fromTimestamp: '2026-10-01T00:00:00Z',
      toTimestamp: '2026-10-07T23:59:59Z',
    };
    const root = await methods.getInsights({ ...options, agentIds: ['agent-a'] });
    const answeringAgent = await methods.getInsights({ ...options, agentIds: ['agent-b'] });
    const combined = await methods.getInsights({ ...options, agentIds: ['agent-a', 'agent-b'] });

    expect(root.summary).toEqual({
      totalConversations: 0,
      totalMessages: 2,
      totalTokens: 18,
      totalUsers: 1,
      totalResponses: 2,
      completedResponses: 2,
      failedResponses: 0,
      interruptedResponses: 0,
      lastUsed: active.toISOString(),
      feedback: feedbackCounts(),
      spendUSD: null,
    });
    expect(root.daily.find((point) => point.date === '2026-10-03')).toEqual({
      date: '2026-10-03',
      conversations: 0,
      messages: 2,
      totalTokens: 18,
      users: 1,
      responses: 2,
      completedResponses: 2,
      failedResponses: 0,
      interruptedResponses: 0,
      feedback: feedbackCounts(),
      spendUSD: null,
    });
    expect(answeringAgent.summary).toEqual({
      totalConversations: 0,
      totalMessages: 0,
      totalTokens: 0,
      totalUsers: 0,
      totalResponses: 0,
      completedResponses: 0,
      failedResponses: 0,
      interruptedResponses: 0,
      lastUsed: null,
      feedback: feedbackCounts(),
      spendUSD: null,
    });
    expect(combined.summary).toEqual(root.summary);
    expect(Object.keys(root).sort()).toEqual(['agents', 'daily', 'summary']);
  });

  it('keeps switched responses isolated by root, conversation owner, tenant and visibility', async () => {
    const now = new Date();
    const firstOwner = new mongoose.Types.ObjectId().toString();
    const secondOwner = new mongoose.Types.ObjectId().toString();
    const outsider = new mongoose.Types.ObjectId().toString();
    const base = { tenantId: 'tenant-a', user: firstOwner, createdAt: now, updatedAt: now };
    await fixtures.conversations.insertMany([
      {
        ...base,
        conversationId: 'shared-root-id',
        initial_agent_id: 'agent-a',
        agent_id: 'agent-b',
      },
      {
        ...base,
        conversationId: 'shared-root-id',
        user: secondOwner,
        initial_agent_id: 'agent-b',
        agent_id: 'agent-a',
      },
      {
        ...base,
        conversationId: 'foreign-only',
        tenantId: 'tenant-b',
        initial_agent_id: 'agent-a',
      },
      { ...base, conversationId: 'temporary-root', initial_agent_id: 'agent-a', isTemporary: true },
      {
        ...base,
        conversationId: 'thread-root',
        initial_agent_id: 'agent-a',
        subagentThread: { parentConversationId: 'shared-root-id' },
      },
      { ...base, conversationId: 'null-root', initial_agent_id: null },
      { ...base, conversationId: 'empty-root', initial_agent_id: '' },
    ]);
    const response = {
      ...base,
      isCreatedByUser: false,
      isTemporary: false,
      model: 'agent-b',
      feedback: { rating: 'thumbsDown', tag: 'inaccurate' },
    };
    await fixtures.messages.insertMany([
      { ...response, messageId: 'belongs-to-a', conversationId: 'shared-root-id', tokenCount: 3 },
      {
        ...response,
        messageId: 'belongs-to-b',
        conversationId: 'shared-root-id',
        user: secondOwner,
        model: 'agent-a',
        tokenCount: 5,
      },
      {
        ...response,
        messageId: 'wrong-owner',
        conversationId: 'shared-root-id',
        user: outsider,
        tokenCount: 1000,
      },
      {
        ...response,
        messageId: 'wrong-conversation-tenant',
        conversationId: 'foreign-only',
        tokenCount: 1000,
      },
      {
        ...response,
        messageId: 'wrong-message-tenant',
        conversationId: 'shared-root-id',
        tenantId: 'tenant-b',
        tokenCount: 1000,
      },
      {
        ...response,
        messageId: 'temporary-conversation',
        conversationId: 'temporary-root',
        tokenCount: 1000,
      },
      {
        ...response,
        messageId: 'temporary-message',
        conversationId: 'shared-root-id',
        isTemporary: true,
        tokenCount: 1000,
      },
      {
        ...response,
        messageId: 'thread-response',
        conversationId: 'thread-root',
        tokenCount: 1000,
      },
      { ...response, messageId: 'null-response', conversationId: 'null-root', tokenCount: 1000 },
      { ...response, messageId: 'empty-response', conversationId: 'empty-root', tokenCount: 1000 },
      {
        ...response,
        messageId: 'orphan-response',
        conversationId: 'missing-conversation',
        tokenCount: 1000,
      },
    ]);
    const methods = createInsightsMethods(mongoose);
    for (const [agentId, owner, tokens] of [
      ['agent-a', firstOwner, 3],
      ['agent-b', secondOwner, 5],
    ] as const) {
      const result = await methods.getInsights({
        tenantId: 'tenant-a',
        range: '7d',
        agentIds: [agentId],
        showDetails: true,
      });
      expect(result.summary).toEqual({
        totalConversations: 1,
        totalMessages: 1,
        totalUsers: 1,
        totalTokens: tokens,
        totalResponses: 1,
        completedResponses: 1,
        failedResponses: 0,
        interruptedResponses: 0,
        lastUsed: now.toISOString(),
        feedback: feedbackCounts(0, 1, { inaccurate: 1 }),
        spendUSD: null,
      });
      expect(result.latest.conversations).toEqual([
        expect.objectContaining({
          conversationId: 'shared-root-id',
          userId: owner,
          agentId,
          messages: 1,
          totalTokens: tokens,
        }),
      ]);
    }
    const combined = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      agentIds: ['agent-a', 'agent-b'],
      showDetails: true,
    });
    expect(combined.summary).toEqual({
      totalConversations: 2,
      totalMessages: 2,
      totalUsers: 2,
      totalTokens: 8,
      totalResponses: 2,
      completedResponses: 2,
      failedResponses: 0,
      interruptedResponses: 0,
      lastUsed: now.toISOString(),
      feedback: feedbackCounts(0, 2, { inaccurate: 2 }),
      spendUSD: null,
    });
    expect(combined.latest.conversations).toHaveLength(2);
  });

  it('bounds latest conversation message totals to a custom range', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-07T23:59:59.999Z');
    const inRange = new Date('2026-01-02T12:00:00.000Z');
    const temporaryInRange = new Date('2026-01-02T11:59:00.000Z');
    const afterRange = new Date('2026-01-08T12:00:00.000Z');
    const userId = new mongoose.Types.ObjectId();

    await mongoose.models.User.collection.insertOne({
      _id: userId,
      tenantId: 'tenant-a',
      name: 'Historical User',
      email: 'historical@example.com',
    });
    await fixtures.conversations.insertOne({
      conversationId: 'historical-conversation',
      tenantId: 'tenant-a',
      user: userId.toString(),
      title: 'Historical conversation',
      createdAt: inRange,
      updatedAt: afterRange,
      isTemporary: false,
    });
    await fixtures.messages.insertMany([
      {
        messageId: 'temporary-prompt',
        conversationId: 'historical-conversation',
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt: temporaryInRange,
        updatedAt: temporaryInRange,
        isCreatedByUser: true,
        isTemporary: true,
        text: 'Temporary prompt',
        tokenCount: 100,
      },
      {
        messageId: 'historical-prompt',
        conversationId: 'historical-conversation',
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt: inRange,
        updatedAt: inRange,
        isCreatedByUser: true,
        isTemporary: false,
        text: 'Historical prompt',
        tokenCount: 10,
      },
      {
        messageId: 'historical-response',
        conversationId: 'historical-conversation',
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt: inRange,
        updatedAt: inRange,
        isCreatedByUser: false,
        isTemporary: false,
        text: 'Historical response',
        tokenCount: 20,
      },
      {
        messageId: 'later-response',
        conversationId: 'historical-conversation',
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt: afterRange,
        updatedAt: afterRange,
        isCreatedByUser: false,
        isTemporary: false,
        text: 'Later response',
        tokenCount: 30,
      },
    ]);

    const result = await createScopedInsightsMethods().getInsights({
      tenantId: 'tenant-a',
      range: 'custom',
      fromTimestamp: from.toISOString(),
      toTimestamp: to.toISOString(),
    });

    expect(result.latest.conversations).toEqual([
      expect.objectContaining({
        conversationId: 'historical-conversation',
        firstMessage: 'Historical prompt',
        messages: 2,
        totalTokens: 30,
      }),
    ]);
  });

  it('uses the selected timezone for daily buckets and fills inactive dates', async () => {
    const userId = new mongoose.Types.ObjectId();
    const activity = [new Date('2026-08-01T12:00:00.000Z'), new Date('2026-08-03T12:00:00.000Z')];

    await mongoose.models.User.collection.insertOne({
      _id: userId,
      tenantId: 'tenant-a',
      name: 'Pacific User',
      email: 'pacific@example.com',
    });
    await fixtures.conversations.insertMany(
      activity.map((createdAt, index) => ({
        conversationId: `pacific-${index}`,
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt,
        updatedAt: createdAt,
        isTemporary: false,
      })),
    );
    await fixtures.messages.insertMany(
      activity.map((createdAt, index) => ({
        messageId: `pacific-message-${index}`,
        conversationId: `pacific-${index}`,
        tenantId: 'tenant-a',
        user: userId.toString(),
        createdAt,
        updatedAt: createdAt,
        isCreatedByUser: true,
        isTemporary: false,
        text: `Message ${index}`,
      })),
    );

    const result = await createScopedInsightsMethods().getInsights({
      tenantId: 'tenant-a',
      range: 'custom',
      fromTimestamp: '2026-08-01T07:00:00.000Z',
      toTimestamp: '2026-08-04T06:59:59.999Z',
      timeZone: 'America/Los_Angeles',
    });

    expect(result.daily).toEqual([
      {
        ...noResponses,
        date: '2026-08-01',
        conversations: 1,
        messages: 1,
        totalTokens: 0,
        users: 1,
      },
      {
        ...noResponses,
        date: '2026-08-02',
        conversations: 0,
        messages: 0,
        totalTokens: 0,
        users: 0,
      },
      {
        ...noResponses,
        date: '2026-08-03',
        conversations: 1,
        messages: 1,
        totalTokens: 0,
        users: 1,
      },
    ]);
  });

  it('preserves a 30-date custom range across a daylight saving time change', async () => {
    const userId = new mongoose.Types.ObjectId();
    const activity = new Date('2026-10-04T04:30:00.000Z');

    await mongoose.models.User.collection.insertOne({
      _id: userId,
      tenantId: 'tenant-a',
      name: 'Eastern User',
      email: 'eastern@example.com',
    });
    await fixtures.conversations.insertOne({
      conversationId: 'dst-fallback',
      tenantId: 'tenant-a',
      user: userId.toString(),
      createdAt: activity,
      updatedAt: activity,
      isTemporary: false,
    });
    await fixtures.messages.insertOne({
      messageId: 'dst-fallback-message',
      conversationId: 'dst-fallback',
      tenantId: 'tenant-a',
      user: userId.toString(),
      createdAt: activity,
      updatedAt: activity,
      isCreatedByUser: true,
      isTemporary: false,
      text: 'Message before the repeated hour',
    });

    const result = await createScopedInsightsMethods().getInsights({
      tenantId: 'tenant-a',
      range: 'custom',
      fromTimestamp: '2026-10-04T04:00:00.000Z',
      toTimestamp: '2026-11-03T04:59:59.999Z',
      timeZone: 'America/New_York',
    });

    expect(result.summary.totalConversations).toBe(1);
    expect(result.summary.totalMessages).toBe(1);
    expect(result.daily).toHaveLength(30);
    expect(result.daily[0]).toEqual(
      expect.objectContaining({ date: '2026-10-04', conversations: 1, messages: 1 }),
    );
  });

  it('fills every local calendar date across a daylight saving time change', async () => {
    const result = await createScopedInsightsMethods().getInsights({
      tenantId: 'tenant-a',
      range: 'custom',
      fromTimestamp: '2026-03-08T04:30:00.000Z',
      toTimestamp: '2026-03-09T04:30:00.000Z',
      timeZone: 'America/New_York',
    });

    expect(result.daily).toEqual([
      {
        ...noResponses,
        date: '2026-03-07',
        conversations: 0,
        messages: 0,
        totalTokens: 0,
        users: 0,
      },
      {
        ...noResponses,
        date: '2026-03-08',
        conversations: 0,
        messages: 0,
        totalTokens: 0,
        users: 0,
      },
      {
        ...noResponses,
        date: '2026-03-09',
        conversations: 0,
        messages: 0,
        totalTokens: 0,
        users: 0,
      },
    ]);
  });

  it('searches tenant conversations by ID and user without inspecting message text', async () => {
    const now = new Date();
    const aliceId = new mongoose.Types.ObjectId();
    const bobId = new mongoose.Types.ObjectId();
    const otherTenantUserId = new mongoose.Types.ObjectId();

    await mongoose.models.User.collection.insertMany([
      {
        _id: aliceId,
        tenantId: 'tenant-a',
        name: 'Alice Example',
        email: 'alice@example.com',
      },
      {
        _id: bobId,
        tenantId: 'tenant-a',
        name: 'Bob Example',
        email: 'bob@example.com',
      },
      {
        _id: otherTenantUserId,
        tenantId: 'tenant-b',
        name: 'Secret User',
        email: 'secret@example.com',
      },
    ]);
    await fixtures.conversations.insertMany([
      {
        conversationId: 'incident-review-123',
        tenantId: 'tenant-a',
        user: aliceId.toString(),
        createdAt: now,
        updatedAt: now,
        isTemporary: false,
      },
      {
        conversationId: 'capacity-plan-456',
        tenantId: 'tenant-a',
        user: bobId.toString(),
        createdAt: now,
        updatedAt: now,
        isTemporary: false,
      },
      {
        conversationId: 'other-tenant-789',
        tenantId: 'tenant-b',
        user: otherTenantUserId.toString(),
        createdAt: now,
        updatedAt: now,
        isTemporary: false,
      },
    ]);
    await fixtures.messages.insertMany([
      {
        messageId: 'message-a',
        conversationId: 'incident-review-123',
        tenantId: 'tenant-a',
        user: aliceId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: true,
        isTemporary: false,
        text: 'Review the production incident',
      },
      {
        messageId: 'message-b',
        conversationId: 'capacity-plan-456',
        tenantId: 'tenant-a',
        user: bobId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: true,
        isTemporary: false,
        text: 'Forecast the sapphire cluster capacity',
      },
      {
        messageId: 'message-secret',
        conversationId: 'other-tenant-789',
        tenantId: 'tenant-b',
        user: otherTenantUserId.toString(),
        createdAt: now,
        updatedAt: now,
        isCreatedByUser: true,
        isTemporary: false,
        text: 'Cross tenant secret phrase',
      },
    ]);

    const methods = createScopedInsightsMethods();
    const byConversationId = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      search: 'review-123',
    });
    const byUser = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      search: 'alice@example.com',
    });
    const byMessage = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      search: 'SAPPHIRE CLUSTER',
    });
    const crossTenant = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      search: 'secret phrase',
    });

    expect(byConversationId.summary.totalConversations).toBe(2);
    expect(byConversationId.latest.conversations.map((row) => row.conversationId)).toEqual([
      'incident-review-123',
    ]);
    expect(byUser.latest.conversations.map((row) => row.conversationId)).toEqual([
      'incident-review-123',
    ]);
    expect(byMessage.latest.conversations).toEqual([]);
    expect(crossTenant.latest).toEqual(expect.objectContaining({ conversations: [], pages: 1 }));
  });

  it('uses focused DocumentDB-compatible aggregations during searches', async () => {
    const conversationAggregateSpy = jest.spyOn(mongoose.models.Conversation, 'aggregate');
    const messageAggregateSpy = jest.spyOn(mongoose.models.Message, 'aggregate');

    try {
      await createScopedInsightsMethods().getInsights({
        tenantId: 'tenant-a',
        range: '7d',
        search: 'conversation-id',
      });

      type AggregationStage = {
        $count?: string;
        $facet?: Record<string, unknown>;
        $limit?: number;
        $lookup?: Record<string, unknown>;
        $match?: Record<string, unknown>;
        $setWindowFields?: Record<string, unknown>;
        $unionWith?: unknown;
      };
      const conversationPipelines = conversationAggregateSpy.mock.calls.map(
        ([pipeline]) => pipeline as AggregationStage[],
      );
      const allStages = [
        ...conversationPipelines.flat(),
        ...messageAggregateSpy.mock.calls.flatMap(([pipeline]) => pipeline as AggregationStage[]),
      ];
      const searchedPipelines = conversationPipelines.filter((pipeline) =>
        pipeline.some((stage) => stage.$lookup?.from === 'users'),
      );
      const unfilteredRecentPipelines = conversationPipelines.filter(
        (pipeline) =>
          !pipeline.some((stage) => stage.$lookup) && pipeline.some((stage) => stage.$limit),
      );

      expect(
        allStages.every(
          (stage) =>
            stage.$facet == null && stage.$setWindowFields == null && stage.$unionWith == null,
        ),
      ).toBe(true);
      expect(JSON.stringify(allStages)).not.toContain('"$expr"');
      expect(JSON.stringify(allStages)).not.toContain('"$type"');
      expect(
        conversationPipelines.every((pipeline) => {
          const firstMatch = pipeline.find((stage) => stage.$match)?.$match;
          return Array.isArray(firstMatch?.$or);
        }),
      ).toBe(true);
      expect(searchedPipelines).toHaveLength(2);
      expect(searchedPipelines.some((pipeline) => pipeline.some((stage) => stage.$count))).toBe(
        true,
      );
      expect(searchedPipelines.some((pipeline) => pipeline.some((stage) => stage.$limit))).toBe(
        true,
      );
      expect(unfilteredRecentPipelines).toHaveLength(0);
    } finally {
      conversationAggregateSpy.mockRestore();
      messageAggregateSpy.mockRestore();
    }
  });

  it('keeps identity matches in a DocumentDB-compatible conversation aggregation', async () => {
    const aggregateSpy = jest.spyOn(mongoose.models.Conversation, 'aggregate');

    try {
      await createScopedInsightsMethods().getInsights({
        tenantId: 'tenant-a',
        range: '7d',
        search: 'alice@example.com',
      });

      type SearchStage = {
        $addFields?: Record<string, unknown>;
        $lookup?: Record<string, unknown>;
      };
      const searchedPipeline = aggregateSpy.mock.calls
        .map(([pipeline]) => pipeline as SearchStage[])
        .find((pipeline) => pipeline.some((stage) => stage.$lookup));
      const identityLookup = searchedPipeline?.find((stage) => stage.$lookup)?.$lookup;
      const ownerConversion = searchedPipeline?.find(
        (stage) => stage.$addFields?.insightsUserId,
      )?.$addFields;

      expect(identityLookup).toEqual({
        from: 'users',
        localField: 'insightsUserId',
        foreignField: '_id',
        as: 'matchedIdentity',
      });
      expect(identityLookup).not.toHaveProperty('let');
      expect(identityLookup).not.toHaveProperty('pipeline');
      expect(ownerConversion).toEqual({
        insightsUserId: {
          $convert: { input: '$user', to: 'objectId', onError: null, onNull: null },
        },
      });
    } finally {
      aggregateSpy.mockRestore();
    }
  });
});
