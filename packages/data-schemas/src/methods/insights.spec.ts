import mongoose from 'mongoose';
import { FEEDBACK_TAGS } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TFeedbackTagKey } from 'librechat-data-provider';
import { createInsightsMethods as createIndexedInsightsMethods } from './insights';
import { backfillInsightsAttribution } from '../migrations/insightsAgentIds';
import { createInsightsExclusionModel } from '../models/insightsExclusion';
import { createTransactionModel } from '../models/transaction';
import { createConversationModel } from '../models/convo';
import { createMessageModel } from '../models/message';
import { createAgentModel } from '../models/agent';
import { createUserModel } from '../models/user';
import { createAgentMethods } from './agent';

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

async function migrateInsightsAttribution() {
  for (const collection of ['conversations', 'messages', 'transactions'] as const) {
    let after: string | undefined;
    do {
      const result = await backfillInsightsAttribution(mongoose, {
        collection,
        batchSize: 1000,
        after,
        apply: true,
      });
      after = result.nextAfter;
    } while (after);
  }
}

function createInsightsMethods(connection: typeof mongoose) {
  const methods = createIndexedInsightsMethods(connection);
  const getInsights = async (options?: Parameters<typeof methods.getInsights>[0]) => {
    await migrateInsightsAttribution();
    return methods.getInsights(options);
  };
  return { ...methods, getInsights };
}

function createScopedInsightsMethods() {
  const methods = createInsightsMethods(mongoose);
  return {
    getInsights: (options: Parameters<typeof methods.getInsights>[0]) =>
      methods.getInsights({ ...options, agents: selectedAgents, agentIds: ['agent-a'] }),
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
    createAgentModel(mongoose),
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
    mongoose.models.Agent.deleteMany({}),
  ]);
});

describe('Insights methods', () => {
  it('returns only saved version numbers and dates for the selected tenant and agent', async () => {
    const privateValue = 'private-snapshot-content';
    await mongoose.models.Agent.collection.insertMany([
      {
        id: 'agent-a',
        tenantId: 'tenant-a',
        versions: [
          {
            updatedAt: new Date('2026-09-01T12:00:00Z'),
            instructions: privateValue,
            updatedBy: privateValue,
          },
          { instructions: privateValue },
          { updatedAt: 'invalid-date' },
          { updatedAt: new Date('2026-10-03T12:00:00Z') },
        ],
      },
      {
        id: 'agent-b',
        tenantId: 'tenant-b',
        versions: [{ updatedAt: new Date('2026-10-05T12:00:00Z') }],
      },
    ]);
    const findAgent = jest.spyOn(mongoose.models.Agent, 'findOne');
    const methods = createInsightsMethods(mongoose);
    const options = {
      tenantId: 'tenant-a',
      agentIds: ['agent-a'],
      showDetails: false as const,
      range: 'custom' as const,
      fromTimestamp: '2026-10-01T00:00:00Z',
      toTimestamp: '2026-10-07T23:59:59Z',
    };
    const result = await methods.getInsights(options);
    expect(result.agentVersions).toEqual([
      { agentId: 'agent-a', version: 1, savedAt: '2026-09-01T12:00:00.000Z', active: false },
      { agentId: 'agent-a', version: 2, savedAt: null, active: false },
      { agentId: 'agent-a', version: 3, savedAt: null, active: false },
      { agentId: 'agent-a', version: 4, savedAt: '2026-10-03T12:00:00.000Z', active: true },
    ]);
    expect(findAgent).toHaveBeenCalledWith(
      { id: 'agent-a', tenantId: 'tenant-a' },
      expect.objectContaining({ _id: 0, 'versions.updatedAt': 1, instructions: 1 }),
    );
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(
      (await methods.getInsights({ ...options, agentIds: ['agent-b'] })).agentVersions,
    ).toEqual([]);
    expect((await methods.getInsights({ ...options, tenantId: undefined })).agentVersions).toEqual(
      [],
    );
    findAgent.mockClear();
    for (const agentIds of [['agent-a', 'agent-b'], []]) {
      expect(await methods.getInsights({ ...options, agentIds })).not.toHaveProperty(
        'agentVersions',
      );
    }
    expect(findAgent).not.toHaveBeenCalled();
  });

  it.each([
    ['the model', { model: 'model-old' }, { model: 'model-new' }],
    [
      'model parameters',
      { model_parameters: { effort: 'low' } },
      { model_parameters: { effort: 'high' } },
    ],
    ['skills', { skills_enabled: true }, { skills_enabled: false }],
    ['subagents', { subagents: { enabled: true } }, { subagents: { enabled: false } }],
  ])('marks the restored version when versions only differ in %s', async (_, older, newer) => {
    const agents = createAgentMethods(mongoose, {
      removeAllPermissions: async () => {},
      getActions: async () => [],
      getSoleOwnedResourceIds: async () => [],
      getUserPrincipals: async () => [],
      findAccessibleResources: async () => [],
    });
    const active = async () => {
      const { agentVersions } = await createInsightsMethods(mongoose).getInsights({
        agentIds: ['agent-a'],
        showDetails: false,
      });
      return agentVersions?.filter((version) => version.active).map(({ version }) => version);
    };
    await agents.createAgent({
      id: 'agent-a',
      name: 'Root',
      provider: 'openAI',
      model: 'model',
      author: new mongoose.Types.ObjectId(),
      ...older,
    });
    expect(await active()).toEqual([1]);
    await agents.updateAgent({ id: 'agent-a' }, newer);
    expect(await active()).toEqual([2]);
    await agents.revertAgentVersion({ id: 'agent-a' }, 0);
    expect(await active()).toEqual([1]);
    await agents.revertAgentVersion({ id: 'agent-a' }, 1);
    expect(await active()).toEqual([2]);
  });

  it.each([
    ['valid root', {}, [], 1, 1],
    ['legacy root', { agent_id: 'agent-a' }, ['initial_agent_id'], 1, 1],
    ['older conversation', { createdAt: new Date('2026-09-01T12:00:00Z') }, [], 0, 1],
    ['temporary conversation', { isTemporary: true }, [], 0, 0],
    ['subagent thread', { subagentThread: { parentConversationId: 'parent' } }, [], 0, 0],
    ['foreign tenant', { tenantId: 'tenant-b' }, [], 0, 0],
    ['another root agent', { initial_agent_id: 'agent-b', agent_id: 'agent-a' }, [], 0, 0],
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
      expect(Object.keys(result).sort()).toEqual([
        'agentVersions',
        'agents',
        'comments',
        'daily',
        'models',
        'summary',
      ]);
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
          text: 'A comment for the agent owners',
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
      model: 'model-x',
      tokenType: 'prompt',
      tokenValue: -1_250_000,
      createdAt: now,
    });
    const detailed = await methods.getInsights(options);
    const userFind = jest.spyOn(mongoose.models.User, 'find');
    const conversationAggregate = jest.spyOn(mongoose.models.Conversation, 'aggregate');
    const messageAggregate = jest.spyOn(mongoose.models.Message, 'aggregate');
    const transactionAggregate = jest.spyOn(mongoose.models.Transaction, 'aggregate');
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
      comments: detailed.comments,
      daily: detailed.daily,
      models: detailed.models,
      agentVersions: detailed.agentVersions,
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
    expect(aggregate.models).toEqual([
      {
        model: 'model-x',
        responses: 0,
        completedResponses: 0,
        failedResponses: 0,
        interruptedResponses: 0,
        thumbsUp: 0,
        thumbsDown: 0,
        usageTokens: 0,
        spendUSD: 1.25,
      },
      {
        model: null,
        responses: 1,
        completedResponses: 1,
        failedResponses: 0,
        interruptedResponses: 0,
        thumbsUp: 0,
        thumbsDown: 1,
        usageTokens: 0,
        spendUSD: null,
      },
    ]);
    expect(Object.keys(aggregate).sort()).toEqual([
      'agentVersions',
      'agents',
      'comments',
      'daily',
      'models',
      'summary',
    ]);
    expect(aggregate.comments?.map(({ text, tag }) => [text, tag])).toEqual([
      ['A comment for the agent owners', 'inaccurate'],
    ]);
    expect(JSON.stringify(aggregate)).not.toContain(privateValue);
    expect(userFind).not.toHaveBeenCalled();
    expect(conversationAggregate).toHaveBeenCalledTimes(1);
    expect(messageAggregate).toHaveBeenCalledTimes(5);
    const pipelines = [
      ...conversationAggregate.mock.calls,
      ...messageAggregate.mock.calls,
      ...transactionAggregate.mock.calls,
    ];
    const isComments = (pipeline: unknown) => JSON.stringify(pipeline).includes('feedback.text');
    expect(pipelines.filter(isComments)).toHaveLength(1);
    const lists = pipelines.filter((pipeline) => !isComments(pipeline));
    const serialized = JSON.stringify(lists);
    expect(serialized).not.toContain('feedback.text');
    expect(serialized).not.toContain('matchedIdentity');
    expect(serialized).not.toContain('firstMessage');
    expect(serialized).not.toContain('"$first"');
    expect(serialized).not.toContain('"$limit"');
  });

  it('lists the latest written feedback of the selected agents, newest first', async () => {
    const now = Date.now();
    const user = new mongoose.Types.ObjectId().toString();
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);
    await fixtures.conversations.insertMany([
      { conversationId: 'chat', user, initial_agent_id: 'agent-a', createdAt: minutesAgo(60) },
      {
        conversationId: 'temporary',
        user,
        initial_agent_id: 'agent-a',
        isTemporary: true,
        createdAt: minutesAgo(60),
      },
      {
        conversationId: 'elsewhere',
        user,
        initial_agent_id: 'agent-b',
        agent_id: 'agent-b',
        createdAt: minutesAgo(60),
      },
    ]);
    const reply = (
      messageId: string,
      conversationId: string,
      minutes: number,
      feedback: Record<string, unknown>,
    ) => ({
      messageId,
      conversationId,
      user,
      isCreatedByUser: false,
      createdAt: minutesAgo(minutes),
      feedback,
    });
    await fixtures.messages.insertMany([
      ...Array.from({ length: 21 }, (_, index) =>
        reply(`older-${index}`, 'chat', 30 + index, {
          rating: 'thumbsDown',
          tag: 'other',
          text: `Older ${index}`,
        }),
      ),
      reply('latest', 'chat', 1, {
        rating: 'thumbsUp',
        tag: { key: 'other_feedback' },
        text: 'Great answer',
      }),
      reply('blank', 'chat', 2, { rating: 'thumbsDown', tag: 'inaccurate', text: '  ' }),
      reply('untagged', 'chat', 3, { rating: 'thumbsUp', text: 'No category' }),
      reply('temporary', 'temporary', 1, { rating: 'thumbsUp', text: 'Temporary chat' }),
      reply('elsewhere', 'elsewhere', 1, { rating: 'thumbsUp', text: 'Another agent' }),
      {
        messageId: 'prompt',
        conversationId: 'chat',
        user,
        isCreatedByUser: true,
        createdAt: minutesAgo(1),
        feedback: { rating: 'thumbsUp', text: 'On a prompt' },
      },
    ]);

    const { comments } = await createScopedInsightsMethods().getInsights({ showDetails: false });

    expect(comments).toHaveLength(20);
    expect(comments?.slice(0, 3)).toEqual([
      {
        agentId: 'agent-a',
        agentName: 'Agent A',
        date: minutesAgo(1).toISOString(),
        rating: 'thumbsUp',
        tag: 'other_feedback',
        text: 'Great answer',
      },
      {
        agentId: 'agent-a',
        agentName: 'Agent A',
        date: minutesAgo(3).toISOString(),
        rating: 'thumbsUp',
        tag: null,
        text: 'No category',
      },
      {
        agentId: 'agent-a',
        agentName: 'Agent A',
        date: minutesAgo(30).toISOString(),
        rating: 'thumbsDown',
        tag: 'other',
        text: 'Older 0',
      },
    ]);
    expect(comments?.[19]?.text).toBe('Older 17');

    const limited = await createScopedInsightsMethods().getInsights({
      showDetails: false,
      commentLimit: 2,
    });
    expect(limited.comments?.map(({ text }) => text)).toEqual(['Great answer', 'No category']);
  });

  it('counts stopped and Responses API replies by their final status, without caller inputs', async () => {
    const createdAt = new Date(Date.now() - 60_000);
    const user = new mongoose.Types.ObjectId().toString();
    await fixtures.conversations.insertOne({
      conversationId: 'responses',
      user,
      initial_agent_id: 'agent-a',
      createdAt,
    });
    const message = { conversationId: 'responses', user, createdAt };
    const reply = (messageId: string, finishReason: string) => ({
      ...message,
      messageId,
      isCreatedByUser: false,
      unfinished: false,
      error: false,
      finish_reason: finishReason,
      feedback: { rating: 'thumbsUp' },
    });
    const input = (messageId: string, role: string) => ({
      ...message,
      messageId,
      isCreatedByUser: false,
      isUserSubmitted: true,
      metadata: { responseInputRole: role },
      feedback: { rating: 'thumbsDown' },
    });
    await fixtures.messages.insertMany([
      { ...message, messageId: 'prompt', isCreatedByUser: true },
      input('instructions', 'system'),
      input('history', 'assistant'),
      reply('completed', 'stop'),
      reply('failed', 'failed'),
      reply('cancelled', 'cancelled'),
      reply('stopped', 'incomplete'),
    ]);

    const { summary, models } = await createScopedInsightsMethods().getInsights({
      showDetails: false,
    });

    expect(summary).toEqual(
      expect.objectContaining({
        totalResponses: 4,
        completedResponses: 1,
        failedResponses: 1,
        interruptedResponses: 2,
        feedback: feedbackCounts(4),
      }),
    );
    expect(models.map(({ responses }) => responses)).toEqual([4]);
  });

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

  it('leaves an excluded chat out of the full history of an inactive user', async () => {
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);
    const user = new mongoose.Types.ObjectId().toString();
    await fixtures.conversations.insertOne({
      conversationId: 'kept',
      user,
      initial_agent_id: 'agent-a',
      createdAt: daysAgo(29),
    });
    await fixtures.messages.insertMany([
      {
        messageId: 'kept-prompt',
        conversationId: 'kept',
        user,
        createdAt: daysAgo(29),
        isCreatedByUser: true,
      },
      ...['converted-first', 'converted-second'].map((messageId) => ({
        messageId,
        conversationId: 'converted',
        user,
        createdAt: daysAgo(60),
        isCreatedByUser: true,
        insightsAgentId: 'agent-a',
      })),
    ]);
    await createInsightsExclusionModel(mongoose).create({
      conversationId: 'converted',
      user,
      createdAt: daysAgo(59),
    });

    const { churnedUsers } = await createScopedInsightsMethods().getInsights({ range: '7d' });

    expect(churnedUsers?.map(({ conversations, messages }) => [conversations, messages])).toEqual([
      [1, 1],
    ]);
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
    const byUser = new Map(insights.latest!.conversations.map((row) => [row.userId, row]));

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
    expect(search.latest!.conversations).toEqual([
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
    expect(agentAInsights.latest!.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: 'primary-agent-a',
          agentId: 'agent-a',
          messages: 2,
          totalTokens: 12,
        }),
      ]),
    );
    expect(agentBInsights.latest!.conversations).toEqual([]);
    const combined = await methods.getInsights({
      tenantId: 'tenant-a',
      range: '7d',
      agentIds: ['agent-a', 'agent-b'],
    });
    expect(combined.summary).toEqual(agentAInsights.summary);
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

    expect(result.latest!.conversations).toEqual([
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
    expect(byConversationId.latest!.conversations.map((row) => row.conversationId)).toEqual([
      'incident-review-123',
    ]);
    expect(byUser.latest!.conversations.map((row) => row.conversationId)).toEqual([
      'incident-review-123',
    ]);
    expect(byMessage.latest!.conversations).toEqual([]);
    expect(crossTenant.latest).toEqual(expect.objectContaining({ conversations: [], pages: 1 }));
  });

  it('uses focused DocumentDB-compatible aggregations during searches', async () => {
    const conversationAggregateSpy = jest.spyOn(mongoose.models.Conversation, 'aggregate');
    const messageAggregateSpy = jest.spyOn(mongoose.models.Message, 'aggregate');
    const transactionAggregateSpy = jest.spyOn(mongoose.models.Transaction, 'aggregate');

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
        ...transactionAggregateSpy.mock.calls.flatMap(
          ([pipeline]) => pipeline as AggregationStage[],
        ),
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
        allStages.every(
          (stage) =>
            stage.$lookup == null || (!('let' in stage.$lookup) && !('pipeline' in stage.$lookup)),
        ),
      ).toBe(true);
      expect(messageAggregateSpy).toHaveBeenCalled();
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
      transactionAggregateSpy.mockRestore();
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
        .find((pipeline) => pipeline.some((stage) => stage.$lookup?.from === 'users'));
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
