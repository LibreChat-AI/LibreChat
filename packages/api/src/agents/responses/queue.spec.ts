import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createResponseStorage,
  responseReference,
  createManagedMessageId,
  tenantStorage,
  runAsSystem,
  getTenantId,
  getUserId,
} from '@librechat/data-schemas';
import type { ResponseStorage, StoredResponseRecord, ResponseOwner } from '@librechat/data-schemas';
import type { AgentTriggerService, AgentTriggerDeliveryPersistence } from '../triggers/service';
import {
  createBackgroundResponseQueue,
  createBackgroundResponseEnvelope,
  createResponseResumeQueue,
  createResponseResumeEnvelope,
  BACKGROUND_RESPONSE_RESUME_SOURCE,
} from './queue';
import { createAgentTriggerService } from '../triggers/service';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
let methods: ReturnType<typeof createMethods>;
let service: AgentTriggerService | undefined;
const responseId = createManagedMessageId();
const owner = { userId: '000000000000000000000001', tenantId: 'response-queue-test' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId: owner.tenantId }, work);

function persistence(): AgentTriggerDeliveryPersistence {
  return {
    ...methods,
    getAgentTriggerDeliveryBatch: (delivery) =>
      methods.getAgentTriggerDeliveryBatch({
        id: delivery.id,
        batchMemberIds: delivery.batchMemberIds?.map(
          (id) => new mongoose.Types.ObjectId(String(id)),
        ),
      }),
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  methods = createMethods(mongoose);
  storage = createResponseStorage(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
afterEach(async () => {
  await service?.stop();
  service = undefined;
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await Promise.all(
      [
        'StoredResponse',
        'ResponseScope',
        'AgentTriggerDelivery',
        'AgentTriggerLaneSequence',
        'AgentTriggerUserPurge',
      ].map((name) => mongoose.models[name].deleteMany({})),
    );
  });
});

async function reserve(principal: ResponseOwner = owner): Promise<StoredResponseRecord> {
  const result = await storage.reserve({
    ...principal,
    responseId,
    requestKey: 'key',
    fingerprint: 'request',
    agentId: 'agent',
    sourceKeyId: 'original-api-key',
    requestJSON: JSON.stringify({
      model: 'agent',
      input: 'Original input',
      instructions: 'Preserve instructions',
      background: true,
      store: true,
    }),
    conversationId: 'conversation',
    parentMessageId: 'root',
  });
  if (!result.ok) throw new Error('Reservation failed');
  return result.record;
}

it.each<ResponseOwner>([owner, { userId: owner.userId }])(
  'executes queued Responses in owner scope through its registered runtime: %j',
  async (principal) =>
    tenantStorage.run({ tenantId: principal.tenantId }, async () => {
      const executed: StoredResponseRecord[] = [];
      const executionScopes: Array<{ tenantId?: string; userId?: string }> = [];
      const fetcher = jest.fn(async () => {
        throw new Error('Chat transport must not run');
      });
      const queue = createBackgroundResponseQueue({
        storage,
        enqueue: (...args) => service!.enqueue(...args),
        authorize: async (record) => record.sourceKeyId === 'original-api-key',
        execute: async (record) => {
          const enrolled = await storage.enrollExecution(
            record,
            { generationCreatedAt: 100, providerExecutionId: 'provider-one' },
            '{}',
          );
          if (!enrolled.ok) throw new Error('Execution enrollment failed');
          executionScopes.push({ tenantId: getTenantId(), userId: getUserId() });
          executed.push(record);
          return { status: 'started', generationCreatedAt: 100 };
        },
      });
      service = createAgentTriggerService({
        methods: persistence(),
        sourceDispatchers: queue.sourceDispatchers,
        fetch: fetcher,
        deliveryOptions: { tickMs: 10 },
      });
      await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3088 } });
      const reserved = await reserve(principal);
      const attached = await storage.attachDelivery(
        principal,
        reserved.responseId,
        queue.deliveryKey(reserved),
      );
      if (!attached.ok) throw new Error('Attach failed');
      await queue.enqueue(attached.record);
      for (let attempt = 0; attempt < 100 && executed.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(executed).toHaveLength(1);
      expect(executionScopes).toEqual([{ tenantId: principal.tenantId, userId: principal.userId }]);
      expect(getTenantId()).toBe(principal.tenantId);
      expect(JSON.parse(executed[0].requestJSON)).toMatchObject({
        instructions: 'Preserve instructions',
        input: 'Original input',
      });
      expect(fetcher).not.toHaveBeenCalled();
      const delivery = await service.getDelivery(attached.record.deliveryKey!);
      expect(delivery?.requiredWorkerCapability).toBe('responses_background_v1');
      expect(JSON.stringify(delivery?.envelope)).not.toContain('original-api-key');
      expect(JSON.stringify(delivery?.envelope)).not.toContain('Original input');
    }),
);

it('does not let a queue worker without the Responses capability claim the response', () =>
  scope(async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('Old worker must not run');
    });
    service = createAgentTriggerService({
      methods: persistence(),
      fetch: fetcher,
      deliveryOptions: { tickMs: 10 },
    });
    await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3088 } });
    const queue = createBackgroundResponseQueue({
      storage,
      enqueue: (...args) => service!.enqueue(...args),
      authorize: async () => true,
      execute: async () => {
        throw new Error('Not installed');
      },
    });
    const record = await reserve();
    const attached = await storage.attachDelivery(
      owner,
      record.responseId,
      queue.deliveryKey(record),
    );
    if (!attached.ok) throw new Error('Attach failed');
    await queue.enqueue(attached.record);
    for (const workerCapabilities of [[], ['unrelated_worker_v1']]) {
      const claimed = await runAsSystem(async () =>
        methods.claimNextAgentTriggerDelivery({
          workerId: 'old-worker',
          claimToken: 'old-token',
          now: new Date(),
          leaseUntil: new Date(Date.now() + 1000),
          workerCapabilities,
        }),
      );
      expect(claimed).toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  }));

it('rejects a tampered source envelope and revoked original authority before execution', () =>
  scope(async () => {
    const execute = jest.fn(async () => ({ status: 'started' as const }));
    let authorized = true;
    const queue = createBackgroundResponseQueue({
      storage,
      enqueue: async () => {
        throw new Error('Not used');
      },
      authorize: async () => authorized,
      execute,
    });
    const record = await reserve();
    await storage.attachDelivery(owner, record.responseId, queue.deliveryKey(record));
    const dispatch = queue.sourceDispatchers.get('responses')!.dispatch;
    const expected = createBackgroundResponseEnvelope(record);
    await expect(dispatch({ ...expected, input: 'tampered' })).rejects.toMatchObject({
      code: 'response_authority_changed',
    });
    authorized = false;
    await expect(dispatch(expected)).rejects.toMatchObject({ code: 'response_authority_changed' });
    expect(execute).not.toHaveBeenCalled();
  }));

async function reserveDecision(principal: ResponseOwner = owner): Promise<StoredResponseRecord> {
  await reserve(principal);
  const running = await storage.enrollExecution(
    (await storage.read(principal, responseId))!,
    { generationCreatedAt: 100, providerExecutionId: 'provider-one' },
    '{}',
  );
  if (!running.ok) throw new Error('Fixture enrollment failed');
  const paused = await storage.publishReview(
    principal,
    responseId,
    { execution: (await storage.read(principal, responseId))! },
    100,
    {
      actionId: 'action-one',
      providerExecutionId: 'provider-one',
      expiresAt: Date.now() + 60_000,
      partialResponseJSON: '{"private":"unfinished output"}',
    },
    '{}',
  );
  if (!paused.ok) throw new Error('Pause failed');
  const result = await storage.reserveResume(
    principal,
    responseId,
    {
      generationCreatedAt: 100,
      actionId: 'action-one',
      intentId: 'intent-one',
      previousProviderExecutionId: 'provider-one',
      providerExecutionId: 'provider-two',
      fingerprint: 'decision-one',
      resolutionJSON: '{"answer":"private owner answer"}',
    },
    Date.now(),
  );
  if (!result.ok) throw new Error('Decision reservation failed');
  return result.record;
}

it.each<ResponseOwner>([owner, { userId: owner.userId }])(
  'admits a saved decision through the durable queue in owner scope: %j',
  async (principal) =>
    tenantStorage.run({ tenantId: principal.tenantId }, async () => {
      const resumed: StoredResponseRecord[] = [];
      const executionScopes: Array<{ tenantId?: string; userId?: string }> = [];
      const queue = createResponseResumeQueue({
        storage,
        enqueue: (...args) => service!.enqueue(...args),
        authorize: async (record) => record.sourceKeyId === 'original-api-key',
        resume: async (record) => {
          const intent = record.resume!;
          await storage.readExecutionProof(record);
          const admitted = await storage.admitResume(
            record,
            record.responseId,
            intent.intentId,
            record.generationCreatedAt!,
            intent.providerExecutionId,
            '{}',
            Date.now(),
          );
          if (!admitted.ok) throw new Error('Resume admission failed');
          executionScopes.push({ tenantId: getTenantId(), userId: getUserId() });
          resumed.push(admitted.record);
          return { status: 'resumed', generationCreatedAt: record.generationCreatedAt };
        },
      });
      service = createAgentTriggerService({
        methods: persistence(),
        sourceDispatchers: queue.sourceDispatchers,
        deliveryOptions: { tickMs: 10 },
      });
      await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3088 } });
      const record = await reserveDecision(principal);
      await queue.enqueue(record);
      for (let attempt = 0; attempt < 100 && resumed.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ status: 'in_progress', resume: { state: 'admitted' } });
      expect(executionScopes).toEqual([{ tenantId: principal.tenantId, userId: principal.userId }]);
      expect(getTenantId()).toBe(principal.tenantId);
    }),
);

it('deduplicates saved decisions in the existing queue and excludes old Responses workers', () =>
  scope(async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('Chat must not run');
    });
    service = createAgentTriggerService({
      methods: persistence(),
      fetch: fetcher,
      deliveryOptions: { tickMs: 10 },
    });
    await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3088 } });
    const queue = createResponseResumeQueue({
      storage,
      enqueue: (...args) => service!.enqueue(...args),
      authorize: async () => true,
      resume: async () => {
        throw new Error('Resume host is not installed');
      },
    });
    const record = await reserveDecision();
    await Promise.all(Array.from({ length: 8 }, () => queue.enqueue(record)));
    const delivery = await service.getDelivery(queue.deliveryKey(record));
    expect(delivery?.requiredWorkerCapability).toBe('responses_resume_v1');
    expect(await mongoose.models.AgentTriggerDelivery.countDocuments({})).toBe(1);
    const serialized = JSON.stringify(delivery?.envelope);
    for (const secret of [
      'private owner answer',
      'unfinished output',
      'original-api-key',
      'Original input',
    ])
      expect(serialized).not.toContain(secret);
    for (const workerCapabilities of [
      [],
      ['responses_background_v1'],
      ['responses_background_v2'],
    ]) {
      expect(
        await runAsSystem(() =>
          methods.claimNextAgentTriggerDelivery({
            workerId: 'old-worker',
            claimToken: 'old-token',
            now: new Date(),
            leaseUntil: new Date(Date.now() + 1000),
            workerCapabilities,
          }),
        ),
      ).toBeNull();
    }
    const claimed = await runAsSystem(() =>
      methods.claimNextAgentTriggerDelivery({
        workerId: 'resume-worker',
        claimToken: 'resume-token',
        now: new Date(),
        leaseUntil: new Date(Date.now() + 1000),
        workerCapabilities: ['responses_resume_v1'],
      }),
    );
    expect(claimed).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  }));

it('rechecks exact saved decision and source grant before dispatching the resume checkpoint', () =>
  scope(async () => {
    const execute = jest.fn(async () => ({ status: 'resumed' as const, generationCreatedAt: 100 }));
    let authorized = true;
    const queue = createResponseResumeQueue({
      storage,
      enqueue: async () => {
        throw new Error('Not used');
      },
      authorize: async () => authorized,
      resume: execute,
    });
    const record = await reserveDecision();
    const envelope = createResponseResumeEnvelope(record);
    const dispatch = queue.sourceDispatchers.get(BACKGROUND_RESPONSE_RESUME_SOURCE)!.dispatch;
    await expect(dispatch({ ...envelope, input: 'tampered' })).rejects.toMatchObject({
      code: 'response_resume_authority_changed',
    });
    await expect(
      dispatch({ ...envelope, event: { ...envelope.event, id: 'other-intent' } }),
    ).rejects.toMatchObject({ code: 'response_resume_authority_changed' });
    authorized = false;
    await expect(dispatch(envelope)).rejects.toMatchObject({
      code: 'response_resume_authority_changed',
    });
    expect(execute).not.toHaveBeenCalled();
    authorized = true;
    expect(await dispatch(envelope)).toMatchObject({
      status: 'resumed',
      streamId: record.responseId,
      generationCreatedAt: 100,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ resume: expect.objectContaining({ intentId: 'intent-one' }) }),
      undefined,
    );
  }));

it('never starts a cancelled decision and does not confuse queue settlement with provider drain', () =>
  scope(async () => {
    const execute = jest.fn(async () => ({ status: 'resumed' as const }));
    const queue = createResponseResumeQueue({
      storage,
      enqueue: async () => {
        throw new Error('Not used');
      },
      authorize: async () => true,
      resume: execute,
    });
    const record = await reserveDecision();
    await storage.requestCancellation(owner, record.responseId, Date.now());
    const dispatch = queue.sourceDispatchers.get(BACKGROUND_RESPONSE_RESUME_SOURCE)!.dispatch;
    expect(await dispatch(createResponseResumeEnvelope(record))).toMatchObject({
      status: 'settled',
    });
    expect(execute).not.toHaveBeenCalled();
    expect((await storage.read(owner, record.responseId))?.status).toBe('requires_action');
  }));

it('rejects an old delivery after a newer provider segment has paused for a different action', () =>
  scope(async () => {
    const execute = jest.fn(async () => ({ status: 'resumed' as const }));
    const queue = createResponseResumeQueue({
      storage,
      enqueue: async () => {
        throw new Error('Not used');
      },
      authorize: async () => true,
      resume: execute,
    });
    const record = await reserveDecision();
    const admitted = await storage.admitResume(
      owner,
      record.responseId,
      'intent-one',
      100,
      'provider-two',
      '{}',
      Date.now(),
    );
    if (!admitted.ok) throw new Error('Admission failed');
    if (
      !(await storage.settleExecution(responseReference(record), {
        generationCreatedAt: 100,
        providerExecutionId: 'provider-one',
      }))
    )
      throw new Error('Provider settlement failed');
    const enrolled = await storage.enrollExecution(
      admitted.record,
      { generationCreatedAt: 100, providerExecutionId: 'provider-two' },
      '{}',
    );
    if (!enrolled.ok) throw new Error('Resume enrollment failed');
    const reviewed = await storage.publishReview(
      owner,
      record.responseId,
      { execution: (await storage.read(owner, record.responseId))! },
      100,
      {
        actionId: 'action-two',
        providerExecutionId: 'provider-two',
        expiresAt: Date.now() + 60_000,
        partialResponseJSON: '{}',
      },
      '{}',
    );
    if (!reviewed.ok) throw new Error('Next pause publication failed');
    const dispatch = queue.sourceDispatchers.get(BACKGROUND_RESPONSE_RESUME_SOURCE)!.dispatch;
    await expect(dispatch(createResponseResumeEnvelope(record))).rejects.toMatchObject({
      code: 'response_resume_authority_changed',
    });
    expect(execute).not.toHaveBeenCalled();
  }));

it.each([null, ''])(
  'dispatches a legacy tenantless stored response %p through the actual trigger queue',
  async (tenantId) => {
    const principal = { userId: owner.userId };
    await tenantStorage.run(principal, async () => {
      const execute = jest.fn().mockResolvedValue({ status: 'started', generationCreatedAt: 100 });
      const queue = createBackgroundResponseQueue({
        storage,
        enqueue: (...args) => service!.enqueue(...args),
        authorize: async () => true,
        execute,
      });
      service = createAgentTriggerService({
        methods: persistence(),
        sourceDispatchers: queue.sourceDispatchers,
        deliveryOptions: { tickMs: 10 },
      });
      await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3088 } });
      const saved = await reserve(principal);
      const key = queue.deliveryKey(saved);
      await mongoose.models.StoredResponse.collection.updateOne(
        { responseId: saved.responseId },
        { $set: { tenantId } },
      );
      const legacy = await storage.read(principal, saved.responseId);
      if (!legacy) throw new Error('Legacy fixture missing');
      expect(queue.deliveryKey(legacy)).toBe(key);
      const attached = await storage.attachDelivery(principal, legacy.responseId, key);
      if (!attached.ok) throw new Error('Attach failed');
      await queue.enqueue(attached.record);
      for (let attempt = 0; attempt < 100 && execute.mock.calls.length === 0; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0]).toMatchObject({
        userId: principal.userId,
        tenantId,
        responseId: saved.responseId,
      });
    });
  },
);

it('rejects an old queued delivery after replacement at the same logical response ID', () =>
  scope(async () => {
    const execute = jest.fn(async () => ({ status: 'started' as const }));
    const queue = createBackgroundResponseQueue({
      storage,
      enqueue: async () => {
        throw new Error('Not used');
      },
      authorize: async () => true,
      execute,
    });
    const first = await reserve();
    const stale = createBackgroundResponseEnvelope(first);
    const oldKey = queue.deliveryKey(first);
    await mongoose.models.StoredResponse.deleteOne({ responseId: first.responseId });
    const replacement = await reserve();
    expect(queue.deliveryKey(replacement)).not.toBe(oldKey);
    await storage.attachDelivery(
      replacement,
      replacement.responseId,
      queue.deliveryKey(replacement),
    );
    await expect(queue.sourceDispatchers.get('responses')!.dispatch(stale)).rejects.toMatchObject({
      code: 'response_authority_changed',
    });
    expect(execute).not.toHaveBeenCalled();
  }));
