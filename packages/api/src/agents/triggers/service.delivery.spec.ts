import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
  getTenantId,
  SYSTEM_TENANT_ID,
} from '@librechat/data-schemas';
import type { AgentTriggerDeliveryPersistence, AgentTriggerStoredRecord } from './service';
import type { AgentTriggerDeliveryStore } from './engine';
import { AgentTriggerServiceUnavailableError, createAgentTriggerService } from './service';
import { __resetShutdownStateForTests } from '../../app/shutdown';
import { createAgentTriggerEnvelope } from './envelope';
import * as deliveryEngineModule from './engine';

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  };
});

const START = new Date('2026-08-17T12:00:00.000Z');

const envelope = () =>
  createAgentTriggerEnvelope({
    mode: 'fire',
    requestId: 'request-1',
    deliveryId: 'delivery-1',
    receivedAt: 20,
    principal: { id: '507f1f77bcf86cd799439011', tenantId: 'tenant-1' },
    target: { agentId: 'agent-1' },
    event: {
      id: 'event-1',
      type: 'resource.ready',
      occurredAt: 10,
      source: { id: 'source-1', type: 'webhook' },
    },
    input: 'Handle the ready resource.',
  });

const boundEnvelope = () =>
  createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: 'request-bound-1',
    deliveryId: 'delivery-bound-1',
    receivedAt: 20,
    principal: { id: '507f1f77bcf86cd799439011', tenantId: 'tenant-1' },
    target: {
      agentId: 'agent-1',
      conversationId: 'child-conversation-1',
      parentMessageId: 'parent-message-1',
      bindingId: 'binding-1',
      sourceKeyId: 'source-key-1',
    },
    event: {
      id: 'event-bound-1',
      type: 'game.turn',
      occurredAt: 10,
      source: { id: 'source-key-1', type: 'remote_api_key' },
    },
    input: 'Make the next move.',
  });

function deliveryRecord(overrides: Partial<AgentTriggerStoredRecord> = {}) {
  return {
    id: 'delivery-row-1',
    user: '507f1f77bcf86cd799439011',
    deliveryKey: 'trigger_1',
    fingerprint: 'fingerprint-1',
    orderingKey: 'ordering-1',
    laneSequence: 1,
    envelope: envelope(),
    tenantId: 'tenant-1',
    status: 'pending' as const,
    attempts: 0,
    availableAt: START,
    createdAt: START,
    ...overrides,
  };
}

function deliveryMethods(
  overrides: Partial<AgentTriggerDeliveryPersistence> = {},
): AgentTriggerDeliveryPersistence {
  return {
    ensureAgentTriggerDeliveryIndexes: jest.fn(async () => undefined),
    enqueueAgentTriggerDelivery: jest.fn(async (input) => ({
      delivery: deliveryRecord({
        deliveryKey: input.deliveryKey,
        fingerprint: input.fingerprint,
        orderingKey: input.orderingKey,
        laneSequence: 1,
        envelope: input.envelope,
        availableAt: input.availableAt,
      }),
      replayed: false,
    })),
    claimNextAgentTriggerDelivery: jest.fn(async () => null),
    findEarlierAgentTriggerDelivery: jest.fn(async () => null),
    getAgentTriggerDeliveryBatch: jest.fn(async () => []),
    releaseAgentTriggerDelivery: jest.fn(async () => true),
    beginAgentTriggerDeliveryAttempt: jest.fn(async () => 1),
    deferAgentTriggerDeliveryAttempt: jest.fn(async () => true),
    completeAgentTriggerDelivery: jest.fn(async () => true),
    retireAgentTriggerDelivery: jest.fn(async () => true),
    renewAgentTriggerDeliveryProducerLease: jest.fn(async () => true),
    retryAgentTriggerDelivery: jest.fn(async () => true),
    deadLetterAgentTriggerDelivery: jest.fn(async () => true),
    getAgentTriggerDelivery: jest.fn(async () => null),
    getAgentTriggerDeliveryStatus: jest.fn(async () => null),
    getAgentTriggerDeadLetters: jest.fn(async () => []),
    requeueAgentTriggerDelivery: jest.fn(async () => null),
    countActiveAgentTriggerDeliveriesByUser: jest.fn(async () => 0),
    recoverAgentTriggerLanePublications: jest.fn(async () => 0),
    recoverAgentTriggerBatchReceipts: jest.fn(async () => 0),
    reclaimInactiveAgentTriggerLanes: jest.fn(async () => 0),
    prepareAgentTriggerUserPurge: jest.fn(async () => undefined),
    cancelAgentTriggerUserPurge: jest.fn(async () => true),
    recoverAgentTriggerUserPurges: jest.fn(async () => 0),
    deleteAgentTriggerDeliveriesByUser: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('durable agent trigger service', () => {
  const originalSelfUrl = process.env.AGENT_TRIGGERS_SELF_URL;

  beforeEach(() => {
    __resetShutdownStateForTests();
    delete process.env.AGENT_TRIGGERS_SELF_URL;
  });

  afterEach(() => {
    __resetShutdownStateForTests();
  });

  afterAll(() => {
    if (originalSelfUrl == null) {
      delete process.env.AGENT_TRIGGERS_SELF_URL;
    } else {
      process.env.AGENT_TRIGGERS_SELF_URL = originalSelfUrl;
    }
  });

  it('fails closed before indexes and the delivery engine are ready', async () => {
    const service = createAgentTriggerService({ methods: deliveryMethods() });

    await expect(service.enqueue(envelope())).rejects.toBeInstanceOf(
      AgentTriggerServiceUnavailableError,
    );
    await service.stop();
  });

  it('refuses to arm without a reachable self origin', async () => {
    const service = createAgentTriggerService({ methods: deliveryMethods() });

    await expect(service.initialize()).rejects.toThrow(
      'requires a valid listener address or AGENT_TRIGGERS_SELF_URL',
    );
    await service.stop();
  });

  it('initializes indexes, enqueues normalized source-neutral work, and starts claims', async () => {
    const methods = deliveryMethods();
    const service = createAgentTriggerService({
      methods,
      mintToken: () => 'token',
      fetch: async () => new Response('{}', { status: 500 }),
      supportsDetachedActionCompletion: () => true,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });

    await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });
    const receipt = await service.enqueue(envelope(), {
      orderingKey: 'match-42',
      availableAt: START,
    });

    expect(methods.ensureAgentTriggerDeliveryIndexes).toHaveBeenCalledTimes(1);
    expect(methods.claimNextAgentTriggerDelivery).toHaveBeenCalled();
    expect(methods.claimNextAgentTriggerDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        workerCapabilities: [
          AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
          AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
          AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
          AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
        ],
      }),
    );
    expect(methods.enqueueAgentTriggerDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: expect.stringMatching(/^trigger_/),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        orderingKey: expect.stringMatching(/^trigger_lane_/),
        user: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        availableAt: START,
      }),
    );
    expect(receipt).toMatchObject({
      id: 'delivery-row-1',
      status: 'pending',
      replayed: false,
      availableAt: START,
    });
    await service.stop();
  });

  describe('waiting completion deliveries', () => {
    const address = { address: '127.0.0.1', family: 'IPv4' as const, port: 3080 };
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const result = { status: 'completed' as const, output: 'done', settledAt: START };

    it('expedites and claims the delivery whose background result just became durable', async () => {
      const methods = deliveryMethods({
        persistAgentBackgroundToolResult: jest.fn(async () => true),
        expediteAgentTriggerDeliveries: jest.fn(async () => ({ expedited: 1, held: 0 })),
      });
      const service = createAgentTriggerService({
        methods,
        deliveryOptions: { concurrency: 1, tickMs: 60_000 },
      });
      await service.initialize({ address });
      jest.mocked(methods.claimNextAgentTriggerDelivery).mockClear();

      await expect(
        service.persistBackgroundToolResult({
          deliveryKey: 'trigger_background',
          sourceId: 'background-tool-completion',
          result,
        }),
      ).resolves.toBe(true);
      await flush();

      expect(methods.expediteAgentTriggerDeliveries).toHaveBeenCalledWith({
        deliveryKeys: ['trigger_background'],
        sourceIds: ['background-tool-completion', 'subagent-completion'],
        now: expect.any(Date),
      });
      expect(methods.claimNextAgentTriggerDelivery).toHaveBeenCalled();
      await service.stop();
    });

    it('targets only named subagent completions when a child settles', async () => {
      const methods = deliveryMethods({
        expediteAgentTriggerDeliveries: jest.fn(async () => ({ expedited: 1, held: 0 })),
      });
      const service = createAgentTriggerService({ methods });
      await service.initialize({ address });
      service.expediteCompletionWakeups({
        user: 'user-1',
        conversationId: 'parent-1',
        taskIds: ['child-1'],
      });
      await flush();
      expect(methods.expediteAgentTriggerDeliveries).toHaveBeenCalledWith({
        user: 'user-1',
        conversationId: 'parent-1',
        taskIds: ['child-1'],
        sourceIds: ['subagent-completion'],
        now: expect.any(Date),
      });
      await service.stop();
    });

    it('does not expedite a result the store refused to persist', async () => {
      const methods = deliveryMethods({
        persistAgentBackgroundToolResult: jest.fn(async () => false),
        expediteAgentTriggerDeliveries: jest.fn(async () => ({ expedited: 1, held: 0 })),
      });
      const service = createAgentTriggerService({
        methods,
        deliveryOptions: { concurrency: 1, tickMs: 60_000 },
      });
      await service.initialize({ address });

      await expect(
        service.persistBackgroundToolResult({
          deliveryKey: 'trigger_background',
          sourceId: 'background-tool-completion',
          result,
        }),
      ).resolves.toBe(false);
      await flush();

      expect(methods.expediteAgentTriggerDeliveries).not.toHaveBeenCalled();
      await service.stop();
    });

    it('keeps background producer writes available after the delivery engine stops for shutdown', async () => {
      const methods = deliveryMethods({
        persistAgentBackgroundToolResult: jest.fn(async () => true),
        renewAgentTriggerDeliveryProducerLease: jest.fn(async () => true),
        expediteAgentTriggerDeliveries: jest.fn(async () => ({ expedited: 1, held: 0 })),
      });
      const service = createAgentTriggerService({ methods });
      await service.initialize({ address });
      await service.stop();

      await expect(
        service.renewProducerLease(
          'trigger_background',
          'background-tool-completion',
          new Date(START.getTime() + 30_000),
        ),
      ).resolves.toBe(true);
      await expect(
        service.persistBackgroundToolResult({
          deliveryKey: 'trigger_background',
          sourceId: 'background-tool-completion',
          result,
        }),
      ).resolves.toBe(true);
      await flush();

      expect(methods.persistAgentBackgroundToolResult).toHaveBeenCalledTimes(1);
      expect(methods.expediteAgentTriggerDeliveries).not.toHaveBeenCalled();
      await expect(service.enqueue(envelope())).rejects.toBeInstanceOf(
        AgentTriggerServiceUnavailableError,
      );
    });

    it("expedites a principal's completion deliveries when one of its generations settles", async () => {
      const methods = deliveryMethods({
        expediteAgentTriggerDeliveries: jest.fn(async () => ({ expedited: 2, held: 0 })),
      });
      let settled: ((event: { userId: string; conversationId: string }) => void) | undefined;
      const unsubscribe = jest.fn();
      const service = createAgentTriggerService({
        methods,
        deliveryOptions: { concurrency: 1, tickMs: 60_000 },
        subscribeGenerationSettled: (listener) => {
          settled = listener;
          return unsubscribe;
        },
      });
      await service.initialize({ address });
      jest.mocked(methods.claimNextAgentTriggerDelivery).mockClear();

      settled?.({ userId: '507f1f77bcf86cd799439011', conversationId: 'conversation-1' });
      await flush();

      expect(methods.expediteAgentTriggerDeliveries).toHaveBeenCalledWith({
        user: '507f1f77bcf86cd799439011',
        conversationId: 'conversation-1',
        sourceIds: ['background-tool-completion', 'subagent-completion'],
        now: expect.any(Date),
      });
      expect(methods.claimNextAgentTriggerDelivery).toHaveBeenCalled();
      await service.stop();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('runs a claim pass even when nothing moved, since a match may already be due', async () => {
      const methods = deliveryMethods({
        expediteAgentTriggerDeliveries: jest.fn(async () => ({ expedited: 0, held: 0 })),
      });
      let settled: ((event: { userId: string; conversationId: string }) => void) | undefined;
      const service = createAgentTriggerService({
        methods,
        deliveryOptions: { concurrency: 1, tickMs: 60_000 },
        subscribeGenerationSettled: (listener) => {
          settled = listener;
          return () => undefined;
        },
      });
      await service.initialize({ address });
      jest.mocked(methods.claimNextAgentTriggerDelivery).mockClear();

      settled?.({ userId: '507f1f77bcf86cd799439011', conversationId: 'conversation-1' });
      await flush();

      expect(methods.expediteAgentTriggerDeliveries).toHaveBeenCalledTimes(1);
      expect(methods.claimNextAgentTriggerDelivery).toHaveBeenCalled();
      await service.stop();
    });
  });

  describe('completion wait configuration', () => {
    const address = { address: '127.0.0.1', family: 'IPv4' as const, port: 3080 };

    it('exposes the configured completion wait cap', async () => {
      const service = createAgentTriggerService({ methods: deliveryMethods() });
      expect(service.getCompletionWaitMaxIntervalMs()).toBe(60_000);
      await service.initialize({ address, idlePolling: { completionWaitMaxIntervalMs: 20_000 } });
      expect(service.getCompletionWaitMaxIntervalMs()).toBe(20_000);
      await service.stop();
    });
  });

  it('advertises ordinary completion but not detached-action capability without durable storage', async () => {
    const methods = deliveryMethods();
    const service = createAgentTriggerService({
      methods,
      supportsDetachedActionCompletion: () => false,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });

    await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });

    expect(methods.claimNextAgentTriggerDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        workerCapabilities: [
          AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
          AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
          AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
        ],
      }),
    );
    await service.stop();
  });

  it('persists terminal handling serialization only for bound continuations', async () => {
    const methods = deliveryMethods();
    const service = createAgentTriggerService({
      methods,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });

    await service.enqueue(boundEnvelope());
    await service.enqueue(envelope());

    expect(methods.enqueueAgentTriggerDelivery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ awaitTerminalHandling: true }),
    );
    expect(methods.enqueueAgentTriggerDelivery).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ awaitTerminalHandling: expect.anything() }),
    );
    await service.stop();
  });

  it('rejects enqueue before persistence when the principal was deleted', async () => {
    const methods = deliveryMethods();
    const service = createAgentTriggerService({
      methods,
      isPrincipalActive: async () => false,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    await expect(service.enqueue(envelope())).rejects.toThrow(
      'Agent trigger delivery principal is no longer active',
    );
    expect(methods.enqueueAgentTriggerDelivery).not.toHaveBeenCalled();
    await service.stop();
  });

  it('preserves a just-enqueued row when deletion wins the admission race', async () => {
    const methods = deliveryMethods();
    const isPrincipalActive = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const service = createAgentTriggerService({
      methods,
      isPrincipalActive,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    await expect(service.enqueue(envelope())).rejects.toThrow(
      'Agent trigger delivery principal is no longer active',
    );
    expect(methods.countActiveAgentTriggerDeliveriesByUser).toHaveBeenCalled();
    expect(methods.deleteAgentTriggerDeliveriesByUser).not.toHaveBeenCalled();
    await service.stop();
  });

  it("drains without data loss, then purges one user's deliveries after commit", async () => {
    const countActiveAgentTriggerDeliveriesByUser = jest
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const deleteAgentTriggerDeliveriesByUser = jest.fn(async () => {
      expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
    });
    const methods = deliveryMethods({
      countActiveAgentTriggerDeliveriesByUser,
      deleteAgentTriggerDeliveriesByUser,
    });
    const service = createAgentTriggerService({
      methods,
      userDrainPollMs: 1,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    await service.drainUser('507f1f77bcf86cd799439011');

    expect(countActiveAgentTriggerDeliveriesByUser).toHaveBeenCalledTimes(2);
    expect(deleteAgentTriggerDeliveriesByUser).not.toHaveBeenCalled();

    await service.stop();
    await service.purgeUser('507f1f77bcf86cd799439011');

    expect(deleteAgentTriggerDeliveriesByUser).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
  });

  it.each(['complete', 'dead', 'retire'] as const)(
    'wakes for unfinished %s finalization, but not healthy terminal writes',
    async (operation) => {
      jest.useFakeTimers();
      let service: ReturnType<typeof createAgentTriggerService> | undefined;
      try {
        let store!: AgentTriggerDeliveryStore;
        const create = deliveryEngineModule.createAgentTriggerDeliveryEngine;
        jest
          .spyOn(deliveryEngineModule, 'createAgentTriggerDeliveryEngine')
          .mockImplementation((deps, options) => {
            store = deps.store;
            return create(deps, options);
          });
        let unfinished = false;
        const terminal = jest.fn(async (_input: unknown, recovery?: { required: boolean }) => {
          if (recovery != null) recovery.required = unfinished;
          return true;
        });
        const methods = deliveryMethods({
          completeAgentTriggerDelivery: terminal,
          deadLetterAgentTriggerDelivery: terminal,
          retireAgentTriggerDelivery: terminal,
        });
        service = createAgentTriggerService({ methods, deliveryOptions: { tickMs: 300_000 } });
        await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });
        await jest.advanceTimersByTimeAsync(180_000);
        const count = (methods.recoverAgentTriggerBatchReceipts as jest.Mock).mock.calls.length;
        const input = {
          id: 'row',
          workerId: 'worker',
          claimToken: 'token',
          attempt: 1,
          settledAt: new Date(),
        };
        const finish = () => {
          if (operation === 'complete') {
            return store.complete({
              ...input,
              result: { mode: 'fire', status: 'started', conversationId: 'conversation-1' },
            });
          }
          if (operation === 'dead') {
            return store.dead({
              ...input,
              error: {
                code: 'FAILED',
                message: 'failed',
                retryable: false,
                certainty: 'definite',
                attemptedAt: new Date(),
              },
            });
          }
          return service!.retire('delivery-key', 'source', 'cancelled');
        };
        await expect(finish()).resolves.toBe(true);
        await jest.advanceTimersByTimeAsync(0);
        expect(methods.recoverAgentTriggerBatchReceipts).toHaveBeenCalledTimes(count);
        unfinished = true;
        await expect(finish()).resolves.toBe(true);
        await jest.advanceTimersByTimeAsync(0);
        expect(methods.recoverAgentTriggerBatchReceipts).toHaveBeenCalledTimes(count + 1);
        expect(getTenantId()).not.toBe(SYSTEM_TENANT_ID);
      } finally {
        await service?.stop();
        jest.restoreAllMocks();
        jest.useRealTimers();
      }
    },
  );

  it.each(['enqueue', 'requeue'] as const)(
    'wakes maintenance after an ambiguous %s write failure',
    async (operation) => {
      jest.useFakeTimers();
      let service: ReturnType<typeof createAgentTriggerService> | undefined;
      try {
        const methods = deliveryMethods();
        (methods.enqueueAgentTriggerDelivery as jest.Mock).mockRejectedValue(
          new Error('publication interrupted'),
        );
        (methods.requeueAgentTriggerDelivery as jest.Mock).mockRejectedValue(
          new Error('publication interrupted'),
        );
        service = createAgentTriggerService({ methods, deliveryOptions: { tickMs: 300_000 } });
        await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });
        await jest.advanceTimersByTimeAsync(180_000);
        const count = (methods.recoverAgentTriggerLanePublications as jest.Mock).mock.calls.length;
        await expect(
          operation === 'enqueue' ? service.enqueue(envelope()) : service.requeue('row'),
        ).rejects.toThrow('publication interrupted');
        await jest.advanceTimersByTimeAsync(0);
        expect(methods.recoverAgentTriggerLanePublications).toHaveBeenCalledTimes(count + 1);
      } finally {
        await service?.stop();
        jest.useRealTimers();
      }
    },
  );

  it('backs off empty maintenance scans and wakes for new cleanup work', async () => {
    jest.useFakeTimers();
    try {
      const recoverAgentTriggerUserPurges = jest.fn(async () => 0);
      const methods = deliveryMethods({ recoverAgentTriggerUserPurges });
      const service = createAgentTriggerService({
        methods,
        deliveryOptions: { concurrency: 1, tickMs: 300_000 },
      });
      await service.initialize({
        address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(recoverAgentTriggerUserPurges).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(recoverAgentTriggerUserPurges).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(recoverAgentTriggerUserPurges).toHaveBeenCalledTimes(3);
      await service.prepareUserPurge('507f1f77bcf86cd799439011', new Date());
      await jest.advanceTimersByTimeAsync(0);
      expect(recoverAgentTriggerUserPurges).toHaveBeenCalledTimes(4);
      await service.stop();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(recoverAgentTriggerUserPurges).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the base cadence when a recovery marker was inspected but no repair completed', async () => {
    jest.useFakeTimers();
    try {
      const recoverAgentTriggerBatchReceipts = jest.fn(
        async (_limit?: number, activity?: { found: boolean }) => {
          if (activity != null) activity.found = true;
          return 0;
        },
      );
      const service = createAgentTriggerService({
        methods: deliveryMethods({ recoverAgentTriggerBatchReceipts }),
        deliveryOptions: { concurrency: 1, tickMs: 300_000 },
      });
      await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });
      await jest.advanceTimersByTimeAsync(0);
      expect(recoverAgentTriggerBatchReceipts).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(recoverAgentTriggerBatchReceipts).toHaveBeenCalledTimes(2);
      await service.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not mistake an isolated maintenance failure for an empty scan', async () => {
    jest.useFakeTimers();
    try {
      const recoverAgentTriggerUserPurges = jest
        .fn()
        .mockRejectedValueOnce(new Error('mongo unavailable'))
        .mockResolvedValue(0);
      const methods = deliveryMethods({ recoverAgentTriggerUserPurges });
      const service = createAgentTriggerService({
        methods,
        deliveryOptions: { concurrency: 1, tickMs: 300_000 },
      });
      await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });
      await jest.advanceTimersByTimeAsync(0);
      expect(recoverAgentTriggerUserPurges).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(recoverAgentTriggerUserPurges).toHaveBeenCalledTimes(2);
      await service.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('arms and disarms post-commit purge recovery in system context', async () => {
    const prepareAgentTriggerUserPurge = jest.fn(async () => {
      expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
    });
    const cancelAgentTriggerUserPurge = jest.fn(async () => {
      expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
      return true;
    });
    const methods = deliveryMethods({
      prepareAgentTriggerUserPurge,
      cancelAgentTriggerUserPurge,
    });
    const service = createAgentTriggerService({
      methods,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });
    const fence = new Date(START);

    await service.prepareUserPurge('507f1f77bcf86cd799439011', fence, 'tenant-1');
    await expect(service.cancelUserPurge('507f1f77bcf86cd799439011', fence)).resolves.toBe(true);

    expect(prepareAgentTriggerUserPurge).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      fence,
      'tenant-1',
    );
    await service.stop();
  });

  it('retries recoverable post-commit purges after a transient sweep failure', async () => {
    const recoverAgentTriggerUserPurges = jest
      .fn()
      .mockRejectedValueOnce(new Error('mongo unavailable'))
      .mockResolvedValue(1);
    const service = createAgentTriggerService({
      methods: deliveryMethods({ recoverAgentTriggerUserPurges }),
      purgeRecoveryIntervalMs: 5,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(recoverAgentTriggerUserPurges.mock.calls.length).toBeGreaterThanOrEqual(2);
    await service.stop();
  });

  it('expires dormant legacy actor receipts during durable maintenance', async () => {
    const expireLegacyAgentEventActorReceipts = jest.fn().mockResolvedValue(1);
    const service = createAgentTriggerService({
      methods: deliveryMethods({ expireLegacyAgentEventActorReceipts }),
      purgeRecoveryIntervalMs: 60_000,
      purgeRecoveryLimit: 17,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    expect(expireLegacyAgentEventActorReceipts).toHaveBeenCalledWith(
      expect.any(Date),
      17,
      expect.objectContaining({ found: false }),
    );
    await service.stop();
  });

  it('runs checkpoint evidence maintenance in system context and waits on shutdown', async () => {
    let finish!: () => void;
    const pending = new Promise<number>((resolve) => {
      finish = () => resolve(1);
    });
    const reclaimCheckpointDeletions = jest.fn(() => {
      expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
      return pending;
    });
    const service = createAgentTriggerService({
      methods: deliveryMethods(),
      reclaimCheckpointDeletions,
      purgeRecoveryLimit: 17,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });
    expect(reclaimCheckpointDeletions).toHaveBeenCalledWith(
      17,
      expect.objectContaining({ found: false }),
    );
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    finish();
    await stop;
    expect(stopped).toBe(true);
  });

  it('reclaims lanes even when another maintenance step rejects', async () => {
    /** A single broken cleanup (e.g. an engine-specific query rejection) used
     * to fail the whole Promise.all and skip the sequenced lane reclamation on
     * every pass; each step must fail alone. */
    const expireLegacyAgentEventActorReceipts = jest
      .fn()
      .mockRejectedValue(new Error('Projections cannot have a mix of inclusion and exclusion'));
    const reclaimInactiveAgentTriggerLanes = jest.fn(async () => 1);
    const service = createAgentTriggerService({
      methods: deliveryMethods({
        expireLegacyAgentEventActorReceipts,
        reclaimInactiveAgentTriggerLanes,
      }),
      purgeRecoveryIntervalMs: 60_000,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    expect(expireLegacyAgentEventActorReceipts).toHaveBeenCalledTimes(1);
    expect(reclaimInactiveAgentTriggerLanes).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it('holds lane reclamation while batch-receipt recovery fails', async () => {
    /** Reclamation consumes the lane-cleanup markers; against a half-recovered
     * batch it clears a request no later successful recovery can re-arm, so a
     * failed batch pass must gate it — unlike the independent steps above. */
    const recoverAgentTriggerBatchReceipts = jest
      .fn()
      .mockRejectedValue(new Error('transient settle failure'));
    const reclaimInactiveAgentTriggerLanes = jest.fn(async () => 1);
    const service = createAgentTriggerService({
      methods: deliveryMethods({
        recoverAgentTriggerBatchReceipts,
        reclaimInactiveAgentTriggerLanes,
      }),
      purgeRecoveryIntervalMs: 60_000,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    expect(recoverAgentTriggerBatchReceipts).toHaveBeenCalledTimes(1);
    expect(reclaimInactiveAgentTriggerLanes).not.toHaveBeenCalled();
    await service.stop();
  });

  it('settles interrupted batch receipts before reclaiming their lane', async () => {
    let finishBatchRecovery: ((count: number) => void) | undefined;
    const recoverAgentTriggerBatchReceipts = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          finishBatchRecovery = resolve;
        }),
    );
    let observeReclaim: (() => void) | undefined;
    const reclaimed = new Promise<void>((resolve) => {
      observeReclaim = resolve;
    });
    const reclaimInactiveAgentTriggerLanes = jest.fn(async () => {
      observeReclaim?.();
      return 1;
    });
    const service = createAgentTriggerService({
      methods: deliveryMethods({
        recoverAgentTriggerBatchReceipts,
        reclaimInactiveAgentTriggerLanes,
      }),
      purgeRecoveryIntervalMs: 60_000,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    expect(recoverAgentTriggerBatchReceipts).toHaveBeenCalledTimes(1);
    expect(reclaimInactiveAgentTriggerLanes).not.toHaveBeenCalled();
    finishBatchRecovery?.(1);
    await reclaimed;
    expect(reclaimInactiveAgentTriggerLanes).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it('keeps trusted operational reads and requeue in system tenant context', async () => {
    const getAgentTriggerDeadLetters = jest.fn(async () => {
      expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
      return [deliveryRecord({ status: 'dead' })];
    });
    const requeueAgentTriggerDelivery = jest.fn(async () => {
      expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
      return deliveryRecord();
    });
    const retireAgentTriggerDelivery = jest.fn(async () => {
      expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
      return true;
    });
    const methods = deliveryMethods({
      getAgentTriggerDeadLetters,
      requeueAgentTriggerDelivery,
      retireAgentTriggerDelivery,
    });
    const service = createAgentTriggerService({
      methods,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    await expect(service.getDeadLetters(10)).resolves.toHaveLength(1);
    await expect(service.requeue('delivery-row-1', START)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(
      service.retire('trigger_1', 'background-tool-completion', 'result unavailable', {
        onlyIfUnclaimed: true,
      }),
    ).resolves.toBe(true);
    expect(retireAgentTriggerDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        sourceId: 'background-tool-completion',
        reason: 'result unavailable',
        onlyIfUnclaimed: true,
      }),
      { required: false },
    );
    await expect(
      service.retire('trigger_1', 'background-tool-completion', 'dead recovery', {
        onlyIfDead: true,
      }),
    ).resolves.toBe(true);
    expect(retireAgentTriggerDelivery).toHaveBeenLastCalledWith(
      expect.objectContaining({ onlyIfDead: true }),
      { required: false },
    );
    await service.stop();
  });

  it('wakes the delivery engine when a dead letter is requeued locally', async () => {
    const claimNextAgentTriggerDelivery = jest.fn(async () => null);
    const requeueAgentTriggerDelivery = jest
      .fn()
      .mockResolvedValueOnce(deliveryRecord())
      .mockResolvedValueOnce(null);
    const methods = deliveryMethods({
      claimNextAgentTriggerDelivery,
      requeueAgentTriggerDelivery,
    });
    const service = createAgentTriggerService({
      methods,
      deliveryOptions: { concurrency: 1, tickMs: 60_000 },
    });
    await service.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const claimsBefore = claimNextAgentTriggerDelivery.mock.calls.length;

    await service.requeue('delivery-row-1', START);
    await new Promise((resolve) => setImmediate(resolve));
    expect(claimNextAgentTriggerDelivery.mock.calls.length).toBeGreaterThan(claimsBefore);

    /** A requeue that revived nothing must not wake anything. */
    const claimsAfterWake = claimNextAgentTriggerDelivery.mock.calls.length;
    await service.requeue('delivery-row-1', START);
    await new Promise((resolve) => setImmediate(resolve));
    expect(claimNextAgentTriggerDelivery.mock.calls.length).toBe(claimsAfterWake);

    await service.stop();
  });

  it('does not become ready when the required unique indexes fail', async () => {
    const methods = deliveryMethods({
      ensureAgentTriggerDeliveryIndexes: jest.fn(async () =>
        Promise.reject(new Error('index unavailable')),
      ),
    });
    const service = createAgentTriggerService({ methods });

    await expect(
      service.initialize({
        address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
      }),
    ).rejects.toThrow('index unavailable');
    await expect(service.enqueue(envelope())).rejects.toBeInstanceOf(
      AgentTriggerServiceUnavailableError,
    );
    await service.stop();
  });
});
