import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createResponseStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
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

async function reserve(): Promise<StoredResponseRecord> {
  const result = await storage.reserve({
    ...owner,
    responseId: 'resp_queue',
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

it('executes queued Responses through its registered runtime, never through chat HTTP', () =>
  scope(async () => {
    const executed: StoredResponseRecord[] = [];
    const fetcher = jest.fn(async () => {
      throw new Error('Chat transport must not run');
    });
    const queue = createBackgroundResponseQueue({
      storage,
      enqueue: (...args) => service!.enqueue(...args),
      authorize: async (record) => record.sourceKeyId === 'original-api-key',
      execute: async (record) => {
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
    const reserved = await reserve();
    const attached = await storage.attachDelivery(
      owner,
      reserved.responseId,
      queue.deliveryKey(reserved),
    );
    if (!attached.ok) throw new Error('Attach failed');
    await queue.enqueue(attached.record);
    for (let attempt = 0; attempt < 100 && executed.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executed).toHaveLength(1);
    expect(JSON.parse(executed[0].requestJSON)).toMatchObject({
      instructions: 'Preserve instructions',
      input: 'Original input',
    });
    expect(fetcher).not.toHaveBeenCalled();
    const delivery = await service.getDelivery(attached.record.deliveryKey!);
    expect(delivery?.requiredWorkerCapability).toBe('responses_background_v2');
    expect(JSON.stringify(delivery?.envelope)).not.toContain('original-api-key');
    expect(JSON.stringify(delivery?.envelope)).not.toContain('Original input');
  }));

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
    for (const workerCapabilities of [[], ['responses_background_v1']]) {
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

async function reserveDecision(): Promise<StoredResponseRecord> {
  await reserve();
  await storage.publish(owner, 'resp_queue', 0, {
    status: 'in_progress',
    generationCreatedAt: 100,
    responseJSON: '{}',
  });
  const paused = await storage.publishReview(
    owner,
    'resp_queue',
    1,
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
    owner,
    'resp_queue',
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
    await storage.publishReview(
      owner,
      record.responseId,
      admitted.record.revision,
      100,
      {
        actionId: 'action-two',
        providerExecutionId: 'provider-two',
        expiresAt: Date.now() + 60_000,
        partialResponseJSON: '{}',
      },
      '{}',
    );
    const dispatch = queue.sourceDispatchers.get(BACKGROUND_RESPONSE_RESUME_SOURCE)!.dispatch;
    await expect(dispatch(createResponseResumeEnvelope(record))).rejects.toMatchObject({
      code: 'response_resume_authority_changed',
    });
    expect(execute).not.toHaveBeenCalled();
  }));
