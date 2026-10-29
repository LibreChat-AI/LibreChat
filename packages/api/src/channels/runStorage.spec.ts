import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createChannelRunStorage,
  createResponseStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  ChannelRunStorage,
  ChannelRunEnrollment,
  ChannelRunRecord,
} from '@librechat/data-schemas';
import type {
  ChannelRunFence,
  ChannelDeliveryPlan,
  ChannelRunSummary,
} from 'librechat-data-provider';
import {
  createBackgroundResponseQueue,
  createBackgroundResponseEnvelope,
} from '~/agents/responses/queue';
import { buildPendingBackgroundResponse } from '~/agents/responses/background';
import { createResponseRetirement } from '~/agents/responses/retirement';
import { createAgentTriggerService } from '~/agents/triggers/service';
import { createChannelResponseRetirement } from './responses';

let mongo: MongoMemoryReplSet;
let storage: ChannelRunStorage;
const tenantId = 'channel-run-test';
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const fence = (run: ChannelRunRecord): ChannelRunFence => ({
  runId: run.runId,
  owner: run.leaseOwner!,
  epoch: run.leaseEpoch,
});
const enrollment = (eventId = 'Ev1', userId = 'owner'): ChannelRunEnrollment => ({
  tenantId,
  channelId: 'channel',
  agentId: 'agent',
  principal: { userId, channelRevision: 'v1' },
  admission: {
    eventId,
    externalChannelId: 'C1',
    externalThreadKey: 'C1:1.001',
    externalMessageKey: `C1:${eventId}`,
    actor: { teamId: 'T1', appId: 'A1', externalUserId: userId },
    input: 'hello',
  },
});
const plan: ChannelDeliveryPlan = {
  revision: 'r1',
  rendererVersion: 'v1',
  parts: [
    { operationId: 'part-1', kind: 'message', required: true, text: 'first' },
    { operationId: 'part-2', kind: 'message', required: true, text: 'second' },
  ],
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  await Promise.all([mongoose.models.ChannelRun.init(), mongoose.models.ChannelLane.init()]);
  storage = createChannelRunStorage(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.ChannelRun.deleteMany({});
    await mongoose.models.ChannelLane.deleteMany({});
  });
});

async function ready() {
  await storage.admit(enrollment(), 100);
  const claimed = await storage.claim(tenantId, 'channel', 'worker-a', 100, 1000);
  expect(claimed).not.toBeNull();
  const run = await storage.prepareExecution(tenantId, fence(claimed!), 101);
  await storage.saveSnapshot(
    tenantId,
    fence(run),
    { responseId: 'response-1', status: 'completed', text: 'first second', elapsedMs: 10 },
    102,
  );
  return storage.savePlan(tenantId, fence(run), plan, 103);
}

it('deduplicates admission, rejects changed payload and allocates ordered sequence', () =>
  scope(async () => {
    const one = await storage.admit(enrollment(), 100);
    const replay = await storage.admit(enrollment(), 101);
    expect(replay.duplicate).toBe(true);
    expect(replay.run.runId).toBe(one.run.runId);
    const altered = enrollment();
    altered.admission.input = 'different';
    await expect(storage.admit(altered, 102)).rejects.toMatchObject({ code: 'event_conflict' });
    const two = await storage.admit(enrollment('Ev2'), 102);
    expect(two.run.sequence).toBe(one.run.sequence + 1);
  }));

async function savedResponse(
  run: ChannelRunRecord,
  overrides: {
    tenantId?: string;
    userId?: string;
    agentId?: string;
    requestKey?: string;
    input?: string;
    previous_response_id?: string;
    responseId?: string;
    sourceKeyId?: string;
  } = {},
) {
  const responseStorage = createResponseStorage(mongoose);
  const result = await responseStorage.reserve({
    tenantId: overrides.tenantId ?? tenantId,
    userId: overrides.userId ?? run.principal.userId,
    agentId: overrides.agentId ?? run.agentId,
    responseId: overrides.responseId ?? 'resp_bound',
    requestKey: overrides.requestKey ?? `channel:${run.runId}`,
    sourceKeyId: overrides.sourceKeyId,
    fingerprint: `fingerprint-${overrides.responseId ?? 'bound'}`,
    requestJSON: JSON.stringify({
      model: overrides.agentId ?? run.agentId,
      input: overrides.input ?? run.admission.input,
      background: true,
      store: true,
      previous_response_id: overrides.previous_response_id,
    }),
    conversationId: 'response-owned-conversation',
    parentMessageId: '00000000-0000-0000-0000-000000000000',
  });
  if (!result.ok) throw new Error('Response reservation failed');
  return result.record;
}

describe('Responses execution binding', () => {
  beforeEach(async () => {
    await runAsSystem(async () => {
      await mongoose.models.StoredResponse.deleteMany({});
      await mongoose.models.ResponseScope?.deleteMany({});
    });
  });
  async function prepared() {
    await storage.admit(enrollment(), 100);
    const claimed = (await storage.claim(tenantId, 'channel', 'worker', 100, 1000))!;
    return storage.prepareExecution(tenantId, fence(claimed), 101);
  }
  async function issued(cancel = true) {
    const preparedRun = await prepared();
    const run = await storage.attachResponseCredential(
      tenantId,
      fence(preparedRun),
      { apiKeyId: 'issued', encryptedApiKey: 'ciphertext' },
      102,
    );
    if (cancel) await storage.requestCancel(tenantId, 'channel', run.runId, 'owner');
    return run;
  }
  it('holds a cancelled issued grant until the exact late response exists, without writing that response', () =>
    scope(async () => {
      const run = await issued();
      expect(await storage.recoverResponse(tenantId, fence(run), 103)).toBeNull();
      const held = await storage.read(tenantId, 'channel', run.runId);
      expect(held).toMatchObject({ state: 'executing', cancellationRequested: true });
      expect(held?.execution?.responseId).toBeUndefined();
      expect(held?.snapshot).toBeUndefined();
      const response = await savedResponse(run, { sourceKeyId: 'issued' });
      const recovered = await storage.recoverResponse(tenantId, fence(run), 104);
      expect(recovered?.execution).toMatchObject({ responseId: response.responseId });
      expect(await createResponseStorage(mongoose).read(response, response.responseId)).toEqual(
        response,
      );
      expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
    }));
  it('replays concurrent recovery and a lost binding acknowledgement without another creation', () =>
    scope(async () => {
      const run = await issued();
      const response = await savedResponse(run, { sourceKeyId: 'issued' });
      const recovered = await Promise.all(
        Array.from({ length: 3 }, () => storage.recoverResponse(tenantId, fence(run), 103)),
      );
      expect(recovered.map((value) => value?.execution?.responseId)).toEqual(
        Array(3).fill(response.responseId),
      );
      expect((await storage.recoverResponse(tenantId, fence(run), 104))?.execution).toEqual(
        recovered[0]?.execution,
      );
      expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
    }));
  it('recovers an already committed bind when its acknowledgement was lost', () =>
    scope(async () => {
      const run = await issued();
      const response = await savedResponse(run, { sourceKeyId: 'issued' });
      const bind = async () => {
        await storage.bindResponse(tenantId, fence(run), response.responseId, 103);
        throw new Error('Bind acknowledgement lost');
      };
      await expect(bind()).rejects.toThrow('Bind acknowledgement lost');
      expect(
        (await storage.recoverResponse(tenantId, fence(run), 104))?.execution?.responseId,
      ).toBe(response.responseId);
      expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
    }));
  it('does not discover the same request identity stored in another tenant', () =>
    scope(async () => {
      const run = await issued();
      await tenantStorage.run({ tenantId: 'foreign-tenant' }, () =>
        savedResponse(run, { tenantId: 'foreign-tenant', sourceKeyId: 'issued' }),
      );
      expect(await storage.recoverResponse(tenantId, fence(run), 103)).toBeNull();
    }));
  it.each([
    { userId: 'other-owner' },
    { agentId: 'other-agent' },
    { requestKey: 'other-request' },
    { sourceKeyId: 'other-key' },
  ])('does not recover a foreign response: %j', (overrides) =>
    scope(async () => {
      const run = await issued();
      const response = await savedResponse(run, { sourceKeyId: 'issued', ...overrides });
      expect(await storage.recoverResponse(tenantId, fence(run), 103)).toBeNull();
      expect(await createResponseStorage(mongoose).read(response, response.responseId)).toEqual(
        response,
      );
    }),
  );
  it.each([{ input: 'different' }, { previous_response_id: 'resp_foreign' }])(
    'rejects canonical identity with a mismatched admitted request: %j',
    (overrides) =>
      scope(async () => {
        const run = await issued();
        await savedResponse(run, { sourceKeyId: 'issued', ...overrides });
        await expect(storage.recoverResponse(tenantId, fence(run), 103)).rejects.toMatchObject({
          code: 'invalid_transition',
        });
        expect(
          (await storage.read(tenantId, 'channel', run.runId))?.execution?.responseId,
        ).toBeUndefined();
      }),
  );
  it('requires cancellation, matching tenant and the current sender epoch inside recovery', () =>
    scope(async () => {
      const run = await issued(false);
      await savedResponse(run, { sourceKeyId: 'issued' });
      await expect(storage.recoverResponse(tenantId, fence(run), 103)).rejects.toMatchObject({
        code: 'invalid_transition',
      });
      await storage.requestCancel(tenantId, 'channel', run.runId, 'owner');
      await expect(storage.recoverResponse('other-tenant', fence(run), 103)).rejects.toMatchObject({
        code: 'invalid_transition',
      });
      await expect(
        storage.recoverResponse(tenantId, { ...fence(run), epoch: 0 }, 103),
      ).rejects.toMatchObject({ code: 'stale_fence' });
      await expect(storage.recoverResponse(tenantId, fence(run), 1100)).rejects.toMatchObject({
        code: 'stale_fence',
      });
    }));
  it('propagates storage failure rather than treating it as absent creation', () =>
    scope(async () => {
      const run = await issued();
      const failure = jest
        .spyOn(mongoose.models.StoredResponse, 'findOne')
        .mockImplementationOnce(() => {
          throw new Error('Storage unavailable');
        });
      await expect(storage.recoverResponse(tenantId, fence(run), 103)).rejects.toThrow(
        'Storage unavailable',
      );
      failure.mockRestore();
      expect(await storage.recoverResponse(tenantId, fence(run), 104)).toBeNull();
    }));
  it('recovers revoked queued creation after a lost queue ACK and retires only the canonical response', () =>
    scope(async () => {
      await storage.admit(enrollment('queue-stop', '000000000000000000000001'), 100);
      const claimed = (await storage.claim(tenantId, 'channel', 'worker', 100, 1000))!;
      await storage.prepareExecution(tenantId, fence(claimed), 101);
      const run = await storage.attachResponseCredential(
        tenantId,
        fence(claimed),
        { apiKeyId: 'issued', encryptedApiKey: 'ciphertext' },
        102,
      );
      const responses = createResponseStorage(mongoose);
      const reserved = await savedResponse(run, { sourceKeyId: 'issued' });
      const methods = createMethods(mongoose);
      const service = createAgentTriggerService({
        methods: {
          ...methods,
          getAgentTriggerDeliveryBatch: (delivery) =>
            methods.getAgentTriggerDeliveryBatch({
              id: delivery.id,
              batchMemberIds: delivery.batchMemberIds?.map(
                (id) => new mongoose.Types.ObjectId(String(id)),
              ),
            }),
        },
      });
      const execute = jest.fn(async () => ({ status: 'started' as const }));
      const queue = createBackgroundResponseQueue({
        storage: responses,
        enqueue: async (...args) => {
          await service.enqueue(...args);
          throw new Error('Queue acknowledgement lost');
        },
        authorize: async () => true,
        execute,
      });
      const attached = await responses.attachDelivery(
        reserved,
        reserved.responseId,
        queue.deliveryKey(reserved),
      );
      if (!attached.ok) throw new Error('Attach failed');
      try {
        await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3088 } });
        await expect(queue.enqueue(attached.record)).rejects.toThrow('Queue acknowledgement lost');
        expect(await service.getDelivery(attached.record.deliveryKey!)).toMatchObject({
          status: 'capability_pending',
        });
        const cleanup = await storage.claimAuthorityLost(run, 'cleanup', 1101, 1000);
        expect(cleanup).not.toBeNull();
        const jobs = { getJob: jest.fn(async () => undefined), abortJob: jest.fn() };
        const retire = createChannelResponseRetirement({
          storage: responses,
          recovery: storage,
          retireResponse: createResponseRetirement({ storage: responses, jobs, now: () => 1103 }),
          now: () => 1102,
        });
        const publication = jest
          .spyOn(responses, 'publish')
          .mockRejectedValueOnce(new Error('Publication unavailable'));
        await expect(retire(cleanup!)).rejects.toThrow('Publication unavailable');
        expect(await responses.read(reserved, reserved.responseId)).toMatchObject({
          status: 'queued',
        });
        await expect(retire(cleanup!)).resolves.toBe('stopped');
        await expect(retire(cleanup!)).resolves.toBe('stopped');
        publication.mockRestore();
        expect(await responses.read(reserved, reserved.responseId)).toMatchObject({
          status: 'cancelled',
        });
        const dispatcher = queue.sourceDispatchers.get('responses')!;
        await expect(
          dispatcher.dispatch(createBackgroundResponseEnvelope(attached.record)),
        ).resolves.toMatchObject({ status: 'settled' });
        expect(execute).not.toHaveBeenCalled();
        expect(jobs.abortJob).not.toHaveBeenCalled();
        expect((await storage.read(tenantId, 'channel', run.runId))?.snapshot).toBeUndefined();
      } finally {
        await service.stop();
      }
    }));
  it('retains a recovered admitted response when the provider drain proof is missing', () =>
    scope(async () => {
      const run = await issued();
      const responses = createResponseStorage(mongoose);
      const response = await savedResponse(run, { sourceKeyId: 'issued' });
      const publication = await responses.publish(
        response,
        response.responseId,
        response.revision,
        {
          generationCreatedAt: 103,
          status: 'in_progress',
          responseJSON: JSON.stringify({
            ...buildPendingBackgroundResponse(response),
            status: 'in_progress',
          }),
        },
      );
      expect(publication.ok).toBe(true);
      const cleanup = await storage.claimAuthorityLost(run, 'cleanup', 1101, 1000);
      const jobs = { getJob: jest.fn(async () => undefined), abortJob: jest.fn() };
      const retire = createChannelResponseRetirement({
        storage: responses,
        recovery: storage,
        retireResponse: createResponseRetirement({ storage: responses, jobs, now: () => 1103 }),
        now: () => 1102,
      });
      await expect(retire(cleanup!)).resolves.toBe('pending');
      expect(jobs.abortJob).not.toHaveBeenCalled();
      expect(await responses.read(response, response.responseId)).toMatchObject({
        status: 'in_progress',
      });
      const held = await storage.read(tenantId, 'channel', run.runId);
      expect(held?.execution).toMatchObject({
        responseId: response.responseId,
        generationCreatedAt: 103,
      });
      expect(held?.state).toBe('executing');
      expect(held?.snapshot).toBeUndefined();
    }));
  it('confirms unstarted cancellation only while no credential or provider admission can exist', () =>
    scope(async () => {
      const run = await prepared();
      await storage.requestCancel(tenantId, 'channel', run.runId, 'owner');
      const cancelled = await storage.finishUnstartedResponseCancellation(
        tenantId,
        fence(run),
        102,
      );
      expect(cancelled.state).toBe('delivering');
      expect(cancelled.snapshot).toMatchObject({ status: 'cancelled' });
      expect(cancelled.execution?.apiKeyId).toBeUndefined();
      await expect(
        storage.attachResponseCredential(
          tenantId,
          fence(run),
          { apiKeyId: 'late-key', encryptedApiKey: 'ciphertext' },
          103,
        ),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
    }));
  it('does not claim an already issued credential could never have executed', () =>
    scope(async () => {
      const run = await prepared();
      await storage.attachResponseCredential(
        tenantId,
        fence(run),
        { apiKeyId: 'issued', encryptedApiKey: 'ciphertext' },
        102,
      );
      await storage.requestCancel(tenantId, 'channel', run.runId, 'owner');
      await expect(
        storage.finishUnstartedResponseCancellation(tenantId, fence(run), 103),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
    }));
  it('binds the actual owner-scoped response idempotently', () =>
    scope(async () => {
      const run = await prepared();
      const response = await savedResponse(run);
      const bound = await storage.bindResponse(tenantId, fence(run), response.responseId, 102);
      expect(bound.execution).toMatchObject({
        protocol: 'responses',
        responseId: response.responseId,
        conversationId: response.conversationId,
        parentMessageId: response.parentMessageId,
      });
      const replayed = await storage.bindResponse(tenantId, fence(run), response.responseId, 103);
      expect(replayed.execution).toEqual(bound.execution);
      expect(bound.execution?.deliveryKey).toBeUndefined();
      expect(bound.execution?.enqueueAttemptedAt).toBeUndefined();
    }));
  it.each([
    { userId: 'other-owner' },
    { agentId: 'other-agent' },
    { requestKey: 'other-event' },
    { input: 'different input' },
    { previous_response_id: 'resp_other_history' },
  ])('rejects a response from another execution boundary: %j', (overrides) =>
    scope(async () => {
      const run = await prepared();
      const response = await savedResponse(run, overrides);
      await expect(
        storage.bindResponse(tenantId, fence(run), response.responseId, 102),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
      expect(
        (await storage.read(tenantId, 'channel', run.runId))?.execution?.protocol,
      ).toBeUndefined();
    }),
  );
  it('cannot switch an already-dispatched legacy run to Responses', () =>
    scope(async () => {
      const run = await prepared();
      const response = await savedResponse(run);
      // Seed historical state directly; production only dispatches through Responses.
      await mongoose.models.ChannelRun.updateOne(
        { tenantId, runId: run.runId },
        {
          $set: { 'execution.deliveryKey': 'legacy-trigger', 'execution.enqueueAttemptedAt': 102 },
        },
      );
      await expect(
        storage.bindResponse(tenantId, fence(run), response.responseId, 103),
      ).rejects.toMatchObject({ code: 'invalid_transition' });
    }));
  it('requires the current sender fence', () =>
    scope(async () => {
      const run = await prepared();
      const response = await savedResponse(run);
      await expect(
        storage.bindResponse(
          tenantId,
          { ...fence(run), epoch: run.leaseEpoch + 1 },
          response.responseId,
          102,
        ),
      ).rejects.toMatchObject({ code: 'stale_fence' });
    }));
});

it('fences generation snapshots and releases only the cancelled lane without advancing its cursor', () =>
  scope(async () => {
    await storage.admit(enrollment(), 100);
    const other = await storage.admit(enrollment('other-actor', 'other'), 101);
    const next = await storage.admit(enrollment('next'), 102);
    const claimed = (await storage.claim(tenantId, 'channel', 'worker', 103, 1000))!;
    const run = await storage.prepareExecution(tenantId, fence(claimed), 104);
    await storage.saveSnapshot(
      tenantId,
      fence(run),
      { status: 'running', text: '', elapsedMs: 1 },
      105,
      106,
    );
    await expect(
      storage.saveSnapshot(
        tenantId,
        fence(run),
        { status: 'running', text: '', elapsedMs: 1 },
        108,
        109,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.saveSnapshot(
      tenantId,
      fence(run),
      { status: 'cancelled', text: 'Cancelled.', elapsedMs: 1 },
      108,
      106,
    );
    await storage.savePlan(
      tenantId,
      fence(run),
      {
        revision: 'stop',
        rendererVersion: 'v1',
        parts: [{ operationId: 'notice', kind: 'message', required: true, text: 'Cancelled.' }],
      },
      109,
    );
    await storage.beginDelivery(tenantId, fence(run), 'notice', 110);
    await storage.settleDelivery(
      tenantId,
      fence(run),
      {
        operationId: 'notice',
        outcome: 'confirmed',
        attempts: 1,
        externalMessageKey: 'C1:notice',
      },
      111,
    );
    expect((await storage.commitDelivery(tenantId, fence(run), 112)).state).toBe('cancelled');
    const lane = await mongoose.models.ChannelLane.findOne({ tenantId, laneId: run.laneId }).lean();
    expect(lane).not.toHaveProperty('activeRunId');
    expect(lane).not.toHaveProperty('responseId');
    expect(lane).not.toHaveProperty('conversationId');
    const following = (await storage.claim(tenantId, 'channel', 'next-worker', 113, 1000))!;
    expect([other.run.runId, next.run.runId]).toContain(following.runId);
    const another = (await storage.claim(tenantId, 'channel', 'another-worker', 114, 1000))!;
    expect([following.runId, another.runId]).toContain(next.run.runId);
    expect([following.runId, another.runId]).toContain(other.run.runId);
  }));

it('serializes simultaneous duplicate ingress without duplicate executions', () =>
  scope(async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => storage.admit(enrollment(), 100)),
    );
    expect(new Set(results.map(({ run }) => run.runId)).size).toBe(1);
    expect(results.filter(({ duplicate }) => !duplicate)).toHaveLength(1);
  }));

it('holds one actor lane while allowing another principal and fences expired workers', () =>
  scope(async () => {
    await storage.admit(enrollment(), 100);
    await storage.admit(enrollment('Ev2'), 101);
    await storage.admit(enrollment('Ev3', 'other'), 102);
    const first = (await storage.claim(tenantId, 'channel', 'one', 103, 10))!;
    const second = (await storage.claim(tenantId, 'channel', 'two', 104, 10))!;
    expect(second.principal.userId).toBe('other');
    expect(await storage.claim(tenantId, 'channel', 'three', 105, 10)).toBeNull();
    const replacement = (await storage.claim(tenantId, 'channel', 'three', 114, 10))!;
    expect(replacement.runId).toBe(first.runId);
    expect(replacement.leaseEpoch).toBe(first.leaseEpoch + 1);
    expect(await storage.renew(tenantId, fence(first), 114, 10)).toBe(false);
    await expect(storage.prepareExecution(tenantId, fence(first), 114)).rejects.toMatchObject({
      code: 'stale_fence',
    });
  }));

it('preserves the exact execution identity across process-owner replacement', () =>
  scope(async () => {
    await storage.admit(enrollment(), 100);
    const first = (await storage.claim(tenantId, 'channel', 'one', 100, 10))!;
    const executing = await storage.prepareExecution(tenantId, fence(first), 101);
    const replacement = (await storage.claim(tenantId, 'channel', 'two', 111, 20))!;
    const resumed = await storage.prepareExecution(tenantId, fence(replacement), 112);
    expect(resumed.execution).toEqual(executing.execution);
  }));

async function waitingResponse() {
  await storage.admit(enrollment(), 100);
  const claimed = (await storage.claim(tenantId, 'channel', 'worker', 100, 60_000))!;
  const prepared = await storage.prepareExecution(tenantId, fence(claimed), 101);
  await mongoose.models.ChannelRun.updateOne(
    { tenantId, runId: prepared.runId },
    {
      $set: {
        execution: { ...prepared.execution, protocol: 'responses', responseId: 'response-1' },
      },
    },
  );
  return (await storage.read(tenantId, 'channel', prepared.runId))!;
}

it('yields only the polling lease, invalidates its fence, and reclaims one exact Response after cooldown', () =>
  scope(async () => {
    const run = await waitingResponse();
    await storage.admit(enrollment('next'), 102);
    await storage.admit(enrollment('other', 'other'), 103);
    expect(
      (await storage.claim(tenantId, 'channel', 'other-worker', 104, 60_000))?.principal.userId,
    ).toBe('other');
    await storage.requestCancel(tenantId, 'channel', run.runId, 'owner');
    expect(await storage.yieldLease(tenantId, 'channel', fence(run), 105)).toBe(true);
    const yielded = (await storage.read(tenantId, 'channel', run.runId))!;
    expect(yielded.leaseOwner).toBeUndefined();
    expect(yielded).toMatchObject({
      leaseEpoch: run.leaseEpoch,
      leaseExpiresAt: 1105,
      claimCheckedAt: run.claimCheckedAt,
      execution: run.execution,
      cancellationRequested: true,
    });
    const lane = await mongoose.models.ChannelLane.findOne({ tenantId, laneId: run.laneId }).lean();
    expect(lane).toMatchObject({ activeRunId: run.runId });
    expect(await storage.renew(tenantId, fence(run), 106, 60_000)).toBe(false);
    await expect(storage.prepareExecution(tenantId, fence(run), 106)).rejects.toMatchObject({
      code: 'stale_fence',
    });
    expect(await storage.claim(tenantId, 'channel', 'too-soon', 1104, 60_000)).toBeNull();
    const claims = await Promise.all(
      ['replica-a', 'replica-b'].map((owner) =>
        storage.claim(tenantId, 'channel', owner, 1105, 60_000),
      ),
    );
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      runId: run.runId,
      leaseEpoch: run.leaseEpoch + 1,
      execution: run.execution,
      cancellationRequested: true,
    });
    expect(await storage.yieldLease(tenantId, 'channel', fence(run), 1106)).toBe(false);
  }));

it.each(['tenant', 'channel', 'owner', 'epoch', 'expired'])(
  'rejects a %s-mismatched polling lease yield',
  (kind) =>
    scope(async () => {
      const run = await waitingResponse();
      const selected = {
        ...fence(run),
        ...(kind === 'owner' ? { owner: 'foreign' } : {}),
        ...(kind === 'epoch' ? { epoch: run.leaseEpoch + 1 } : {}),
      };
      expect(
        await storage.yieldLease(
          kind === 'tenant' ? 'foreign' : tenantId,
          kind === 'channel' ? 'foreign' : 'channel',
          selected,
          kind === 'expired' ? 60_100 : 102,
        ),
      ).toBe(false);
      expect((await storage.read(tenantId, 'channel', run.runId))?.leaseOwner).toBe('worker');
    }),
);

it.each([
  'plan',
  'inflight-progress',
  'unknown-progress',
  'inflight-receipt',
  'unknown-receipt',
  'unbound',
  'legacy',
] as const)('does not yield unsafe %s work', (kind) =>
  scope(async () => {
    const run = await waitingResponse();
    const patch = {
      plan: { plan },
      'inflight-progress': { progress: { outcome: 'inflight' } },
      'unknown-progress': { progress: { outcome: 'unknown' } },
      'inflight-receipt': {
        receipts: [{ operationId: 'part-1', outcome: 'inflight', attempts: 1 }],
      },
      'unknown-receipt': { receipts: [{ operationId: 'part-1', outcome: 'unknown', attempts: 1 }] },
      unbound: { execution: run.execution },
      legacy: { execution: { ...run.execution, protocol: 'legacy' } },
    }[kind];
    await mongoose.models.ChannelRun.updateOne({ tenantId, runId: run.runId }, { $set: patch });
    if (kind === 'unbound')
      await mongoose.models.ChannelRun.updateOne(
        { tenantId, runId: run.runId },
        { $unset: { 'execution.responseId': 1 } },
      );
    expect(await storage.yieldLease(tenantId, 'channel', fence(run), 102)).toBe(false);
  }),
);

it('cannot renew or yield again after a concurrent successful yield', () =>
  scope(async () => {
    const run = await waitingResponse();
    const results = await Promise.all([
      storage.yieldLease(tenantId, 'channel', fence(run), 102),
      storage.yieldLease(tenantId, 'channel', fence(run), 102),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await storage.renew(tenantId, fence(run), 103, 60_000)).toBe(false);
  }));

it('retains ambiguous remote writes and never reopens them for an automatic repost', () =>
  scope(async () => {
    const run = await ready();
    await storage.beginDelivery(tenantId, fence(run), 'part-1', 104);
    const replacement = (await storage.claim(tenantId, 'channel', 'replacement', 1101, 1000))!;
    expect(replacement.receipts[0].outcome).toBe('unknown');
    await expect(
      storage.beginDelivery(tenantId, fence(replacement), 'part-1', 1102),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(storage.commitDelivery(tenantId, fence(replacement), 1102)).rejects.toMatchObject({
      code: 'delivery_incomplete',
    });
  }));

it('commits all confirmed reply mappings and cursor atomically, then releases FIFO', () =>
  scope(async () => {
    const run = await ready();
    await storage.admit(enrollment('Ev2'), 104);
    await expect(storage.beginDelivery(tenantId, fence(run), 'part-2', 104)).rejects.toMatchObject({
      code: 'delivery_incomplete',
    });
    await expect(storage.commitDelivery(tenantId, fence(run), 104)).rejects.toMatchObject({
      code: 'delivery_incomplete',
    });
    for (const [index, part] of plan.parts.entries()) {
      await storage.beginDelivery(tenantId, fence(run), part.operationId, 105 + index);
      await storage.settleDelivery(
        tenantId,
        fence(run),
        {
          operationId: part.operationId,
          attempts: 1,
          outcome: 'confirmed',
          externalMessageKey: `C1:reply-${index}`,
        },
        107 + index,
      );
    }
    const committed = await storage.commitDelivery(tenantId, fence(run), 110);
    expect(committed.state).toBe('delivered');
    expect((await storage.commitDelivery(tenantId, fence(run), 111)).runId).toBe(run.runId);
    expect((await storage.findDeliveredReply(tenantId, 'channel', 'C1:reply-1'))?.runId).toBe(
      run.runId,
    );
    const next = (await storage.claim(tenantId, 'channel', 'next', 112, 1000))!;
    const execution = await storage.prepareExecution(tenantId, fence(next), 113);
    expect(execution.execution?.parentMessageId).toBe('response-1');
    expect(execution.execution?.conversationId).toBe(run.execution?.conversationId);
  }));

it('honors persisted retry time and immutable plans', () =>
  scope(async () => {
    const run = await ready();
    await expect(
      storage.savePlan(tenantId, fence(run), { ...plan, rendererVersion: 'changed' }, 104),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.beginDelivery(tenantId, fence(run), 'part-1', 105);
    await storage.settleDelivery(
      tenantId,
      fence(run),
      { operationId: 'part-1', attempts: 1, outcome: 'retryable', retryAt: 200 },
      106,
    );
    await expect(storage.beginDelivery(tenantId, fence(run), 'part-1', 199)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(
      (await storage.beginDelivery(tenantId, fence(run), 'part-1', 200)).receipts[0].attempts,
    ).toBe(2);
  }));

it('enforces tenant and initiating actor boundaries for reads and cancellation', () =>
  scope(async () => {
    const { run } = await storage.admit(enrollment(), 100);
    expect(await storage.requestCancel(tenantId, 'channel', run.runId, 'intruder')).toBe(false);
    expect(await storage.requestCancel(tenantId, 'channel', run.runId, 'owner')).toBe(true);
    await tenantStorage.run({ tenantId: 'different' }, async () => {
      expect(await storage.read(tenantId, 'channel', run.runId)).toBeNull();
      expect(await storage.claim(tenantId, 'channel', 'intruder', 100, 100)).toBeNull();
    });
  }));

it('native Stop lookup excludes a newer claim, even when its message was already queued', () =>
  scope(async () => {
    const input = enrollment();
    const { run } = await storage.admit(input, 100);
    await storage.claim(tenantId, 'channel', 'worker', 200, 100);
    const lookup = (at: number, actor = 'owner') =>
      storage.readActiveThread(
        tenantId,
        'channel',
        input.admission.externalThreadKey,
        actor,
        input.principal,
        at,
      );
    expect(await lookup(199)).toBeNull();
    expect((await lookup(200))?.runId).toBe(run.runId);
    expect(await lookup(200, 'foreign')).toBeNull();
    // Reclaimed work rejects the old Stop instead of guessing its intent.
    await storage.claim(tenantId, 'channel', 'replacement', 301, 100);
    expect(await lookup(200)).toBeNull();
    expect((await lookup(301))?.runId).toBe(run.runId);
  }));

it('persists progress handles and monotonic update intent, freezing ambiguous writes after replacement', () =>
  scope(async () => {
    await storage.admit(enrollment(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'one', 100, 100))!;
    const progress = { revision: 1, rendererVersion: 'v1', text: 'Request received' };
    await storage.planProgress(tenantId, fence(run), progress, 101);
    await storage.beginProgress(tenantId, fence(run), 1, 102);
    await expect(
      storage.planProgress(tenantId, fence(run), { ...progress, revision: 2 }, 103),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.settleProgress(
      tenantId,
      fence(run),
      { revision: 1, outcome: 'confirmed', attempts: 1, externalMessageKey: 'C1:status' },
      104,
    );
    const update = await storage.planProgress(
      tenantId,
      fence(run),
      { ...progress, revision: 2, text: 'Working' },
      105,
    );
    expect(update.progress?.externalMessageKey).toBe('C1:status');
    await storage.beginProgress(tenantId, fence(run), 2, 106);
    const recovered = (await storage.claim(tenantId, 'channel', 'two', 201, 100))!;
    expect(recovered.progress).toMatchObject({
      revision: 2,
      outcome: 'unknown',
      externalMessageKey: 'C1:status',
    });
    await expect(storage.beginProgress(tenantId, fence(recovered), 2, 202)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    await expect(
      storage.settleProgress(
        tenantId,
        fence(run),
        { revision: 2, outcome: 'confirmed', attempts: 1, externalMessageKey: 'C1:status' },
        202,
      ),
    ).rejects.toMatchObject({ code: 'stale_fence' });
  }));

it('allows known-handle terminal cleanup before final plan and never creates a new terminal surface', () =>
  scope(async () => {
    await storage.admit(enrollment(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'one', 100, 100))!;
    await storage.prepareExecution(tenantId, fence(run), 101);
    await storage.planProgress(
      tenantId,
      fence(run),
      { revision: 1, rendererVersion: 'v1', text: 'Working' },
      102,
    );
    await storage.beginProgress(tenantId, fence(run), 1, 103);
    await storage.settleProgress(
      tenantId,
      fence(run),
      { revision: 1, outcome: 'confirmed', attempts: 1, externalMessageKey: 'C1:status' },
      104,
    );
    await storage.saveSnapshot(
      tenantId,
      fence(run),
      { status: 'completed', text: 'Answer', responseId: 'response', elapsedMs: 10 },
      105,
    );
    await storage.planProgress(
      tenantId,
      fence(run),
      { revision: 2, rendererVersion: 'v1', text: 'Completed' },
      106,
    );
    await storage.beginProgress(tenantId, fence(run), 2, 107);
    await storage.settleProgress(
      tenantId,
      fence(run),
      { revision: 2, outcome: 'confirmed', attempts: 1, externalMessageKey: 'C1:status' },
      108,
    );
    await storage.savePlan(tenantId, fence(run), plan, 109);
    await expect(
      storage.planProgress(
        tenantId,
        fence(run),
        { revision: 3, rendererVersion: 'v1', text: 'Late' },
        110,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it('retains the original response credential and refuses replacement after cancellation', () =>
  scope(async () => {
    await storage.admit(enrollment(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'one', 100, 100))!;
    await storage.prepareExecution(tenantId, fence(run), 101);
    const original = { apiKeyId: 'original', encryptedApiKey: 'ciphertext' };
    await storage.attachResponseCredential(tenantId, fence(run), original, 102);
    const replay = await storage.attachResponseCredential(
      tenantId,
      fence(run),
      { apiKeyId: 'replacement', encryptedApiKey: 'other' },
      103,
    );
    expect(replay.execution).toMatchObject(original);
    await storage.requestCancel(tenantId, 'channel', run.runId, 'owner');
    await expect(
      storage.attachResponseCredential(tenantId, fence(run), original, 104),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it('freezes the first terminal summary inside the fence transaction even for stale concurrent projections', () =>
  scope(async () => {
    await storage.admit(enrollment(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'worker', 100, 100))!;
    await storage.prepareExecution(tenantId, fence(run), 101);
    const summary: ChannelRunSummary = {
      version: 1,
      scope: 'actor_lane',
      throughSequence: 1,
      includesCurrent: true,
      priorRuns: 0,
      expectedRuns: 1,
      observedRuns: 1,
      costUSD: { coverage: 'unavailable', coveredRuns: 0 },
      tokens: { coverage: 'unavailable', coveredRuns: 0 },
      elapsedMs: { coverage: 'complete', coveredRuns: 1, value: 12 },
    };
    const snapshot = { status: 'completed' as const, text: 'Answer', elapsedMs: 12, summary };
    await storage.saveSnapshot(tenantId, fence(run), snapshot, 102);
    const result = await storage.saveSnapshot(
      tenantId,
      fence(run),
      {
        ...snapshot,
        summary: { ...summary, elapsedMs: { coverage: 'unavailable', coveredRuns: 0 } },
      },
      103,
    );
    expect(result.snapshot?.summary).toEqual(summary);
    const replacement = (await storage.claim(tenantId, 'channel', 'next-worker', 201, 100))!;
    await expect(storage.saveSnapshot(tenantId, fence(run), snapshot, 202)).rejects.toMatchObject({
      code: 'stale_fence',
    });
    expect(replacement.snapshot?.summary).toEqual(summary);
  }));

it('retains exact upload allocation and stage across a crash without reopening remote creation', () =>
  scope(async () => {
    await storage.admit(enrollment(), 100);
    const run = (await storage.claim(tenantId, 'channel', 'one', 100, 100))!;
    await storage.prepareExecution(tenantId, fence(run), 101);
    await storage.saveSnapshot(
      tenantId,
      fence(run),
      { status: 'completed', responseId: 'response', text: 'File', elapsedMs: 1 },
      102,
    );
    await storage.savePlan(
      tenantId,
      fence(run),
      {
        revision: 'file-plan',
        rendererVersion: 'v1',
        parts: [
          {
            operationId: 'file',
            kind: 'artifact',
            artifactId: 'opaque',
            required: true,
            text: 'Report',
          },
        ],
      },
      103,
    );
    await storage.beginDelivery(tenantId, fence(run), 'file', 104);
    await expect(
      storage.checkpointUpload(
        tenantId,
        fence(run),
        'file',
        1,
        { fileId: 'F1', stage: 'uploaded' },
        105,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.checkpointUpload(
      tenantId,
      fence(run),
      'file',
      1,
      { fileId: 'F1', stage: 'allocated' },
      106,
    );
    await expect(
      storage.checkpointUpload(
        tenantId,
        fence(run),
        'file',
        1,
        { fileId: 'F2', stage: 'uploaded' },
        107,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await storage.checkpointUpload(
      tenantId,
      fence(run),
      'file',
      1,
      { fileId: 'F1', stage: 'uploaded' },
      108,
    );
    const replacement = (await storage.claim(tenantId, 'channel', 'two', 201, 100))!;
    expect(replacement.receipts[0]).toMatchObject({
      outcome: 'unknown',
      upload: { fileId: 'F1', stage: 'uploaded' },
    });
    await expect(
      storage.beginDelivery(tenantId, fence(replacement), 'file', 202),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(
      storage.checkpointUpload(
        tenantId,
        fence(run),
        'file',
        1,
        { fileId: 'F1', stage: 'uploaded' },
        202,
      ),
    ).rejects.toMatchObject({ code: 'stale_fence' });
  }));

it('does not give actor B actor A history or cancellation even when the configured shared principal is identical', () =>
  scope(async () => {
    const runA = await ready();
    const eventB = enrollment('EvB');
    eventB.admission.actor.externalUserId = 'actor-B';
    const { run: runB } = await storage.admit(eventB, 104);
    expect(runB.principal.userId).toBe(runA.principal.userId);
    expect(runB.laneId).not.toBe(runA.laneId);
    expect(await storage.requestCancel(tenantId, 'channel', runA.runId, 'actor-B')).toBe(false);
    const claimedB = (await storage.claim(tenantId, 'channel', 'worker-B', 105, 1000))!;
    expect(claimedB.runId).toBe(runB.runId);
    const preparedB = await storage.prepareExecution(tenantId, fence(claimedB), 106);
    expect(preparedB.execution?.conversationId).not.toBe(runA.execution?.conversationId);
    expect(preparedB.execution?.parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
  }));

it('bounds each fair scan and persists progress across restarts past a full backlog', () =>
  scope(async () => {
    await storage.admit(enrollment('head'), 100);
    await storage.claim(tenantId, 'channel', 'holding-worker', 100, 10_000);
    for (let i = 0; i < 105; i++) await storage.admit(enrollment(`queued-${i}`), 101 + i);
    const next = await storage.admit(enrollment('actor-b', 'actor-b'), 300);
    const reads = jest.spyOn(mongoose.models.ChannelLane, 'findOne');
    const predecessors = jest.spyOn(mongoose.models.ChannelRun, 'exists');
    const writes = jest.spyOn(mongoose.models.ChannelRun, 'updateOne');
    for (let attempt = 0; attempt < 4; attempt++) {
      reads.mockClear();
      predecessors.mockClear();
      writes.mockClear();
      storage = createChannelRunStorage(mongoose);
      expect(await storage.claim(tenantId, 'channel', 'worker-b', 301 + attempt, 1000)).toBeNull();
      expect(reads.mock.calls.length).toBeLessThanOrEqual(25);
      expect(predecessors.mock.calls.length).toBeLessThanOrEqual(25);
      expect(writes.mock.calls.length).toBe(25);
    }
    storage = createChannelRunStorage(mongoose);
    expect((await storage.claim(tenantId, 'channel', 'worker-b', 305, 1000))?.runId).toBe(
      next.run.runId,
    );
    const explanation = await mongoose.models.ChannelRun.find({
      tenantId,
      channelId: 'channel',
      state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
      leaseExpiresAt: { $lte: 305 },
    })
      .sort({ claimCheckedAt: 1, receivedAt: 1, sequence: 1 })
      .limit(25)
      .hint('channel_run_fair_claim')
      .explain('queryPlanner');
    expect(JSON.stringify(explanation)).toContain('channel_run_fair_claim');
    expect(JSON.stringify(explanation)).not.toMatch(/"stage":"SORT"/);
  }));

it('cleanup ownership supersedes an active worker once and fences stale observations without losing current receipts', () =>
  scope(async () => {
    const run = await ready();
    const inflight = await storage.beginDelivery(tenantId, fence(run), 'part-1', 104);
    const cleanup = (await storage.claimAuthorityLost(run, 'cleanup-a', 105, 1000))!;
    expect(cleanup.leaseEpoch).toBe(run.leaseEpoch + 1);
    expect(cleanup.receipts[0]).toMatchObject({ ...inflight.receipts[0], outcome: 'unknown' });
    expect(await storage.claimAuthorityLost(run, 'stale-cleanup', 106, 1000)).toBeNull();
    expect(await storage.claimAuthorityLost(cleanup, 'cleanup-b', 106, 1000)).toBeNull();
    await expect(storage.beginDelivery(tenantId, fence(run), 'part-2', 106)).rejects.toMatchObject({
      code: 'stale_fence',
    });
    await expect(storage.finishAuthorityLost(tenantId, fence(run), 106)).rejects.toMatchObject({
      code: 'stale_fence',
    });
    const replacement = (await storage.claimAuthorityLost(cleanup, 'cleanup-b', 1106, 1000))!;
    expect(replacement.leaseEpoch).toBe(cleanup.leaseEpoch + 1);
    expect(await storage.read(tenantId, 'channel', run.runId)).toMatchObject({
      receipts: cleanup.receipts,
      claimCheckedAt: run.claimCheckedAt,
    });
    await storage.finishAuthorityLost(tenantId, fence(replacement), 1107);
  }));

it('authority cleanup releases FIFO without advancing history or erasing ambiguous delivery evidence', () =>
  scope(async () => {
    const run = await ready();
    await storage.beginDelivery(tenantId, fence(run), 'part-1', 104);
    await expect(storage.finishAuthorityLost(tenantId, fence(run), 105)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    const lost = await storage.markAuthorityLost(tenantId, fence(run), 105);
    expect(lost.receipts[0].outcome).toBe('unknown');
    expect(lost.errorCode).toBe('channel_authority_changed');
    await storage.finishAuthorityLost(tenantId, fence(run), 106);
    expect(await storage.read(tenantId, 'channel', run.runId)).toMatchObject({
      state: 'cancelled',
      receipts: lost.receipts,
    });
    expect(await storage.findDeliveredReply(tenantId, 'channel', 'C1:reply')).toBeNull();
    const next = await storage.admit(enrollment('next'), 107);
    const claimed = (await storage.claim(tenantId, 'channel', 'next-worker', 108, 1000))!;
    expect(claimed.runId).toBe(next.run.runId);
    const prepared = await storage.prepareExecution(tenantId, fence(claimed), 109);
    expect(prepared.execution?.parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
    await expect(storage.markAuthorityLost(tenantId, fence(run), 110)).rejects.toMatchObject({
      code: 'stale_fence',
    });
  }));
