import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
} from '@librechat/data-schemas';
import type { AgentTriggerProducerLeaseStatus } from '@librechat/data-schemas';
import type { CodeApprovalMode } from 'librechat-data-provider';
import type { EnqueueBackgroundToolCompletion } from './backgroundCompletionWakeup';
import {
  BACKGROUND_TOOL_WAKEUP_INPUT_MAX_CHARS,
  createPendingBackgroundCompletions,
  createBackgroundToolCompletionWakeupHandler,
  createBackgroundToolCompletionWakeupResolver,
  createBackgroundToolDeadClaimRecovery,
} from './backgroundCompletionWakeup';
import { parseAgentTriggerEnvelope } from './triggers/envelope';

const NOW = Date.parse('2026-08-30T12:00:00Z');

function registration(overrides = {}) {
  return {
    taskId: 'task-1',
    toolCallId: 'call-1',
    toolName: 'slow_tool',
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    parentMessageId: 'response-1',
    parentAgentId: 'agent_parent_1',
    createdAt: NOW - 10,
    ...overrides,
  };
}

function envelope(registrationOverrides = {}) {
  let value: unknown;
  const notify = createBackgroundToolCompletionWakeupHandler(
    async (next) => {
      value = next;
      return { deliveryKey: 'delivery-key-1' };
    },
    async () => true,
    async () => true,
  );
  return notify(registration(registrationOverrides)).then(() => {
    const parsed = parseAgentTriggerEnvelope(value);
    if (parsed.mode !== 'continue') {
      throw new Error('Expected a continue envelope');
    }
    return parsed;
  });
}

function resolverMethods(codeApprovalMode?: CodeApprovalMode) {
  const releaseBackgroundToolResultClaims = jest.fn(async () => true);
  return {
    releaseBackgroundToolResultClaims,
    methods: {
      getConvo: jest.fn(async () => ({
        tenantId: 'tenant-1',
        ...(codeApprovalMode != null && { codeApprovalMode }),
      })),
      getMessages: jest.fn(async () => [
        {
          messageId: 'response-1',
          parentMessageId: 'user-1',
          isCreatedByUser: false,
          createdAt: new Date(NOW - 5),
        },
        {
          messageId: 'response-2',
          parentMessageId: 'response-1',
          isCreatedByUser: false,
          createdAt: new Date(NOW),
        },
      ]),
      claimBackgroundToolResults: jest.fn(async () => ({
        status: 'acquired',
        results: [
          {
            taskId: 'task-1',
            toolCallId: 'call-1',
            toolName: 'slow_tool',
            status: 'completed',
            output: 'done',
          },
          {
            taskId: 'task-2',
            toolCallId: 'call-2',
            toolName: 'other_tool',
            status: 'error',
            output: 'failed safely',
          },
        ],
      })),
      releaseBackgroundToolResultClaims,
      getAgentTriggerDeliveryProducerLease: jest.fn(
        async (): Promise<AgentTriggerProducerLeaseStatus> => ({
          status: 'live',
          leaseUntil: new Date(NOW + 30_000),
        }),
      ),
      getAgentBackgroundToolResult: jest.fn(async () => null),
      getAgentBackgroundToolResultClaim: jest.fn(async () => null),
      claimAgentBackgroundToolResults: jest.fn(async () => ({ status: 'not_ready' as const })),
      releaseAgentBackgroundToolResultClaims: jest.fn(async () => true),
    },
  };
}

describe('background tool completion wakeups', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('admits v3 receipts only when the deployment rollout gate is enabled', async () => {
    const enqueue = jest.fn<
      ReturnType<EnqueueBackgroundToolCompletion>,
      Parameters<EnqueueBackgroundToolCompletion>
    >(async () => ({ deliveryKey: 'key' }));
    let enabled = false;
    const notify = createBackgroundToolCompletionWakeupHandler(
      enqueue,
      async () => true,
      async () => true,
      undefined,
      undefined,
      () => enabled,
    );
    await notify(registration());
    expect(enqueue).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      }),
    );
    enabled = true;
    await notify(registration({ taskId: 'task-2' }));
    expect(enqueue).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
      }),
    );
  });

  it('expedites its own delivery when a result it can consume appears', async () => {
    const expedite = jest.fn();
    const notify = createBackgroundToolCompletionWakeupHandler(
      async () => ({ deliveryKey: 'delivery-key-1' }),
      async () => true,
      async () => true,
      undefined,
      expedite,
    );

    const admission = await notify(registration());
    if (admission === false) {
      throw new Error('Expected an admission');
    }
    admission.expedite?.();

    expect(expedite).toHaveBeenCalledWith('delivery-key-1');
  });

  it('pre-registers the exact task on the invoking response branch', async () => {
    const enqueue = jest.fn<
      ReturnType<EnqueueBackgroundToolCompletion>,
      Parameters<EnqueueBackgroundToolCompletion>
    >(async () => ({ deliveryKey: 'delivery-key-1' }));
    const retire = jest.fn(async () => true);
    const renew = jest.fn(async () => true);
    const persistResult = jest.fn(async () => true);
    const notify = createBackgroundToolCompletionWakeupHandler(
      enqueue,
      retire,
      renew,
      persistResult,
    );

    const admission = await notify(registration());
    expect(admission).not.toBe(false);

    const [value, options] = enqueue.mock.calls[0]!;
    expect(parseAgentTriggerEnvelope(value)).toMatchObject({
      deliveryId: 'task-1',
      principal: { userId: 'user-1', tenantId: 'tenant-1' },
      target: {
        agentId: 'agent_parent_1',
        conversationId: 'conversation-1',
        parentMessageId: 'response-1',
      },
      event: {
        type: 'background-tool.completion',
        source: { id: 'background-tool-completion', type: 'internal' },
        payload: { taskId: 'task-1', toolCallId: 'call-1', toolName: 'slow_tool' },
      },
    });
    expect(options).toEqual({
      orderingKey: 'background-tool-completion:conversation-1:task-1',
      availableAt: new Date(NOW + 250),
      requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      producerLeaseUntil: new Date(NOW + 30_000),
    });
    if (admission !== false) {
      await expect(admission.renew()).resolves.toBe(true);
    }
    expect(renew).toHaveBeenCalledWith(
      'delivery-key-1',
      'background-tool-completion',
      new Date(NOW + 30_000),
    );
    if (admission !== false) {
      await expect(
        admission.persistResult?.({
          status: 'completed',
          output: 'done',
          settledAt: new Date(NOW),
        }),
      ).resolves.toBe(true);
    }
    expect(persistResult).toHaveBeenCalledWith('delivery-key-1', 'background-tool-completion', {
      status: 'completed',
      output: 'done',
      settledAt: new Date(NOW),
    });
    if (admission !== false) {
      await expect(admission.retire('result unavailable')).resolves.toBe(true);
    }
    expect(retire).toHaveBeenCalledWith(
      'delivery-key-1',
      'background-tool-completion',
      'result unavailable',
    );
    if (admission !== false) {
      await expect(
        admission.retire('manual poll elected', { onlyIfUnclaimed: true }),
      ).resolves.toBe(true);
    }
    expect(retire).toHaveBeenLastCalledWith(
      'delivery-key-1',
      'background-tool-completion',
      'manual poll elected',
      { onlyIfUnclaimed: true },
    );
    if (admission !== false) {
      await expect(admission.retire('dead delivery recovered', { onlyIfDead: true })).resolves.toBe(
        true,
      );
    }
    expect(retire).toHaveBeenLastCalledWith(
      'delivery-key-1',
      'background-tool-completion',
      'dead delivery recovered',
      { onlyIfDead: true },
    );
  });

  it('retires the batch-root delivery before releasing all of its sibling claims', async () => {
    const retire = jest.fn(async () => true);
    const release = jest.fn(async () => true);
    const releaseReceipts = jest.fn(async () => true);
    const getGenerationJob = jest.fn(async () => ({ status: 'complete' }));
    const fenceGenerationClaim = jest.fn(async () => 'fenced' as const);
    const recover = createBackgroundToolDeadClaimRecovery(
      retire,
      release,
      getGenerationJob,
      fenceGenerationClaim,
      releaseReceipts,
    );

    await expect(
      recover({
        userId: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'response-1',
        claimId: 'batch-root-delivery',
      }),
    ).resolves.toBe(true);

    expect(retire).toHaveBeenCalledWith(
      'batch-root-delivery',
      'background-tool-completion',
      'dead background completion batch recovered by manual poll',
      { onlyIfDead: true },
    );
    expect(getGenerationJob).toHaveBeenCalledTimes(2);
    expect(getGenerationJob).toHaveBeenCalledWith('conversation-1');
    expect(fenceGenerationClaim).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'conversation-1',
      claimId: 'batch-root-delivery',
    });
    expect(release).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'response-1',
      allowMissingMessage: true,
      kind: 'wakeup',
      claimId: 'batch-root-delivery',
    });
    expect(releaseReceipts).toHaveBeenCalledWith({
      sourceId: 'background-tool-completion',
      userId: 'user-1',
      conversationId: 'conversation-1',
      parentMessageId: 'response-1',
      claimId: 'batch-root-delivery',
      recoveryFenced: true,
    });
  });

  it('keeps a manual result claim while its owning generation is active', async () => {
    const retire = jest.fn(async () => true);
    const release = jest.fn(async () => true);
    const getGenerationJob = jest.fn(async () => ({
      status: 'running',
      metadata: { responseMessageId: 'response-manual-owner' },
    }));
    const fenceGenerationClaim = jest.fn(async () => 'fenced' as const);
    const recover = createBackgroundToolDeadClaimRecovery(
      retire,
      release,
      getGenerationJob,
      fenceGenerationClaim,
    );

    await expect(
      recover({
        userId: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'response-result',
        claimId: 'manual-poll',
        kind: 'manual',
        generationId: 'response-manual-owner',
      }),
    ).resolves.toBe(false);

    expect(getGenerationJob).toHaveBeenCalledWith('conversation-1');
    expect(release).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(fenceGenerationClaim).not.toHaveBeenCalled();
  });

  it('releases a manual result claim after its owning generation is gone', async () => {
    const retire = jest.fn(async () => true);
    const release = jest.fn(async () => true);
    const getGenerationJob = jest.fn(async () => null);
    const fenceGenerationClaim = jest.fn(async () => 'fenced' as const);
    const recover = createBackgroundToolDeadClaimRecovery(
      retire,
      release,
      getGenerationJob,
      fenceGenerationClaim,
    );

    await expect(
      recover({
        userId: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'response-result',
        claimId: 'manual-poll',
        kind: 'manual',
        generationId: 'response-manual-owner',
      }),
    ).resolves.toBe(true);

    expect(release).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'response-result',
      kind: 'manual',
      claimId: 'manual-poll',
    });
    expect(retire).not.toHaveBeenCalled();
    expect(fenceGenerationClaim).not.toHaveBeenCalled();
  });

  it('does not recover a dead delivery while its admitted generation is still active', async () => {
    const retire = jest.fn(async () => true);
    const release = jest.fn(async () => true);
    const fenceGenerationClaim = jest.fn(async () => 'fenced' as const);
    const recover = createBackgroundToolDeadClaimRecovery(
      retire,
      release,
      async () => ({
        status: 'running',
        metadata: { idempotencyClientRequestId: 'batch-root-delivery' },
      }),
      fenceGenerationClaim,
    );

    await expect(
      recover({
        userId: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'response-1',
        claimId: 'batch-root-delivery',
      }),
    ).resolves.toBe(false);
    expect(retire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(fenceGenerationClaim).not.toHaveBeenCalled();
  });

  it('rechecks a generation published while its dead delivery is being retired', async () => {
    const retire = jest.fn(async () => true);
    const release = jest.fn(async () => true);
    const getGenerationJob = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        status: 'running',
        metadata: { idempotencyClientRequestId: 'batch-root-delivery' },
      })
      .mockResolvedValue({ status: 'complete' });
    const fenceGenerationClaim = jest
      .fn()
      .mockResolvedValueOnce('started' as const)
      .mockResolvedValueOnce('fenced' as const);
    const recover = createBackgroundToolDeadClaimRecovery(
      retire,
      release,
      getGenerationJob,
      fenceGenerationClaim,
    );
    const input = {
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'response-1',
      claimId: 'batch-root-delivery',
    };

    await expect(recover(input)).resolves.toBe(false);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    await expect(recover(input)).resolves.toBe(true);
    expect(retire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retries claim release through an idempotently retired recovery receipt', async () => {
    const retire = jest.fn(async () => true);
    const release = jest
      .fn()
      .mockRejectedValueOnce(new Error('release receipt lost'))
      .mockResolvedValueOnce(true);
    const recover = createBackgroundToolDeadClaimRecovery(
      retire,
      release,
      async () => ({
        status: 'complete',
      }),
      async () => 'fenced',
    );
    const input = {
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'response-1',
      claimId: 'batch-root-delivery',
    };

    await expect(recover(input)).rejects.toThrow('release receipt lost');
    await expect(recover(input)).resolves.toBe(true);
    expect(retire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("keeps unfinished sibling tasks out of each other's delivery lanes", async () => {
    const enqueue = jest.fn<
      ReturnType<EnqueueBackgroundToolCompletion>,
      Parameters<EnqueueBackgroundToolCompletion>
    >(async () => ({ deliveryKey: 'delivery-key' }));
    const notify = createBackgroundToolCompletionWakeupHandler(
      enqueue,
      async () => true,
      async () => true,
    );

    await notify(registration({ taskId: 'task-slow' }));
    await notify(registration({ taskId: 'task-fast' }));

    expect(enqueue.mock.calls.map(([, options]) => options?.orderingKey)).toEqual([
      'background-tool-completion:conversation-1:task-slow',
      'background-tool-completion:conversation-1:task-fast',
    ]);
  });

  it('reports skipped registration for an ephemeral invoking agent', async () => {
    const enqueue = jest.fn(async () => ({ deliveryKey: 'delivery-key-1' }));
    const retire = jest.fn(async () => true);
    const notify = createBackgroundToolCompletionWakeupHandler(enqueue, retire, async () => true);

    await expect(notify(registration({ parentAgentId: 'ephemeral-agent' }))).resolves.toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });

  describe.each(['projection', 'receipt', 'legacy receipt'] as const)(
    '%s approval context',
    (source) => {
      it.each([undefined, 'ask', 'acceptEdits', 'fullAccess'] as const)(
        'inherits the parent mode %s without granting broader access',
        async (mode) => {
          const { methods } = resolverMethods(mode);
          if (source !== 'projection') {
            methods.claimBackgroundToolResults.mockResolvedValue({
              status: 'not_ready',
              results: [],
            });
          }
          if (source === 'receipt') {
            methods.claimAgentBackgroundToolResults.mockResolvedValue({
              status: 'acquired',
              results: [
                {
                  taskId: 'task-1',
                  toolCallId: 'call-1',
                  toolName: 'slow_tool',
                  status: 'completed',
                  output: 'done',
                },
              ],
            } as never);
          }
          if (source === 'legacy receipt') {
            Reflect.deleteProperty(methods, 'claimAgentBackgroundToolResults');
            methods.getAgentBackgroundToolResult.mockResolvedValue({
              status: 'completed',
              output: 'done',
              settledAt: new Date(NOW),
            } as never);
          }
          const resolve = createBackgroundToolCompletionWakeupResolver({
            methods: methods as never,
            getGenerationJob: async () => null,
          });

          const prepared = await resolve(await envelope(), { idempotencyKey: 'delivery-1' });

          expect(prepared?.status).toBe('ready');
          expect(prepared?.status === 'ready' && prepared.codeApprovalMode).toBe(mode);
          expect(methods.getConvo).toHaveBeenCalledTimes(1);
          expect(methods.getConvo).toHaveBeenCalledWith('user-1', 'conversation-1');
        },
      );
    },
  );

  it('rereads the parent approval mode on a delivery retry', async () => {
    const { methods } = resolverMethods('fullAccess');
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    const delivery = await envelope();
    const first = await resolve(delivery, { idempotencyKey: 'delivery-1' });
    expect(first?.status === 'ready' && first.codeApprovalMode).toBe('fullAccess');

    methods.getConvo.mockResolvedValue({ tenantId: 'tenant-1', codeApprovalMode: 'ask' });
    const retry = await resolve(delivery, { idempotencyKey: 'delivery-1' });
    expect(retry?.status === 'ready' && retry.codeApprovalMode).toBe('ask');
  });

  it('claims a bounded sibling batch and continues from the latest branch leaf', async () => {
    const { methods } = resolverMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const prepared = await resolve(await envelope(), { idempotencyKey: 'delivery-1' });

    expect(prepared).toMatchObject({ status: 'ready', parentMessageId: 'response-2' });
    expect(prepared?.status === 'ready' && prepared.input).toContain('task-2');
    expect(methods.claimBackgroundToolResults).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'response-1',
        taskId: 'task-1',
        kind: 'wakeup',
        claimId: 'delivery-1',
      }),
    );
  });

  it('continues from the independent delivery receipt before the parent projection lands', async () => {
    const { methods } = resolverMethods();
    methods.claimBackgroundToolResults.mockResolvedValueOnce({ status: 'not_ready', results: [] });
    methods.claimAgentBackgroundToolResults.mockResolvedValueOnce({
      status: 'acquired',
      results: [
        {
          taskId: 'task-1',
          toolCallId: 'call-1',
          toolName: 'slow_tool',
          status: 'completed',
          output: 'independently durable',
        },
      ],
    } as never);
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const prepared = await resolve(await envelope(), { idempotencyKey: 'delivery-1' });

    expect(prepared).toMatchObject({ status: 'ready', parentMessageId: 'response-2' });
    expect(prepared?.status === 'ready' && prepared.input).toContain('independently durable');
    expect(methods.claimAgentBackgroundToolResults).toHaveBeenCalledWith({
      deliveryKey: 'delivery-1',
      sourceId: 'background-tool-completion',
      userId: 'user-1',
      conversationId: 'conversation-1',
      parentMessageId: 'response-1',
      agentId: 'agent_parent_1',
      claimId: 'delivery-1',
      limit: 1,
    });
    expect(methods.claimBackgroundToolResults).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', kind: 'wakeup', claimId: 'delivery-1' }),
    );
  });

  it('honors a manual message claim before an independent receipt', async () => {
    const { methods } = resolverMethods();
    methods.claimBackgroundToolResults.mockResolvedValueOnce({ status: 'claimed', results: [] });
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    await expect(resolve(await envelope(), { idempotencyKey: 'delivery-1' })).resolves.toEqual({
      status: 'settled',
    });
    expect(methods.claimAgentBackgroundToolResults).not.toHaveBeenCalled();
    expect(methods.getAgentBackgroundToolResult).not.toHaveBeenCalled();
  });

  it('does not settle a resumed receipt owner while a speculative manual message claim yields', async () => {
    const { methods } = resolverMethods();
    methods.claimBackgroundToolResults.mockResolvedValueOnce({ status: 'claimed', results: [] });
    methods.getAgentBackgroundToolResultClaim.mockResolvedValueOnce({
      kind: 'wakeup',
      claimId: 'delivery-1',
      claimedAt: new Date(NOW),
    } as never);
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    await expect(resolve(await envelope(), { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      {
        code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
        deferWithoutAttempt: true,
      },
    );
    expect(methods.releaseAgentBackgroundToolResultClaims).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'delivery-1' }),
    );
    expect(methods.releaseBackgroundToolResultClaims).not.toHaveBeenCalled();
  });

  it('retries after yielding to a racing manual claim so mutual yielding cannot lose output', async () => {
    const { methods } = resolverMethods();
    methods.claimBackgroundToolResults
      .mockResolvedValueOnce({ status: 'not_ready' } as never)
      .mockResolvedValueOnce({
        status: 'claimed',
        claim: { kind: 'manual', claimId: 'poll-1' },
      } as never);
    methods.claimAgentBackgroundToolResults.mockResolvedValueOnce({
      status: 'acquired',
      results: [
        {
          taskId: 'task-1',
          toolCallId: 'call-1',
          toolName: 'slow_tool',
          status: 'completed',
          output: 'durable',
        },
      ],
    } as never);
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    await expect(resolve(await envelope(), { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      {
        code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
        deferWithoutAttempt: true,
      },
    );
    expect(methods.releaseAgentBackgroundToolResultClaims).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'delivery-1', parentMessageId: 'response-1' }),
    );
  });

  it('shares one bounded input budget across a full sibling batch', async () => {
    const { methods } = resolverMethods();
    const results = Array.from({ length: 8 }, (_, index) => ({
      taskId: `task-${index}`,
      toolCallId: `call-${index}`,
      toolName: 'large_tool',
      status: 'completed' as const,
      output: `${index}:` + 'large result '.repeat(10_000),
    }));
    methods.claimBackgroundToolResults.mockResolvedValueOnce({ status: 'acquired', results });
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    const prepared = await resolve(await envelope(), { idempotencyKey: 'delivery-large' });

    expect(prepared?.status).toBe('ready');
    if (prepared?.status === 'ready') {
      expect(prepared.input.length).toBeLessThanOrEqual(BACKGROUND_TOOL_WAKEUP_INPUT_MAX_CHARS);
      for (const result of results) {
        expect(prepared.input).toContain(result.taskId);
      }
      expect(prepared.input).toContain('[truncated:');
    }
  });

  it('releases every claimed sibling when admission definitely fails', async () => {
    const { methods, releaseBackgroundToolResultClaims } = resolverMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    const prepared = await resolve(await envelope(), { idempotencyKey: 'delivery-1' });

    expect(prepared?.status).toBe('ready');
    if (prepared?.status === 'ready') {
      await prepared.releaseOnDefiniteFailure?.();
    }
    expect(releaseBackgroundToolResultClaims).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'delivery-1', kind: 'wakeup' }),
    );
    expect(releaseBackgroundToolResultClaims).toHaveBeenCalledWith(
      expect.not.objectContaining({ taskIds: expect.anything() }),
    );
  });

  it('passes the configured batch size and escaped metadata budget to the atomic claim', async () => {
    const { methods } = resolverMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
      getResultBatchSize: () => 16,
    });
    await resolve(await envelope(), { idempotencyKey: 'delivery-1' });
    expect(methods.claimBackgroundToolResults).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 16,
        maxMetadataChars: BACKGROUND_TOOL_WAKEUP_INPUT_MAX_CHARS - 256,
      }),
    );
  });

  it('releases projections acquired after receipt arbitration when admission fails', async () => {
    const { methods } = resolverMethods();
    methods.claimBackgroundToolResults.mockResolvedValueOnce({ status: 'not_ready', results: [] });
    methods.claimAgentBackgroundToolResults.mockResolvedValueOnce({
      status: 'acquired',
      results: [
        {
          taskId: 'task-1',
          toolCallId: 'call-1',
          toolName: 'slow_tool',
          status: 'completed',
          output: 'done',
        },
      ],
    } as never);
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    const prepared = await resolve(await envelope(), { idempotencyKey: 'delivery-1' });
    if (prepared?.status !== 'ready') throw new Error('Expected ready');
    await prepared.releaseOnDefiniteFailure?.();
    expect(methods.releaseBackgroundToolResultClaims).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'response-1',
      kind: 'wakeup',
      claimId: 'delivery-1',
    });
    expect(methods.releaseAgentBackgroundToolResultClaims).toHaveBeenCalled();
  });

  it('defers without claiming while the invoking generation is active', async () => {
    const { methods } = resolverMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => ({ status: 'running' }),
    });

    await expect(resolve(await envelope(), { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      {
        code: 'PARENT_NOT_READY',
        deferWithoutAttempt: true,
      },
    );
    expect(methods.claimBackgroundToolResults).not.toHaveBeenCalled();
  });

  it('backs off by waiting age while the invoking generation keeps running', async () => {
    const { methods } = resolverMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => ({ status: 'running' }),
    });
    const deliveryEnvelope = await envelope();

    jest.setSystemTime(NOW + 120_000);
    await expect(resolve(deliveryEnvelope, { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      { code: 'PARENT_NOT_READY', retryAfter: '12', deferWithoutAttempt: true },
    );
    jest.setSystemTime(NOW + 6 * 60 * 60_000);
    await expect(resolve(deliveryEnvelope, { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      { code: 'PARENT_NOT_READY', retryAfter: '60' },
    );
  });

  it('caps the waiting backoff at the configured interval', async () => {
    const { methods } = resolverMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => ({ status: 'running' }),
      getWaitMaxIntervalMs: () => 20_000,
    });
    const deliveryEnvelope = await envelope();

    jest.setSystemTime(NOW + 6 * 60 * 60_000);
    await expect(resolve(deliveryEnvelope, { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      { code: 'PARENT_NOT_READY', retryAfter: '20' },
    );
  });

  it('keeps backing off while the parent is paused for approval', async () => {
    const { methods } = resolverMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => ({ status: 'requires_action' }),
    });
    const deliveryEnvelope = await envelope();

    jest.setSystemTime(NOW + 60 * 60_000);
    await expect(resolve(deliveryEnvelope, { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      { code: 'PARENT_NOT_READY', retryAfter: '60' },
    );
  });

  it('re-checks within a second once the parent has settled and only persistence remains', async () => {
    const { methods } = resolverMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => ({
        status: 'complete',
        metadata: { terminalPersistencePending: true },
      }),
    });
    const deliveryEnvelope = await envelope();

    jest.setSystemTime(NOW + 10 * 60_000);
    await expect(resolve(deliveryEnvelope, { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      { code: 'PARENT_NOT_READY', retryAfter: '1' },
    );
  });

  it('backs off by waiting age while the tool result is not durable yet', async () => {
    const { methods } = resolverMethods();
    methods.claimBackgroundToolResults.mockResolvedValue({ status: 'missing', results: [] });
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    const deliveryEnvelope = await envelope();

    await expect(resolve(deliveryEnvelope, { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      { code: 'BACKGROUND_TOOL_RESULT_NOT_READY', retryAfter: '5' },
    );
    jest.setSystemTime(NOW + 5 * 60_000);
    await expect(resolve(deliveryEnvelope, { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      { code: 'BACKGROUND_TOOL_RESULT_NOT_READY', retryAfter: '30' },
    );
  });

  it('does not manufacture terminal evidence from wall-clock age', async () => {
    const { methods } = resolverMethods();
    methods.claimBackgroundToolResults.mockResolvedValue({ status: 'missing', results: [] });
    const deliveryEnvelope = await envelope({ createdAt: NOW - 7 * 24 * 60 * 60_000 });
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    await expect(resolve(deliveryEnvelope, { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      { code: 'BACKGROUND_TOOL_RESULT_NOT_READY', retryable: true },
    );
  });

  it('terminally rejects a missing result after its process-local producer is lost', async () => {
    const { methods } = resolverMethods();
    methods.claimBackgroundToolResults.mockResolvedValue({ status: 'missing', results: [] });
    methods.getAgentTriggerDeliveryProducerLease.mockResolvedValue({
      status: 'expired',
      leaseUntil: new Date(NOW - 1),
    });
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });

    await expect(resolve(await envelope(), { idempotencyKey: 'delivery-1' })).rejects.toMatchObject(
      {
        code: 'BACKGROUND_TOOL_PRODUCER_LOST',
        retryable: false,
      },
    );
  });
});

describe('pending background completions', () => {
  const dispatchedAt = new Date(NOW - 60_000);
  const settled = { status: 'completed' as const, settledAt: new Date(NOW) };
  const row = (overrides = {}) => ({
    deliveryKey: 'delivery-key-1',
    taskId: 'task-1',
    toolCallId: 'call-1',
    toolName: 'slow_tool',
    dispatchedAt,
    claimedByWakeup: false,
    ...overrides,
  });
  const listing = (completions: Array<ReturnType<typeof row>>, truncated = false) =>
    jest.fn(async () => ({ completions, dead: [row({ taskId: 'task-dead' })], truncated }));
  const listTaskIds = jest.fn(async () => ({ taskIds: ['child-1'], truncated: false }));

  it('lists the durable view for the owner without delivery internals', async () => {
    const list = listing([row({ result: settled })], true);
    const pending = createPendingBackgroundCompletions({ list, listTaskIds, retire: jest.fn() });

    await expect(
      pending.list({ userId: 'user-1', conversationId: 'conversation-1' }),
    ).resolves.toEqual({
      dead: [
        {
          taskId: 'task-dead',
          toolCallId: 'call-1',
          toolName: 'slow_tool',
          dispatchedAt,
          claimedByWakeup: false,
        },
      ],
      completions: [
        {
          taskId: 'task-1',
          toolCallId: 'call-1',
          toolName: 'slow_tool',
          dispatchedAt,
          result: settled,
          claimedByWakeup: false,
        },
      ],
      complete: false,
    });
    expect(list).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
      sourceId: 'background-tool-completion',
    });
  });

  it('discards a settled, unclaimed result by looking up that task and retiring it exactly', async () => {
    const retire = jest.fn(async () => true);
    const list = listing([row({ result: settled })]);
    const pending = createPendingBackgroundCompletions({ list, listTaskIds, retire });

    await expect(
      pending.discard({ userId: 'user-1', conversationId: 'conversation-1', taskId: 'task-1' }),
    ).resolves.toBe('discarded');
    expect(list).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
      sourceId: 'background-tool-completion',
      taskId: 'task-1',
    });
    expect(retire).toHaveBeenCalledWith(
      'delivery-key-1',
      'background-tool-completion',
      'background result discarded by its owner',
      { onlyIfUnclaimed: true, requireTransition: true },
    );
  });

  it("retires a manually claimed task's delivery only while no wake-up holds it", async () => {
    const retire = jest.fn(async () => true);
    const pending = createPendingBackgroundCompletions({
      list: listing([row({ result: settled })]),
      listTaskIds,
      retire,
    });

    await expect(
      pending.settleClaimed({
        userId: 'user-1',
        conversationId: 'conversation-1',
        taskId: 'task-1',
      }),
    ).resolves.toBe(true);
    expect(retire).toHaveBeenCalledWith(
      'delivery-key-1',
      'background-tool-completion',
      'completion claimed by manual poll',
      { onlyIfUnclaimed: true },
    );
    await expect(
      createPendingBackgroundCompletions({ list: listing([]), listTaskIds, retire }).settleClaimed({
        userId: 'user-1',
        conversationId: 'conversation-1',
        taskId: 'task-1',
      }),
    ).resolves.toBe(false);
  });

  it('lists undelivered subagent wake-ups from their own source', async () => {
    const pending = createPendingBackgroundCompletions({
      list: listing([]),
      listTaskIds,
      retire: jest.fn(),
    });

    await expect(
      pending.listSubagentWakeups({ userId: 'user-1', conversationId: 'conversation-1' }),
    ).resolves.toEqual({ taskIds: ['child-1'], complete: true });
    expect(listTaskIds).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
      sourceId: 'subagent-completion',
    });
  });

  it.each([
    ['not_pending', [], true],
    ['running', [row()], true],
    ['delivering', [row({ result: settled, claimedByWakeup: true })], true],
    ['delivering', [row({ result: settled })], false],
  ])('reports %s without discarding what it cannot', async (outcome, rows, retired) => {
    const retire = jest.fn(async () => retired);
    const pending = createPendingBackgroundCompletions({
      list: listing(rows),
      listTaskIds,
      retire,
    });

    await expect(
      pending.discard({ userId: 'user-1', conversationId: 'conversation-1', taskId: 'task-1' }),
    ).resolves.toBe(outcome);
    if (outcome !== 'delivering' || rows[0]?.claimedByWakeup === true) {
      expect(retire).not.toHaveBeenCalled();
    }
  });
});

it('fences an ordinary background wakeup queued before schedule enrollment', async () => {
  const { methods } = resolverMethods();
  const lookup = jest.fn(async () => ({
    identity: {
      scheduleId: 'schedule',
      ownerId: 'user-1',
      tenantId: 'tenant-1',
      agentId: 'agent_parent_1',
      invocationMode: 'delegated' as const,
    },
    enrolled: true,
  }));
  const prepare = createBackgroundToolCompletionWakeupResolver({
    methods: methods as never,
    getGenerationJob: async () => null,
    getScheduleMCPCompletionState: lookup,
  });
  await expect(
    prepare(await envelope({ scheduleMCPIdentity: (await lookup()).identity }), {
      idempotencyKey: 'wakeup',
    } as never),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  expect(lookup).toHaveBeenCalledWith((await lookup()).identity);
  expect(methods.claimBackgroundToolResults).not.toHaveBeenCalled();
});

describe('capability-gated receipt batch resolution', () => {
  function batchMethods() {
    const { methods } = resolverMethods();
    return {
      ...methods,
      claimAgentBackgroundToolResultBatch: jest.fn(async () => ({
        status: 'acquired' as const,
        batchId: 'batch-1',
        results: [
          {
            taskId: 'task-1',
            toolCallId: 'call-1',
            toolName: 'tool',
            status: 'completed' as const,
            output: 'one',
          },
          {
            taskId: 'task-2',
            toolCallId: 'call-2',
            toolName: 'tool',
            status: 'completed' as const,
            output: 'two',
          },
        ],
      })),
      beginAgentBackgroundToolResultBatchDispatch: jest.fn(async () => true),
      confirmAgentBackgroundToolResultBatch: jest.fn(async () => true),
    };
  }

  it.each([true, false])(
    'keeps schedule lineage before receipt batch admission (enrolled=%s)',
    async (enrolled) => {
      const methods = batchMethods();
      const identity = {
        scheduleId: 'schedule',
        ownerId: 'user-1',
        tenantId: 'tenant-1',
        agentId: 'agent_parent_1',
        invocationMode: 'delegated' as const,
      };
      const prepare = createBackgroundToolCompletionWakeupResolver({
        methods: methods as never,
        getGenerationJob: async () => null,
        getScheduleMCPCompletionState: async () => ({ identity, enrolled }),
      });
      const pending = prepare(await envelope({ scheduleMCPIdentity: identity }), {
        idempotencyKey: 'batch',
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
      });
      if (enrolled) {
        await expect(pending).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
        expect(methods.claimAgentBackgroundToolResultBatch).not.toHaveBeenCalled();
      } else
        await expect(pending).resolves.toMatchObject({
          status: 'ready',
          scheduleMCPIdentity: identity,
        });
    },
  );

  it('does not probe batch storage for rollout-default v2 deliveries', async () => {
    const methods = batchMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    await resolve(await envelope(), {
      idempotencyKey: 'delivery-1',
      requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
    });
    expect(methods.claimAgentBackgroundToolResultBatch).not.toHaveBeenCalled();
  });

  it('reconciles every member before dispatch and confirms only after admission', async () => {
    const methods = batchMethods();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    const prepared = await resolve(await envelope(), { idempotencyKey: 'delivery-1' });
    expect(methods.claimBackgroundToolResults).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ taskId: 'task-1' }),
    );
    expect(methods.claimBackgroundToolResults).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ taskId: 'task-2' }),
    );
    expect(methods.confirmAgentBackgroundToolResultBatch).not.toHaveBeenCalled();
    expect(methods.claimAgentBackgroundToolResultBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        limit: 8,
        maxMetadataChars: BACKGROUND_TOOL_WAKEUP_INPUT_MAX_CHARS - 256,
      }),
    );
    if (prepared?.status !== 'ready') throw new Error('Expected ready');
    expect(prepared.input).toContain('task-2');
    await prepared.settleOnAdmission?.({
      mode: 'continue',
      status: 'started',
      conversationId: 'conversation-1',
    });
    expect(methods.confirmAgentBackgroundToolResultBatch).toHaveBeenCalledTimes(1);
  });

  it('defers followers until the root has confirmed admission', async () => {
    const methods = batchMethods();
    methods.claimAgentBackgroundToolResultBatch
      .mockResolvedValueOnce({
        status: 'claimed',
        claimId: 'root',
        ownerStatus: 'pending',
      } as never)
      .mockResolvedValueOnce({
        status: 'claimed',
        claimId: 'root',
        ownerStatus: 'applied',
      } as never);
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    await expect(resolve(await envelope(), { idempotencyKey: 'follower' })).rejects.toMatchObject({
      code: 'BACKGROUND_TOOL_BATCH_PENDING',
      deferWithoutAttempt: true,
    });
    await expect(resolve(await envelope(), { idempotencyKey: 'follower' })).resolves.toEqual({
      status: 'settled',
    });
    expect(methods.claimBackgroundToolResults).not.toHaveBeenCalled();
  });

  it('uses fenced dead-owner recovery before retrying a follower as its own root', async () => {
    const methods = batchMethods();
    const recoverDeadClaim = jest.fn(async () => true);
    methods.claimAgentBackgroundToolResultBatch.mockResolvedValueOnce({
      status: 'claimed',
      claimId: 'root',
      ownerStatus: 'recoverable',
    } as never);
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
      recoverDeadClaim,
    });
    await expect(resolve(await envelope(), { idempotencyKey: 'follower' })).rejects.toMatchObject({
      code: 'BACKGROUND_TOOL_BATCH_PENDING',
    });
    expect(recoverDeadClaim).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'root', messageId: 'response-1' }),
    );
    expect((await resolve(await envelope(), { idempotencyKey: 'follower' }))?.status).toBe('ready');
  });

  it('releases the entire frozen batch when a sibling manual poll wins', async () => {
    const methods = batchMethods();
    methods.claimBackgroundToolResults
      .mockResolvedValueOnce({ status: 'acquired', results: [] })
      .mockResolvedValueOnce({
        status: 'claimed',
        claim: { kind: 'manual', claimId: 'poll' },
      } as never);
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    await expect(resolve(await envelope(), { idempotencyKey: 'root' })).rejects.toMatchObject({
      code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
    });
    expect(methods.releaseAgentBackgroundToolResultClaims).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'root' }),
    );
    expect(methods.confirmAgentBackgroundToolResultBatch).not.toHaveBeenCalled();
  });

  it('releases receipt ownership even when no message projection has landed', async () => {
    const methods = batchMethods();
    methods.claimBackgroundToolResults.mockResolvedValue({ status: 'not_found' } as never);
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    const prepared = await resolve(await envelope(), { idempotencyKey: 'root' });
    if (prepared?.status !== 'ready') throw new Error('Expected ready');
    await prepared.releaseOnDefiniteFailure?.();
    expect(methods.releaseBackgroundToolResultClaims).not.toHaveBeenCalled();
    expect(methods.releaseAgentBackgroundToolResultClaims).toHaveBeenCalled();
  });

  it('retains ownership when admission confirmation fails after dispatch', async () => {
    const methods = batchMethods();
    methods.confirmAgentBackgroundToolResultBatch.mockRejectedValueOnce(new Error('lost reply'));
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    const prepared = await resolve(await envelope(), { idempotencyKey: 'root' });
    if (prepared?.status !== 'ready') throw new Error('Expected ready');
    await expect(
      prepared.settleOnAdmission?.({
        mode: 'continue',
        status: 'started',
        conversationId: 'conversation-1',
      }),
    ).rejects.toThrow('lost reply');
    expect(methods.releaseAgentBackgroundToolResultClaims).not.toHaveBeenCalled();
  });

  it('still detects a lost producer while a v3 receipt is not ready', async () => {
    const methods = batchMethods();
    methods.claimBackgroundToolResults.mockResolvedValueOnce({ status: 'not_ready', results: [] });
    methods.claimAgentBackgroundToolResultBatch.mockResolvedValueOnce({
      status: 'not_ready',
      waitingForResult: true,
    } as never);
    methods.getAgentTriggerDeliveryProducerLease.mockResolvedValueOnce({
      status: 'expired',
      leaseUntil: new Date(0),
    });
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
    });
    await expect(resolve(await envelope(), { idempotencyKey: 'root' })).rejects.toMatchObject({
      code: 'BACKGROUND_TOOL_PRODUCER_LOST',
      retryable: false,
    });
  });
});

it.each([
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
])(
  'does not apply historical schedule authority to an ordinary background completion (%s)',
  async (capability) => {
    const { methods } = resolverMethods();
    const lookup = jest.fn(async () => {
      throw new Error('historical schedule must not be consulted');
    });
    const prepare = createBackgroundToolCompletionWakeupResolver({
      methods: methods as never,
      getGenerationJob: async () => null,
      getScheduleMCPCompletionState: lookup,
    });
    const prepared = await prepare(await envelope(), {
      idempotencyKey: 'ordinary',
      requiredWorkerCapability: capability,
    });
    expect(prepared).toMatchObject({ status: 'ready' });
    expect(prepared).not.toHaveProperty('scheduleMCPIdentity');
    expect(lookup).not.toHaveBeenCalled();
  },
);
