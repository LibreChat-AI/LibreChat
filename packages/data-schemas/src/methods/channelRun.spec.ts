import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelRunRecord } from '~/models/channelRun';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelRunStorage } from './channelRun';
import { createUserMethods } from './user';
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
    await mongoose.models.StoredResponse.deleteMany({});
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
    await bindTestResponse(run);
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

it('isolates actor lanes across distinct personal links with the same revision', () =>
  scope(async () => {
    const first = event('link-one');
    const second = event('link-two');
    const a = await storage.admit(
      { ...first, principal: { ...first.principal, linkId: 'one', linkRevision: '1' } },
      100,
    );
    const b = await storage.admit(
      { ...second, principal: { ...second.principal, linkId: 'two', linkRevision: '1' } },
      101,
    );
    expect(a.run.laneId).not.toBe(b.run.laneId);
    const claimedA = (await storage.claim(tenantId, 'channel', 'worker-a', 102, 1000))!;
    const claimedB = (await storage.claim(tenantId, 'channel', 'worker-b', 103, 1000))!;
    const preparedA = await storage.prepareExecution(tenantId, fence(claimedA), 104);
    const preparedB = await storage.prepareExecution(tenantId, fence(claimedB), 104);
    expect(preparedA.execution?.conversationId).not.toBe(preparedB.execution?.conversationId);
    expect(preparedA.execution?.parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
    expect(preparedB.execution?.parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
  }));

it('deduplicates equivalent nested event fields regardless of object construction order', () =>
  scope(async () => {
    const input = event();
    const first = await storage.admit(input, 100);
    const { admission } = input;
    const replay = await storage.admit(
      {
        ...input,
        admission: {
          input: admission.input,
          actor: {
            externalUserId: admission.actor.externalUserId,
            appId: admission.actor.appId,
            teamId: admission.actor.teamId,
          },
          externalMessageKey: admission.externalMessageKey,
          externalThreadKey: admission.externalThreadKey,
          externalChannelId: admission.externalChannelId,
          eventId: admission.eventId,
        },
      },
      101,
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.run.runId).toBe(first.run.runId);
    expect(await mongoose.models.ChannelRun.countDocuments({ tenantId })).toBe(1);
  }));

it('atomically rejects a delayed cancellation after the observed run is reclaimed', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const first = (await storage.claim(tenantId, 'channel', 'worker', 101, 10))!;
    const observed = await storage.readActiveThread(event(), 105);
    expect(observed?.runId).toBe(first.runId);
    const replacement = (await storage.claim(tenantId, 'channel', 'replacement', 112, 1000))!;
    expect(
      await storage.requestCancel(event(), first.runId, {
        epoch: first.leaseEpoch,
        before: 105,
      }),
    ).toBe(false);
    expect((await storage.read(tenantId, 'channel', first.runId))?.cancellationRequested).toBe(
      false,
    );
    expect(
      await storage.requestCancel(event(), first.runId, {
        epoch: replacement.leaseEpoch,
        before: 105,
      }),
    ).toBe(false);
    expect(
      await storage.requestCancel(event('event', 'intruder'), first.runId, {
        epoch: replacement.leaseEpoch,
        before: 113,
      }),
    ).toBe(false);
    expect(
      await storage.requestCancel(event(), first.runId, {
        epoch: replacement.leaseEpoch,
        before: 113,
      }),
    ).toBe(true);
  }));

async function plannedRun() {
  await storage.admit(event(), 100);
  const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 10))!;
  await storage.prepareExecution(tenantId, fence(run), 102);
  await bindTestResponse(run);
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
  return run;
}

it('reconciles a verified uncertain delivery with a current fence, without blind resending', () =>
  scope(async () => {
    const run = await plannedRun();
    await storage.beginDelivery(tenantId, fence(run), 'message', 105);
    const replacement = (await storage.claim(tenantId, 'channel', 'replacement', 112, 1000))!;
    expect(replacement.receipts[0]).toMatchObject({ outcome: 'unknown', attempts: 1 });
    await expect(
      storage.beginDelivery(tenantId, fence(replacement), 'message', 113),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const evidence = {
      operationId: 'message',
      attempts: 1,
      outcome: 'confirmed' as const,
      externalMessageKey: 'C1:verified',
    };
    await expect(
      storage.reconcileDelivery(tenantId, fence(run), evidence, 113),
    ).rejects.toMatchObject({ code: 'stale_fence' });
    await expect(
      storage.reconcileDelivery(tenantId, fence(replacement), { ...evidence, attempts: 2 }, 113),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(
      storage.reconcileDelivery(
        tenantId,
        fence(replacement),
        { ...evidence, externalMessageKey: undefined },
        113,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.reconcileDelivery(tenantId, fence(replacement), evidence, 113);
    await storage.reconcileDelivery(tenantId, fence(replacement), evidence, 114);
    await expect(
      storage.reconcileDelivery(
        tenantId,
        fence(replacement),
        { ...evidence, externalMessageKey: 'C1:other' },
        114,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect((await storage.commitDelivery(tenantId, fence(replacement), 115)).state).toBe(
      'delivered',
    );
    await storage.admit(event('next'), 116);
    expect(
      (await storage.claim(tenantId, 'channel', 'next-worker', 117, 1000))?.admission.eventId,
    ).toBe('next');
  }));

it('rejects reconciliation of an operation that has never been sent', () =>
  scope(async () => {
    const run = await plannedRun();
    await expect(
      storage.reconcileDelivery(
        tenantId,
        fence(run),
        {
          operationId: 'message',
          attempts: 0,
          outcome: 'confirmed',
          externalMessageKey: 'fabricated',
        },
        105,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it('reconciles uncertain progress with the same attempt and immutable provider message', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 10))!;
    await storage.prepareExecution(tenantId, fence(run), 102);
    await storage.planProgress(
      tenantId,
      fence(run),
      { revision: 1, rendererVersion: 'test', text: 'working' },
      103,
    );
    await storage.beginProgress(tenantId, fence(run), 1, 104);
    const replacement = (await storage.claim(tenantId, 'channel', 'replacement', 112, 1000))!;
    const receipt = { revision: 1, attempts: 1, externalMessageKey: 'C1:progress' };
    await expect(
      storage.reconcileProgress(tenantId, fence(run), receipt, 113),
    ).rejects.toMatchObject({ code: 'stale_fence' });
    await expect(
      storage.reconcileProgress(tenantId, fence(replacement), { ...receipt, revision: 2 }, 113),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.reconcileProgress(tenantId, fence(replacement), receipt, 113);
    await storage.reconcileProgress(tenantId, fence(replacement), receipt, 114);
    await expect(
      storage.reconcileProgress(
        tenantId,
        fence(replacement),
        { ...receipt, externalMessageKey: 'C1:other' },
        114,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.planProgress(
      tenantId,
      fence(replacement),
      { revision: 2, rendererVersion: 'test', text: 'still working' },
      115,
    );
  }));

it('replays response binding after the authoritative parent differs from the original request', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    await storage.prepareExecution(tenantId, fence(run), 102);
    await mongoose.models.StoredResponse.create({
      tenantId,
      userId: 'actor',
      responseId: 'bound-response',
      requestKey: `channel:${run.runId}`,
      fingerprint: 'request',
      agentId: 'agent',
      requestJSON: JSON.stringify({
        model: 'agent',
        input: 'hello',
        background: true,
        store: true,
      }),
      conversationId: 'canonical-conversation',
      parentMessageId: 'canonical-parent',
      status: 'queued',
      revision: 0,
    });
    const first = await storage.bindResponse(tenantId, fence(run), 'bound-response', 103);
    const replay = await storage.bindResponse(tenantId, fence(run), 'bound-response', 104);
    expect(first.execution?.parentMessageId).toBe('canonical-parent');
    expect(replay.execution).toEqual(first.execution);
    await expect(
      storage.bindResponse(tenantId, fence(run), 'different-response', 105),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it('compares immutable delivery plans semantically while preserving part order', () =>
  scope(async () => {
    const run = await plannedRun();
    await storage.beginDelivery(tenantId, fence(run), 'message', 105);
    await expect(
      storage.savePlan(
        tenantId,
        fence(run),
        {
          parts: [{ text: 'answer', required: true, kind: 'message', operationId: 'message' }],
          rendererVersion: 'test',
          revision: 'plan',
        },
        106,
      ),
    ).resolves.toMatchObject({ plan: { revision: 'plan' } });
    await expect(
      storage.savePlan(
        tenantId,
        fence(run),
        {
          parts: [{ text: 'changed', required: true, kind: 'message', operationId: 'message' }],
          rendererVersion: 'test',
          revision: 'plan',
        },
        107,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it('seeks active predecessors without scanning completed lane history', () =>
  scope(async () => {
    const { run } = await storage.admit(event(), 100);
    await mongoose.models.ChannelRun.updateOne(
      { runId: run.runId },
      { $set: { state: 'delivered' } },
    );
    await mongoose.models.ChannelRun.insertMany(
      Array.from({ length: 200 }, (_, i) => ({
        ...event(`history-${i}`),
        laneId: run.laneId,
        payloadHash: 'historical',
        sequence: i + 2,
        runId: `history-${i}`,
        state: 'delivered',
        receivedAt: 0,
        leaseEpoch: 0,
        leaseExpiresAt: 0,
        receipts: [],
        cancellationRequested: false,
      })),
    );
    const plan = await mongoose.models.ChannelRun.collection
      .find({
        tenantId,
        laneId: run.laneId,
        state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
        sequence: { $lt: 1000 },
      })
      .hint('channel_run_active_predecessor')
      .explain('executionStats');
    expect(plan.executionStats.nReturned).toBe(0);
    expect(plan.executionStats.totalKeysExamined).toBeLessThan(10);
  }));

it('does not replay an admitted event through a different principal or linked account', () =>
  scope(async () => {
    const input = event();
    await storage.admit(input, 100);
    for (const principal of [
      { ...input.principal, userId: 'another-owner' },
      { ...input.principal, linkId: 'another-link' },
      { ...input.principal, channelRevision: 'new-revision' },
    ])
      await expect(storage.admit({ ...input, principal }, 101)).rejects.toMatchObject({
        code: 'event_conflict',
      });
    await expect(storage.admit({ ...input, agentId: 'another-agent' }, 101)).rejects.toMatchObject({
      code: 'event_conflict',
    });
  }));

it('erases channel request/output and legacy lane identity before deleting its account', () =>
  scope(async () => {
    const user = await mongoose.models.User.create({
      email: 'channel-erasure@example.com',
      provider: 'local',
      tenantId,
    });
    const userId = String(user._id);
    const input = { ...event(), principal: { ...event().principal, userId } };
    const own = await storage.admit(input, 100);
    const other = await storage.admit(event('other', 'other-owner'), 100);
    await mongoose.models.ChannelLane.updateOne(
      { laneId: own.run.laneId },
      { $unset: { userId: 1 } },
    );
    await createUserMethods(mongoose).deleteUserById(userId);
    expect(await storage.read(tenantId, 'channel', own.run.runId)).toBeNull();
    expect(await mongoose.models.ChannelLane.exists({ laneId: own.run.laneId })).toBeNull();
    expect(await storage.read(tenantId, 'channel', other.run.runId)).not.toBeNull();
    await expect(storage.admit(input, 101)).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it('serializes account erasure with an already inserting channel event', () =>
  scope(async () => {
    const user = await mongoose.models.User.create({
      email: 'channel-erasure-race@example.com',
      provider: 'local',
      tenantId,
    });
    const userId = String(user._id);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = mongoose.models.ChannelRun.collection;
    const insert = collection.insertOne.bind(collection);
    const paused = jest.spyOn(collection, 'insertOne').mockImplementation(async (...args) => {
      entered();
      await gate;
      return insert(...args);
    });
    const pending = storage.admit({ ...event(), principal: { ...event().principal, userId } }, 100);
    await started;
    let erased = false;
    const deletion = createUserMethods(mongoose)
      .deleteUserById(userId)
      .then((result) => {
        erased = true;
        return result;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(erased).toBe(false);
    } finally {
      release();
      paused.mockRestore();
    }
    await pending;
    await deletion;
    expect(await mongoose.models.ChannelRun.exists({ 'principal.userId': userId })).toBeNull();
    expect(await mongoose.models.ChannelLane.exists({ userId })).toBeNull();
  }));

async function bindTestResponse(run: ChannelRunRecord, responseId = 'response') {
  await mongoose.models.StoredResponse.create({
    tenantId: run.tenantId === '_' ? undefined : run.tenantId,
    userId: run.principal.userId,
    responseId,
    requestKey: `channel:${run.runId}`,
    fingerprint: 'request',
    agentId: run.agentId,
    requestJSON: JSON.stringify({
      model: run.agentId,
      input: run.admission.input,
      background: true,
      store: true,
    }),
    conversationId: 'bound-conversation',
    parentMessageId: 'bound-parent',
    status: 'queued',
    revision: 0,
  });
  return storage.bindResponse(run.tenantId, fence(run), responseId, 102);
}

it('renews the same fence idempotently without shortening a lease on reordered heartbeats', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    for (const now of [102, 102, 101])
      expect(await storage.renew(tenantId, fence(run), now, 1000)).toBe(true);
    expect((await storage.read(tenantId, 'channel', run.runId))?.leaseExpiresAt).toBe(1102);
    expect(
      await storage.renew(tenantId, { ...fence(run), epoch: run.leaseEpoch + 1 }, 103, 1000),
    ).toBe(false);
    expect(await storage.renew(tenantId, fence(run), 1102, 1000)).toBe(false);
    await expect(storage.renew(tenantId, fence(run), 103, -1)).rejects.toThrow(
      'Invalid channel lease',
    );
  }));

it.each(['teamId', 'appId', 'externalChannelId', 'externalThreadKey', 'agentId'] as const)(
  'isolates complete lane scope including %s in admission, lookup and cancellation',
  (field) =>
    scope(async () => {
      const first = event();
      const second = event('other');
      if (field === 'teamId' || field === 'appId') second.admission.actor[field] = 'different';
      else if (field === 'agentId') second.agentId = 'different';
      else second.admission[field] = 'different';
      const a = await storage.admit(first, 100);
      const b = await storage.admit(second, 101);
      expect(a.run.laneId).not.toBe(b.run.laneId);
      const claimedA = (await storage.claim(tenantId, 'channel', 'a', 102, 1000))!;
      const claimedB = (await storage.claim(tenantId, 'channel', 'b', 103, 1000))!;
      expect((await storage.readActiveThread(first, 104))?.runId).toBe(claimedA.runId);
      expect((await storage.readActiveThread(second, 104))?.runId).toBe(claimedB.runId);
      expect(await storage.requestCancel(second, claimedA.runId)).toBe(false);
      expect(await storage.requestCancel(first, claimedA.runId)).toBe(true);
      const pa = await storage.prepareExecution(tenantId, fence(claimedA), 104);
      const pb = await storage.prepareExecution(tenantId, fence(claimedB), 104);
      expect(pa.execution?.conversationId).not.toBe(pb.execution?.conversationId);
    }),
);

it('rejects unbound and mismatched response projections and revalidates them before cursor commit', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    await storage.prepareExecution(tenantId, fence(run), 102);
    const snapshot = {
      status: 'completed' as const,
      text: 'answer',
      elapsedMs: 1,
      responseId: 'response',
    };
    await expect(storage.saveSnapshot(tenantId, fence(run), snapshot, 103)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    await expect(
      storage.saveSnapshot(tenantId, fence(run), { ...snapshot, responseId: undefined }, 103),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await bindTestResponse(run);
    for (const status of [
      'running',
      'requires_action',
      'completed',
      'failed',
      'cancelled',
    ] as const)
      await expect(
        storage.saveSnapshot(
          tenantId,
          fence(run),
          { ...snapshot, status, responseId: 'other' },
          103,
        ),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.saveSnapshot(tenantId, fence(run), snapshot, 103);
    await storage.savePlan(
      tenantId,
      fence(run),
      {
        revision: 'v1',
        rendererVersion: 'test',
        parts: [{ operationId: 'm', kind: 'message', required: true, text: 'answer' }],
      },
      104,
    );
    await storage.beginDelivery(tenantId, fence(run), 'm', 105);
    await storage.settleDelivery(
      tenantId,
      fence(run),
      { operationId: 'm', attempts: 1, outcome: 'confirmed', externalMessageKey: 'C1:ok' },
      106,
    );
    await mongoose.models.ChannelRun.updateOne(
      { runId: run.runId },
      { $set: { 'snapshot.responseId': 'poison' } },
    );
    await expect(storage.commitDelivery(tenantId, fence(run), 107)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(
      await mongoose.models.ChannelLane.findOne({ laneId: run.laneId }).lean(),
    ).not.toHaveProperty('responseId');
  }));

it.each(['message', 'artifact'] as const)(
  'requires %s evidence in settlement, recovery and persisted commit',
  (kind) =>
    scope(async () => {
      await storage.admit(event(), 100);
      const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 10))!;
      await storage.prepareExecution(tenantId, fence(run), 102);
      await storage.saveSnapshot(
        tenantId,
        fence(run),
        { status: 'failed', text: 'failure', elapsedMs: 1 },
        103,
      );
      await storage.savePlan(
        tenantId,
        fence(run),
        {
          revision: 'v1',
          rendererVersion: 'test',
          parts: [
            {
              operationId: 'part',
              kind,
              required: true,
              text: 'answer',
              ...(kind === 'artifact' ? { artifactId: 'artifact' } : {}),
            },
          ],
        },
        104,
      );
      await storage.beginDelivery(tenantId, fence(run), 'part', 105);
      if (kind === 'artifact')
        await storage.checkpointUpload(
          tenantId,
          fence(run),
          'part',
          1,
          { fileId: 'file', stage: 'allocated' },
          105,
        );
      const receipt = { operationId: 'part', attempts: 1, outcome: 'confirmed' as const };
      const wrong =
        kind === 'artifact' ? { externalMessageKey: 'message' } : { externalFileId: 'file' };
      await expect(
        storage.settleDelivery(tenantId, fence(run), { ...receipt, ...wrong }, 106),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
      const replacement = (await storage.claim(tenantId, 'channel', 'replacement', 112, 1000))!;
      await expect(
        storage.reconcileDelivery(tenantId, fence(replacement), { ...receipt, ...wrong }, 113),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
      if (kind === 'artifact') {
        for (const evidence of [
          { externalFileId: 'other' },
          { externalFileId: 'file', upload: { fileId: 'other', stage: 'uploaded' as const } },
        ])
          await expect(
            storage.reconcileDelivery(
              tenantId,
              fence(replacement),
              { ...receipt, ...evidence },
              113,
            ),
          ).rejects.toMatchObject({ code: 'invalid_transition' });
      }
      const valid =
        kind === 'artifact' ? { externalFileId: 'file' } : { externalMessageKey: 'message' };
      await storage.reconcileDelivery(tenantId, fence(replacement), { ...receipt, ...valid }, 113);
      await storage.reconcileDelivery(tenantId, fence(replacement), { ...receipt, ...valid }, 114);
      await mongoose.models.ChannelRun.updateOne(
        { runId: run.runId },
        { $set: { receipts: [{ ...receipt, ...wrong }] } },
      );
      await expect(storage.commitDelivery(tenantId, fence(replacement), 115)).rejects.toMatchObject(
        { code: 'invalid_transition' },
      );
      await mongoose.models.ChannelRun.updateOne(
        { runId: run.runId },
        { $set: { receipts: [{ ...receipt, ...valid }] } },
      );
      expect((await storage.commitDelivery(tenantId, fence(replacement), 116)).state).toBe(
        'failed',
      );
    }),
);

it.each([undefined, null, ''])(
  'binds tenantless responses stored with tenantId %s',
  (storedTenant) =>
    tenantStorage.run({}, async () => {
      const input = { ...event(), tenantId: '_' };
      await storage.admit(input, 100);
      const run = (await storage.claim('_', 'channel', 'worker', 101, 1000))!;
      await storage.prepareExecution('_', fence(run), 102);
      await runAsSystem(async () =>
        mongoose.models.StoredResponse.collection.insertOne({
          ...(storedTenant === undefined ? {} : { tenantId: storedTenant }),
          userId: 'actor',
          agentId: 'agent',
          responseId: 'response',
          requestKey: `channel:${run.runId}`,
          fingerprint: 'request',
          requestJSON: JSON.stringify({ model: 'agent', input: 'hello', background: true }),
          conversationId: 'canonical',
          parentMessageId: 'parent',
          status: 'queued',
          revision: 0,
        }),
      );
      expect(
        (await storage.bindResponse('_', fence(run), 'response', 103)).execution?.responseId,
      ).toBe('response');
    }),
);

it('injects the configured claim batch without starving a later eligible lane', () =>
  scope(async () => {
    await storage.admit(event('first'), 100);
    await storage.claim(tenantId, 'channel', 'active', 101, 1000);
    for (let i = 0; i < 3; i++) await storage.admit(event(`blocked-${i}`), 102 + i);
    const other = await storage.admit(event('ready', 'another-actor'), 106);
    const small = createChannelRunStorage(mongoose, { claimBatchSize: 2 });
    expect(await small.claim(tenantId, 'channel', 'small', 107, 1000)).toBeNull();
    const large = createChannelRunStorage(mongoose, { claimBatchSize: 4 });
    expect((await large.claim(tenantId, 'channel', 'large', 108, 1000))?.runId).toBe(
      other.run.runId,
    );
    expect(() => createChannelRunStorage(mongoose, { claimBatchSize: 0 })).toThrow();
  }));
