import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type {
  AgentTriggerDeliveryFailure,
  AgentTriggerDeliveryRecord,
  AgentTriggerDeliveryStore,
} from './engine';
import type { AgentTriggerExecutionResult } from './host';
import { AgentTriggerDeliveryDeferredError, createAgentTriggerDeliveryEngine } from './engine';
import { createAgentTriggerEnvelope } from './envelope';
import { AgentTriggerDispatchError } from './dispatch';
import { AgentTriggerExecutionError } from './host';

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  };
});

const START = new Date('2026-08-17T12:00:00.000Z');

const successResult = (): AgentTriggerExecutionResult => ({
  mode: 'fire',
  status: 'started',
  conversationId: 'conversation-1',
});

function delivery(overrides: Partial<AgentTriggerDeliveryRecord> = {}): AgentTriggerDeliveryRecord {
  return {
    id: 'delivery-row-1',
    user: 'user-1',
    claimToken: 'claim-1',
    deliveryKey: 'trigger_1',
    fingerprint: 'fingerprint-1',
    orderingKey: 'ordering-1',
    laneSequence: 1,
    envelope: { version: 1 },
    status: 'leased',
    attempts: 0,
    availableAt: START,
    createdAt: START,
    leaseBy: 'worker-1',
    leaseUntil: new Date(START.getTime() + 120_000),
    ...overrides,
  };
}

function storeWith(overrides: Partial<AgentTriggerDeliveryStore> = {}): AgentTriggerDeliveryStore {
  return {
    claimNext: jest.fn(async () => delivery()),
    findEarlierUnsettled: jest.fn(async () => null),
    getBatch: jest.fn(async () => []),
    release: jest.fn(async () => true),
    beginAttempt: jest.fn(async () => 1),
    defer: jest.fn(async () => true),
    complete: jest.fn(async () => true),
    retry: jest.fn(async () => true),
    dead: jest.fn(async () => true),
    ...overrides,
  };
}

describe('createAgentTriggerDeliveryEngine', () => {
  it('claims, dispatches, and completes with the per-claim fence', async () => {
    const store = storeWith();
    const dispatch = jest.fn(async () => successResult());
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START, workerId: 'worker-1' },
      { concurrency: 1 },
    );

    await expect(engine.runTick()).resolves.toBe(1);

    expect(dispatch).toHaveBeenCalledWith(
      { version: 1 },
      { signal: expect.any(AbortSignal), attempt: 1, maxAttempts: 8 },
    );
    expect(store.beginAttempt).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });
    expect(store.complete).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: 1,
      result: successResult(),
      settledAt: START,
    });
  });

  it.each([
    ['honours a longer requested wait', '30', 30_000],
    ['keeps the default re-check for a shorter request', '1', 5_000],
    ['keeps the default re-check without a request', undefined, 5_000],
  ])('%s for a readiness deferral', async (_label, retryAfter, expectedDelayMs) => {
    const store = storeWith();
    const dispatch = jest.fn(async () => {
      throw new AgentTriggerExecutionError('The parent generation has not settled yet.', {
        mode: 'continue',
        certainty: 'definite',
        code: 'PARENT_NOT_READY',
        retryable: true,
        deferWithoutAttempt: true,
        ...(retryAfter != null && { retryAfter }),
      });
    });
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START, workerId: 'worker-1' },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(store.defer).toHaveBeenCalledWith(
      expect.objectContaining({
        availableAt: new Date(START.getTime() + expectedDelayMs),
      }),
    );
    expect(store.retry).not.toHaveBeenCalled();
  });

  it('re-dispatches at once a delivery its deferral found expedited while held', async () => {
    const dispatchesWithin = async (deferred: boolean | 'expedited'): Promise<number> => {
      jest.useFakeTimers();
      try {
        /** Models the store: the deferred row is claimable again only when the
         * deferral honored a wake marker and moved it to now. */
        let claimable = true;
        const store = storeWith({
          claimNext: jest.fn(async () => {
            if (!claimable) {
              return null;
            }
            claimable = false;
            return delivery();
          }),
          defer: jest.fn(async () => {
            claimable = deferred === 'expedited';
            return deferred;
          }),
        });
        let dispatches = 0;
        const dispatch = jest.fn(async () => {
          dispatches++;
          if (dispatches > 1) {
            return successResult();
          }
          throw new AgentTriggerExecutionError('The parent generation has not settled yet.', {
            mode: 'continue',
            certainty: 'definite',
            code: 'PARENT_NOT_READY',
            retryable: true,
            deferWithoutAttempt: true,
            retryAfter: '30',
          });
        });
        const engine = createAgentTriggerDeliveryEngine(
          { store, dispatch, now: () => START, workerId: 'worker-1' },
          { concurrency: 1, tickMs: 60_000, maxIdleTickMs: 60_000 },
        );
        engine.start();
        await jest.advanceTimersByTimeAsync(100);
        await engine.stop();
        return dispatches;
      } finally {
        jest.useRealTimers();
      }
    };

    await expect(dispatchesWithin(true)).resolves.toBe(1);
    await expect(dispatchesWithin('expedited')).resolves.toBe(2);
  });

  it('reclaims an ordering release made due by a held wake signal without waiting for its stale deadline', async () => {
    jest.useFakeTimers();
    try {
      let claimable = true;
      const store = storeWith({
        claimNext: jest.fn(async () => {
          if (!claimable) return null;
          claimable = false;
          return delivery();
        }),
        findEarlierUnsettled: jest
          .fn()
          .mockResolvedValueOnce({ availableAt: new Date(START.getTime() + 60_000) })
          .mockResolvedValue(null),
        release: jest.fn(async () => {
          claimable = true;
          return true;
        }),
      });
      const dispatch = jest.fn(async () => successResult());
      const engine = createAgentTriggerDeliveryEngine(
        { store, dispatch, now: () => START },
        { concurrency: 1, tickMs: 60_000, maxIdleTickMs: 60_000 },
      );
      engine.start();
      await jest.advanceTimersByTimeAsync(100);
      await engine.stop();
      expect(store.release).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs each claim pass under the root trace context', async () => {
    const withContext = jest.spyOn(context, 'with');
    const store = storeWith({ claimNext: jest.fn(async () => null) });
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch: jest.fn(async () => successResult()), now: () => START },
      { concurrency: 1 },
    );

    try {
      await engine.runTick();
      expect(withContext).toHaveBeenCalledWith(ROOT_CONTEXT, expect.any(Function));
      expect(store.claimNext).toHaveBeenCalled();
    } finally {
      withContext.mockRestore();
    }
  });

  it('arms each poll timer under the root trace context', async () => {
    jest.useFakeTimers();
    const withContext = jest.spyOn(context, 'with');
    try {
      const store = storeWith({ claimNext: jest.fn(async () => null) });
      const engine = createAgentTriggerDeliveryEngine(
        { store, dispatch: jest.fn(async () => successResult()), now: () => START },
        { concurrency: 1, tickMs: 1_000 },
      );
      engine.start();
      await jest.advanceTimersByTimeAsync(0);

      const timersArmed = withContext.mock.results.filter(
        (result, index) =>
          withContext.mock.calls[index][0] === ROOT_CONTEXT &&
          result.type === 'return' &&
          typeof (result.value as { unref?: unknown } | undefined)?.unref === 'function',
      );
      expect(timersArmed.length).toBeGreaterThan(0);
      await engine.stop();
    } finally {
      withContext.mockRestore();
      jest.useRealTimers();
    }
  });

  it('persists generation identity when a bound continuation starts', async () => {
    const envelope = createAgentTriggerEnvelope({
      mode: 'continue',
      requestId: 'request-1',
      deliveryId: 'delivery-1',
      receivedAt: 10,
      principal: { id: 'user-1' },
      target: {
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        parentMessageId: 'response-1',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: 'source-key',
      },
      event: {
        id: 'event-1',
        type: 'turn.ready',
        occurredAt: 9,
        source: { id: 'source-key', type: 'remote_api_key' },
      },
      input: 'Take the turn.',
    });
    const store = storeWith({
      claimNext: jest.fn(async () => delivery({ envelope, awaitTerminalHandling: true })),
    });
    const result: AgentTriggerExecutionResult = {
      mode: 'continue',
      status: 'started',
      conversationId: 'conversation-1',
      streamId: 'conversation-1',
      generationCreatedAt: 1_787_000_000_000,
    };
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch: jest.fn(async () => result), now: () => START, workerId: 'worker-1' },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        awaitTerminalHandling: true,
        handling: {
          status: 'started',
          conversationId: 'conversation-1',
          streamId: 'conversation-1',
          generationCreatedAt: 1_787_000_000_000,
          startedAt: START,
        },
      }),
    );
  });

  it('dispatches one structured invocation for every member of a claimed batch', async () => {
    const envelope = createAgentTriggerEnvelope({
      mode: 'continue',
      requestId: 'request-1',
      deliveryId: 'delivery-1',
      receivedAt: 10,
      principal: { id: 'user-1' },
      target: {
        agentId: 'agent-1',
        conversationId: 'thread-1',
        parentMessageId: 'placeholder',
        bindingId: `evtbind_${'a'.repeat(48)}`,
        sourceKeyId: 'source-key',
      },
      event: {
        id: 'event-1',
        type: 'notification.ready',
        occurredAt: 10,
        source: { id: 'source-key', type: 'remote_api_key' },
      },
      input: 'Handle event 1.',
    });
    const root = delivery({ envelope, batchMemberIds: ['row-2'] });
    const member = delivery({
      id: 'row-2',
      deliveryKey: 'trigger_2',
      claimToken: undefined,
      leaseBy: undefined,
      leaseUntil: undefined,
      status: 'batched',
      envelope: createAgentTriggerEnvelope({
        mode: 'continue',
        requestId: 'request-2',
        deliveryId: 'delivery-2',
        receivedAt: 11,
        principal: { id: 'user-1' },
        target: {
          agentId: 'agent-1',
          conversationId: 'thread-1',
          parentMessageId: 'placeholder',
          bindingId: `evtbind_${'a'.repeat(48)}`,
          sourceKeyId: 'source-key',
        },
        event: { ...envelope.event, id: 'event-2', occurredAt: 11 },
        input: 'Handle event 2.',
      }),
    });
    const store = storeWith({
      claimNext: jest.fn(async () => root),
      getBatch: jest.fn(async () => [member]),
    });
    const dispatch = jest.fn<
      Promise<AgentTriggerExecutionResult>,
      [unknown, { signal?: AbortSignal }?]
    >(async () => successResult());
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START, workerId: 'worker-1' },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const dispatched = dispatch.mock.calls[0]?.[0] as { input: string };
    expect(JSON.parse(dispatched.input)).toMatchObject({
      kind: 'librechat.agent_event_batch',
      count: 2,
    });
  });

  it('cancels and drains an in-flight delivery for one user', async () => {
    const store = storeWith();
    let dispatchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const dispatch = jest.fn(
      async (_envelope: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<AgentTriggerExecutionResult>((_resolve, reject) => {
          dispatchStarted?.();
          options?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new AgentTriggerExecutionError('cancelled', {
                  mode: 'fire',
                  certainty: 'ambiguous',
                  retryable: true,
                  code: 'ABORTED',
                }),
              ),
            { once: true },
          );
        }),
    );
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START, workerId: 'worker-1' },
      { concurrency: 1, maxAttempts: 1 },
    );

    const tick = engine.runTick();
    await started;
    await engine.cancelUser('user-1');
    await tick;

    expect(store.defer).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: 1,
      availableAt: new Date(START.getTime() + 5_000),
    });
    expect(store.retry).not.toHaveBeenCalled();
    expect(store.dead).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('releases a claimed delivery without dispatch after its user is fenced', async () => {
    const store = storeWith();
    const dispatch = jest.fn(async () => successResult());
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START, workerId: 'worker-1' },
      { concurrency: 1 },
    );

    await engine.cancelUser('user-1');
    await expect(engine.runTick()).resolves.toBe(1);

    expect(store.release).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      availableAt: START,
    });
    expect(store.beginAttempt).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();

    engine.releaseUserCancellation('user-1');
    await engine.runTick();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After for a retryable admission rejection', async () => {
    const store = storeWith();
    const error = new AgentTriggerExecutionError('busy', {
      mode: 'fire',
      certainty: 'definite',
      retryable: true,
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: '120',
    });
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch: async () => Promise.reject(error), now: () => START },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(store.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: 'claim-1',
        availableAt: new Date(START.getTime() + 120_000),
        error: expect.objectContaining({
          code: 'RATE_LIMITED',
          certainty: 'definite',
          retryable: true,
          status: 429,
        }),
      }),
    );
    expect(store.dead).not.toHaveBeenCalled();
  });

  it('defers a fenced principal without consuming its delivery attempt', async () => {
    const store = storeWith();
    const engine = createAgentTriggerDeliveryEngine(
      {
        store,
        dispatch: async () =>
          Promise.reject(new AgentTriggerDeliveryDeferredError('principal fenced')),
        now: () => START,
        workerId: 'worker-1',
      },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(store.defer).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: 1,
      availableAt: new Date(START.getTime() + 5_000),
    });
    expect(store.retry).not.toHaveBeenCalled();
    expect(store.dead).not.toHaveBeenCalled();
  });

  it('defers a cross-replica account-deletion rejection without consuming its attempt', async () => {
    const store = storeWith();
    const engine = createAgentTriggerDeliveryEngine(
      {
        store,
        dispatch: async () =>
          Promise.reject(
            new AgentTriggerExecutionError('account deletion is in progress', {
              mode: 'fire',
              certainty: 'definite',
              retryable: false,
              code: 'ACCOUNT_DELETION_IN_PROGRESS',
              status: 409,
            }),
          ),
        now: () => START,
        workerId: 'worker-1',
      },
      { concurrency: 1, maxAttempts: 1 },
    );

    await engine.runTick();

    expect(store.defer).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: 1,
      availableAt: new Date(START.getTime() + 5_000),
    });
    expect(store.retry).not.toHaveBeenCalled();
    expect(store.dead).not.toHaveBeenCalled();
  });

  it('defers an auth-stage account-deletion rejection without consuming its attempt', async () => {
    const store = storeWith();
    const engine = createAgentTriggerDeliveryEngine(
      {
        store,
        dispatch: async () =>
          Promise.reject(
            new AgentTriggerExecutionError('account deletion is in progress', {
              mode: 'fire',
              certainty: 'definite',
              retryable: false,
              code: 'ACCOUNT_DELETION_IN_PROGRESS',
              status: 401,
            }),
          ),
        now: () => START,
        workerId: 'worker-1',
      },
      { concurrency: 1, maxAttempts: 1 },
    );

    await engine.runTick();

    expect(store.defer).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: 1,
      availableAt: new Date(START.getTime() + 5_000),
    });
    expect(store.retry).not.toHaveBeenCalled();
    expect(store.dead).not.toHaveBeenCalled();
  });

  it('defers a continuation until its parent generation settles without consuming an attempt', async () => {
    const store = storeWith();
    const engine = createAgentTriggerDeliveryEngine(
      {
        store,
        dispatch: async () =>
          Promise.reject(
            new AgentTriggerExecutionError('parent generation is still running', {
              mode: 'continue',
              certainty: 'definite',
              retryable: true,
              deferWithoutAttempt: true,
              code: 'PARENT_NOT_READY',
              status: 409,
            }),
          ),
        now: () => START,
        workerId: 'worker-1',
      },
      { concurrency: 1, maxAttempts: 1 },
    );

    await engine.runTick();

    expect(store.defer).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: 1,
      availableAt: new Date(START.getTime() + 5_000),
    });
    expect(store.retry).not.toHaveBeenCalled();
    expect(store.dead).not.toHaveBeenCalled();
  });

  it('does not shorten Retry-After to the exponential backoff cap', async () => {
    const store = storeWith();
    const error = new AgentTriggerExecutionError('maintenance', {
      mode: 'fire',
      certainty: 'definite',
      retryable: true,
      retryAfter: '3600',
    });
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch: async () => Promise.reject(error), now: () => START },
      { concurrency: 1, retryCapMs: 1_000 },
    );

    await engine.runTick();

    expect(store.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        availableAt: new Date(START.getTime() + 60 * 60_000),
      }),
    );
  });

  it('dead-letters invalid envelopes without retrying', async () => {
    const transitions: string[] = [];
    const store = storeWith({
      dead: jest.fn(async () => {
        transitions.push('delivery-dead');
        return true;
      }),
    });
    const settleSourceBeforeDeadLetter = jest.fn(async () => {
      transitions.push('source-dead');
    });
    const engine = createAgentTriggerDeliveryEngine(
      {
        store,
        dispatch: async () => Promise.reject(new AgentTriggerDispatchError('invalid envelope')),
        settleSourceBeforeDeadLetter,
        now: () => START,
      },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(store.dead).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: 'claim-1',
        error: expect.objectContaining({
          code: 'INVALID_ENVELOPE',
          certainty: 'definite',
          retryable: false,
        }),
      }),
    );
    expect(settleSourceBeforeDeadLetter).toHaveBeenCalledWith(
      { version: 1 },
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    );
    expect(transitions).toEqual(['source-dead', 'delivery-dead']);
    expect(store.retry).not.toHaveBeenCalled();
  });

  it('bounds one terminal failure before source and delivery settlement', async () => {
    const oversized = 'x'.repeat(3_000);
    const store = storeWith();
    const settleSourceBeforeDeadLetter = jest.fn(
      async (_envelope: unknown, _failure: AgentTriggerDeliveryFailure) => undefined,
    );
    const engine = createAgentTriggerDeliveryEngine(
      {
        store,
        dispatch: async () =>
          Promise.reject(
            new AgentTriggerExecutionError(oversized, {
              mode: 'fire',
              certainty: 'definite',
              retryable: false,
              code: oversized,
            }),
          ),
        settleSourceBeforeDeadLetter,
        now: () => START,
      },
      { concurrency: 1 },
    );

    await engine.runTick();

    const sourceFailure = settleSourceBeforeDeadLetter.mock.calls[0]?.[1];
    const deliveryFailure = (store.dead as jest.Mock).mock.calls[0]?.[0]?.error;
    expect(sourceFailure).toMatchObject({
      code: 'x'.repeat(128),
      message: 'x'.repeat(2_048),
    });
    expect(deliveryFailure).toEqual(sourceFailure);
  });

  it('releases the delivery when source terminalization fails before dead-lettering', async () => {
    const store = storeWith();
    const settleSourceBeforeDeadLetter = jest.fn(async () => {
      throw new Error('source write unavailable');
    });
    const engine = createAgentTriggerDeliveryEngine(
      {
        store,
        dispatch: async () => Promise.reject(new AgentTriggerDispatchError('invalid envelope')),
        settleSourceBeforeDeadLetter,
        now: () => START,
        workerId: 'worker-1',
      },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(store.dead).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      availableAt: START,
    });
  });

  it('dead-letters an exhausted row without dispatching again', async () => {
    const store = storeWith({
      claimNext: jest.fn(async () => delivery({ attempts: 8 })),
    });
    const dispatch = jest.fn(async () => successResult());
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START },
      { concurrency: 1, maxAttempts: 8 },
    );

    await engine.runTick();

    expect(dispatch).not.toHaveBeenCalled();
    expect(store.beginAttempt).not.toHaveBeenCalled();
    expect(store.dead).toHaveBeenCalledWith(expect.objectContaining({ claimToken: 'claim-1' }));
  });

  it.each([false, true])(
    'offers configured receipt recovery when already exhausted is %s',
    async (exhausted) => {
      const store = storeWith({
        claimNext: jest.fn(async () => delivery({ attempts: exhausted ? 1 : 0 })),
      });
      const engine = createAgentTriggerDeliveryEngine(
        {
          store,
          now: () => START,
          dispatch: async () => {
            throw new Error('database unavailable');
          },
        },
        { concurrency: 1, maxAttempts: 1, retryCapMs: 123_000 },
      );
      await engine.runTick();
      expect(store.dead).toHaveBeenCalledWith(
        expect.objectContaining({
          receiptRetryAt: new Date(START.getTime() + 123_000),
          error: expect.objectContaining({ retryable: true }),
        }),
      );
    },
  );

  it('bounds a persisted last failure before exhausting its source', async () => {
    const oversized = 'x'.repeat(3_000);
    const store = storeWith({
      claimNext: jest.fn(async () =>
        delivery({
          attempts: 8,
          lastError: {
            code: oversized,
            message: oversized,
            certainty: 'ambiguous',
            retryable: true,
            attemptedAt: START,
          },
        }),
      ),
    });
    const settleSourceBeforeDeadLetter = jest.fn(async () => undefined);
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch: jest.fn(), settleSourceBeforeDeadLetter, now: () => START },
      { concurrency: 1, maxAttempts: 8 },
    );

    await engine.runTick();

    expect(settleSourceBeforeDeadLetter).toHaveBeenCalledWith(
      { version: 1 },
      expect.objectContaining({ code: 'x'.repeat(128), message: 'x'.repeat(2_048) }),
    );
    expect(store.dead).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'x'.repeat(128),
          message: 'x'.repeat(2_048),
        }),
      }),
    );
  });

  it('does not dead-letter an exhausted row until its source is terminal', async () => {
    const store = storeWith({
      claimNext: jest.fn(async () => delivery({ attempts: 8 })),
    });
    const settleSourceBeforeDeadLetter = jest.fn(async () => {
      throw new Error('source write unavailable');
    });
    const engine = createAgentTriggerDeliveryEngine(
      {
        store,
        dispatch: jest.fn(async () => successResult()),
        settleSourceBeforeDeadLetter,
        now: () => START,
        workerId: 'worker-1',
      },
      { concurrency: 1, maxAttempts: 8 },
    );

    await engine.runTick();

    expect(settleSourceBeforeDeadLetter).toHaveBeenCalledWith(
      { version: 1 },
      expect.objectContaining({ retryable: true }),
    );
    expect(store.dead).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: 'worker-1',
      claimToken: 'claim-1',
      availableAt: START,
    });
  });

  it('rechecks a leased predecessor promptly instead of waiting for its full lease', async () => {
    const store = storeWith({
      findEarlierUnsettled: jest.fn(async () => ({
        availableAt: new Date(START.getTime() + 2_000),
        leaseUntil: new Date(START.getTime() + 4_000),
      })),
    });
    const dispatch = jest.fn(async () => successResult());
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(store.release).toHaveBeenCalledWith({
      id: 'delivery-row-1',
      workerId: expect.any(String),
      claimToken: 'claim-1',
      availableAt: new Date(START.getTime() + 250),
    });
    expect(store.beginAttempt).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not poll ahead of a pending predecessor eligibility time', async () => {
    const store = storeWith({
      findEarlierUnsettled: jest.fn(async () => ({
        availableAt: new Date(START.getTime() + 4_000),
      })),
    });
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch: async () => successResult(), now: () => START },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(store.release).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(START.getTime() + 4_000) }),
    );
  });

  it('rechecks an active actor turn without a tight delivery-lease polling loop', async () => {
    const store = storeWith({
      findEarlierUnsettled: jest.fn(async () => ({
        availableAt: START,
        reason: 'active_handling' as const,
      })),
    });
    const dispatch = jest.fn(async () => successResult());
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START },
      { concurrency: 1 },
    );

    await engine.runTick();

    expect(store.release).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(START.getTime() + 5_000) }),
    );
    expect(store.beginAttempt).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('starts independent deliveries up to the configured concurrency', async () => {
    let releaseDispatch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let dispatchStarts = 0;
    let bothStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const records = [delivery(), delivery({ id: 'delivery-row-2', claimToken: 'claim-2' })];
    const store = storeWith({
      claimNext: jest.fn(async () => records.shift() ?? null),
    });
    const dispatch = jest.fn(async () => {
      dispatchStarts += 1;
      if (dispatchStarts === 2) {
        bothStarted?.();
      }
      await gate;
      return successResult();
    });
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START },
      { concurrency: 2 },
    );

    const tick = engine.runTick();
    await started;
    expect(dispatch).toHaveBeenCalledTimes(2);
    releaseDispatch?.();
    await tick;
  });

  it('backs off polling while idle and snaps back on a wake', async () => {
    jest.useFakeTimers();
    try {
      const store = storeWith({ claimNext: jest.fn(async () => null) });
      const dispatch = jest.fn(async () => successResult());
      const engine = createAgentTriggerDeliveryEngine(
        { store, dispatch, now: () => START, workerId: 'worker-1' },
        { concurrency: 1, tickMs: 1_000, maxIdleTickMs: 8_000 },
      );

      engine.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(store.claimNext).toHaveBeenCalledTimes(1);

      /** Idle polls land at +1s, +5s, +13s (doubling, capped at 8s): 3 more claims in 15s, not 15. */
      await jest.advanceTimersByTimeAsync(15_000);
      expect(store.claimNext).toHaveBeenCalledTimes(4);

      /** A wake — an enqueue nudge or a finished delivery — claims immediately and
       *  re-arms the base cadence, so the next idle poll is one second out again. */
      engine.wake();
      await jest.advanceTimersByTimeAsync(0);
      expect(store.claimNext).toHaveBeenCalledTimes(5);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(store.claimNext).toHaveBeenCalledTimes(6);

      await engine.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns to the base cadence after a claimed delivery interrupts an idle stretch', async () => {
    jest.useFakeTimers();
    try {
      const responses: Array<AgentTriggerDeliveryRecord | null> = [
        null,
        null,
        delivery(),
        null,
        null,
      ];
      const store = storeWith({
        claimNext: jest.fn(async () => (responses.length > 0 ? (responses.shift() ?? null) : null)),
      });
      const dispatch = jest.fn(async () => successResult());
      const engine = createAgentTriggerDeliveryEngine(
        { store, dispatch, now: () => START, workerId: 'worker-1' },
        { concurrency: 1, tickMs: 1_000, maxIdleTickMs: 8_000 },
      );

      engine.start();
      /** start (null) -> +1s (null) -> +5s: the third claim finds work. */
      await jest.advanceTimersByTimeAsync(5_000);
      expect(dispatch).toHaveBeenCalledTimes(1);
      const claimsAfterWork = (store.claimNext as jest.Mock).mock.calls.length;

      /** The completed delivery wakes the engine, so polling resumes at one-second steps. */
      await jest.advanceTimersByTimeAsync(1_000);
      expect((store.claimNext as jest.Mock).mock.calls.length).toBeGreaterThan(claimsAfterWork);

      await engine.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps polling at the base cadence while claims are failing', async () => {
    jest.useFakeTimers();
    try {
      const store = storeWith({
        claimNext: jest.fn(async () => {
          throw new Error('mongo unavailable');
        }),
      });
      const dispatch = jest.fn(async () => successResult());
      const engine = createAgentTriggerDeliveryEngine(
        { store, dispatch, now: () => START, workerId: 'worker-1' },
        { concurrency: 1, tickMs: 1_000, maxIdleTickMs: 8_000 },
      );

      engine.start();
      /** A failed claim proves nothing about the queue, so recovery attempts stay
       *  one second apart instead of stretching toward the idle ceiling. */
      await jest.advanceTimersByTimeAsync(10_000);
      expect((store.claimNext as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(10);

      await engine.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('claims a scheduled retry when it becomes eligible instead of waiting out the idle backoff', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    try {
      let handedFirst = false;
      let handedRetry = false;
      const store = storeWith({
        claimNext: jest.fn(async () => {
          if (!handedFirst) {
            handedFirst = true;
            return delivery();
          }
          if (!handedRetry && Date.now() >= START.getTime() + 20_000) {
            handedRetry = true;
            return delivery({ claimToken: 'claim-2', attempts: 1 });
          }
          return null;
        }),
      });
      const retryable = new AgentTriggerExecutionError('busy', {
        mode: 'fire',
        certainty: 'definite',
        retryable: true,
        code: 'RATE_LIMITED',
        status: 429,
        retryAfter: '20',
      });
      const dispatch = jest
        .fn()
        .mockRejectedValueOnce(retryable)
        .mockImplementation(async () => successResult());
      const engine = createAgentTriggerDeliveryEngine(
        { store, dispatch, now: () => new Date(), workerId: 'worker-1' },
        { concurrency: 1, tickMs: 1_000, maxIdleTickMs: 60_000 },
      );

      engine.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(store.retry).toHaveBeenCalledWith(
        expect.objectContaining({ availableAt: new Date(START.getTime() + 20_000) }),
      );

      /** The idle backoff alone would next poll at +31s; the recorded eligibility
       *  caps the sleep so the retry is claimed on time. */
      await jest.advanceTimersByTimeAsync(21_000);
      expect(dispatch).toHaveBeenCalledTimes(2);

      await engine.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('tracks several eligibility deadlines and interrupts a capped idle sleep for a new earliest', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    try {
      const handed = new Set<string>();
      const pendingAt = new Map<string, number>([
        ['claim-1', 0],
        ['claim-2', 0],
        ['retry-1', START.getTime() + 5_000],
        ['retry-2', START.getTime() + 23_000],
      ]);
      const store = storeWith({
        claimNext: jest.fn(async () => {
          for (const [token, at] of pendingAt) {
            if (!handed.has(token) && Date.now() >= at) {
              handed.add(token);
              return delivery({ claimToken: token });
            }
          }
          return null;
        }),
      });
      const retryable = (retryAfter: string) =>
        new AgentTriggerExecutionError('busy', {
          mode: 'fire',
          certainty: 'definite',
          retryable: true,
          code: 'RATE_LIMITED',
          status: 429,
          retryAfter,
        });
      const dispatch = jest
        .fn()
        .mockRejectedValueOnce(retryable('5'))
        .mockRejectedValueOnce(retryable('23'))
        .mockImplementation(async () => successResult());
      const engine = createAgentTriggerDeliveryEngine(
        { store, dispatch, now: () => new Date(), workerId: 'worker-1' },
        { concurrency: 2, tickMs: 1_000, maxIdleTickMs: 60_000 },
      );

      engine.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledTimes(2);

      /** Both retry deadlines are tracked: the +5s one fires on time, and the +23s one
       *  survives it — a single-slot tracker would discard it and idle to the cap. */
      await jest.advanceTimersByTimeAsync(6_000);
      expect(dispatch).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(18_000);
      expect(dispatch).toHaveBeenCalledTimes(4);

      /** And a deadline learned while the timer already sleeps toward the idle cap
       *  re-arms it: nothing new until the engine has idled well past base cadence. */
      await jest.advanceTimersByTimeAsync(40_000);
      pendingAt.set('late-arrival', Date.now() + 3_000);
      engine.noteEligibleAt(new Date(Date.now() + 3_000));
      await jest.advanceTimersByTimeAsync(4_000);
      expect(dispatch).toHaveBeenCalledTimes(5);

      await engine.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('coalesces overlapping ticks into one claim pass', async () => {
    let releaseClaim: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const claimNext = jest.fn(async () => {
      await gate;
      return null;
    });
    const store = storeWith({ claimNext });
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch: async () => successResult() },
      { concurrency: 1 },
    );

    const first = engine.runTick();
    const second = engine.runTick();
    releaseClaim?.();
    await Promise.all([first, second]);
    expect(claimNext).toHaveBeenCalledTimes(1);
  });

  it('uses one claim when an idle worker has no due work', async () => {
    const claimNext = jest.fn(async () => null);
    const engine = createAgentTriggerDeliveryEngine(
      { store: storeWith({ claimNext }), dispatch: async () => successResult() },
      { concurrency: 4 },
    );

    await expect(engine.runTick()).resolves.toBe(0);

    expect(claimNext).toHaveBeenCalledTimes(1);
  });

  it('fills an open worker slot while an earlier independent delivery is still running', async () => {
    const records = [delivery({ envelope: { delivery: 1 } })];
    const store = storeWith({
      claimNext: jest.fn(async () => records.shift() ?? null),
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let firstStarted: (() => void) | undefined;
    const firstStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted: (() => void) | undefined;
    const secondStart = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const dispatch = jest.fn(async (value: unknown) => {
      const deliveryNumber = (value as { delivery: number }).delivery;
      if (deliveryNumber === 1) {
        firstStarted?.();
        await firstGate;
      } else {
        secondStarted?.();
        await secondGate;
      }
      return successResult();
    });
    const engine = createAgentTriggerDeliveryEngine({ store, dispatch }, { concurrency: 2 });

    engine.start();
    await firstStart;
    records.push(
      delivery({ id: 'delivery-row-2', claimToken: 'claim-2', envelope: { delivery: 2 } }),
    );
    engine.wake();
    await secondStart;

    expect(dispatch).toHaveBeenCalledTimes(2);
    releaseFirst?.();
    releaseSecond?.();
    await engine.stop();
  });

  it('retries ambiguously when execution succeeds but result persistence fails', async () => {
    const store = storeWith({
      complete: jest.fn(async () => Promise.reject(new Error('mongo unavailable'))),
    });
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch: async () => successResult(), now: () => START, random: () => 0 },
      { concurrency: 1, retryBaseMs: 1_000 },
    );

    await engine.runTick();

    expect(store.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: 'claim-1',
        availableAt: new Date(START.getTime() + 500),
        error: expect.objectContaining({
          code: 'RESULT_PERSISTENCE_FAILED',
          certainty: 'ambiguous',
          retryable: true,
        }),
      }),
    );
  });

  it('aborts in-flight dispatch during stop and persists a retry', async () => {
    const store = storeWith();
    let dispatchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const dispatch = jest.fn(
      (
        _envelope: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<AgentTriggerExecutionResult> =>
        new Promise((_, reject) => {
          dispatchStarted?.();
          options?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new AgentTriggerExecutionError('stopping', {
                  mode: 'fire',
                  certainty: 'definite',
                  retryable: true,
                  code: 'ABORTED',
                }),
              ),
            { once: true },
          );
        }),
    );
    const engine = createAgentTriggerDeliveryEngine(
      { store, dispatch, now: () => START },
      { concurrency: 1 },
    );

    const tick = engine.runTick();
    await started;
    await engine.stop();
    await tick;

    expect(store.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: 'claim-1',
        error: expect.objectContaining({ code: 'ABORTED', retryable: true }),
      }),
    );
  });
});
