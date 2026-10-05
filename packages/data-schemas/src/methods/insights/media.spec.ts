import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTransactionModel } from '../../models/transaction';
import { createMediaJobModel } from '../../models/media';
import { createIndexesWithRetry } from '~/utils/retry';
import { getMediaInsights } from './media';

let mongo: MongoMemoryServer;
const owner = new mongoose.Types.ObjectId();
const otherOwner = new mongoose.Types.ObjectId();
const createdAt = new Date();
const options = {
  tenantId: 'tenant-a',
  from: new Date(Date.now() - 60_000),
  to: new Date(Date.now() + 60_000),
  page: 1,
  pageSize: 5,
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createMediaJobModel(mongoose);
  await createIndexesWithRetry(createTransactionModel(mongoose));
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    mongoose.models.MediaJob.deleteMany({}),
    mongoose.models.Transaction.deleteMany({}),
  ]);
});

const job = (jobId: string, changes = {}) => ({
  jobId,
  clientRequestId: jobId,
  ownerId: owner.toString(),
  tenantId: 'tenant-a',
  createdAt,
  executionOwner: 'media',
  receipt: { phase: 'accepted' },
  phase: 'succeeded',
  execution: { api: 'openai', modelId: 'image-model', accountingMode: 'balance' },
  operation: 'image.generate',
  provider: { certainty: 'terminal' },
  ...changes,
});
const transaction = (jobId: string, changes = {}) => ({
  user: owner,
  tenantId: 'tenant-a',
  mediaJobId: jobId,
  context: 'media',
  costUSD: 1,
  costSource: 'provider',
  tokenValue: -100,
  ...changes,
});

it('aggregates durable outcomes and the shared ledger without chat, cross-owner or cross-tenant costs', async () => {
  await mongoose.models.MediaJob.collection.insertMany([
    job('known'),
    job('estimated'),
    job('legacy'),
    job('operator', { phase: 'failed', recoveryDecisions: [{ request: { action: 'settle' } }] }),
    job('unknown', { phase: 'requires_attention', provider: { certainty: 'unknown' } }),
    job('cancelled', { phase: 'cancelled', provider: { certainty: 'unsubmitted' } }),
    job('active', { phase: 'queued', provider: { certainty: 'unsubmitted' } }),
    job('native', { executionOwner: 'chat' }),
    job('private', { tenantId: 'tenant-b' }),
    job('unpublished', { receipt: { phase: 'preparing' } }),
  ]);
  await mongoose.models.Transaction.collection.insertMany([
    transaction('known'),
    transaction('estimated', { costUSD: 2, costSource: 'estimate' }),
    transaction('legacy', { costUSD: 3, costSource: null }),
    transaction('operator', { costUSD: 4 }),
    transaction('unknown', { tenantId: 'tenant-b', costUSD: 100 }),
    transaction('unknown', { user: otherOwner, costUSD: 200 }),
    transaction('known', { context: 'media_debt', costUSD: 900 }),
  ]);
  const result = await getMediaInsights(mongoose, options);
  expect(result.summary).toEqual({
    submitted: 7,
    completed: 3,
    failed: 1,
    cancelled: 1,
    uncertain: 1,
    active: 1,
    providerCostUSD: 1,
    tokenCostUSD: 0,
    creditsCharged: 400,
    balanceCostJobs: 7,
    unbilledJobs: 0,
    operatorCostUSD: 4,
    estimatedCostUSD: 2,
    unclassifiedCostUSD: 3,
    unknownCostJobs: 1,
  });
  expect(result.offerings).toHaveLength(1);
  expect(result.offerings[0]).toMatchObject({
    provider: 'openai',
    model: 'image-model',
    operation: 'image.generate',
  });
  expect(JSON.stringify(result)).not.toContain('ownerId');
});

it('treats the default tenant explicitly and keeps every tenant out of its result', async () => {
  await mongoose.models.MediaJob.collection.insertMany([
    job('tenant'),
    job('default', { tenantId: null }),
  ]);
  await mongoose.models.Transaction.collection.insertMany([
    transaction('default', { tenantId: null, costUSD: 0 }),
  ]);
  const result = await getMediaInsights(mongoose, { ...options, tenantId: undefined });
  expect(result.summary.submitted).toBe(1);
  expect(result.summary.unknownCostJobs).toBe(0);
});

it('reads immutable legacy costs alongside generic receipt columns and prefers the frozen job mode', async () => {
  await mongoose.models.MediaJob.collection.insertMany([job('legacy'), job('generic')]);
  const legacy = transaction('legacy');
  await mongoose.models.Transaction.collection.insertMany([
    {
      user: legacy.user,
      tenantId: legacy.tenantId,
      mediaJobId: legacy.mediaJobId,
      context: legacy.context,
      tokenValue: -40,
      mediaCostUSD: 2,
      mediaCostSource: 'provider',
      mediaAccountingMode: 'transactions',
    },
    transaction('generic', { costUSD: 3, tokenValue: -60 }),
  ]);
  const result = await getMediaInsights(mongoose, options);
  expect(result.summary).toMatchObject({
    providerCostUSD: 5,
    creditsCharged: 100,
    balanceCostJobs: 2,
  });
});

it('reports token-priced cost and actually charged credits independently of owed credits', async () => {
  await mongoose.models.MediaJob.collection.insertOne(job('tokens'));
  await mongoose.models.Transaction.collection.insertOne(
    transaction('tokens', {
      costSource: 'tokens',
      costUSD: 0.002,
      rawAmount: -2000,
      tokenValue: -600,
      mediaDebtCredits: 1400,
    }),
  );
  const result = await getMediaInsights(mongoose, options);
  expect(result.summary).toEqual(
    expect.objectContaining({
      tokenCostUSD: 0.002,
      providerCostUSD: 0,
      creditsCharged: 600,
      unclassifiedCostUSD: 0,
      unknownCostJobs: 0,
    }),
  );
});

it('distinguishes unbilled jobs and transaction-only usage from credits debited to a balance', async () => {
  await mongoose.models.MediaJob.collection.insertMany([
    job('none', { execution: { api: 'openai', modelId: 'image-model', accountingMode: 'none' } }),
    job('transactions', {
      execution: { api: 'openai', modelId: 'image-model', accountingMode: 'transactions' },
    }),
    job('balance'),
  ]);
  await mongoose.models.Transaction.collection.insertMany([
    transaction('transactions', {
      context: 'image_generation',
      tokenValue: -500,
    }),
    transaction('balance', {
      context: 'image_edit',
      tokenValue: -75,
    }),
  ]);
  const result = await getMediaInsights(mongoose, options);
  expect(result.summary).toMatchObject({
    unbilledJobs: 1,
    balanceCostJobs: 1,
    creditsCharged: 75,
    providerCostUSD: 2,
    unknownCostJobs: 0,
  });
});

it('paginates offerings while preserving totals and ignores jobs outside the shared date range', async () => {
  await mongoose.models.MediaJob.collection.insertMany([
    ...Array.from({ length: 7 }, (_, i) =>
      job(`job-${i}`, { execution: { api: 'openai', modelId: `model-${i}` } }),
    ),
    job('old', { createdAt: new Date('2000-01-01T00:00:00.000Z') }),
  ]);
  const [first, second] = await Promise.all([
    getMediaInsights(mongoose, options),
    getMediaInsights(mongoose, { ...options, page: 2 }),
  ]);
  expect(first.summary.submitted).toBe(7);
  expect(first.pages).toBe(2);
  expect(first.offerings).toHaveLength(5);
  expect(second.offerings).toHaveLength(2);
  expect(second.summary).toEqual(first.summary);
  expect(new Set([...first.offerings, ...second.offerings].map((row) => row.model)).size).toBe(7);
});

it('uses the shared ledger index for each job lookup', async () => {
  await mongoose.models.MediaJob.collection.insertOne(job('indexed'));
  await mongoose.models.Transaction.collection.insertMany([
    transaction('indexed'),
    ...Array.from({ length: 200 }, (_, i) => transaction(`unrelated-${i}`)),
  ]);
  const aggregate = jest.spyOn(mongoose.models.MediaJob, 'aggregate');
  await getMediaInsights(mongoose, options);
  const pipeline = aggregate.mock.calls[0][0]!;
  aggregate.mockRestore();
  const explanation = await mongoose.models.MediaJob.aggregate(pipeline).explain('executionStats');
  const plan = explanation.stages[0].$cursor.queryPlanner.winningPlan.queryPlan;
  expect(plan).toMatchObject({ stage: 'EQ_LOOKUP', strategy: 'IndexedLoopJoin' });
  expect(plan.indexName).toBe('mediaJobId_1');
});
