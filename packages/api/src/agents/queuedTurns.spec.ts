import { Types } from 'mongoose';
import type {
  AgentQueuedTurnClaim,
  AgentQueuedTurnMethods,
  AgentQueuedTurnRecord,
  ConversationMethods,
  IMessage,
  MessageMethods,
} from '@librechat/data-schemas';
import type { AgentQueuedTurnResolverDeps, AgentQueuedTurnSchedulerDeps } from './queuedTurns';
import type { AgentContinueTriggerEnvelope } from './triggers/envelope';
import {
  createQueuedTurnDeliveryReservation,
  AGENT_QUEUED_TURN_SOURCE,
  createAgentQueuedTurnLifecycle,
} from './queuedTurns';
import { getAgentTriggerIdempotencyKey } from './triggers/envelope';
import { AgentTriggerExecutionError } from './triggers/host';

const NOW = Date.parse('2026-08-30T12:00:00Z');
const USER_ID = '507f191e810c19729de860ea';

function envelope(): AgentContinueTriggerEnvelope {
  return {
    version: 1,
    mode: 'continue',
    requestId: 'request-1',
    deliveryId: 'queued-turn-1',
    receivedAt: NOW,
    principal: { userId: USER_ID, tenantId: 'tenant-1' },
    event: {
      id: 'queued-turn-1',
      type: 'agent.queued-turn',
      occurredAt: NOW,
      source: { id: AGENT_QUEUED_TURN_SOURCE, type: 'internal' },
      payload: { queuedTurnId: 'queued-turn-1' },
    },
    target: {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentMessageId: 'assistant-1',
    },
    input: 'queued words',
  };
}

function claim(): AgentQueuedTurnClaim {
  return {
    queuedTurnId: 'queued-turn-1',
    user: new Types.ObjectId(USER_ID),
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    parentMessageId: 'assistant-1',
    clientRequestId: 'client-1',
    fingerprint: 'fingerprint-1',
    sequence: 1,
    admissionSlot: true,
    status: 'claimed',
    priority: false,
    text: 'queued words',
    files: [{ file_id: 'file-1' }],
    quotes: ['quote'],
    manualSkills: ['skill-1'],
    attempts: 1,
    availableAt: new Date(NOW),
    claimId: 'trigger-1',
    claimBy: 'worker-1',
    claimUntil: new Date(NOW + 60_000),
    createdAt: new Date(NOW - 1_000),
  };
}

function persistedMessage(
  value: Pick<IMessage, 'messageId' | 'parentMessageId' | 'isCreatedByUser'> &
    Partial<Pick<IMessage, 'createdAt' | 'unfinished' | 'error'>>,
): IMessage {
  return value as unknown as IMessage;
}

function resolverMethods() {
  const turn = claim();
  const methods = {
    getConvo: jest.fn(async () => ({ tenantId: 'tenant-1', agent_id: 'agent-1' })),
    getMessages: jest.fn(
      async (..._args: Parameters<MessageMethods['getMessages']>): Promise<IMessage[]> => [
        persistedMessage({
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          isCreatedByUser: false,
          createdAt: new Date(NOW - 500),
        }),
        persistedMessage({
          messageId: 'assistant-2',
          parentMessageId: 'assistant-1',
          isCreatedByUser: false,
          createdAt: new Date(NOW),
        }),
      ],
    ),
    claimNextAgentQueuedTurn: jest.fn(
      async (..._args: Parameters<AgentQueuedTurnMethods['claimNextAgentQueuedTurn']>) => ({
        outcome: 'acquired' as const,
        claim: turn,
      }),
    ),
    releaseAgentQueuedTurn: jest.fn(async () => ({ outcome: 'released' as const, turn })),
    beginAgentQueuedTurnAdmission: jest.fn(async () => ({
      outcome: 'started' as const,
      turn,
    })),
    getEffectiveAgentQueuedTurnPredecessor: jest.fn(
      async (
        ..._args: Parameters<AgentQueuedTurnMethods['getEffectiveAgentQueuedTurnPredecessor']>
      ) => null,
    ),
    markAgentQueuedTurnAdmitted: jest.fn(async () => ({
      outcome: 'admitted' as const,
      turn: { ...turn, status: 'admitted' as const },
    })),
    hasAgentQueuedTurnAdmissionReceipt: jest.fn(async () => true),
  };
  return {
    methods: methods as unknown as AgentQueuedTurnMethods &
      Pick<ConversationMethods, 'getConvo'> &
      Pick<MessageMethods, 'getMessages'>,
    spies: methods,
  };
}

function createAgentQueuedTurnResolver(deps: AgentQueuedTurnResolverDeps) {
  return createAgentQueuedTurnLifecycle({
    ...deps,
    getGenerationAdmissionEvidence: async () => null,
    enqueue: async () => ({ deliveryKey: 'unused-delivery' }),
  }).prepareContinue;
}

function createAgentQueuedTurnDeadLetterSettlement({
  methods,
  getGenerationAdmissionEvidence = async () => null,
  now,
}: {
  methods: Pick<AgentQueuedTurnMethods, 'deadLetterAgentQueuedTurn'>;
  getGenerationAdmissionEvidence?: AgentQueuedTurnSchedulerDeps['getGenerationAdmissionEvidence'];
  now?: () => number;
}) {
  return createAgentQueuedTurnLifecycle({
    methods: methods as AgentQueuedTurnSchedulerDeps['methods'] &
      AgentQueuedTurnResolverDeps['methods'],
    getGenerationJob: async () => null,
    getGenerationAdmissionEvidence,
    enqueue: async () => ({ deliveryKey: 'unused-delivery' }),
    ...(now != null && { now }),
  }).settleBeforeDeadLetter;
}

function createAgentQueuedTurnScheduler(deps: AgentQueuedTurnSchedulerDeps) {
  return createAgentQueuedTurnLifecycle({
    ...deps,
    methods: deps.methods as AgentQueuedTurnSchedulerDeps['methods'] &
      AgentQueuedTurnResolverDeps['methods'],
    getGenerationJob: async () => null,
  });
}

describe('Agent queued-turn continuation', () => {
  it.each([undefined, 'ask', 'acceptEdits', 'fullAccess'] as const)(
    'prepares only the snapshotted approval mode %s, not event or current conversation permissions',
    async (mode) => {
      const { methods, spies } = resolverMethods();
      const saved = claim();
      spies.claimNextAgentQueuedTurn.mockResolvedValue({
        outcome: 'acquired',
        claim: { ...saved, ...(mode != null && { codeApprovalMode: mode }) },
      });
      const resolve = createAgentQueuedTurnResolver({
        methods,
        getGenerationJob: async () => null,
      });
      const delivery = envelope();
      delivery.event.payload = { queuedTurnId: 'queued-turn-1', codeApprovalMode: 'fullAccess' };
      const prepared = await resolve(delivery, { idempotencyKey: 'delivery-1' } as never);
      expect(prepared?.status).toBe('ready');
      expect(prepared?.status === 'ready' && prepared.codeApprovalMode).toBe(mode);
    },
  );

  it('dead-letters a delivery while preserving an admission-indeterminate source', async () => {
    const deadLetterAgentQueuedTurn = jest.fn(async () => ({
      outcome: 'admission_indeterminate' as const,
      turn: claim(),
    }));
    const settle = createAgentQueuedTurnDeadLetterSettlement({
      methods: { deadLetterAgentQueuedTurn },
      now: () => NOW,
    });

    await expect(
      settle(envelope(), {
        code: 'ATTEMPTS_EXHAUSTED',
        message: 'admission receipt unavailable',
        certainty: 'ambiguous',
        retryable: true,
        attemptedAt: new Date(NOW),
      }),
    ).resolves.toBeUndefined();
    expect(deadLetterAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-1',
        deliveryKey: getAgentTriggerIdempotencyKey(envelope()),
      }),
    );
  });

  it('passes exact live-generation evidence into dead-letter reconciliation', async () => {
    const deliveryKey = getAgentTriggerIdempotencyKey(envelope());
    const deadLetterAgentQueuedTurn = jest.fn(async () => ({
      outcome: 'admission_reconciled' as const,
      turn: { ...claim(), status: 'admitted' as const },
    }));
    const settle = createAgentQueuedTurnDeadLetterSettlement({
      methods: { deadLetterAgentQueuedTurn },
      getGenerationAdmissionEvidence: async () => ({
        generationId: 'generation-1',
        generationCreatedAt: NOW + 1,
      }),
      now: () => NOW,
    });

    await settle(envelope(), {
      code: 'ATTEMPTS_EXHAUSTED',
      message: 'admission receipt unavailable',
      certainty: 'ambiguous',
      retryable: true,
      attemptedAt: new Date(NOW),
    });
    expect(deadLetterAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey,
        admissionEvidence: {
          generationId: 'generation-1',
          generationCreatedAt: NOW + 1,
        },
      }),
    );
  });

  it('defers without claiming while the predecessor generation remains active', async () => {
    const { methods, spies } = resolverMethods();
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => ({ status: 'running' }),
      now: () => NOW,
      claimBy: 'worker-1',
    });

    await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).rejects.toMatchObject({
      code: 'PARENT_NOT_READY',
      retryable: true,
      deferWithoutAttempt: true,
    });
    expect(spies.claimNextAgentQueuedTurn).not.toHaveBeenCalled();
  });

  it('preserves queued context and settles only after fresh-turn admission', async () => {
    const { methods, spies } = resolverMethods();
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });

    const prepared = await resolve(envelope(), { idempotencyKey: 'trigger-1' });
    expect(prepared).toMatchObject({
      status: 'ready',
      input: 'queued words',
      parentMessageId: 'assistant-2',
      files: [{ file_id: 'file-1' }],
      quotes: ['quote'],
      manualSkills: ['skill-1'],
      admissionSource: {
        source: AGENT_QUEUED_TURN_SOURCE,
        sourceId: 'queued-turn-1',
        claimId: 'trigger-1',
        claimBy: 'worker-1',
      },
    });
    if (prepared?.status !== 'ready') {
      throw new Error('Expected a ready queued turn');
    }
    expect(spies.markAgentQueuedTurnAdmitted).not.toHaveBeenCalled();
    expect(spies.beginAgentQueuedTurnAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-1',
        admissionId: 'trigger-1',
        admissionProtocolVersion: 2,
      }),
    );
    await prepared.settleOnAdmission?.({
      mode: 'continue',
      status: 'started',
      conversationId: 'conversation-1',
      streamId: 'stream-1',
      generationCreatedAt: NOW + 1,
    });
    expect(spies.markAgentQueuedTurnAdmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-1',
        admissionId: 'trigger-1',
        admissionMode: 'ordinary',
        generationId: 'stream-1',
        generationCreatedAt: NOW + 1,
      }),
    );
  });

  it('records execution admission through the source-owned lifecycle seam', async () => {
    const { methods, spies } = resolverMethods();
    const lifecycle = createAgentQueuedTurnLifecycle({
      methods,
      getGenerationJob: async () => null,
      getGenerationAdmissionEvidence: async () => null,
      enqueue: async () => ({ deliveryKey: 'queued-delivery-1' }),
    });

    await expect(
      lifecycle.recordExecutionAdmission(
        {
          source: AGENT_QUEUED_TURN_SOURCE,
          sourceId: 'queued-turn-1',
          claimId: 'trigger-1',
          claimBy: 'worker-1',
          effectivePredecessorCreatedAt: NOW,
        },
        {
          userId: USER_ID,
          tenantId: 'tenant-1',
          conversationId: 'conversation-1',
          clientRequestId: 'trigger-1',
          generationId: 'conversation-1',
          generationCreatedAt: NOW + 1,
        },
      ),
    ).resolves.toBe(true);
    expect(spies.markAgentQueuedTurnAdmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-1',
        claimId: 'trigger-1',
        claimBy: 'worker-1',
        admissionId: 'trigger-1',
        generationId: 'conversation-1',
        generationCreatedAt: NOW + 1,
        effectivePredecessorCreatedAt: NOW,
      }),
    );
  });

  it('requires the exact durable source receipt before deduplicated success', async () => {
    const { methods, spies } = resolverMethods();
    const lifecycle = createAgentQueuedTurnLifecycle({
      methods,
      getGenerationJob: async () => null,
      getGenerationAdmissionEvidence: async () => null,
      enqueue: async () => ({ deliveryKey: 'queued-delivery-1' }),
    });
    const source = {
      source: AGENT_QUEUED_TURN_SOURCE,
      sourceId: 'queued-turn-1',
      claimId: 'trigger-1',
      claimBy: 'worker-1',
      effectivePredecessorCreatedAt: NOW,
    };
    const admission = {
      userId: USER_ID,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      clientRequestId: 'trigger-1',
      generationId: 'conversation-1',
      generationCreatedAt: NOW + 1,
    };

    await expect(lifecycle.verifyExecutionAdmission(source, admission)).resolves.toBe(true);
    expect(spies.hasAgentQueuedTurnAdmissionReceipt).toHaveBeenCalledWith({
      user: new Types.ObjectId(USER_ID),
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: 'queued-turn-1',
      admissionId: 'trigger-1',
      generationId: 'conversation-1',
      generationCreatedAt: NOW + 1,
      effectivePredecessorCreatedAt: NOW,
    });

    spies.hasAgentQueuedTurnAdmissionReceipt.mockResolvedValueOnce(false);
    await expect(lifecycle.verifyExecutionAdmission(source, admission)).rejects.toThrow(
      'not yet confirmed',
    );
  });

  it('retires cancellation through the same lifecycle interface', async () => {
    const { methods: resolver } = resolverMethods();
    const cancelled = {
      ...claim(),
      status: 'cancelled' as const,
      deliveryKey: 'delivery-cancelled',
      terminalReceipt: {
        outcome: 'cancelled' as const,
        settledAt: new Date(NOW),
      },
    };
    const cancelAgentQueuedTurn = jest.fn(async () => ({
      outcome: 'cancelled' as const,
      turn: cancelled,
    }));
    const markAgentQueuedTurnDeliveryRetired = jest.fn(async () => true);
    const retireDelivery = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const lifecycle = createAgentQueuedTurnLifecycle({
      methods: {
        ...resolver,
        cancelAgentQueuedTurn,
        markAgentQueuedTurnDeliveryRetired,
      },
      getGenerationJob: async () => null,
      getGenerationAdmissionEvidence: async () => null,
      enqueue: async () => ({ deliveryKey: 'unused-delivery' }),
      retireDelivery,
    });

    await expect(
      lifecycle.cancel({
        user: new Types.ObjectId(USER_ID),
        tenantId: 'tenant-1',
        queuedTurnId: 'queued-turn-1',
      }),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(retireDelivery).toHaveBeenNthCalledWith(
      1,
      'delivery-cancelled',
      AGENT_QUEUED_TURN_SOURCE,
      'queued_turn_cancelled',
    );
    expect(retireDelivery).toHaveBeenNthCalledWith(
      2,
      'delivery-cancelled',
      AGENT_QUEUED_TURN_SOURCE,
      'queued_turn_cancelled',
      { onlyIfDead: true },
    );
    expect(markAgentQueuedTurnDeliveryRetired).toHaveBeenCalledWith({
      deliveryKey: 'delivery-cancelled',
    });
  });

  it('settles an obsolete-lane delivery without crossing ordinary admission', async () => {
    const { methods, spies } = resolverMethods();
    (
      spies.beginAgentQueuedTurnAdmission as unknown as jest.MockedFunction<
        AgentQueuedTurnMethods['beginAgentQueuedTurnAdmission']
      >
    ).mockResolvedValueOnce({
      outcome: 'retired',
      turn: { ...claim(), status: 'cancelled' },
    });
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });

    await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).resolves.toEqual({
      status: 'settled',
    });
    expect(spies.markAgentQueuedTurnAdmitted).not.toHaveBeenCalled();
  });

  it('uses the latest admitted queued generation as the effective predecessor epoch', async () => {
    const { methods, spies } = resolverMethods();
    const claimed = claim();
    claimed.expectedPredecessorCreatedAt = NOW;
    spies.claimNextAgentQueuedTurn.mockResolvedValueOnce({ outcome: 'acquired', claim: claimed });
    spies.beginAgentQueuedTurnAdmission.mockResolvedValueOnce({
      outcome: 'started',
      turn: { ...claimed, admissionEffectivePredecessorCreatedAt: NOW + 250 },
    });
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });

    const prepared = await resolve(envelope(), { idempotencyKey: 'trigger-1' });
    expect(prepared).toMatchObject({
      status: 'ready',
      expectedPredecessorCreatedAt: NOW + 250,
      admissionSource: { effectivePredecessorCreatedAt: NOW + 250 },
    });
    expect(spies.beginAgentQueuedTurnAdmission).toHaveBeenCalledTimes(1);
    if (prepared?.status !== 'ready') {
      throw new Error('Expected a ready queued turn');
    }
    await prepared.settleOnAdmission?.({
      mode: 'continue',
      status: 'started',
      conversationId: 'conversation-1',
      streamId: 'stream-2',
      generationCreatedAt: NOW + 500,
    });
    expect(spies.markAgentQueuedTurnAdmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-1',
        effectivePredecessorCreatedAt: NOW + 250,
      }),
    );
  });

  it('does not reinterpret a missing underscore-suffixed anchor', async () => {
    const { methods, spies } = resolverMethods();
    const queued = claim();
    queued.parentMessageId = 'user-1_';
    spies.claimNextAgentQueuedTurn.mockResolvedValueOnce({ outcome: 'acquired', claim: queued });
    spies.getMessages.mockResolvedValueOnce([
      persistedMessage({
        messageId: 'user-1',
        parentMessageId: 'root',
        isCreatedByUser: true,
        createdAt: new Date(NOW - 1_000),
      }),
      persistedMessage({
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        createdAt: new Date(NOW),
      }),
    ]);
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });

    await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).rejects.toMatchObject({
      code: 'PARENT_NOT_FOUND',
    });
    expect(spies.releaseAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: queued.queuedTurnId,
        disposition: 'dead',
        failure: expect.objectContaining({ code: 'PARENT_NOT_FOUND' }),
      }),
    );
  });

  it('continues after the newest regenerated response under a durable user anchor', async () => {
    const { methods, spies } = resolverMethods();
    const queued = claim();
    queued.parentMessageId = 'user-1';
    spies.claimNextAgentQueuedTurn.mockResolvedValueOnce({ outcome: 'acquired', claim: queued });
    spies.getMessages.mockResolvedValueOnce([
      persistedMessage({
        messageId: 'user-1',
        parentMessageId: 'root',
        isCreatedByUser: true,
        createdAt: new Date(NOW - 3_000),
      }),
      persistedMessage({
        messageId: 'old-assistant',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        createdAt: new Date(NOW - 2_000),
      }),
      persistedMessage({
        messageId: 'regenerated-assistant',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        createdAt: new Date(NOW),
      }),
    ]);
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });

    await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).resolves.toMatchObject({
      status: 'ready',
      parentMessageId: 'regenerated-assistant',
    });
  });

  it('dead-letters a legacy admission order that cannot be reconstructed safely', async () => {
    const { methods, spies } = resolverMethods();
    (
      spies.beginAgentQueuedTurnAdmission as unknown as jest.MockedFunction<
        AgentQueuedTurnMethods['beginAgentQueuedTurnAdmission']
      >
    ).mockResolvedValueOnce({
      outcome: 'order_unavailable',
      turn: { ...claim(), status: 'dead' },
    });
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });

    await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).resolves.toEqual({
      status: 'settled',
    });
    expect(spies.releaseAgentQueuedTurn).not.toHaveBeenCalled();
    expect(spies.beginAgentQueuedTurnAdmission).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['aborted', 'PREDECESSOR_ABORTED'],
    ['error', 'PREDECESSOR_FAILED'],
  ] as const)('dead-letters a queued turn whose predecessor is %s', async (status, code) => {
    const { methods, spies } = resolverMethods();
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => ({ status }),
      now: () => NOW,
      claimBy: 'worker-1',
    });

    await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).resolves.toEqual({
      status: 'settled',
    });
    expect(spies.releaseAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'dead',
        failure: expect.objectContaining({ code }),
      }),
    );
    expect(spies.getMessages).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ unfinished: true }, 'PREDECESSOR_ABORTED'],
    [{ error: true }, 'PREDECESSOR_FAILED'],
  ] as const)(
    'uses durable response history after the transient predecessor job is cleaned up',
    async (terminal, code) => {
      const { methods, spies } = resolverMethods();
      spies.getMessages.mockResolvedValueOnce([
        persistedMessage({
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          isCreatedByUser: false,
          createdAt: new Date(NOW),
          ...terminal,
        }),
      ]);
      const resolve = createAgentQueuedTurnResolver({
        methods,
        getGenerationJob: async () => null,
        now: () => NOW,
        claimBy: 'worker-1',
      });

      await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).resolves.toEqual({
        status: 'settled',
      });
      expect(spies.releaseAgentQueuedTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          disposition: 'dead',
          failure: expect.objectContaining({ code }),
        }),
      );
    },
  );

  it('allows an explicitly prioritized interrupt successor after its predecessor is unfinished', async () => {
    const { methods, spies } = resolverMethods();
    const prioritized = claim();
    prioritized.priority = true;
    spies.claimNextAgentQueuedTurn.mockResolvedValueOnce({
      outcome: 'acquired',
      claim: prioritized,
    });
    spies.getMessages.mockResolvedValueOnce([
      persistedMessage({
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        createdAt: new Date(NOW),
        unfinished: true,
      }),
    ]);
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });

    await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).resolves.toMatchObject({
      status: 'ready',
      parentMessageId: 'assistant-1',
    });
  });

  it('dead-letters the queue row when admission is definitely rejected', async () => {
    const { methods, spies } = resolverMethods();
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });
    const prepared = await resolve(envelope(), { idempotencyKey: 'trigger-1' });
    if (prepared?.status !== 'ready') {
      throw new Error('Expected a ready queued turn');
    }
    await prepared.releaseOnDefiniteFailure?.(
      new AgentTriggerExecutionError('forbidden', {
        mode: 'continue',
        certainty: 'definite',
        retryable: false,
        status: 403,
        code: 'FORBIDDEN',
      }),
    );
    expect(spies.releaseAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'dead',
        failure: { code: 'FORBIDDEN', message: 'forbidden' },
      }),
    );
  });

  it('releases a claim when admission defers with PARENT_NOT_READY', async () => {
    const { methods, spies } = resolverMethods();
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });
    const prepared = await resolve(envelope(), { idempotencyKey: 'trigger-1' });
    if (prepared?.status !== 'ready') {
      throw new Error('Expected a ready queued turn');
    }
    await prepared.releaseOnDefiniteFailure?.(
      new AgentTriggerExecutionError('parent raced', {
        mode: 'continue',
        certainty: 'definite',
        retryable: true,
        deferWithoutAttempt: true,
        status: 409,
        code: 'PARENT_NOT_READY',
      }),
    );
    expect(spies.releaseAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-1',
        claimId: 'trigger-1',
        claimBy: 'worker-1',
        disposition: 'retry',
      }),
    );
  });

  it('dead-letters a retryable admission rejection on the final delivery attempt', async () => {
    const { methods, spies } = resolverMethods();
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });
    const prepared = await resolve(envelope(), {
      idempotencyKey: 'trigger-1',
      attempt: 3,
      maxAttempts: 3,
    });
    if (prepared?.status !== 'ready') {
      throw new Error('Expected a ready queued turn');
    }

    await prepared.releaseOnDefiniteFailure?.(
      new AgentTriggerExecutionError('still busy', {
        mode: 'continue',
        certainty: 'definite',
        retryable: true,
        status: 503,
        code: 'ADMISSION_BUSY',
      }),
    );
    expect(spies.releaseAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'dead',
        failure: { code: 'ADMISSION_BUSY', message: 'still busy' },
      }),
    );
  });

  it('releases an acquired claim when branch preparation is temporarily unavailable', async () => {
    const { methods, spies } = resolverMethods();
    spies.getMessages.mockRejectedValueOnce(new Error('read unavailable'));
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });

    await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).rejects.toMatchObject({
      code: 'QUEUED_TURN_PREPARATION_UNAVAILABLE',
      retryable: true,
      deferWithoutAttempt: true,
    });
    expect(spies.releaseAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-1',
        claimId: 'trigger-1',
        claimBy: 'worker-1',
        disposition: 'retry',
      }),
    );
  });

  it('keeps a failed preparation release retryable under the same claim fence', async () => {
    const { methods, spies } = resolverMethods();
    spies.getMessages.mockRejectedValueOnce(new Error('read unavailable'));
    spies.releaseAgentQueuedTurn.mockRejectedValueOnce(new Error('write unavailable'));
    const resolve = createAgentQueuedTurnResolver({
      methods,
      getGenerationJob: async () => null,
      now: () => NOW,
      claimBy: 'worker-1',
    });

    await expect(resolve(envelope(), { idempotencyKey: 'trigger-1' })).rejects.toMatchObject({
      code: 'QUEUED_TURN_PREPARATION_RELEASE_FAILED',
      retryable: true,
      deferWithoutAttempt: true,
    });
  });

  it('uses a replica-unique default claim owner that remains stable for the process', async () => {
    const first = resolverMethods();
    const second = resolverMethods();
    const firstResolve = createAgentQueuedTurnResolver({
      methods: first.methods,
      getGenerationJob: async () => null,
      now: () => NOW,
    });
    const secondResolve = createAgentQueuedTurnResolver({
      methods: second.methods,
      getGenerationJob: async () => null,
      now: () => NOW,
    });

    await firstResolve(envelope(), { idempotencyKey: 'trigger-1' });
    await secondResolve(envelope(), { idempotencyKey: 'trigger-1' });
    const firstOwner = first.spies.claimNextAgentQueuedTurn.mock.calls[0][0].claimBy;
    const secondOwner = second.spies.claimNextAgentQueuedTurn.mock.calls[0][0].claimBy;
    expect(firstOwner).toMatch(/^agent-queued-turn:\d+:[0-9a-f-]{36}$/);
    expect(secondOwner).toBe(firstOwner);
  });
});

describe('Agent queued-turn delivery scheduling', () => {
  it('can retry initialization after a transient index setup failure', async () => {
    const ensureAgentQueuedTurnIndexes = jest
      .fn()
      .mockRejectedValueOnce(new Error('mongo unavailable'))
      .mockResolvedValue(undefined);
    const scheduler = createAgentQueuedTurnScheduler({
      methods: {
        ensureAgentQueuedTurnIndexes,
        findQueuedTurnsNeedingDelivery: jest.fn(async () => []),
        claimQueuedTurnsForAdmissionReconciliation: jest.fn(async () => []),
      } as unknown as AgentQueuedTurnMethods,
      enqueue: jest.fn(),
      getGenerationAdmissionEvidence: async () => null,
    });
    await expect(scheduler.initialize()).rejects.toThrow('mongo unavailable');
    await expect(scheduler.initialize()).resolves.toBeUndefined();
    expect(ensureAgentQueuedTurnIndexes).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('does not back off when discovery repairs reservations but returns no deliveries', async () => {
    jest.useFakeTimers();
    const findQueuedTurnsNeedingDelivery = jest.fn(
      async (_limit: number, activity: { found: boolean }) => {
        activity.found = true;
        return [];
      },
    );
    const scheduler = createAgentQueuedTurnScheduler({
      methods: {
        ensureAgentQueuedTurnIndexes: jest.fn(async () => undefined),
        findQueuedTurnsNeedingDelivery,
        claimQueuedTurnsForAdmissionReconciliation: jest.fn(async () => []),
      } as unknown as AgentQueuedTurnMethods,
      enqueue: jest.fn(),
      getGenerationAdmissionEvidence: async () => null,
    });
    try {
      await scheduler.initialize();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(findQueuedTurnsNeedingDelivery).toHaveBeenCalledTimes(2);
    } finally {
      await scheduler.stop();
      jest.useRealTimers();
    }
  });

  it('waits for sibling lease discovery after an error before allowing shutdown or another scan', async () => {
    jest.useFakeTimers();
    let release!: (turns: AgentQueuedTurnRecord[]) => void;
    const findQueuedTurnsNeedingDelivery = jest
      .fn()
      .mockRejectedValue(new Error('mongo unavailable'));
    const claimQueuedTurnsForAdmissionReconciliation = jest.fn(
      () =>
        new Promise<AgentQueuedTurnRecord[]>((resolve) => {
          release = resolve;
        }),
    );
    const scheduler = createAgentQueuedTurnScheduler({
      methods: {
        ensureAgentQueuedTurnIndexes: jest.fn(async () => undefined),
        findQueuedTurnsNeedingDelivery,
        claimQueuedTurnsForAdmissionReconciliation,
      } as unknown as AgentQueuedTurnMethods,
      enqueue: jest.fn(),
      getGenerationAdmissionEvidence: async () => null,
    });
    try {
      const starting = scheduler.initialize();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(findQueuedTurnsNeedingDelivery).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      release([]);
      await Promise.all([starting, stopping]);
      expect(stopped).toBe(true);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(findQueuedTurnsNeedingDelivery).toHaveBeenCalledTimes(1);
      expect(claimQueuedTurnsForAdmissionReconciliation).toHaveBeenCalledTimes(1);
    } finally {
      await scheduler.stop();
      jest.useRealTimers();
    }
  });

  it('reduces empty Mongo discovery reads without losing bounded fallback polling', async () => {
    jest.useFakeTimers();
    try {
      const findQueuedTurnsNeedingDelivery = jest.fn(async () => []);
      const claimQueuedTurnsForAdmissionReconciliation = jest.fn(async () => []);
      const scheduler = createAgentQueuedTurnScheduler({
        methods: {
          ensureAgentQueuedTurnIndexes: jest.fn(async () => undefined),
          findQueuedTurnsNeedingDelivery,
          claimQueuedTurnsForAdmissionReconciliation,
        } as unknown as AgentQueuedTurnMethods,
        enqueue: jest.fn(),
        getGenerationAdmissionEvidence: async () => null,
      });
      await scheduler.initialize();
      expect(findQueuedTurnsNeedingDelivery).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(findQueuedTurnsNeedingDelivery).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(findQueuedTurnsNeedingDelivery).toHaveBeenCalledTimes(3);
      expect(claimQueuedTurnsForAdmissionReconciliation).toHaveBeenCalledTimes(3);
      await scheduler.stop();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(findQueuedTurnsNeedingDelivery).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not treat a deferred indeterminate admission as an empty queue', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    try {
      const turn = {
        ...queuedTurn('queued-turn-deferred', 1),
        status: 'dead' as const,
        deliveryKey: 'delivery-deferred',
        admissionId: 'delivery-deferred',
        admissionProtocolVersion: 2 as const,
        terminalReceipt: {
          outcome: 'dead' as const,
          settledAt: new Date(NOW),
          failure: { code: 'ADMISSION_INDETERMINATE', message: 'pending evidence' },
        },
      };
      const claimQueuedTurnsForAdmissionReconciliation = jest.fn(async (input) => [
        {
          ...turn,
          reconciliationClaimId: input.claimId,
          reconciliationClaimBy: input.claimBy,
        },
      ]);
      const deferAgentQueuedTurnAdmissionReconciliation = jest.fn(async () => true);
      const scheduler = createAgentQueuedTurnScheduler({
        methods: {
          ensureAgentQueuedTurnIndexes: jest.fn(async () => undefined),
          findQueuedTurnsNeedingDelivery: jest.fn(async () => []),
          claimQueuedTurnsForAdmissionReconciliation,
          deferAgentQueuedTurnAdmissionReconciliation,
        } as unknown as AgentQueuedTurnMethods,
        enqueue: jest.fn(),
        getGenerationAdmissionEvidence: async () => null,
      });
      await scheduler.initialize();
      expect(deferAgentQueuedTurnAdmissionReconciliation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(4_999);
      expect(claimQueuedTurnsForAdmissionReconciliation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(claimQueuedTurnsForAdmissionReconciliation).toHaveBeenCalledTimes(2);
      await scheduler.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('wakes recovery after direct publication fails outside its own recovery pass', async () => {
    jest.useFakeTimers();
    try {
      const findQueuedTurnsNeedingDelivery = jest.fn(async () => []);
      const scheduler = createAgentQueuedTurnScheduler({
        methods: {
          ensureAgentQueuedTurnIndexes: jest.fn(async () => undefined),
          findQueuedTurnsNeedingDelivery,
          claimQueuedTurnsForAdmissionReconciliation: jest.fn(async () => []),
          reserveAgentQueuedTurnDelivery: jest.fn(async () => {
            throw new Error('mongo unavailable');
          }),
        } as unknown as AgentQueuedTurnMethods,
        enqueue: jest.fn(),
        getGenerationAdmissionEvidence: async () => null,
      });
      await scheduler.initialize();
      await expect(scheduler.schedule(queuedTurn('queued-turn-1', 1))).rejects.toThrow(
        'mongo unavailable',
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(findQueuedTurnsNeedingDelivery).toHaveBeenCalledTimes(2);
      await scheduler.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  function queuedTurn(id: string, sequence: number): AgentQueuedTurnRecord {
    const { claimId: _claimId, claimBy: _claimBy, claimUntil: _claimUntil, ...record } = claim();
    return {
      ...record,
      queuedTurnId: id,
      sequence,
      status: 'queued',
    };
  }

  it('publishes approval snapshots only with their precommitted v2 identity', async () => {
    const input = { ...queuedTurn('seed', 1), codeApprovalMode: 'fullAccess' as const };
    const reservation = createQueuedTurnDeliveryReservation(input);
    const row = { ...input, ...reservation, deliveryState: 'publishing' as const };
    const reserve = jest.fn().mockResolvedValue({ outcome: 'already_reserved', turn: row });
    const enqueue = jest.fn(async (value: unknown) => ({
      deliveryKey: getAgentTriggerIdempotencyKey(value as AgentContinueTriggerEnvelope),
    }));
    const scheduler = createAgentQueuedTurnScheduler({
      methods: {
        reserveAgentQueuedTurnDelivery: reserve,
        markQueuedTurnScheduled: jest.fn(async () => ({ outcome: 'scheduled', turn: row })),
      } as unknown as AgentQueuedTurnMethods,
      enqueue,
      getGenerationAdmissionEvidence: async () => null,
    });
    await scheduler.schedule(row);
    expect(reserve).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveryKey: reservation.deliveryKey }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requiredWorkerCapability: 'agent_queued_turn_v2' }),
    );
    // An old worker computes the v1 identity from a projection lacking the mode.
    const { codeApprovalMode: _mode, ...legacyProjection } = row;
    reserve.mockResolvedValueOnce({ outcome: 'conflict', turn: row });
    await expect(scheduler.schedule(legacyProjection)).rejects.toThrow();
    expect(reserve.mock.calls[1]?.[0].deliveryKey).not.toBe(reservation.deliveryKey);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('uses independent delivery lanes so publication order cannot invert queue order', async () => {
    const enqueue = jest.fn(async (value: unknown) => ({
      deliveryKey: getAgentTriggerIdempotencyKey(value as AgentContinueTriggerEnvelope),
    }));
    const reserveAgentQueuedTurnDelivery = jest.fn(async (input) => ({
      outcome: 'reserved' as const,
      turn: { ...queuedTurn(input.queuedTurnId, 1), deliveryKey: input.deliveryKey },
    }));
    const markQueuedTurnScheduled = jest.fn(async (input) => ({
      outcome: 'scheduled' as const,
      turn: queuedTurn(input.queuedTurnId, 1),
    }));
    const scheduler = createAgentQueuedTurnScheduler({
      methods: {
        reserveAgentQueuedTurnDelivery,
        markQueuedTurnScheduled,
      } as unknown as AgentQueuedTurnMethods,
      enqueue,
      getGenerationAdmissionEvidence: async () => null,
    });

    await scheduler.schedule(queuedTurn('queued-turn-2', 2));
    await scheduler.schedule(queuedTurn('queued-turn-1', 1));

    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ orderingKey: 'agent-queued-turn-delivery:queued-turn-2' }),
    );
    expect(enqueue).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ orderingKey: 'agent-queued-turn-delivery:queued-turn-1' }),
    );
    expect(reserveAgentQueuedTurnDelivery).toHaveBeenCalledTimes(2);
    expect(reserveAgentQueuedTurnDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      enqueue.mock.invocationCallOrder[0],
    );
    expect(reserveAgentQueuedTurnDelivery.mock.calls[0]?.[0].deliveryKey).toBe(
      getAgentTriggerIdempotencyKey(enqueue.mock.calls[0]?.[0] as AgentContinueTriggerEnvelope),
    );
  });

  it('reconciles a claimed indeterminate legacy admission during durable recovery', async () => {
    const turn = {
      ...queuedTurn('queued-turn-indeterminate', 1),
      status: 'claimed' as const,
      deliveryKey: 'delivery-indeterminate',
      deliveryState: 'published' as const,
      admissionId: 'delivery-indeterminate',
      admissionStartedAt: new Date(NOW - 1_000),
      reconciliationClaimId: 'reconciliation-claim',
      reconciliationClaimBy: 'reconciler-1',
      terminalReceipt: {
        outcome: 'dead' as const,
        settledAt: new Date(NOW),
        failure: {
          code: 'ADMISSION_INDETERMINATE',
          message: 'The queued turn may have been admitted',
        },
      },
    };
    const deadLetterAgentQueuedTurn = jest.fn(async () => ({
      outcome: 'admission_reconciled' as const,
      turn: { ...turn, status: 'admitted' as const },
    }));
    const getGenerationAdmissionEvidence = jest.fn(async () => ({
      generationId: 'conversation-1',
      generationCreatedAt: NOW + 1,
    }));
    const scheduler = createAgentQueuedTurnScheduler({
      methods: {
        findQueuedTurnsNeedingDelivery: jest.fn(async () => []),
        claimQueuedTurnsForAdmissionReconciliation: jest.fn(async (input) => [
          {
            ...turn,
            reconciliationClaimId: input.claimId,
            reconciliationClaimBy: input.claimBy,
          },
        ]),
        deadLetterAgentQueuedTurn,
      } as unknown as AgentQueuedTurnMethods,
      enqueue: jest.fn(),
      getGenerationAdmissionEvidence,
    });

    await expect(scheduler.recover()).resolves.toBe(1);
    expect(getGenerationAdmissionEvidence).toHaveBeenCalledWith(
      USER_ID,
      'delivery-indeterminate',
      'conversation-1',
      'conversation-1',
    );
    expect(deadLetterAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-indeterminate',
        deliveryKey: 'delivery-indeterminate',
        admissionEvidence: {
          generationId: 'conversation-1',
          generationCreatedAt: NOW + 1,
        },
      }),
    );
  });

  it('rotates source-fenced ambiguity without trusting transient job-store evidence', async () => {
    const turn = {
      ...queuedTurn('queued-turn-source-fenced', 1),
      status: 'claimed' as const,
      deliveryKey: 'delivery-source-fenced',
      deliveryState: 'published' as const,
      admissionId: 'delivery-source-fenced',
      admissionStartedAt: new Date(NOW - 1_000),
      admissionProtocolVersion: 2 as const,
      terminalReceipt: {
        outcome: 'dead' as const,
        settledAt: new Date(NOW),
        failure: {
          code: 'ADMISSION_INDETERMINATE',
          message: 'The queued turn may have been admitted',
        },
      },
    };
    const deferAgentQueuedTurnAdmissionReconciliation = jest.fn(async () => true);
    const getGenerationAdmissionEvidence = jest.fn(async () => ({
      generationId: 'stale-generation',
      generationCreatedAt: NOW,
    }));
    const scheduler = createAgentQueuedTurnScheduler({
      methods: {
        findQueuedTurnsNeedingDelivery: jest.fn(async () => []),
        claimQueuedTurnsForAdmissionReconciliation: jest.fn(async (input) => [
          {
            ...turn,
            reconciliationClaimId: input.claimId,
            reconciliationClaimBy: input.claimBy,
          },
        ]),
        deferAgentQueuedTurnAdmissionReconciliation,
      } as unknown as AgentQueuedTurnMethods,
      enqueue: jest.fn(),
      getGenerationAdmissionEvidence,
    });

    await expect(scheduler.recover()).resolves.toBe(0);
    expect(getGenerationAdmissionEvidence).not.toHaveBeenCalled();
    expect(deferAgentQueuedTurnAdmissionReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-source-fenced',
        deliveryKey: 'delivery-source-fenced',
      }),
    );
  });

  it('quarantines an expired provider-admission owner before any replay', async () => {
    const turn = {
      ...queuedTurn('queued-turn-owner-lost', 1),
      status: 'claimed' as const,
      claimId: 'delivery-owner-lost',
      claimBy: 'worker-gone',
      claimUntil: new Date(NOW - 1),
      deliveryKey: 'delivery-owner-lost',
      deliveryState: 'published' as const,
      admissionId: 'delivery-owner-lost',
      admissionStartedAt: new Date(NOW - 1_000),
      admissionProtocolVersion: 2 as const,
    };
    const deadLetterAgentQueuedTurn = jest.fn(async () => ({
      outcome: 'admission_indeterminate' as const,
      turn: {
        ...turn,
        status: 'dead' as const,
        terminalReceipt: {
          outcome: 'dead' as const,
          settledAt: new Date(NOW),
          failure: { code: 'ADMISSION_INDETERMINATE', message: 'owner disappeared' },
        },
      },
    }));
    const getGenerationAdmissionEvidence = jest.fn(async () => null);
    const scheduler = createAgentQueuedTurnScheduler({
      methods: {
        findQueuedTurnsNeedingDelivery: jest.fn(async () => []),
        claimQueuedTurnsForAdmissionReconciliation: jest.fn(async (input) => [
          {
            ...turn,
            reconciliationClaimId: input.claimId,
            reconciliationClaimBy: input.claimBy,
          },
        ]),
        deadLetterAgentQueuedTurn,
      } as unknown as AgentQueuedTurnMethods,
      enqueue: jest.fn(),
      getGenerationAdmissionEvidence,
    });

    await expect(scheduler.recover()).resolves.toBe(1);
    expect(getGenerationAdmissionEvidence).not.toHaveBeenCalled();
    expect(deadLetterAgentQueuedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedTurnId: 'queued-turn-owner-lost',
        deliveryKey: 'delivery-owner-lost',
        failure: expect.objectContaining({ code: 'ADMISSION_INDETERMINATE' }),
      }),
    );
  });
});
