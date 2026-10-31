import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelRunSummary } from 'librechat-data-provider';
import type { ChannelRunRecord } from '~/models/channelRun';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
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

async function seedRunLink(input: ReturnType<typeof event>, linkId: string) {
  await mongoose.models.ChannelIdentity.deleteMany({ tenantId, 'identity.channelId': 'channel' });
  await mongoose.models.ChannelIdentity.create({
    tenantId,
    linkId,
    revision: '1',
    state: 'active',
    userId: input.principal.userId,
    ticketHash: `ticket-${linkId}`,
    ticketExpiresAtMs: 10000,
    expiresAtMs: 10000,
    identity: {
      tenantId,
      channelId: input.channelId,
      channelRevision: input.principal.channelRevision,
      teamId: input.admission.actor.teamId,
      externalUserId: input.admission.actor.externalUserId,
      agentId: input.agentId,
    },
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  storage = createChannelRunStorage(mongoose);
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.AgentChannel.deleteMany({});
    await mongoose.models.ChannelIdentity.deleteMany({});
    await mongoose.models.ChannelScope.deleteMany({});
    await mongoose.models.ResponseScope.deleteMany({});
    await createAgentChannelMethods(mongoose).createAgentChannel({
      tenantId,
      channelId: 'channel',
      agentId: 'agent',
      createdBy: 'channel-owner',
      type: 'slack',
      status: 'active',
      credentialMode: 'shared',
      revision: 'revision',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
    });
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
    await seedRunLink(first, 'one');
    const a = await storage.admit(
      { ...first, principal: { ...first.principal, linkId: 'one', linkRevision: '1' } },
      100,
    );
    await seedRunLink(second, 'two');
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

it('pins a skewed Stop to its first cutoff and epoch across retries and replicas', () =>
  scope(async () => {
    const input = event();
    await storage.admit(input, 100);
    const first = (await storage.claim(tenantId, 'channel', 'first', 101, 10))!;
    const observed = await storage.observeThreadStop(input, 120, 105);
    expect(observed).toMatchObject({
      before: 105,
      run: { runId: first.runId, leaseEpoch: first.leaseEpoch },
    });
    const replica = createChannelRunStorage(mongoose);
    expect(await replica.observeThreadStop(input, 120, 110)).toMatchObject({
      before: 105,
      run: { leaseEpoch: first.leaseEpoch },
    });
    const replacement = (await storage.claim(tenantId, 'channel', 'second', 112, 1000))!;
    expect(replacement.leaseEpoch).toBeGreaterThan(first.leaseEpoch);
    expect(await replica.observeThreadStop(input, 120, 118)).toBeNull();
    expect(
      await storage.requestCancel(input, first.runId, { epoch: first.leaseEpoch, before: 105 }),
    ).toBe(false);
    expect(await replica.observeThreadStop(input, 119, 121)).toBeNull();
    const fresh = await replica.observeThreadStop(input, 122, 123);
    expect(fresh).toMatchObject({
      before: 122,
      run: { runId: replacement.runId, leaseEpoch: replacement.leaseEpoch },
    });
    expect(
      await storage.requestCancel(input, fresh!.run.runId, {
        epoch: fresh!.run.leaseEpoch,
        before: fresh!.before,
      }),
    ).toBe(true);
  }));

it('retains an empty Stop observation before lane creation and never targets a later run', () =>
  scope(async () => {
    const input = event();
    expect(await storage.observeThreadStop(input, 120, 100)).toBeNull();
    const admitted = await storage.admit(input, 101);
    expect(admitted.run.sequence).toBe(1);
    const first = (await storage.claim(tenantId, 'channel', 'first', 102, 1000))!;
    expect(await createChannelRunStorage(mongoose).observeThreadStop(input, 120, 110)).toBeNull();
    expect(await storage.observeThreadStop(input, 119, 121)).toBeNull();
    expect((await storage.read(tenantId, 'channel', first.runId))?.cancellationRequested).toBe(
      false,
    );
    expect(await storage.observeThreadStop(input, 122, 123)).toMatchObject({
      run: { runId: first.runId },
      before: 122,
    });
  }));

it('retains the first run target after it completes instead of cancelling the next actor turn', () =>
  scope(async () => {
    const input = event();
    await storage.admit(input, 100);
    const first = (await storage.claim(tenantId, 'channel', 'first', 101, 1000))!;
    expect(await storage.observeThreadStop(input, 120, 105)).toMatchObject({
      run: { runId: first.runId },
    });
    // Model the atomic finish transition; the assertion concerns durable Stop replay, not execution.
    await mongoose.models.ChannelRun.updateOne(
      { runId: first.runId },
      { $set: { state: 'delivered' } },
    );
    await mongoose.models.ChannelLane.updateOne(
      { activeRunId: first.runId },
      { $unset: { activeRunId: '' } },
    );
    await storage.admit(event('next'), 106);
    const next = (await storage.claim(tenantId, 'channel', 'second', 107, 1000))!;
    expect(next.runId).not.toBe(first.runId);
    expect(await storage.observeThreadStop(input, 120, 115)).toBeNull();
    expect((await storage.read(tenantId, 'channel', next.runId))?.cancellationRequested).toBe(
      false,
    );
  }));

it('keeps one external Stop observation across changes to the linked execution principal', () =>
  scope(async () => {
    const first = event('first');
    const second = { ...event('second'), principal: { ...first.principal, userId: 'new-account' } };
    await storage.admit(first, 100);
    const a = (await storage.claim(tenantId, 'channel', 'a', 101, 1000))!;
    expect(await storage.observeThreadStop(first, 120, 105)).toMatchObject({
      run: { runId: a.runId },
    });
    await storage.admit(second, 106);
    const b = (await storage.claim(tenantId, 'channel', 'b', 107, 1000))!;
    expect(await storage.observeThreadStop(second, 120, 110)).toBeNull();
    expect(await storage.observeThreadStop(second, 119, 110)).toBeNull();
    expect((await storage.read(tenantId, 'channel', b.runId))?.cancellationRequested).toBe(false);
    expect(await storage.observeThreadStop(second, 121, 111)).toMatchObject({
      run: { runId: b.runId },
      before: 111,
    });
    expect(
      await mongoose.models.ChannelLane.countDocuments({
        tenantId,
        stopObservation: { $exists: true },
      }),
    ).toBe(1);
    expect(await storage.observeThreadStop(first, 120, 112)).toBeNull();
  }));

it('serializes duplicate Stop observations across principal lanes without rebinding either target', () =>
  scope(async () => {
    const first = event('first');
    const second = { ...event('second'), principal: { ...first.principal, userId: 'new-account' } };
    await storage.admit(first, 100);
    await storage.claim(tenantId, 'channel', 'a', 101, 1000);
    await storage.admit(second, 102);
    await storage.claim(tenantId, 'channel', 'b', 103, 1000);
    const replica = createChannelRunStorage(mongoose);
    const observations = await Promise.all([
      storage.observeThreadStop(first, 120, 105),
      replica.observeThreadStop(second, 120, 106),
    ]);
    expect(observations.filter(Boolean)).toHaveLength(1);
    expect(
      await mongoose.models.ChannelLane.countDocuments({
        tenantId,
        stopObservation: { $exists: true },
      }),
    ).toBe(1);
    const replay = await Promise.all([
      storage.observeThreadStop(first, 120, 108),
      replica.observeThreadStop(second, 120, 109),
    ]);
    expect(replay.filter(Boolean)).toHaveLength(1);
    expect(replay.find(Boolean)?.run.runId).toBe(observations.find(Boolean)?.run.runId);
    expect(replay.find(Boolean)?.before).toBe(observations.find(Boolean)?.before);
  }));

it('preserves an absent Stop target through a principal transition', () =>
  scope(async () => {
    const first = event();
    expect(await storage.observeThreadStop(first, 120, 100)).toBeNull();
    const second = { ...event('next'), principal: { ...first.principal, userId: 'new-account' } };
    await storage.admit(second, 101);
    const claimed = (await storage.claim(tenantId, 'channel', 'b', 102, 1000))!;
    expect(await storage.observeThreadStop(second, 120, 110)).toBeNull();
    expect((await storage.read(tenantId, 'channel', claimed.runId))?.cancellationRequested).toBe(
      false,
    );
    expect(await storage.observeThreadStop(second, 121, 111)).toMatchObject({
      run: { runId: claimed.runId },
    });
  }));

it('does not couple Stop occurrences for distinct external actors', () =>
  scope(async () => {
    const first = event('first', 'one');
    const second = event('second', 'two');
    await storage.admit(first, 100);
    const a = (await storage.claim(tenantId, 'channel', 'a', 101, 1000))!;
    await storage.admit(second, 102);
    const b = (await storage.claim(tenantId, 'channel', 'b', 103, 1000))!;
    const observations = await Promise.all([
      storage.observeThreadStop(first, 120, 105),
      storage.observeThreadStop(second, 120, 106),
    ]);
    expect(observations.map((o) => o?.run.runId)).toEqual([a.runId, b.runId]);
  }));

it('owns legacy empty Stop lanes for erasure and cannot recreate them after account deletion', () =>
  scope(async () => {
    const user = await mongoose.models.User.create({
      email: 'stop-erasure@example.com',
      provider: 'local',
      tenantId,
    });
    const input = { ...event(), principal: { ...event().principal, userId: String(user._id) } };
    await storage.admit(input, 100);
    // Retained legacy lane after run cleanup, before lane ownership was recorded.
    await mongoose.models.ChannelRun.deleteMany({ tenantId });
    await mongoose.models.ChannelLane.updateMany(
      { userId: input.principal.userId },
      { $unset: { userId: 1 } },
    );
    await storage.observeThreadStop(input, 120, 101);
    await createUserMethods(mongoose).deleteUserById(input.principal.userId);
    expect(await storage.observeThreadStop(input, 121, 110)).toBeNull();
    expect(
      await mongoose.models.ChannelLane.countDocuments({
        tenantId,
        userId: input.principal.userId,
      }),
    ).toBe(0);
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
        code:
          principal.channelRevision !== input.principal.channelRevision || 'linkId' in principal
            ? 'invalid_transition'
            : 'event_conflict',
      });
    await expect(storage.admit({ ...input, agentId: 'another-agent' }, 101)).rejects.toMatchObject({
      code: 'invalid_transition',
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
    sourceKeyId: (await storage.read(run.tenantId, run.channelId, run.runId))?.execution?.apiKeyId,
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
      if (field === 'agentId') {
        await expect(storage.admit(second, 101)).rejects.toMatchObject({
          code: 'invalid_transition',
        });
        expect(await mongoose.models.ChannelRun.countDocuments({ tenantId })).toBe(1);
        return;
      }
      if (field === 'teamId' || field === 'appId') {
        await createAgentChannelMethods(mongoose).updateAgentChannel('channel', 'channel-owner', {
          revision: 'rotated',
          slack: {
            teamId: second.admission.actor.teamId,
            appId: second.admission.actor.appId,
            botUserId: 'B1',
          },
        });
        second.principal.channelRevision = 'rotated';
      }
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
        {
          status: 'failed',
          text: 'failure',
          elapsedMs: 1,
          artifacts: kind === 'artifact' ? [testArtifact] : [],
        },
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
      await runAsSystem(async () =>
        mongoose.models.AgentChannel.updateOne(
          { channelId: 'channel' },
          { $unset: { tenantId: '' } },
        ),
      );
      await createAgentChannelMethods(mongoose).updateAgentChannel('channel', 'channel-owner', {
        revision: 'revision',
      });
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

const testArtifact = {
  artifactId: 'artifact',
  filename: 'report.txt',
  mediaType: 'text/plain',
  bytes: 12,
  sha256: 'hash',
};

it('migrates the prototype event constraint before admitting colliding event IDs from different apps', () =>
  scope(async () => {
    const collection = mongoose.models.ChannelRun.collection;
    const legacy = {
      tenantId: 1,
      channelId: 1,
      'admission.actor.teamId': 1,
      'admission.eventId': 1,
    };
    await collection.createIndex(legacy, { unique: true, name: 'prototype_event' });
    const revised = createChannelRunStorage(mongoose);
    const second = event();
    second.admission.actor.appId = 'other-app';
    const a = await revised.admit(event(), 100);
    await createAgentChannelMethods(mongoose).updateAgentChannel('channel', 'channel-owner', {
      revision: 'rotated',
      slack: { teamId: 'T1', appId: 'other-app', botUserId: 'B1' },
    });
    second.principal.channelRevision = 'rotated';
    const b = await revised.admit(second, 100);
    expect(a.run.runId).not.toBe(b.run.runId);
    expect((await revised.admit(second, 101)).run.runId).toBe(b.run.runId);
    const indexes = await collection.indexes();
    expect(indexes.some((index) => index.name === 'prototype_event')).toBe(false);
    expect(indexes.find((index) => index.name === 'channel_run_event_v2')).toMatchObject({
      unique: true,
      key: { 'admission.actor.appId': 1 },
    });
  }));

it.each(['completed', 'failed', 'cancelled'] as const)(
  'never rolls a %s snapshot back into execution',
  (status) =>
    scope(async () => {
      await storage.admit(event(), 100);
      const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
      await storage.prepareExecution(tenantId, fence(run), 102);
      await bindTestResponse(run);
      for (const current of ['running', 'requires_action', 'running'] as const)
        await storage.saveSnapshot(
          tenantId,
          fence(run),
          { status: current, responseId: 'response', text: 'working', elapsedMs: 1 },
          103,
        );
      const terminal = { status, responseId: 'response', text: 'final', elapsedMs: 2 };
      await storage.saveSnapshot(tenantId, fence(run), terminal, 104);
      for (const stale of ['running', 'requires_action'] as const)
        await expect(
          storage.saveSnapshot(tenantId, fence(run), { ...terminal, status: stale }, 105),
        ).rejects.toMatchObject({ code: 'invalid_transition' });
      expect(
        (await storage.saveSnapshot(tenantId, fence(run), terminal, 106)).snapshot,
      ).toMatchObject(terminal);
      expect((await storage.read(tenantId, 'channel', run.runId))?.state).toBe('delivering');
    }),
);

function testSummary(coverage: 'partial' | 'complete'): ChannelRunSummary {
  return {
    version: 1,
    scope: 'actor_lane',
    throughSequence: 1,
    includesCurrent: true,
    priorRuns: 0,
    expectedRuns: 1,
    observedRuns: 1,
    costUSD: { coverage: 'unavailable', coveredRuns: 0 },
    tokens: { coverage: 'unavailable', coveredRuns: 0 },
    elapsedMs: {
      coverage,
      coveredRuns: 1,
      ...(coverage === 'complete' ? { value: 2 } : { knownValue: 1 }),
    },
  };
}

it('replaces partial summary metrics with supplied complete metrics and preserves them only on omission', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    await storage.prepareExecution(tenantId, fence(run), 102);
    await bindTestResponse(run);
    await storage.saveSnapshot(
      tenantId,
      fence(run),
      {
        status: 'running',
        responseId: 'response',
        text: 'working',
        elapsedMs: 1,
        summary: testSummary('partial'),
      },
      103,
    );
    const terminal = {
      status: 'completed' as const,
      responseId: 'response',
      text: 'answer',
      elapsedMs: 2,
    };
    const complete = await storage.saveSnapshot(
      tenantId,
      fence(run),
      { ...terminal, summary: testSummary('complete') },
      104,
    );
    expect(complete.snapshot?.summary?.elapsedMs).toMatchObject({ coverage: 'complete', value: 2 });
    const replay = await storage.saveSnapshot(tenantId, fence(run), terminal, 105);
    expect(replay.snapshot?.summary).toEqual(testSummary('complete'));
  }));

it('authorizes every artifact plan part against the execution snapshot before accepting transport work', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    await storage.prepareExecution(tenantId, fence(run), 102);
    await storage.saveSnapshot(
      tenantId,
      fence(run),
      { status: 'failed', text: 'failure', elapsedMs: 1, artifacts: [testArtifact] },
      103,
    );
    const part = { operationId: 'file', kind: 'artifact' as const, required: true, text: 'report' };
    for (const artifactId of [undefined, 'other'])
      await expect(
        storage.savePlan(
          tenantId,
          fence(run),
          { revision: 'p', rendererVersion: 'test', parts: [{ ...part, artifactId }] },
          104,
        ),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.savePlan(
      tenantId,
      fence(run),
      { revision: 'p', rendererVersion: 'test', parts: [{ ...part, artifactId: 'artifact' }] },
      104,
    );
    await mongoose.models.ChannelRun.updateOne(
      { runId: run.runId },
      { $set: { 'plan.parts.0.artifactId': 'other' } },
    );
    await expect(storage.beginDelivery(tenantId, fence(run), 'file', 105)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    await expect(
      storage.checkpointUpload(
        tenantId,
        fence(run),
        'file',
        0,
        { fileId: 'file', stage: 'allocated' },
        105,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it('finalizes permanent required failure after active sends settle, releases the lane and preserves its old cursor', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    await storage.prepareExecution(tenantId, fence(run), 102);
    await storage.attachResponseCredential(
      tenantId,
      fence(run),
      { apiKeyId: 'key', encryptedApiKey: 'private-ciphertext' },
      102,
    );
    await bindTestResponse(run);
    await storage.saveSnapshot(
      tenantId,
      fence(run),
      { status: 'completed', responseId: 'response', text: 'answer', elapsedMs: 1 },
      103,
    );
    await storage.savePlan(
      tenantId,
      fence(run),
      {
        revision: 'p',
        rendererVersion: 'test',
        parts: [
          { operationId: 'optional', kind: 'message', required: false, text: 'preview' },
          { operationId: 'required', kind: 'message', required: true, text: 'answer' },
        ],
      },
      104,
    );
    await storage.beginDelivery(tenantId, fence(run), 'optional', 105);
    await storage.beginDelivery(tenantId, fence(run), 'required', 105);
    await storage.settleDelivery(
      tenantId,
      fence(run),
      { operationId: 'required', attempts: 1, outcome: 'permanent_failure' },
      106,
    );
    await expect(storage.commitDelivery(tenantId, fence(run), 107)).rejects.toMatchObject({
      code: 'delivery_incomplete',
    });
    await storage.settleDelivery(
      tenantId,
      fence(run),
      { operationId: 'optional', attempts: 1, outcome: 'unknown' },
      108,
    );
    const failed = await storage.commitDelivery(tenantId, fence(run), 109);
    expect(failed.state).toBe('failed');
    expect(failed.errorCode).toBe('delivery_permanent_failure');
    expect(failed.execution).not.toHaveProperty('encryptedApiKey');
    expect(failed).not.toHaveProperty('leaseOwner');
    await storage.admit(event('next'), 110);
    const next = (await storage.claim(tenantId, 'channel', 'next', 111, 1000))!;
    expect(
      (await storage.prepareExecution(tenantId, fence(next), 112)).execution?.parentMessageId,
    ).toBe('00000000-0000-0000-0000-000000000000');
    await storage.commitDelivery(tenantId, fence(run), 113);
    expect(await mongoose.models.ChannelLane.findOne({ laneId: run.laneId }).lean()).toMatchObject({
      activeRunId: next.runId,
    });
  }));

it.each(['completed', 'failed', 'cancelled'] as const)(
  'retires credential ciphertext after delivering a %s execution',
  (status) =>
    scope(async () => {
      await storage.admit(event(), 100);
      const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
      await storage.prepareExecution(tenantId, fence(run), 102);
      const credential = { apiKeyId: 'key', encryptedApiKey: 'private-ciphertext' };
      await storage.attachResponseCredential(tenantId, fence(run), credential, 102);
      await storage.attachResponseCredential(tenantId, fence(run), credential, 102);
      await expect(
        storage.attachResponseCredential(
          tenantId,
          fence(run),
          { ...credential, apiKeyId: 'replacement' },
          102,
        ),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
      await bindTestResponse(run);
      await storage.saveSnapshot(
        tenantId,
        fence(run),
        { status, responseId: 'response', text: 'answer', elapsedMs: 1 },
        103,
      );
      await storage.savePlan(
        tenantId,
        fence(run),
        {
          revision: 'p',
          rendererVersion: 'test',
          parts: [{ operationId: 'm', kind: 'message', required: true, text: 'answer' }],
        },
        104,
      );
      await storage.beginDelivery(tenantId, fence(run), 'm', 105);
      await storage.settleDelivery(
        tenantId,
        fence(run),
        { operationId: 'm', attempts: 1, outcome: 'confirmed', externalMessageKey: 'C1:reply' },
        106,
      );
      const result = await storage.commitDelivery(tenantId, fence(run), 107);
      expect(result.execution).not.toHaveProperty('encryptedApiKey');
      expect((await storage.read(tenantId, 'channel', run.runId))?.execution).not.toHaveProperty(
        'encryptedApiKey',
      );
      expect(await storage.findDeliveredReply(event(), 'C1:reply')).toEqual(
        status === 'completed' ? result : null,
      );
      const wrong = event();
      wrong.admission.actor.appId = 'other-app';
      expect(await storage.findDeliveredReply(wrong, 'C1:reply')).toBeNull();
    }),
);

it('retires credentials when authority is lost before execution starts', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    await storage.prepareExecution(tenantId, fence(run), 102);
    await storage.attachResponseCredential(
      tenantId,
      fence(run),
      { apiKeyId: 'key', encryptedApiKey: 'private-ciphertext' },
      102,
    );
    await storage.markAuthorityLost(tenantId, fence(run), 103);
    await storage.finishAuthorityLost(tenantId, fence(run), 104);
    const final = await storage.read(tenantId, 'channel', run.runId);
    expect(final?.state).toBe('cancelled');
    expect(final?.execution).not.toHaveProperty('encryptedApiKey');
  }));

it('distinguishes two apps whose delivered provider-local reply keys collide', () =>
  scope(async () => {
    const first = event('one');
    const second = event('two');
    second.admission.actor.appId = 'another-app';
    const a = await storage.admit(first, 100);
    await createAgentChannelMethods(mongoose).updateAgentChannel('channel', 'channel-owner', {
      revision: 'rotated',
      slack: { teamId: 'T1', appId: 'another-app', botUserId: 'B1' },
    });
    second.principal.channelRevision = 'rotated';
    const b = await storage.admit(second, 100);
    for (const item of [a, b])
      await mongoose.models.ChannelRun.updateOne(
        { runId: item.run.runId },
        {
          $set: {
            state: 'delivered',
            receipts: [
              {
                operationId: 'm',
                outcome: 'confirmed',
                attempts: 1,
                externalMessageKey: 'C1:same-key',
              },
            ],
          },
        },
      );
    expect((await storage.findDeliveredReply(first, 'C1:same-key'))?.runId).toBe(a.run.runId);
    expect((await storage.findDeliveredReply(second, 'C1:same-key'))?.runId).toBe(b.run.runId);
  }));

it('drains a previously accepted plan even when the configured new-plan limit is lowered', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
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
        revision: 'p',
        rendererVersion: 'test',
        parts: [
          { operationId: 'm', kind: 'message', required: true, text: 'failure' },
          { operationId: 'o', kind: 'message', required: false, text: 'footer' },
        ],
      },
      104,
    );
    const reduced = createChannelRunStorage(mongoose, { maxDeliveryParts: 1 });
    await reduced.beginDelivery(tenantId, fence(run), 'm', 105);
    await reduced.settleDelivery(
      tenantId,
      fence(run),
      { operationId: 'm', attempts: 1, outcome: 'confirmed', externalMessageKey: 'C1:reply' },
      106,
    );
    expect((await reduced.commitDelivery(tenantId, fence(run), 107)).state).toBe('failed');
  }));

it('replays exact settled transport acknowledgements without opening another attempt', () =>
  scope(async () => {
    const run = await plannedRun();
    await storage.beginDelivery(tenantId, fence(run), 'message', 105);
    const receipt = {
      operationId: 'message',
      outcome: 'confirmed' as const,
      attempts: 1,
      externalMessageKey: 'C1:reply',
    };
    await storage.settleDelivery(tenantId, fence(run), receipt, 106);
    await storage.settleDelivery(tenantId, fence(run), receipt, 107);
    await expect(
      storage.settleDelivery(
        tenantId,
        fence(run),
        { ...receipt, externalMessageKey: 'C1:other' },
        108,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const snapshot = (await storage.read(tenantId, 'channel', run.runId))!.snapshot!;
    await storage.saveSnapshot(tenantId, fence(run), snapshot, 108);
    await expect(
      storage.saveSnapshot(tenantId, fence(run), { ...snapshot, text: 'changed' }, 108),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect((await storage.commitDelivery(tenantId, fence(run), 109)).state).toBe('delivered');
  }));

it('refuses every named underscore context before it can read or mutate tenantless runs', async () => {
  const input = { ...event(), tenantId: '_' };
  const { run } = await tenantStorage.run({}, async () => {
    await runAsSystem(async () =>
      mongoose.models.AgentChannel.updateOne(
        { channelId: 'channel' },
        { $unset: { tenantId: '' } },
      ),
    );
    await createAgentChannelMethods(mongoose).updateAgentChannel('channel', 'channel-owner', {
      revision: 'revision',
    });
    return storage.admit(input, 100);
  });
  for (const action of [
    () => storage.read('_', 'channel', run.runId),
    () => storage.claim('_', 'channel', 'worker', 101, 1000),
    () => storage.listPendingMetadata(undefined, 10),
    () => storage.requestCancel(input, run.runId),
    () => storage.readActiveThread(input, 101),
    () => storage.observeThreadStop(input, 101, 102),
    () => storage.findDeliveredReply(input, 'C1:reply'),
  ])
    await expect(tenantStorage.run({ tenantId: '_' }, async () => action())).rejects.toThrow(
      'Reserved tenant identifier',
    );
  expect(
    await tenantStorage.run({}, async () => storage.read('_', 'channel', run.runId)),
  ).toMatchObject({ state: 'queued', leaseEpoch: 0, cancellationRequested: false });
});

it('rejects persisting a real user in the reserved channel partition', () =>
  runAsSystem(async () => {
    await expect(
      mongoose.models.User.create({
        email: 'reserved-tenant@example.com',
        provider: 'local',
        tenantId: '_',
      }),
    ).rejects.toThrow('Reserved tenant identifier');
  }));

it.each(['principal', 'agent'] as const)(
  'normalizes concurrent %s conflicts on one provider event',
  (kind) =>
    scope(async () => {
      const first = event();
      const second = event();
      if (kind === 'principal') second.principal.userId = 'different-owner';
      else second.agentId = 'different-agent';
      const results = await Promise.allSettled([
        storage.admit(first, 100),
        storage.admit(second, 100),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failure = results.find((result) => result.status === 'rejected');
      expect(failure).toMatchObject({
        status: 'rejected',
        reason: {
          name: 'ChannelRunConflict',
          code: kind === 'agent' ? 'invalid_transition' : 'event_conflict',
        },
      });
      expect(await mongoose.models.ChannelRun.countDocuments({ tenantId })).toBe(1);
      expect(await mongoose.models.ChannelLane.countDocuments({ tenantId })).toBe(1);
    }),
);

it('injects account erasure work bounds before closing admission', () =>
  scope(async () => {
    const user = await mongoose.models.User.create({
      email: 'configured-erasure@example.com',
      provider: 'local',
      tenantId,
    });
    const userId = String(user._id);
    for (let i = 0; i < 3; i++) {
      const input = event(`erase-${i}`);
      input.principal.userId = userId;
      input.admission.externalThreadKey = `thread-${i}`;
      await storage.admit(input, 100 + i);
    }
    await mongoose.models.ChannelLane.updateMany({ userId }, { $unset: { userId: 1 } });
    const getConfig = jest.fn(async () => ({ erasureBatchSize: 1 }));
    const deleted = jest.spyOn(mongoose.models.ChannelLane, 'deleteMany');
    try {
      await createUserMethods(mongoose, { getChannelStorageConfig: getConfig }).deleteUserById(
        userId,
      );
      const batches = deleted.mock.calls
        .map(([filter]) => filter as { laneId?: { $in?: string[] } })
        .filter((filter) => filter?.laneId?.$in);
      expect(batches).toHaveLength(3);
      for (const batch of batches) expect(batch?.laneId?.$in).toHaveLength(1);
      expect(getConfig).toHaveBeenCalledTimes(1);
    } finally {
      deleted.mockRestore();
    }
  }));

it('fails a bad erasure configuration before closing the account owner fence', () =>
  scope(async () => {
    const user = await mongoose.models.User.create({
      email: 'bad-erasure-config@example.com',
      provider: 'local',
      tenantId,
    });
    const userId = String(user._id);
    await expect(
      createUserMethods(mongoose, {
        getChannelStorageConfig: async () => ({ erasureBatchSize: 0 }),
      }).deleteUserById(userId),
    ).rejects.toThrow();
    const input = event();
    input.principal.userId = userId;
    await expect(storage.admit(input, 100)).resolves.toMatchObject({ duplicate: false });
  }));

it('persists cancellation as language-neutral status without presentation copy', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    await storage.prepareExecution(tenantId, fence(run), 102);
    await storage.requestCancel(event(), run.runId);
    const result = await storage.finishUnstartedResponseCancellation(tenantId, fence(run), 103);
    expect(result.snapshot).toMatchObject({ status: 'cancelled', text: '' });
  }));

it('allocates separate canonical conversations for identical timestamps in different external channels', () =>
  scope(async () => {
    const first = event('first-channel');
    first.admission.externalThreadKey = '123.456';
    const second = event('second-channel');
    second.admission.externalThreadKey = '123.456';
    second.admission.externalChannelId = 'C2';
    const [a, b] = await Promise.all([storage.admit(first, 100), storage.admit(second, 100)]);
    expect(a.run.laneId).not.toBe(b.run.laneId);
    const claimedA = (await storage.claim(tenantId, 'channel', 'a', 101, 1000))!;
    const claimedB = (await storage.claim(tenantId, 'channel', 'b', 102, 1000))!;
    const prepared = await Promise.all([
      storage.prepareExecution(tenantId, fence(claimedA), 103),
      storage.prepareExecution(tenantId, fence(claimedB), 103),
    ]);
    expect(new Set(prepared.map((run) => run.execution!.conversationId)).size).toBe(2);
    expect(
      prepared.every(
        (run) => run.execution!.parentMessageId === '00000000-0000-0000-0000-000000000000',
      ),
    ).toBe(true);
    expect(new Set(prepared.map((run) => run.admission.externalThreadKey))).toEqual(
      new Set(['123.456']),
    );
    expect(new Set(prepared.map((run) => run.admission.externalChannelId))).toEqual(
      new Set(['C1', 'C2']),
    );
  }));

it('returns one canonical conversation across racing preparation retries in the same actor lane', () =>
  scope(async () => {
    await storage.admit(event(), 100);
    const claimed = (await storage.claim(tenantId, 'channel', 'worker', 101, 1000))!;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => storage.prepareExecution(tenantId, fence(claimed), 102)),
    );
    const saved = await storage.read(tenantId, 'channel', claimed.runId);
    expect(new Set(attempts.map((run) => run.execution!.conversationId))).toEqual(
      new Set([saved!.execution!.conversationId]),
    );
    expect(new Set(attempts.map((run) => run.execution!.requestId))).toEqual(
      new Set([claimed.runId]),
    );
  }));
