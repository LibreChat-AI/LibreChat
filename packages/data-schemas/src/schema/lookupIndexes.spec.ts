import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FilterQuery, Model } from 'mongoose';
import { createModels } from '../models';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  Object.assign(mongoose.models, createModels(mongoose));
  await mongoose.connect(server.getUri());
  await Promise.all(
    ['Session', 'ToolCall', 'AgentQueuedTurn', 'Agent'].map((name) =>
      mongoose.models[name].createIndexes(),
    ),
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

/** Names the index the winning plan scans, or `COLLSCAN` when it reads the whole collection. */
async function winningScan(
  modelName: string,
  filter: FilterQuery<unknown>,
  seed: Record<string, unknown>[],
): Promise<string> {
  const model = mongoose.models[modelName] as Model<unknown>;
  await model.collection.deleteMany({});
  /** Filler rows without the indexed field keep the planner from preferring a scan on a tiny collection. */
  await model.collection.insertMany(seed);
  const plan = (await model.find(filter).explain('queryPlanner')) as unknown as {
    queryPlanner: { winningPlan: unknown };
  };
  const text = JSON.stringify(plan.queryPlanner.winningPlan);
  const match = /"stage":"IXSCAN".*?"indexName":"([^"]+)"/.exec(text);
  return match?.[1] ?? (text.includes('COLLSCAN') ? 'COLLSCAN' : text);
}

/** Builds rows that satisfy each collection's unique indexes via `make(index)`. */
const filler = (count: number, make: (index: number) => Record<string, unknown>) =>
  Array.from({ length: count }, (_, index) => ({ filler: index, ...make(index) }));

describe('single-field lookups use an index', () => {
  it('session by refreshTokenHash without a user', async () => {
    const scan = await winningScan('Session', { refreshTokenHash: 'abc' }, [
      ...filler(50, (i) => ({
        user: new mongoose.Types.ObjectId(),
        refreshTokenHash: `other-${i}`,
      })),
      { user: new mongoose.Types.ObjectId(), refreshTokenHash: 'abc' },
    ]);
    expect(scan).toBe('refreshTokenHash_1');
  });

  it('tool calls by user alone', async () => {
    const user = new mongoose.Types.ObjectId();
    const scan = await winningScan('ToolCall', { user }, [
      ...filler(50, () => ({ user: new mongoose.Types.ObjectId() })),
      { user },
    ]);
    expect(scan).toBe('user_1');
  });

  it.each([
    ['deliveryKey', { deliveryKey: 'key-1' }, 'agent_queued_turn_delivery_key'],
    [
      'reconciliationClaimId',
      { reconciliationClaimId: 'claim-1', reconciliationClaimBy: 'worker' },
      'agent_queued_turn_reconciliation_claim',
    ],
  ])('queued turns by %s', async (_name, filter, indexName) => {
    const scan = await winningScan('AgentQueuedTurn', filter, [
      ...filler(50, (i) => ({ clientRequestId: `filler-${i}` })),
      { ...filter, clientRequestId: 'target', filler: -1 },
    ]);
    expect(scan).toBe(indexName);
  });

  it.each([
    ['code_environment_id', 'agent_code_environment_id', 'env-1'],
    ['code_environment_ids', 'agent_code_environment_ids', 'env-1'],
  ])('agents by %s', async (field, indexName, value) => {
    const scan = await winningScan('Agent', { [field]: value }, [
      ...filler(50, (i) => ({ id: `filler-${i}` })),
      { id: 'target', [field]: field.endsWith('s') ? [value] : value, filler: -1 },
    ]);
    expect(scan).toBe(indexName);
  });
});
