import mongoose from 'mongoose';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TInsightsAggregateResponse, TInsightsSummary } from 'librechat-data-provider';
import type { PipelineStage } from 'mongoose';
import { createTransactionModel } from '../models/transaction';
import { createConversationModel } from '../models/convo';
import { createMessageModel } from '../models/message';
import { createInsightsMethods } from './insights';
import { createUserModel } from '../models/user';

const reportPath = process.env.INSIGHTS_PLAN_REPORT;
const planSuite = reportPath ? describe : describe.skip;
const activeAt = new Date('2026-10-03T12:00:00Z');
const historicalAt = new Date('2026-09-01T12:00:00Z');
const unrelatedAgents = Array.from({ length: 20 }, (_, index) => `unrelated-${index}`);
const allAgents = ['small', 'history', ...unrelatedAgents];

type CapturedQuery = { collection: 'conversations' | 'messages'; pipeline: PipelineStage[] };
type QueryReport = CapturedQuery & { counters: ReturnType<typeof counters>; explain: unknown };
type ScenarioReport = {
  traffic: string;
  selection: string;
  latenciesMS: number[];
  medianMS: number;
  summary: TInsightsSummary;
  queries: QueryReport[];
};

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function counters(explain: unknown) {
  if (!object(explain)) return {};
  const stages = Array.isArray(explain.stages) ? explain.stages.filter(object) : [];
  const cursor = stages.find((stage) => object(stage.$cursor))?.$cursor;
  let execution: Record<string, unknown> = {};
  if (object(explain.executionStats)) execution = explain.executionStats;
  else if (object(cursor) && object(cursor.executionStats)) execution = cursor.executionStats;
  return {
    cursorDocs: execution.totalDocsExamined,
    cursorKeys: execution.totalKeysExamined,
    executionMS: execution.executionTimeMillis,
    lookups: stages
      .filter((stage) => object(stage.$lookup))
      .map((stage) => ({
        from: object(stage.$lookup) ? stage.$lookup.from : undefined,
        documents: stage.totalDocsExamined,
        keys: stage.totalKeysExamined,
        scans: stage.collectionScans,
        indexes: stage.indexesUsed,
        rows: stage.nReturned,
      })),
  };
}

planSuite('Insights query plans (opt in with INSIGHTS_PLAN_REPORT)', () => {
  let mongo: MongoMemoryServer;
  const scenarios: ScenarioReport[] = [];

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      createConversationModel(mongoose).init(),
      createMessageModel(mongoose).init(),
      createTransactionModel(mongoose).init(),
      createUserModel(mongoose).init(),
    ]);
  });

  afterAll(async () => {
    try {
      if (reportPath) {
        await mkdir(dirname(reportPath), { recursive: true });
        await writeFile(
          reportPath,
          JSON.stringify(
            {
              label: process.env.INSIGHTS_PLAN_LABEL ?? 'working-tree',
              server: await mongoose.connection.db?.admin().serverInfo(),
              fixture: {
                conversations: await mongoose.models.Conversation.countDocuments(),
                messages: await mongoose.models.Message.countDocuments(),
                transactions: await mongoose.models.Transaction.countDocuments(),
              },
              indexes: {
                conversations: await mongoose.models.Conversation.collection.indexes(),
                messages: await mongoose.models.Message.collection.indexes(),
                transactions: await mongoose.models.Transaction.collection.indexes(),
              },
              scenarios,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await mongoose.disconnect();
      await mongo?.stop();
    }
  });

  async function seed(
    agent: string,
    conversations: number,
    historical: number,
    active: number,
    recent: number,
  ) {
    const conversationRows: Record<string, unknown>[] = [];
    const messages: Record<string, unknown>[] = [];
    const transactions: Record<string, unknown>[] = [];
    for (let index = 0; index < conversations; index += 1) {
      const conversationId = `${agent}-${index}`;
      const user = new mongoose.Types.ObjectId();
      conversationRows.push({
        conversationId,
        user: user.toString(),
        tenantId: 'plan-tenant',
        isTemporary: false,
        ...(index % 10 === 0
          ? { agent_id: agent }
          : { initial_agent_id: agent, agent_id: 'switched' }),
        createdAt: historicalAt,
        updatedAt: new Date('2026-11-01T12:00:00Z'),
      });
      for (let message = 0; message < historical + (index < active ? recent : 0); message += 1) {
        const createdAt = message < historical ? historicalAt : activeAt;
        const isCreatedByUser = message % 2 === 0;
        const messageId = `${conversationId}-${message}`;
        messages.push({
          conversationId,
          messageId,
          user: user.toString(),
          tenantId: 'plan-tenant',
          createdAt,
          isCreatedByUser,
          isTemporary: false,
          model: 'switched',
          tokenCount: 2,
          text: 'Synthetic benchmark payload. '.repeat(4),
        });
        transactions.push({
          conversationId,
          messageId,
          user,
          tenantId: 'plan-tenant',
          createdAt,
          tokenType: isCreatedByUser ? 'prompt' : 'completion',
          tokenValue: -1_000,
        });
      }
    }
    await mongoose.models.Conversation.collection.insertMany(conversationRows);
    await mongoose.models.Message.collection.insertMany(messages);
    await mongoose.models.Transaction.collection.insertMany(transactions);
  }

  async function measure(
    traffic: string,
    selection: string,
    agentIds: string[],
    messages: number,
    users: number,
  ) {
    const conversationSpy = jest.spyOn(mongoose.models.Conversation, 'aggregate');
    const messageSpy = jest.spyOn(mongoose.models.Message, 'aggregate');
    const methods = createInsightsMethods(mongoose);
    const latenciesMS: number[] = [];
    let result: TInsightsAggregateResponse | undefined;
    let captured: CapturedQuery[] = [];
    try {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        conversationSpy.mockClear();
        messageSpy.mockClear();
        const start = performance.now();
        result = await methods.getInsights({
          showDetails: false,
          tenantId: 'plan-tenant',
          agentIds,
          agents: allAgents.map((id) => ({ id, name: id })),
          range: 'custom',
          fromTimestamp: '2026-10-01T00:00:00Z',
          toTimestamp: '2026-10-07T23:59:59Z',
        });
        latenciesMS.push(performance.now() - start);
        expect(result.summary.totalConversations).toBe(0);
        expect(result.summary.totalMessages).toBe(messages);
        expect(result.summary.totalTokens).toBe(messages * 2);
        expect(result.summary.totalResponses).toBe(messages / 2);
        expect(result.summary.totalUsers).toBe(users);
        expect(result.summary.spendUSD).toBeCloseTo(messages / 1_000, 8);
        expect(result.summary.lastUsed).toBe(activeAt.toISOString());
        expect(Object.keys(result).sort()).toEqual(['agents', 'daily', 'summary']);
      }
      captured = [
        ...conversationSpy.mock.calls.flatMap(([pipeline]) =>
          pipeline ? [{ collection: 'conversations' as const, pipeline }] : [],
        ),
        ...messageSpy.mock.calls.flatMap(([pipeline]) =>
          pipeline ? [{ collection: 'messages' as const, pipeline }] : [],
        ),
      ];
    } finally {
      conversationSpy.mockRestore();
      messageSpy.mockRestore();
    }
    if (!result) throw new Error('Plan measurement produced no Insights result');
    const queries: QueryReport[] = [];
    for (const query of captured) {
      const model =
        query.collection === 'messages' ? mongoose.models.Message : mongoose.models.Conversation;
      const explain: unknown = await model.aggregate(query.pipeline).explain('executionStats');
      queries.push({ ...query, counters: counters(explain), explain });
    }
    scenarios.push({
      traffic,
      selection,
      latenciesMS,
      medianMS: [...latenciesMS].sort((left, right) => left - right)[1],
      summary: result.summary,
      queries,
    });
  }

  it('records real query plans for selected agents and all agents before and after unrelated traffic', async () => {
    await seed('small', 20, 20, 20, 2);
    await seed('history', 200, 100, 10, 2);
    await measure('quiet', 'small', ['small'], 40, 20);
    await measure('quiet', 'history', ['history'], 20, 10);
    await measure('quiet', 'all', allAgents, 60, 30);
    for (const agent of unrelatedAgents) await seed(agent, 50, 10, 50, 10);
    await measure('busy', 'small', ['small'], 40, 20);
    await measure('busy', 'history', ['history'], 20, 10);
    await measure('busy', 'all', allAgents, 10_060, 1_030);
    expect(scenarios).toHaveLength(6);
    for (const selection of ['small', 'history']) {
      const quiet = scenarios.find(
        (scenario) => scenario.traffic === 'quiet' && scenario.selection === selection,
      );
      const busy = scenarios.find(
        (scenario) => scenario.traffic === 'busy' && scenario.selection === selection,
      );
      expect(quiet).toBeDefined();
      expect(busy?.summary).toEqual(quiet?.summary);
    }
  }, 180_000);
});
