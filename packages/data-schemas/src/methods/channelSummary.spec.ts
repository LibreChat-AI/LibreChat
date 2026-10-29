import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ChannelRunRecord } from '~/models/channelRun';
import type { ChannelSummaryRow } from './channelSummary';
import { createChannelSummaryStorage, CHANNEL_SUMMARY_MAX_PRIOR_ROWS } from './channelSummary';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createChannelRunModel } from '~/models/channelRun';

let mongo: MongoMemoryServer;
const storage = createChannelSummaryStorage(mongoose);
function record(sequence = 1): ChannelRunRecord {
  return {
    tenantId: 'tenant',
    channelId: 'channel',
    agentId: 'agent',
    laneId: 'lane',
    runId: `run-${sequence}`,
    sequence,
    state: 'delivered',
    receivedAt: 1,
    payloadHash: 'hash',
    leaseEpoch: 1,
    leaseExpiresAt: 0,
    receipts: [],
    cancellationRequested: false,
    principal: {
      userId: 'same-internal-user',
      channelRevision: 'r1',
      linkId: 'link',
      linkRevision: 'l1',
    },
    admission: {
      eventId: `event-${sequence}`,
      externalChannelId: 'C1',
      externalThreadKey: 'C1:123',
      externalMessageKey: `C1:${sequence}`,
      input: 'secret transcript',
      actor: { teamId: 'T1', appId: 'A1', externalUserId: 'ACTOR-A' },
    },
    snapshot: {
      status: 'completed',
      text: 'secret answer',
      elapsedMs: 10,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      accounting: {
        status: 'available',
        currency: 'USD',
        amount: '0.1',
        basis: 'application_billing',
        coverage: 'complete',
        reason: 'priced',
        calls: [],
      },
    },
  };
}
async function read(scope: ChannelRunRecord): Promise<ChannelSummaryRow[]> {
  return tenantStorage.run({ tenantId: scope.tenantId }, async () => {
    const rows: ChannelSummaryRow[] = [];
    for await (const row of storage.priorMetrics(scope)) rows.push(row);
    return rows;
  });
}
beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createChannelRunModel(mongoose);
  await mongoose.models.ChannelRun.init();
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => mongoose.models.ChannelRun.deleteMany({}));
});

it('reads newest prior metrics only, using the existing lane index, without transcripts', async () => {
  await runAsSystem(async () =>
    mongoose.models.ChannelRun.insertMany([record(1), record(2), record(3)]),
  );
  const rows = await read(record(3));
  expect(rows.map((row) => row.sequence)).toEqual([2, 1]);
  expect(rows[0]).toEqual({
    sequence: 2,
    snapshot: {
      status: 'completed',
      elapsedMs: 10,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      accounting: {
        status: 'available',
        currency: 'USD',
        amount: '0.1',
        basis: 'application_billing',
        coverage: 'complete',
        reason: 'priced',
        calls: [],
      },
    },
  });
  expect(JSON.stringify(rows)).not.toContain('secret');
  expect(JSON.stringify(rows)).not.toContain('same-internal-user');
  const indexes = await mongoose.models.ChannelRun.collection.indexes();
  expect(
    indexes.some(
      (index) =>
        JSON.stringify(index.key) === JSON.stringify({ tenantId: 1, laneId: 1, sequence: 1 }),
    ),
  ).toBe(true);
});

it.each([
  'tenant',
  'lane',
  'channel',
  'agent',
  'user',
  'channelRevision',
  'link',
  'linkRevision',
  'team',
  'app',
  'actor',
  'thread',
  'externalChannel',
])('excludes a foreign %s even when a malformed row reuses the same lane', async (kind) => {
  const foreign = record(1);
  if (kind === 'tenant') foreign.tenantId = 'other';
  if (kind === 'lane') foreign.laneId = 'other';
  if (kind === 'channel') foreign.channelId = 'other';
  if (kind === 'agent') foreign.agentId = 'other';
  if (kind === 'user') foreign.principal.userId = 'other';
  if (kind === 'channelRevision') foreign.principal.channelRevision = 'other';
  if (kind === 'link') foreign.principal.linkId = 'other';
  if (kind === 'linkRevision') foreign.principal.linkRevision = 'other';
  if (kind === 'team') foreign.admission.actor.teamId = 'other';
  if (kind === 'app') foreign.admission.actor.appId = 'other';
  if (kind === 'actor') foreign.admission.actor.externalUserId = 'ACTOR-B';
  if (kind === 'thread') foreign.admission.externalThreadKey = 'other';
  if (kind === 'externalChannel') foreign.admission.externalChannelId = 'other';
  await runAsSystem(async () => mongoose.models.ChannelRun.create(foreign));
  expect(await read(record(2))).toEqual([]);
});

it('keeps failed/cancelled/legacy attempts visible as metric coverage gaps', async () => {
  await runAsSystem(async () =>
    mongoose.models.ChannelRun.insertMany([
      { ...record(1), state: 'failed', snapshot: undefined },
      { ...record(2), state: 'cancelled' },
      { ...record(3), state: 'blocked' },
    ]),
  );
  expect((await read(record(4))).map((row) => row.sequence)).toEqual([3, 2, 1]);
});

it('bounds long-history reads at newest 1000 rows without silently altering the sequence cutoff', async () => {
  const count = CHANNEL_SUMMARY_MAX_PRIOR_ROWS + 3;
  await runAsSystem(async () =>
    mongoose.models.ChannelRun.insertMany(Array.from({ length: count }, (_, i) => record(i + 1))),
  );
  const rows = await read(record(count));
  expect(rows).toHaveLength(CHANNEL_SUMMARY_MAX_PRIOR_ROWS);
  expect(rows[0].sequence).toBe(count - 1);
  expect(rows[rows.length - 1]?.sequence).toBe(count - CHANNEL_SUMMARY_MAX_PRIOR_ROWS);
});

it('throws for invalid sequence and database failure instead of disguising outages as absence', async () => {
  await expect(read(record(0))).rejects.toThrow('Invalid channel summary sequence');
  const other = new mongoose.Mongoose();
  await expect(
    (async () => {
      for await (const row of createChannelSummaryStorage(other).priorMetrics(record(2))) void row;
    })(),
  ).rejects.toThrow();
});
