import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelRunRecord } from '~/models/channelRun';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelRunStorage } from './channelRun';
import { createModels } from '~/models';

let mongo: MongoMemoryReplSet;
let storage: ReturnType<typeof createChannelRunStorage>;
const tenantId = 'channel-storage-test';
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const fence = (run: ChannelRunRecord) => ({
  runId: run.runId,
  owner: run.leaseOwner!,
  epoch: run.leaseEpoch,
});
const event = (eventId = 'event', actorId = 'actor') => ({
  tenantId,
  channelId: 'channel',
  agentId: 'agent',
  principal: { userId: actorId, channelRevision: 'revision' },
  admission: {
    eventId,
    externalChannelId: 'C1',
    externalThreadKey: 'C1:1',
    externalMessageKey: `C1:${eventId}`,
    actor: { teamId: 'T1', appId: 'A1', externalUserId: actorId },
    input: 'hello',
  },
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  storage = createChannelRunStorage(mongoose);
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.ChannelRun.deleteMany({});
    await mongoose.models.ChannelLane.deleteMany({});
  });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it('admits concurrent retries as one event and one lane sequence', () =>
  scope(async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => storage.admit(event(), 100)),
    );
    expect(new Set(attempts.map(({ run }) => run.runId)).size).toBe(1);
    expect(attempts.filter(({ duplicate }) => !duplicate)).toHaveLength(1);
    expect(await mongoose.models.ChannelRun.countDocuments({ tenantId })).toBe(1);
    expect(await mongoose.models.ChannelLane.findOne({ tenantId }).lean()).toMatchObject({
      nextSequence: 1,
    });
  }));

it('rejects changed payloads that reuse an admitted event identity', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const changed = event();
    changed.admission.input = 'different';
    await expect(storage.admit(changed, 101)).rejects.toMatchObject({ code: 'event_conflict' });
  }));

it('orders one actor while allowing another actor to make progress', () =>
  scope(async () => {
    const first = await storage.admit(event(), 100);
    await storage.admit(event('next'), 101);
    const other = await storage.admit(event('other', 'other-actor'), 102);
    expect((await storage.claim(tenantId, 'channel', 'worker', 103, 1000))?.runId).toBe(
      first.run.runId,
    );
    expect((await storage.claim(tenantId, 'channel', 'other-worker', 104, 1000))?.runId).toBe(
      other.run.runId,
    );
    expect(await storage.claim(tenantId, 'channel', 'third-worker', 105, 1000)).toBeNull();
  }));

it('rejects a superseded worker after its lease is reclaimed', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const first = (await storage.claim(tenantId, 'channel', 'worker', 101, 10))!;
    await storage.prepareExecution(tenantId, fence(first), 102);
    const replacement = (await storage.claim(tenantId, 'channel', 'replacement', 112, 1000))!;
    expect(replacement.leaseEpoch).toBeGreaterThan(first.leaseEpoch);
    await expect(
      storage.saveSnapshot(
        tenantId,
        fence(first),
        { status: 'completed', text: 'answer', elapsedMs: 1 },
        113,
      ),
    ).rejects.toMatchObject({ code: 'stale_fence' });
  }));

it('holds the lane until every required delivery has been confirmed', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    await storage.prepareExecution(tenantId, fence(run), 102);
    await storage.saveSnapshot(
      tenantId,
      fence(run),
      { status: 'completed', text: 'answer', responseId: 'response', elapsedMs: 1 },
      103,
    );
    await storage.savePlan(
      tenantId,
      fence(run),
      {
        revision: 'plan',
        rendererVersion: 'test',
        parts: [{ operationId: 'message', kind: 'message', required: true, text: 'answer' }],
      },
      104,
    );
    await expect(storage.commitDelivery(tenantId, fence(run), 105)).rejects.toMatchObject({
      code: 'delivery_incomplete',
    });
    expect(await mongoose.models.ChannelLane.findOne({ tenantId }).lean()).toMatchObject({
      activeRunId: run.runId,
    });
  }));
