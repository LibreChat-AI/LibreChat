import type { AgentEventActorDetachedAction } from '@librechat/data-schemas';
import {
  createAgentEventActorDetachedActionLifecycle,
  createAgentEventDetachedResumeHandler,
} from '~/agents/triggers/detachedAction';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';

describe('GenerationJobManager terminal host actions', () => {
  let manager: GenerationJobManagerClass;
  let store: InMemoryJobStore;

  beforeEach(() => {
    manager = new GenerationJobManagerClass();
    store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it.each(['ordinary', 'detached'])(
    'all deletion callers discover %s terminal host actions outside owner membership',
    async (lane) => {
      const job = await manager.createJob('pending-host', 'user-1', 'conversation');
      await store.transitionStatus('pending-host', {
        from: 'running',
        to: 'complete',
        expectCreatedAt: job.createdAt,
        patch: { completedAt: Date.now(), providerDrained: true, terminalHostActionPending: true },
      });
      Object.assign(store, { getCleanupJobIdsByUser: undefined });
      const terminal = (await store.getJob('pending-host'))!;
      jest.spyOn(store, 'getRetainedJobIdsByUser').mockResolvedValue([]);
      const rows = [
        terminal,
        { ...terminal, streamId: 'foreign-user', userId: 'user-2' },
        { ...terminal, streamId: 'foreign-tenant', tenantId: 'tenant-b' },
      ];
      jest
        .spyOn(store, 'getTerminalHostActionJobs')
        .mockResolvedValue(lane === 'ordinary' ? rows : []);
      Object.assign(store, {
        getDetachedAgentEventTerminalHostActionJobs: jest
          .fn()
          .mockResolvedValue(lane === 'detached' ? rows : []),
      });
      expect(await manager.getAccountCleanupJobIdsForUser('user-1', 'tenant-a')).toEqual([
        'pending-host',
      ]);
      expect(await manager.getCleanupBlockingJobIdsForUser('user-1', 'tenant-a')).toEqual([
        'pending-host',
      ]);
      expect(
        await manager.getCleanupBlockingJobIdsForConversations(
          'user-1',
          ['conversation'],
          'tenant-a',
        ),
      ).toEqual(['pending-host']);
      expect(
        await manager.getCleanupBlockingJobIdsForConversations('user-1', ['unrelated'], 'tenant-a'),
      ).toEqual([]);
      expect((await manager.getJob('pending-host'))?.metadata?.terminalHostActionPending).toBe(
        true,
      );
    },
  );

  it('owner queries retain terminal obligations through active polling without global scans', async () => {
    const job = await manager.createJob('owner-host', 'user-1', 'conversation');
    await store.transitionStatus('owner-host', {
      from: 'running',
      to: 'complete',
      expectCreatedAt: job.createdAt,
      patch: { completedAt: Date.now(), providerDrained: true, terminalHostActionPending: true },
    });
    const global = jest.spyOn(store, 'getTerminalHostActionJobs');
    expect(await manager.getActiveJobIdsForUser('user-1')).toEqual([]);
    expect(await manager.getCleanupBlockingJobIdsForUser('user-1')).toEqual(['owner-host']);
    expect(global).not.toHaveBeenCalled();
    await store.clearTerminalHostAction('owner-host', job.createdAt);
    expect(await manager.getCleanupBlockingJobIdsForUser('user-1')).toEqual([]);
  });

  it('durable cleanup preserves stale terminal-persistence recovery', async () => {
    const job = await manager.createJob('stale-persistence', 'user-1', 'conversation');
    await store.transitionStatus('stale-persistence', {
      from: 'running',
      to: 'complete',
      expectCreatedAt: job.createdAt,
      patch: { completedAt: 1, terminalPersistenceStartedAt: 1, terminalPersistencePending: true },
    });
    expect(await manager.getCleanupJob('stale-persistence')).toMatchObject({
      createdAt: job.createdAt,
      metadata: { terminalPersistencePending: false },
    });
  });

  it('durable cleanup still sees a replacement when runtime attachment loses its epoch', async () => {
    const first = await store.createJob('remote', 'user-1', 'conversation');
    const read = store.getJob.bind(store);
    const replacement = await store.createJob('remote', 'user-1', 'conversation');
    jest.spyOn(store, 'getJob').mockResolvedValueOnce(first).mockImplementation(read);
    expect(await manager.getJob('remote')).toBeUndefined();
    expect(await manager.getCleanupJob('remote')).toMatchObject({
      createdAt: replacement.createdAt,
      status: 'running',
      metadata: { userId: 'user-1' },
    });
  });

  it('verifies detached terminal outbox persistence against the exact generation', async () => {
    const streamId = 'conversation-detached-outbox';
    const job = await manager.createJob(streamId, 'user-1', streamId);
    const evidence = {
      version: 1 as const,
      deliveryKey: 'trigger-outbox',
      generationCreatedAt: job.createdAt,
      taskId: 'task-outbox',
      idempotencyKey: 'a'.repeat(64),
      status: 'succeeded' as const,
      result: 'accepted',
      observedAt: job.createdAt + 1,
    };

    await expect(
      manager.persistAgentEventDetachedTerminalEvidence(streamId, job.createdAt, evidence),
    ).resolves.toBe(true);
    await expect(store.getJob(streamId)).resolves.toMatchObject({
      agentEventDetachedTerminalEvidence: evidence,
    });

    const replacement = await store.createJob(streamId, 'user-1', streamId);
    expect(replacement.createdAt).not.toBe(job.createdAt);
    await expect(
      manager.persistAgentEventDetachedTerminalEvidence(streamId, job.createdAt, evidence),
    ).resolves.toBe(false);
    await expect(store.getJob(streamId)).resolves.not.toHaveProperty(
      'agentEventDetachedTerminalEvidence',
    );
  });

  it('runs detached launch, completion, and continuation through the in-memory adapter', async () => {
    const streamId = 'conversation-memory-detached-action';
    const invocationId = 'trigger-memory-detached-action';
    const enqueueContinuation = jest.fn().mockResolvedValue(undefined);
    let action: AgentEventActorDetachedAction = {
      version: 1 as const,
      invocationId,
      expectedToolName: 'submit_move',
      toolName: 'submit_move',
      toolCallId: 'call-memory-detached-action',
      turnId: 'response-memory:0',
      taskId: `event_actor_${'a'.repeat(64)}`,
      idempotencyKey: 'a'.repeat(64),
      launchAttempt: 1,
      status: 'reserved',
      reservedAt: new Date(),
      observedAt: new Date(),
      recoveryAfter: new Date(Date.now() + 60_000),
    };
    const resumeDetachedAction = createAgentEventDetachedResumeHandler({
      getAgentTriggerDelivery: jest.fn().mockResolvedValue({
        user: 'user-1',
        envelope: {
          mode: 'continue',
          principal: { userId: 'user-1' },
          target: {
            agentId: 'agent-1',
            bindingId: 'binding-1',
            conversationId: streamId,
            parentMessageId: 'message-1',
            sourceKeyId: 'source-key-1',
          },
          expectedAction: { toolName: 'submit_move' },
        },
      }),
      enqueueAgentTrigger: enqueueContinuation,
      requestId: () => 'memory-detached-continuation',
    });
    manager.setTerminalHostActionHandler(async (_streamId, job) => {
      if (action.status !== 'succeeded') {
        throw new Error('detached action is still running');
      }
      await resumeDetachedAction({
        streamId,
        job,
        handlingGenerationCreatedAt: job.createdAt,
        suspension: {} as never,
        action,
      });
    });
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: {
        agentEventDeliveryKey: invocationId,
        agentEventBindingId: 'binding-1',
        agentEventExpectedAction: { toolName: 'submit_move' },
      },
    });
    const lifecycle = createAgentEventActorDetachedActionLifecycle(
      {
        user: 'user-1',
        bindingId: 'binding-1',
        conversationId: streamId,
        generationCreatedAt: job.createdAt,
        turnCreatedAt: job.createdAt,
        invocationId,
        expectedAction: { toolName: 'submit_move' },
      },
      {
        storeMode: () => manager.detachedAgentEventActionStoreMode,
        reserveAgentEventActorDetachedAction: jest.fn(async () => ({
          status: 'reserved' as const,
          action,
        })),
        markAgentEventActorDetachedActionRunning: jest.fn(async () => {
          action = { ...action, status: 'running', observedAt: new Date() };
          return { status: 'applied' as const, action };
        }),
        settleAgentEventActorDetachedAction: jest.fn(async (input) => {
          action = {
            ...action,
            status: 'succeeded',
            result: input.result,
            observedAt: input.observedAt,
          };
          return { status: 'applied' as const, action };
        }),
        persistTerminalEvidence: async (evidence) => {
          const persisted = await manager.persistAgentEventDetachedTerminalEvidence(
            streamId,
            job.createdAt,
            evidence,
          );
          if (!persisted) {
            throw new Error('failed to stage detached terminal evidence');
          }
        },
        onTerminal: async () => {
          await manager.retryTerminalHostAction(streamId, job.createdAt);
        },
      },
    );

    expect(manager.detachedAgentEventActionStoreMode).toBe('process_local');
    await expect(
      lifecycle.reserve({
        toolName: 'submit_move',
        toolCallId: action.toolCallId,
        turnId: action.turnId,
        arguments: {},
      }),
    ).resolves.toMatchObject({ status: 'reserved', taskId: action.taskId });
    await expect(
      lifecycle.markRunning({ taskId: action.taskId, idempotencyKey: action.idempotencyKey }),
    ).resolves.toBe(true);
    expect(lifecycle.readSuspension()).toMatchObject({
      kind: 'internal_completion',
      actionId: action.taskId,
    });

    await expect(manager.completeJob(streamId, undefined, job.createdAt)).resolves.toBe(true);
    expect(enqueueContinuation).not.toHaveBeenCalled();
    await expect(store.getJob(streamId)).resolves.toMatchObject({
      terminalHostActionPending: true,
    });

    await expect(
      lifecycle.settle({
        taskId: action.taskId,
        idempotencyKey: action.idempotencyKey,
        status: 'succeeded',
        result: 'move accepted',
      }),
    ).resolves.toBe(true);
    await lifecycle.wake({ taskId: action.taskId, idempotencyKey: action.idempotencyKey });

    expect(enqueueContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'continue',
        deliveryId: `detached_completion:${action.taskId}`,
        event: expect.objectContaining({
          type: 'librechat.event_actor.detached_completion',
          payload: expect.objectContaining({ invocationId, taskId: action.taskId }),
        }),
      }),
      { requiredWorkerCapability: 'event_actor_detached_action_v1' },
    );
    await expect(store.getJob(streamId)).resolves.not.toHaveProperty('terminalHostActionPending');
  });

  it('runs and acknowledges a generation-fenced host action before terminal cleanup', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const job = await manager.createJob('conversation-1', 'user-1', 'conversation-1', {
      initialMetadata: {
        agentEventDeliveryKey: 'trigger_1',
        agentEventExpectedAction: { toolName: 'submit_move' },
      },
    });
    await manager.emitChunk('conversation-1', {
      event: 'on_run_step',
      data: {
        id: 'step-1',
        index: 0,
        type: 'tool_calls',
        status: 'in_progress',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-1', name: 'submit_move', args: { gameId: 'game-1' } }],
        },
      },
    });
    await manager.emitChunk('conversation-1', {
      event: 'on_run_step_completed',
      data: {
        result: {
          id: 'step-1',
          index: 0,
          type: 'tool_call',
          tool_call: { id: 'call-1', name: 'submit_move', output: 'ok' },
        },
      },
    });

    await expect(manager.completeJob('conversation-1', undefined, job.createdAt)).resolves.toBe(
      true,
    );

    expect(handler).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        createdAt: job.createdAt,
        agentEventDeliveryKey: 'trigger_1',
        status: 'complete',
      }),
      [
        expect.objectContaining({
          id: 'step-1',
          status: 'completed',
          stepDetails: expect.objectContaining({
            tool_calls: [
              expect.objectContaining({
                id: 'call-1',
                args: { gameId: 'game-1' },
                output: 'ok',
              }),
            ],
          }),
        }),
      ],
      expect.any(Array),
    );
    await expect(store.getJob('conversation-1')).resolves.not.toHaveProperty(
      'terminalHostActionPending',
    );
  });

  it('retries an exact pending terminal host action when late evidence arrives', async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('detached action is still running'))
      .mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const streamId = 'conversation-late-terminal-evidence';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { agentEventDeliveryKey: 'trigger-late-evidence' },
    });

    await expect(manager.completeJob(streamId, undefined, job.createdAt)).resolves.toBe(true);
    await expect(store.getJob(streamId)).resolves.toMatchObject({
      terminalHostActionPending: true,
    });

    await expect(manager.retryTerminalHostAction(streamId, job.createdAt + 1)).resolves.toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(manager.retryTerminalHostAction(streamId, job.createdAt)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
    await expect(store.getJob(streamId)).resolves.not.toHaveProperty('terminalHostActionPending');
  });

  it('waits for the provider evidence fence and retains a failed tool close', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const streamId = 'conversation-provider-evidence';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: {
        agentEventDeliveryKey: 'trigger_provider_evidence',
      },
    });
    const providerExecutionId = job.metadata.providerExecutionId!;
    await expect(
      manager.beginProviderExecution(streamId, job.createdAt, providerExecutionId),
    ).resolves.toBe(true);
    await manager.emitChunk(streamId, {
      event: 'on_run_step',
      data: {
        id: 'step-failed',
        index: 0,
        type: 'tool_calls',
        status: 'in_progress',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-failed', name: 'submit_move', args: {} }],
        },
      },
    });
    await manager.emitChunk(streamId, {
      event: 'on_run_step_completed',
      data: {
        result: {
          id: 'step-failed',
          index: 0,
          type: 'tool_call',
          tool_call: {
            id: 'call-failed',
            name: 'submit_move',
            output: 'Error: [submit_move] tool call failed: unavailable',
          },
        },
      },
    });
    await manager.emitChunk(streamId, {
      event: 'on_run_step_closed',
      data: {
        id: 'step-failed',
        index: 0,
        type: 'tool_calls',
        status: 'failed',
        closed_at: Date.now(),
      },
    });

    await expect(manager.completeJob(streamId, undefined, job.createdAt)).resolves.toBe(true);
    expect(handler).not.toHaveBeenCalled();
    await expect(store.getJob(streamId)).resolves.toMatchObject({
      providerDrained: false,
      terminalHostActionPending: true,
    });

    await expect(
      manager.markProviderExecutionDrained(streamId, job.createdAt, providerExecutionId),
    ).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({ providerDrained: true }),
      [
        expect.objectContaining({
          id: 'step-failed',
          status: 'failed',
          stepDetails: expect.objectContaining({
            tool_calls: [expect.objectContaining({ executionStatus: 'error' })],
          }),
        }),
      ],
      expect.any(Array),
    );
    await expect(store.getJob(streamId)).resolves.not.toHaveProperty('terminalHostActionPending');
  });

  it('routes a post-drain approval expiry through the schedule-specific hook', async () => {
    const approvalHandler = jest.fn().mockResolvedValue(undefined);
    const genericHandler = jest.fn().mockResolvedValue(undefined);
    manager.setApprovalExpiredHandler(approvalHandler);
    manager.setTerminalHostActionHandler(genericHandler);
    const streamId = 'conversation-expired-approval-drain';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { scheduleId: 'schedule-1' },
    });
    const providerExecutionId = job.metadata.providerExecutionId!;
    await manager.beginProviderExecution(streamId, job.createdAt, providerExecutionId);
    await expect(
      store.transitionStatus(streamId, {
        from: 'running',
        to: 'aborted',
        expectCreatedAt: job.createdAt,
        patch: {
          completedAt: Date.now(),
          error: 'Approval expired before a decision was made',
          terminalHostActionPending: true,
        },
      }),
    ).resolves.toBe(true);

    await manager.markProviderExecutionDrained(streamId, job.createdAt, providerExecutionId);

    expect(approvalHandler).toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({ scheduleId: 'schedule-1', providerDrained: true }),
    );
    expect(genericHandler).not.toHaveBeenCalled();
    await expect(store.getJob(streamId)).resolves.not.toHaveProperty('terminalHostActionPending');
  });

  it('recovers a terminal host action after its provider owner is lost', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const handler = jest.fn().mockResolvedValue(undefined);
      manager.setTerminalHostActionHandler(handler);
      const streamId = 'conversation-lost-provider-owner';
      const job = await manager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { agentEventDeliveryKey: 'trigger_lost_provider' },
      });
      await manager.beginProviderExecution(
        streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      );
      await manager.completeJob(streamId, undefined, job.createdAt);
      expect(handler).not.toHaveBeenCalled();

      now.mockReturnValue(40_001);
      await (
        manager as unknown as { expireStaleApprovals: () => Promise<void> }
      ).expireStaleApprovals();

      expect(handler).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({ providerDrained: true }),
        expect.any(Array),
        expect.any(Array),
      );
      await expect(store.getJob(streamId)).resolves.not.toHaveProperty('terminalHostActionPending');
    } finally {
      now.mockRestore();
    }
  });

  it('serializes run-step snapshots so an earlier write cannot erase completion evidence', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const streamId = 'conversation-run-step-order';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { agentEventDeliveryKey: 'trigger_run_step_order' },
    });
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writes: Array<Array<{ status?: string }>> = [];
    Object.assign(store, { saveRunSteps: jest.fn() });
    jest
      .spyOn(store as InMemoryJobStore & { saveRunSteps: jest.Mock }, 'saveRunSteps')
      .mockImplementation(async (_id, steps) => {
        writes.push(structuredClone(steps));
        if (writes.length === 1) {
          await firstWrite;
        }
      });

    await manager.emitChunk(streamId, {
      event: 'on_run_step',
      data: {
        id: 'step-ordered',
        index: 0,
        type: 'tool_calls',
        status: 'in_progress',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-ordered', name: 'submit_move', args: {} }],
        },
      },
    });
    await manager.emitChunk(streamId, {
      event: 'on_run_step_completed',
      data: {
        result: {
          id: 'step-ordered',
          index: 0,
          type: 'tool_call',
          tool_call: { id: 'call-ordered', name: 'submit_move', output: 'ok' },
        },
      },
    });

    const completing = manager.completeJob(streamId, undefined, job.createdAt);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handler).not.toHaveBeenCalled();
    releaseFirstWrite?.();
    await expect(completing).resolves.toBe(true);

    expect(writes[writes.length - 1]).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retains a failed host action and lets a later cleanup owner retry it', async () => {
    manager.setTerminalHostActionHandler(jest.fn().mockRejectedValue(new Error('mongo down')));
    const job = await manager.createJob('conversation-2', 'user-1', 'conversation-2', {
      initialMetadata: {
        agentEventDeliveryKey: 'trigger_2',
        agentEventExpectedAction: { toolName: 'submit_move' },
      },
    });
    await manager.emitChunk('conversation-2', {
      event: 'on_run_step_completed',
      data: {
        result: {
          id: 'step-2',
          index: 0,
          type: 'tool_calls',
          status: 'completed',
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: 'call-2', name: 'submit_move', output: 'ok' }],
          },
        },
      },
    });
    await manager.completeJob('conversation-2', undefined, job.createdAt);
    await expect(store.getJob('conversation-2')).resolves.toMatchObject({
      terminalHostActionPending: true,
    });

    const recovered = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(recovered);
    await (
      manager as unknown as {
        cleanup: () => Promise<void>;
      }
    ).cleanup();

    expect(recovered).toHaveBeenCalledWith(
      'conversation-2',
      expect.objectContaining({ createdAt: job.createdAt, agentEventDeliveryKey: 'trigger_2' }),
      [expect.objectContaining({ id: 'step-2', status: 'completed' })],
      expect.any(Array),
    );
    await expect(store.getJob('conversation-2')).resolves.not.toHaveProperty(
      'terminalHostActionPending',
    );
  });

  it('recovers detached completion jobs from the capability-isolated terminal lane', async () => {
    const streamId = 'conversation-detached-terminal-lane';
    const invocationKey = 'trigger-original-invocation';
    const completionDeliveryKey = 'trigger-internal-completion';
    const invocationGenerationCreatedAt = 42;
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: {
        agentEventDeliveryKey: completionDeliveryKey,
        agentEventInvocationKey: invocationKey,
        agentEventInvocationGenerationCreatedAt: invocationGenerationCreatedAt,
      },
    });
    await store.transitionStatus(streamId, {
      from: 'running',
      to: 'complete',
      expectCreatedAt: job.createdAt,
      patch: { completedAt: Date.now(), terminalHostActionPending: true },
    });
    const terminalJob = (await store.getJob(streamId))!;
    jest.spyOn(store, 'getTerminalHostActionJobs').mockResolvedValue([]);
    Object.assign(store, {
      getDetachedAgentEventTerminalHostActionJobs: jest.fn().mockResolvedValue([terminalJob]),
    });
    const handler = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);

    await (manager as unknown as { cleanup: () => Promise<void> }).cleanup();

    expect(handler).toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({
        agentEventDeliveryKey: completionDeliveryKey,
        agentEventInvocationKey: invocationKey,
        agentEventInvocationGenerationCreatedAt: invocationGenerationCreatedAt,
      }),
      expect.any(Array),
      expect.any(Array),
    );
    await expect(store.getJob(streamId)).resolves.not.toHaveProperty('terminalHostActionPending');
  });

  it('retains completed run-step evidence through repeated host-action failures', async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockRejectedValueOnce(new Error('mongo still down'))
      .mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const job = await manager.createJob('conversation-retry', 'user-1', 'conversation-retry', {
      initialMetadata: { agentEventDeliveryKey: 'trigger_retry' },
    });
    await manager.emitChunk('conversation-retry', {
      event: 'on_run_step_completed',
      data: {
        result: {
          id: 'step-retry',
          index: 0,
          type: 'tool_calls',
          status: 'completed',
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: 'call-retry', name: 'submit_move', output: 'ok' }],
          },
        },
      },
    });
    await manager.completeJob('conversation-retry', undefined, job.createdAt);

    const cleanup = () =>
      (
        manager as unknown as {
          cleanup: () => Promise<void>;
        }
      ).cleanup();
    await cleanup();
    await expect(store.getJob('conversation-retry')).resolves.toMatchObject({
      terminalHostActionPending: true,
    });

    await cleanup();

    expect(handler).toHaveBeenLastCalledWith(
      'conversation-retry',
      expect.objectContaining({ agentEventDeliveryKey: 'trigger_retry' }),
      [expect.objectContaining({ id: 'step-retry', status: 'completed' })],
      expect.any(Array),
    );
    await expect(store.getJob('conversation-retry')).resolves.not.toHaveProperty(
      'terminalHostActionPending',
    );
  });

  it('does not let a stale buffered step replace completed durable evidence', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const streamId = 'conversation-completed-evidence';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { agentEventDeliveryKey: 'trigger_completed' },
    });
    const completedStep = {
      id: 'step-shared',
      index: 0,
      type: 'tool_calls',
      status: 'completed',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call-shared', name: 'submit_move', output: 'ok' }],
      },
    };
    store.setGraph(streamId, { contentData: [completedStep] } as never, job.createdAt);
    await manager.emitChunk(streamId, {
      event: 'on_run_step',
      data: { ...completedStep, status: 'in_progress' },
    });

    await manager.completeJob(streamId, undefined, job.createdAt);

    expect(handler).toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({ agentEventDeliveryKey: 'trigger_completed' }),
      [expect.objectContaining({ id: 'step-shared', status: 'completed' })],
      expect.any(Array),
    );
  });

  it('marks an aborted event generation for terminal handling', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const job = await manager.createJob('conversation-3', 'user-1', 'conversation-3', {
      initialMetadata: { agentEventDeliveryKey: 'trigger_3' },
    });

    await expect(
      manager.abortJob('conversation-3', { expectedCreatedAt: job.createdAt }),
    ).resolves.toMatchObject({ success: true });

    expect(handler).toHaveBeenCalledWith(
      'conversation-3',
      expect.objectContaining({
        createdAt: job.createdAt,
        agentEventDeliveryKey: 'trigger_3',
        status: 'aborted',
      }),
      [],
      expect.any(Array),
    );
    await expect(store.getJob('conversation-3')).resolves.not.toHaveProperty(
      'terminalHostActionPending',
    );
  });

  it('settles a bound generation when graceful shutdown terminalizes it', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const streamId = 'conversation-shutdown';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { agentEventDeliveryKey: 'trigger_shutdown' },
    });

    await (
      manager as unknown as { finalizeOwnedJobsForShutdown: () => Promise<void> }
    ).finalizeOwnedJobsForShutdown();

    expect(handler).toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({
        createdAt: job.createdAt,
        agentEventDeliveryKey: 'trigger_shutdown',
        status: 'error',
      }),
      [],
      expect.any(Array),
    );
    await expect(store.getJob(streamId)).resolves.not.toHaveProperty('terminalHostActionPending');
  });

  it('settles a bound generation when pause persistence times out', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const handler = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const streamId = 'conversation-pause-timeout';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { agentEventDeliveryKey: 'trigger_pause_timeout' },
    });
    const action = buildPendingAction(
      buildToolApprovalPayload([
        { name: 'submit_move', arguments: { gameId: 'game-1' }, tool_call_id: 'call-1' },
      ]),
      { streamId, conversationId: streamId },
    );
    await expect(
      manager.approvals.pause(streamId, action, {
        expectedCreatedAt: job.createdAt,
        persistencePending: true,
      }),
    ).resolves.toBe(true);

    now.mockReturnValue(31_001);
    await (manager as unknown as { cleanup: () => Promise<void> }).cleanup();

    expect(handler).toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({
        agentEventDeliveryKey: 'trigger_pause_timeout',
        status: 'error',
      }),
      [],
      expect.any(Array),
    );
    await expect(store.getJob(streamId)).resolves.not.toHaveProperty('terminalHostActionPending');
    now.mockRestore();
  });
});
