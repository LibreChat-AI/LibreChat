import { StepTypes } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { SerializableJobData } from '~/stream';
import {
  createAgentEventTerminalHandler as createAgentEventTerminalHandlerImpl,
  createAgentEventActionRecorder,
} from './outcome';
import { cancelAgentEventActor } from './actor';

jest.mock('./actor', () => ({
  ...jest.requireActual('./actor'),
  cancelAgentEventActor: jest.fn(),
}));
const mockedCancelAgentEventActor = jest.mocked(cancelAgentEventActor);

const createAgentEventTerminalHandler = (
  methods: Pick<
    Parameters<typeof createAgentEventTerminalHandlerImpl>[0],
    'settleAgentTriggerHandlingOutcome'
  > &
    Partial<Parameters<typeof createAgentEventTerminalHandlerImpl>[0]>,
  options?: Parameters<typeof createAgentEventTerminalHandlerImpl>[1],
) =>
  createAgentEventTerminalHandlerImpl(
    {
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue(undefined),
      recordAgentEventActorReconciliation: jest.fn().mockResolvedValue(true),
      getMessage: jest.fn().mockResolvedValue(null),
      resolveAgentEventActorReconciliation: jest.fn().mockResolvedValue(true),
      clearAgentEventActorReconciliation: jest.fn().mockResolvedValue(true),
      settleAgentEventActorReceipt: jest.fn().mockResolvedValue(true),
      getAgentEventActorReceipt: jest.fn().mockResolvedValue(null),
      backfillAgentEventActorReceipt: jest.fn().mockResolvedValue(true),
      completeAgentEventActorLegacyTurn: jest.fn().mockResolvedValue(true),
      cancelAgentEventActorSuspension: jest.fn().mockResolvedValue({ status: 'cancelled' }),
      releaseAgentEventActorAction: jest.fn().mockResolvedValue(true),
      getAgentEventActorActionAdmission: jest.fn().mockResolvedValue(null),
      hasAgentEventActorActionAdmission: jest.fn().mockResolvedValue(false),
      getAgentEventActorDetachedAction: jest.fn().mockResolvedValue(null),
      settleAgentEventActorDetachedAction: jest.fn().mockResolvedValue({ status: 'applied' }),
      markAgentEventActorDetachedActionLaunchIndeterminate: jest
        .fn()
        .mockResolvedValue({ status: 'applied' }),
      ...methods,
    },
    options,
  );

function job(overrides: Partial<SerializableJobData> = {}): SerializableJobData {
  return {
    streamId: 'conversation-1',
    conversationId: 'conversation-1',
    userId: 'user-1',
    status: 'complete',
    createdAt: 1_787_000_000_000,
    completedAt: 1_787_000_001_000,
    syncSent: false,
    agentEventDeliveryKey: 'trigger_1',
    ...overrides,
  };
}

function completedToolStep(): Agents.RunStep {
  return {
    id: 'step-1',
    index: 0,
    type: StepTypes.TOOL_CALLS,
    status: 'completed',
    stepDetails: {
      type: StepTypes.TOOL_CALLS,
      tool_calls: [
        {
          id: 'call-1',
          name: 'submit_move_mcp_speed-chess',
          args: { gameId: 'game-1', expectedPly: 7 },
          output: '{"accepted":true}',
        },
      ],
    },
  };
}

function suspensionEvidence(suspensionId: string, attempt = 0) {
  return {
    version: 1 as const,
    suspensionId,
    attempt,
    issuedAt: 1,
    expiresAt: 2,
    invocation: {
      actorThreadId: 'conversation-1',
      invocationId: 'trigger_1',
      depth: 1,
      continuation: 'warm' as const,
      base: { actorThreadId: 'conversation-1', generation: 1 },
      fork: {
        threadId: 'conversation-1',
        checkpointNs: 'event-actor/trigger-1',
        checkpointId: `checkpoint-${attempt}`,
        invocationId: 'trigger_1',
      },
    },
    checkpoint: {
      threadId: 'conversation-1',
      checkpointNs: 'event-actor/trigger-1',
      checkpointId: `checkpoint-${attempt}`,
      invocationId: 'trigger_1',
    },
    interrupt: { id: `interrupt-${attempt}`, payload: { type: 'tool_approval' } },
    suspensionDigest: `signed-digest-${attempt}`,
  };
}

describe('agent event terminal outcomes', () => {
  beforeEach(() => {
    mockedCancelAgentEventActor.mockReset();
    mockedCancelAgentEventActor.mockResolvedValue({ status: 'cancelled' });
  });

  it('hands a terminal internal suspension to the durable resume adapter without settling', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const resumeDetachedAction = jest.fn().mockResolvedValue(undefined);
    const suspension = {
      version: 1 as const,
      suspensionId: 'suspension-detached-1',
      attempt: 0,
      issuedAt: 1,
      expiresAt: 2,
      invocation: {
        actorThreadId: 'conversation-1',
        invocationId: 'trigger_1',
        depth: 0,
        continuation: 'warm' as const,
        base: { actorThreadId: 'conversation-1', generation: 1 },
        fork: {
          threadId: 'conversation-1',
          checkpointNs: 'event-actor/trigger-1',
          checkpointId: 'checkpoint-1',
          invocationId: 'trigger_1',
        },
      },
      checkpoint: {
        threadId: 'conversation-1',
        checkpointNs: 'event-actor/trigger-1',
        checkpointId: 'checkpoint-1',
        invocationId: 'trigger_1',
      },
      interrupt: { id: 'task-1', payload: { type: 'event_actor_detached_action' } },
      suspensionDigest: 'signed-digest',
    };
    const detachedAction = {
      version: 1 as const,
      invocationId: 'trigger_1',
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-1',
      taskId: 'task-1',
      idempotencyKey: 'a'.repeat(64),
      launchAttempt: 0 as const,
      status: 'succeeded' as const,
      reservedAt: new Date(),
      recoveryAfter: new Date(),
      launchedAt: new Date(),
      settledAt: new Date(),
      observedAt: new Date(),
      result: 'move accepted',
    };
    const settleAgentEventActorDetachedAction = jest
      .fn()
      .mockResolvedValue({ status: 'already_achieved' });
    const handler = createAgentEventTerminalHandler(
      {
        settleAgentTriggerHandlingOutcome,
        settleAgentEventActorDetachedAction,
        getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: {
            kind: 'internal_completion',
            suspension,
            actionId: 'task-1',
            jobCreatedAt: 1_787_000_000_000,
            status: 'pending',
            observedAt: new Date(),
          },
        }),
        getAgentEventActorDetachedAction: jest.fn().mockResolvedValue(detachedAction),
      },
      { resumeDetachedAction },
    );

    await handler(
      'conversation-1',
      job({
        agentEventBindingId: 'binding-1',
        agentEventDetachedTerminalEvidence: {
          version: 1,
          deliveryKey: 'trigger_1',
          generationCreatedAt: 1_787_000_000_000,
          taskId: detachedAction.taskId,
          idempotencyKey: detachedAction.idempotencyKey,
          status: 'succeeded',
          result: 'move accepted',
          observedAt: 1_787_000_000_500,
        },
        agentEventSuspension: {
          version: 1,
          suspensionId: suspension.suspensionId,
          attempt: 0,
        },
      }),
      [],
    );

    expect(resumeDetachedAction).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'conversation-1', suspension, action: detachedAction }),
    );
    expect(settleAgentEventActorDetachedAction).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        generationCreatedAt: 1_787_000_000_000,
        taskId: detachedAction.taskId,
        status: 'succeeded',
        result: 'move accepted',
        observedAt: new Date(1_787_000_000_500),
      }),
    );
    expect(settleAgentTriggerHandlingOutcome).not.toHaveBeenCalled();
  });

  it('durably enqueues a re-pause successor before settling its completion predecessor', async () => {
    const events: string[] = [];
    const suspension = suspensionEvidence('suspension-repause-successor', 1);
    const action = {
      version: 1 as const,
      invocationId: 'trigger_1',
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-successor',
      taskId: 'task-successor',
      idempotencyKey: '9'.repeat(64),
      launchAttempt: 1,
      status: 'succeeded' as const,
      reservedAt: new Date(),
      recoveryAfter: new Date(),
      observedAt: new Date(),
      settledAt: new Date(),
      result: 'accepted',
    };
    const settleAgentTriggerHandlingOutcome = jest.fn(async () => {
      events.push('settle-predecessor');
      return true;
    });
    const resumeDetachedAction = jest.fn(async () => {
      events.push('enqueue-successor');
    });
    const handler = createAgentEventTerminalHandler(
      {
        settleAgentTriggerHandlingOutcome,
        getAgentEventActorDetachedAction: jest.fn().mockResolvedValue(action),
        getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: {
            kind: 'internal_completion',
            suspension,
            actionId: action.taskId,
            jobCreatedAt: 1_787_000_010_000,
            handlingGenerationCreatedAt: 1_787_000_000_000,
            status: 'pending',
            observedAt: new Date(),
          },
        }),
      },
      { resumeDetachedAction },
    );

    await handler(
      'conversation-1',
      job({
        createdAt: 1_787_000_010_000,
        agentEventDeliveryKey: 'trigger_completion_1',
        agentEventInvocationKey: 'trigger_1',
        agentEventBindingId: 'binding-1',
        agentEventSuspension: {
          version: 1,
          suspensionId: suspension.suspensionId,
          attempt: suspension.attempt,
        },
      }),
      [],
    );

    expect(events).toEqual(['enqueue-successor', 'settle-predecessor']);
    expect(resumeDetachedAction).toHaveBeenCalledWith(
      expect.objectContaining({ handlingGenerationCreatedAt: 1_787_000_000_000 }),
    );
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_completion_1',
        generationCreatedAt: 1_787_000_010_000,
        status: 'completed_no_action',
      }),
    );
  });

  it('preserves original ownership and retires every predecessor across three completion hops', async () => {
    const events: string[] = [];
    const originalGenerationCreatedAt = 1_787_000_000_000;
    const suspensions = [
      suspensionEvidence('suspension-hop-1', 1),
      suspensionEvidence('suspension-hop-2', 2),
    ];
    const actions = suspensions.map((_, index) => ({
      version: 1 as const,
      invocationId: 'trigger_1',
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: `call-hop-${index + 1}`,
      taskId: `task-hop-${index + 1}`,
      idempotencyKey: String(index + 1).repeat(64),
      launchAttempt: index + 1,
      status: 'succeeded' as const,
      reservedAt: new Date(),
      recoveryAfter: new Date(),
      observedAt: new Date(),
      settledAt: new Date(),
      result: 'accepted',
    }));
    const getAgentEventActorSnapshot = jest
      .fn()
      .mockResolvedValueOnce({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          kind: 'internal_completion',
          suspension: suspensions[0],
          actionId: actions[0].taskId,
          jobCreatedAt: originalGenerationCreatedAt + 10_000,
          handlingGenerationCreatedAt: originalGenerationCreatedAt,
          status: 'pending',
          observedAt: new Date(),
        },
      })
      .mockResolvedValueOnce({
        state: null,
        epoch: 2,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          kind: 'internal_completion',
          suspension: suspensions[1],
          actionId: actions[1].taskId,
          jobCreatedAt: originalGenerationCreatedAt + 20_000,
          handlingGenerationCreatedAt: originalGenerationCreatedAt,
          status: 'pending',
          observedAt: new Date(),
        },
      });
    const getAgentEventActorDetachedAction = jest
      .fn()
      .mockResolvedValueOnce(actions[0])
      .mockResolvedValueOnce(actions[1]);
    const settleAgentTriggerHandlingOutcome = jest.fn(async (input) => {
      events.push(`settle:${input.deliveryKey}`);
      return true;
    });
    const resumeDetachedAction = jest.fn(async (input) => {
      events.push(`enqueue:${input.action.taskId}`);
    });
    const handler = createAgentEventTerminalHandler(
      {
        settleAgentTriggerHandlingOutcome,
        getAgentEventActorSnapshot,
        getAgentEventActorDetachedAction,
      },
      { resumeDetachedAction },
    );

    for (let index = 0; index < 2; index++) {
      await handler(
        'conversation-1',
        job({
          createdAt: originalGenerationCreatedAt + (index + 1) * 10_000,
          agentEventDeliveryKey: `trigger_completion_${index + 1}`,
          agentEventInvocationKey: 'trigger_1',
          agentEventBindingId: 'binding-1',
          agentEventSuspension: {
            version: 1,
            suspensionId: suspensions[index].suspensionId,
            attempt: suspensions[index].attempt,
          },
        }),
        [],
      );
    }

    expect(events).toEqual([
      'enqueue:task-hop-1',
      'settle:trigger_completion_1',
      'enqueue:task-hop-2',
      'settle:trigger_completion_2',
    ]);
    expect(getAgentEventActorDetachedAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ generationCreatedAt: originalGenerationCreatedAt }),
    );
    expect(getAgentEventActorDetachedAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ generationCreatedAt: originalGenerationCreatedAt }),
    );
    expect(resumeDetachedAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ handlingGenerationCreatedAt: originalGenerationCreatedAt }),
    );
  });

  it('repairs a crash after successor enqueue by replaying enqueue and predecessor settlement', async () => {
    const suspension = suspensionEvidence('suspension-handoff-retry', 1);
    const action = {
      version: 1 as const,
      invocationId: 'trigger_1',
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-handoff-retry',
      taskId: 'task-handoff-retry',
      idempotencyKey: '6'.repeat(64),
      launchAttempt: 1,
      status: 'succeeded' as const,
      reservedAt: new Date(),
      recoveryAfter: new Date(),
      observedAt: new Date(),
      settledAt: new Date(),
      result: 'accepted',
    };
    const snapshot = {
      state: null,
      epoch: 1,
      legacyTurn: null,
      reconciliations: [],
      suspension: {
        kind: 'internal_completion' as const,
        suspension,
        actionId: action.taskId,
        jobCreatedAt: 1_787_000_010_000,
        handlingGenerationCreatedAt: 1_787_000_000_000,
        status: 'pending' as const,
        observedAt: new Date(),
      },
    };
    const resumeDetachedAction = jest.fn().mockResolvedValue(undefined);
    const settleAgentTriggerHandlingOutcome = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const handler = createAgentEventTerminalHandler(
      {
        settleAgentTriggerHandlingOutcome,
        getAgentEventActorDetachedAction: jest.fn().mockResolvedValue(action),
        getAgentEventActorSnapshot: jest.fn().mockResolvedValue(snapshot),
      },
      { resumeDetachedAction },
    );
    const completionJob = job({
      createdAt: 1_787_000_010_000,
      agentEventDeliveryKey: 'trigger_completion_retry',
      agentEventInvocationKey: 'trigger_1',
      agentEventBindingId: 'binding-1',
      agentEventSuspension: {
        version: 1,
        suspensionId: suspension.suspensionId,
        attempt: suspension.attempt,
      },
    });

    await expect(handler('conversation-1', completionJob, [])).rejects.toThrow(
      'Failed to settle internal completion delivery',
    );
    await expect(handler('conversation-1', completionJob, [])).resolves.toBeUndefined();
    expect(resumeDetachedAction).toHaveBeenCalledTimes(2);
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledTimes(2);
  });

  it('settles both the original invocation and its internal completion delivery', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const getAgentEventActorDetachedAction = jest.fn().mockResolvedValue({
      version: 1,
      invocationId: 'trigger_1',
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-failed',
      taskId: 'task-failed',
      idempotencyKey: 'b'.repeat(64),
      launchAttempt: 0,
      status: 'failed',
      reservedAt: new Date(),
      recoveryAfter: new Date(),
      observedAt: new Date(),
      settledAt: new Date(),
      error: 'move service rejected the request',
    });
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorDetachedAction,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          kind: 'internal_completion',
          suspension: {
            version: 1,
            suspensionId: 'suspension-failed',
            attempt: 0,
            invocation: { invocationId: 'trigger_1' },
          },
          actionId: 'task-failed',
          jobCreatedAt: 1_787_000_000_000,
          handlingGenerationCreatedAt: 1_787_000_000_000,
          status: 'closed',
          outcome: 'settled',
          observedAt: new Date(),
        },
      }),
    });

    await handler(
      'conversation-1',
      job({
        createdAt: 1_787_000_010_000,
        agentEventDeliveryKey: 'trigger_completion_1',
        agentEventInvocationKey: 'trigger_1',
        agentEventBindingId: 'binding-1',
      }),
      [],
    );

    expect(getAgentEventActorDetachedAction).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 1_787_000_000_000 }),
    );
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        generationCreatedAt: 1_787_000_000_000,
        status: 'failed',
        error: 'move service rejected the request',
      }),
    );
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        deliveryKey: 'trigger_completion_1',
        generationCreatedAt: 1_787_000_010_000,
        status: 'failed',
        error: 'move service rejected the request',
      }),
    );
  });

  it('marks an expired detached launch indeterminate without resuming or relaunching', async () => {
    const suspension = suspensionEvidence('suspension-indeterminate');
    const getAgentEventActorDetachedAction = jest
      .fn()
      .mockResolvedValueOnce({
        version: 1,
        invocationId: 'trigger_1',
        expectedToolName: 'submit_move',
        toolName: 'submit_move_mcp_chess',
        toolCallId: 'call-indeterminate',
        taskId: 'task-indeterminate',
        idempotencyKey: 'c'.repeat(64),
        launchAttempt: 0,
        status: 'running',
        reservedAt: new Date(0),
        observedAt: new Date(0),
        recoveryAfter: new Date(1),
      })
      .mockResolvedValueOnce({
        version: 1,
        invocationId: 'trigger_1',
        expectedToolName: 'submit_move',
        toolName: 'submit_move_mcp_chess',
        toolCallId: 'call-indeterminate',
        taskId: 'task-indeterminate',
        idempotencyKey: 'c'.repeat(64),
        launchAttempt: 0,
        status: 'launch_indeterminate',
        reservedAt: new Date(0),
        observedAt: new Date(),
        recoveryAfter: new Date(1),
      });
    const markIndeterminate = jest.fn().mockResolvedValue({ status: 'applied' });
    const resumeDetachedAction = jest.fn();
    const handler = createAgentEventTerminalHandler(
      {
        settleAgentTriggerHandlingOutcome: jest.fn(),
        getAgentEventActorDetachedAction,
        markAgentEventActorDetachedActionLaunchIndeterminate: markIndeterminate,
        getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: {
            kind: 'internal_completion',
            suspension,
            actionId: 'task-indeterminate',
            jobCreatedAt: 1_787_000_000_000,
            status: 'pending',
            observedAt: new Date(),
          },
        }),
      },
      { resumeDetachedAction },
    );

    await expect(
      handler(
        'conversation-1',
        job({
          agentEventBindingId: 'binding-1',
          agentEventSuspension: {
            version: 1,
            suspensionId: suspension.suspensionId,
            attempt: suspension.attempt,
          },
        }),
        [],
      ),
    ).rejects.toThrow('detached action launch is indeterminate');
    expect(markIndeterminate).toHaveBeenCalledTimes(1);
    expect(resumeDetachedAction).not.toHaveBeenCalled();
  });

  it('keeps an indeterminate action owner open when the executor dies before suspension', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const markIndeterminate = jest.fn().mockResolvedValue({ status: 'applied' });
    const action = {
      version: 1,
      invocationId: 'trigger_1',
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-unacknowledged',
      taskId: 'task-unacknowledged',
      idempotencyKey: 'e'.repeat(64),
      launchAttempt: 0,
      status: 'running',
      reservedAt: new Date(0),
      observedAt: new Date(0),
      recoveryAfter: new Date(1),
    };
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      markAgentEventActorDetachedActionLaunchIndeterminate: markIndeterminate,
      getAgentEventActorDetachedAction: jest
        .fn()
        .mockResolvedValueOnce(action)
        .mockResolvedValueOnce({ ...action, status: 'launch_indeterminate' }),
    });

    await expect(
      handler(
        'conversation-1',
        job({ status: 'error', error: 'executor exited', agentEventBindingId: 'binding-1' }),
        [],
      ),
    ).rejects.toThrow('detached action launch is indeterminate');

    expect(markIndeterminate).toHaveBeenCalledTimes(1);
    expect(settleAgentTriggerHandlingOutcome).not.toHaveBeenCalled();
  });

  it('keeps an unexpired detached launch open after generation failure', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn();
    const markIndeterminate = jest.fn();
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      markAgentEventActorDetachedActionLaunchIndeterminate: markIndeterminate,
      getAgentEventActorDetachedAction: jest.fn().mockResolvedValue({
        version: 1,
        invocationId: 'trigger_1',
        expectedToolName: 'submit_move',
        toolName: 'submit_move_mcp_chess',
        toolCallId: 'call-running',
        taskId: 'task-running',
        idempotencyKey: '8'.repeat(64),
        launchAttempt: 0,
        status: 'running',
        reservedAt: new Date(),
        observedAt: new Date(),
        recoveryAfter: new Date(Date.now() + 60_000),
      }),
    });

    await expect(
      handler(
        'conversation-1',
        job({ status: 'error', error: 'generation failed', agentEventBindingId: 'binding-1' }),
        [],
      ),
    ).rejects.toThrow('detached action is still in flight');
    expect(markIndeterminate).not.toHaveBeenCalled();
    expect(settleAgentTriggerHandlingOutcome).not.toHaveBeenCalled();
  });

  it('cancels an aborted internal completion instead of waking it', async () => {
    const suspension = suspensionEvidence('suspension-aborted-internal');
    const resumeDetachedAction = jest.fn();
    const handler = createAgentEventTerminalHandler(
      {
        settleAgentTriggerHandlingOutcome: jest.fn().mockResolvedValue(true),
        getAgentEventActorDetachedAction: jest.fn().mockResolvedValue({
          version: 1,
          invocationId: 'trigger_1',
          expectedToolName: 'submit_move',
          toolName: 'submit_move_mcp_chess',
          toolCallId: 'call-aborted',
          taskId: 'task-aborted',
          idempotencyKey: 'd'.repeat(64),
          launchAttempt: 0,
          status: 'failed',
          reservedAt: new Date(),
          observedAt: new Date(),
          recoveryAfter: new Date(),
          settledAt: new Date(),
          error: 'detached action failed',
        }),
        getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: {
            kind: 'internal_completion',
            suspension,
            actionId: 'task-aborted',
            jobCreatedAt: 1_787_000_000_000,
            status: 'pending',
            observedAt: new Date(),
          },
        }),
      },
      { resumeDetachedAction },
    );

    await handler(
      'conversation-1',
      job({
        status: 'aborted',
        agentEventBindingId: 'binding-1',
        agentEventSuspension: {
          version: 1,
          suspensionId: suspension.suspensionId,
          attempt: suspension.attempt,
        },
      }),
      [],
    );

    expect(resumeDetachedAction).not.toHaveBeenCalled();
    expect(mockedCancelAgentEventActor).toHaveBeenCalledTimes(1);
  });

  it('retires a failed detached action that became terminal before suspension storage', async () => {
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const initialSnapshot = {
      state: null,
      epoch: 1,
      legacyTurn: null,
      reconciliations: [
        {
          invocationId: 'trigger_1',
          actionAdmitted: true,
          status: 'invocation_pending' as const,
          checkpoint,
          action: { toolName: 'submit_move' },
          observedAt: new Date(),
        },
      ],
    };
    const retiredSnapshot = { ...initialSnapshot, reconciliations: [] };
    const getAgentEventActorSnapshot = jest
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValue(retiredSnapshot);
    const resolveAgentEventActorReconciliation = jest.fn().mockResolvedValue(true);
    const getAgentEventActorActionAdmission = jest
      .fn()
      .mockResolvedValueOnce('admission-pre-suspension')
      .mockResolvedValue(null);
    const releaseAgentEventActorAction = jest.fn().mockResolvedValue(true);
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot,
      resolveAgentEventActorReconciliation,
      getAgentEventActorActionAdmission,
      releaseAgentEventActorAction,
      getAgentEventActorDetachedAction: jest.fn().mockResolvedValue({
        version: 1,
        invocationId: 'trigger_1',
        expectedToolName: 'submit_move',
        toolName: 'submit_move_mcp_chess',
        toolCallId: 'call-pre-suspension-failure',
        taskId: 'task-pre-suspension-failure',
        idempotencyKey: 'f'.repeat(64),
        launchAttempt: 0,
        status: 'failed',
        reservedAt: new Date(),
        observedAt: new Date(),
        recoveryAfter: new Date(),
        settledAt: new Date(),
        error: 'detached action failed before suspension storage',
      }),
    });
    const terminalJob = job({ agentEventBindingId: 'binding-1' });

    await handler('conversation-1', terminalJob, []);
    await handler('conversation-1', terminalJob, []);

    expect(resolveAgentEventActorReconciliation).toHaveBeenCalledTimes(1);
    expect(resolveAgentEventActorReconciliation).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
      invocationId: 'trigger_1',
      checkpoint,
      expectedActionAdmitted: true,
      resolution: 'invocation_abandoned',
    });
    expect(releaseAgentEventActorAction).toHaveBeenCalledTimes(1);
    expect(releaseAgentEventActorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        bindingId: 'binding-1',
        admissionId: 'admission-pre-suspension',
      }),
    );
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledTimes(2);
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        status: 'failed',
        error: 'detached action failed before suspension storage',
      }),
    );
  });

  it('retires the claimed predecessor when a successor fails before re-pause storage', async () => {
    const predecessor = suspensionEvidence('suspension-claimed-predecessor', 1);
    const initialSnapshot = {
      state: null,
      epoch: 1,
      legacyTurn: null,
      reconciliations: [
        {
          invocationId: 'trigger_1',
          actionAdmitted: true,
          status: 'invocation_pending' as const,
          checkpoint: predecessor.checkpoint,
          action: { toolName: 'submit_move' },
          observedAt: new Date(),
        },
      ],
      suspension: {
        kind: 'internal_completion' as const,
        suspension: predecessor,
        actionId: 'task-predecessor',
        jobCreatedAt: 1_787_000_000_000,
        handlingGenerationCreatedAt: 1_787_000_000_000,
        status: 'claimed' as const,
        resumeAttemptId: 'trigger_completion_failed_successor',
        observedAt: new Date(),
      },
    };
    const closedSnapshot = {
      ...initialSnapshot,
      reconciliations: [],
      suspension: {
        ...initialSnapshot.suspension,
        status: 'closed' as const,
        outcome: 'cancelled' as const,
      },
    };
    const getAgentEventActorSnapshot = jest
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValue(closedSnapshot);
    const releaseAgentEventActorAction = jest
      .fn()
      .mockRejectedValueOnce(new Error('delivery store unavailable'))
      .mockResolvedValue(true);
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot,
      releaseAgentEventActorAction,
      getAgentEventActorDetachedAction: jest.fn().mockResolvedValue({
        version: 1,
        invocationId: 'trigger_1',
        expectedToolName: 'submit_move',
        toolName: 'submit_move_mcp_chess',
        toolCallId: 'call-failed-successor',
        taskId: 'task-failed-successor',
        idempotencyKey: '6'.repeat(64),
        launchAttempt: 1,
        status: 'failed',
        reservedAt: new Date(),
        observedAt: new Date(),
        recoveryAfter: new Date(),
        settledAt: new Date(),
        error: 'successor failed before re-pause storage',
      }),
    });

    const terminalJob = job({
      createdAt: 1_787_000_010_000,
      agentEventDeliveryKey: 'trigger_completion_failed_successor',
      agentEventInvocationKey: 'trigger_1',
      agentEventBindingId: 'binding-1',
      agentEventSuspension: undefined,
    });

    await expect(handler('conversation-1', terminalJob, [])).rejects.toThrow(
      'delivery store unavailable',
    );
    await handler('conversation-1', terminalJob, []);

    expect(mockedCancelAgentEventActor).toHaveBeenCalledWith(
      expect.objectContaining({
        suspension: predecessor,
        claimedResumeAttemptId: 'trigger_completion_failed_successor',
        reason: 'cancelled',
      }),
      expect.any(Object),
    );
    expect(releaseAgentEventActorAction).toHaveBeenCalledTimes(2);
    expect(releaseAgentEventActorAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveryKey: 'trigger_1', bindingId: 'binding-1' }),
    );
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledTimes(2);
    expect(
      settleAgentTriggerHandlingOutcome.mock.calls.map(([input]) => input.deliveryKey),
    ).toEqual(['trigger_1', 'trigger_completion_failed_successor']);
    expect(settleAgentTriggerHandlingOutcome.mock.calls[0][0]).toMatchObject({
      status: 'failed',
      error: 'successor failed before re-pause storage',
    });
  });

  it('releases admission after an exact completion predecessor settled normally', async () => {
    const predecessor = suspensionEvidence('suspension-settled-predecessor', 1);
    const completionDeliveryKey = 'trigger_completion_settled_successor';
    const releaseAgentEventActorAction = jest.fn().mockResolvedValue(true);
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      releaseAgentEventActorAction,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          kind: 'internal_completion',
          suspension: predecessor,
          actionId: 'task-settled-predecessor',
          jobCreatedAt: 1_787_000_000_000,
          handlingGenerationCreatedAt: 1_787_000_000_000,
          status: 'closed',
          outcome: 'settled',
          resumeAttemptId: completionDeliveryKey,
          observedAt: new Date(),
        },
      }),
      getAgentEventActorDetachedAction: jest.fn().mockResolvedValue({
        version: 1,
        invocationId: 'trigger_1',
        expectedToolName: 'submit_move',
        toolName: 'submit_move_mcp_chess',
        toolCallId: 'call-settled-successor',
        turnId: 'response-settled-successor:0',
        taskId: 'task-settled-successor',
        idempotencyKey: '8'.repeat(64),
        launchAttempt: 1,
        status: 'succeeded',
        reservedAt: new Date(),
        observedAt: new Date(),
        recoveryAfter: new Date(),
        settledAt: new Date(),
        result: 'accepted',
      }),
    });

    await handler(
      'conversation-1',
      job({
        createdAt: 1_787_000_010_000,
        agentEventDeliveryKey: completionDeliveryKey,
        agentEventInvocationKey: 'trigger_1',
        agentEventBindingId: 'binding-1',
        agentEventSuspension: undefined,
      }),
      [],
    );

    expect(releaseAgentEventActorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        bindingId: 'binding-1',
        admissionId: expect.any(String),
      }),
    );
    expect(
      settleAgentTriggerHandlingOutcome.mock.calls.map(([input]) => input.deliveryKey),
    ).toEqual(['trigger_1', completionDeliveryKey]);
  });

  it('records reconciliation when a detached action succeeds after generation abort', async () => {
    const suspension = suspensionEvidence('suspension-aborted-success');
    const recordAgentEventActorReconciliation = jest.fn().mockResolvedValue(true);
    const settleAgentTriggerHandlingOutcome = jest.fn();
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      recordAgentEventActorReconciliation,
      getAgentEventActorDetachedAction: jest.fn().mockResolvedValue({
        version: 1,
        invocationId: 'trigger_1',
        expectedToolName: 'submit_move',
        toolName: 'submit_move_mcp_chess',
        toolCallId: 'call-aborted-success',
        taskId: 'task-aborted-success',
        idempotencyKey: '7'.repeat(64),
        launchAttempt: 0,
        status: 'succeeded',
        reservedAt: new Date(),
        observedAt: new Date(),
        recoveryAfter: new Date(),
        settledAt: new Date(),
        result: 'accepted',
      }),
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [
          {
            invocationId: 'trigger_1',
            actionAdmitted: true,
            status: 'invocation_pending',
            checkpoint: suspension.checkpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
        suspension: {
          kind: 'internal_completion',
          suspension,
          actionId: 'task-aborted-success',
          jobCreatedAt: job().createdAt,
          status: 'pending',
          observedAt: new Date(),
        },
      }),
    });

    await expect(
      handler(
        'conversation-1',
        job({
          status: 'aborted',
          agentEventBindingId: 'binding-1',
          agentEventSuspension: {
            version: 1,
            suspensionId: suspension.suspensionId,
            attempt: suspension.attempt,
          },
        }),
        [],
      ),
    ).rejects.toThrow('requires commit_indeterminate reconciliation');
    expect(recordAgentEventActorReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliation: expect.objectContaining({
          invocationId: 'trigger_1',
          status: 'commit_indeterminate',
          action: {
            toolName: 'submit_move_mcp_chess',
            toolCallId: 'call-aborted-success',
          },
        }),
      }),
    );
    expect(mockedCancelAgentEventActor).not.toHaveBeenCalled();
    expect(settleAgentTriggerHandlingOutcome).not.toHaveBeenCalled();
  });

  it('cancels a versioned paused actor before settling its expired delivery', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const suspension = {
      version: 1 as const,
      suspensionId: 'suspension-1',
      attempt: 0,
      issuedAt: 1,
      expiresAt: 2,
      invocation: {
        invocationId: 'trigger_1',
        continuation: 'warm' as const,
        base: { actorThreadId: 'conversation-1', generation: 1 },
        fork: {
          threadId: 'conversation-1',
          checkpointNs: 'event-actor/trigger-1',
          checkpointId: 'checkpoint-1',
          invocationId: 'trigger_1',
        },
      },
      checkpoint: {
        threadId: 'conversation-1',
        checkpointNs: 'event-actor/trigger-1',
        checkpointId: 'checkpoint-1',
        invocationId: 'trigger_1',
      },
      interrupt: { id: 'interrupt-1', payload: { type: 'tool_approval' } },
      suspensionDigest: 'signed-digest',
    };
    const getAgentEventActorSnapshot = jest
      .fn()
      .mockResolvedValueOnce({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          suspension,
          actionId: 'action-1',
          jobCreatedAt: 1_787_000_000_000,
          status: 'pending',
          observedAt: new Date(),
        },
      })
      .mockResolvedValueOnce({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: { suspension, status: 'closed', outcome: 'cancelled' },
      });
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot,
    });

    await handler(
      'conversation-1',
      job({
        status: 'aborted',
        error: 'Approval expired before a decision was made',
        agentEventBindingId: 'binding-1',
        agentEventSuspension: { version: 1, suspensionId: 'suspension-1', attempt: 0 },
      }),
      [],
    );

    expect(mockedCancelAgentEventActor).toHaveBeenCalledWith(
      expect.objectContaining({ suspension, reason: 'expired' }),
      expect.objectContaining({ cancelSuspension: expect.any(Function) }),
    );
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('compensates the exact claimed resume when approval expiry proves execution never began', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const suspension = {
      version: 1 as const,
      suspensionId: 'suspension-claimed',
      attempt: 0,
      issuedAt: 1,
      expiresAt: 2,
      invocation: {
        invocationId: 'trigger_1',
        continuation: 'warm' as const,
        base: { actorThreadId: 'conversation-1', generation: 1 },
        fork: {
          threadId: 'conversation-1',
          checkpointNs: 'event-actor/trigger-1',
          checkpointId: 'checkpoint-1',
          invocationId: 'trigger_1',
        },
      },
      checkpoint: {
        threadId: 'conversation-1',
        checkpointNs: 'event-actor/trigger-1',
        checkpointId: 'checkpoint-1',
        invocationId: 'trigger_1',
      },
      interrupt: { id: 'interrupt-1', payload: { type: 'tool_approval' } },
      suspensionDigest: 'signed-digest',
    };
    const getAgentEventActorSnapshot = jest
      .fn()
      .mockResolvedValueOnce({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          suspension,
          actionId: 'action-1',
          jobCreatedAt: 1_787_000_000_000,
          status: 'claimed',
          resumeAttemptId: 'resume-attempt-1',
          observedAt: new Date(),
        },
      })
      .mockResolvedValueOnce({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: { suspension, status: 'closed', outcome: 'cancelled' },
      });
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot,
    });

    await handler(
      'conversation-1',
      job({
        status: 'aborted',
        error: 'Approval expired before a decision was made',
        agentEventBindingId: 'binding-1',
        providerExecutionId: 'provider-paused',
        agentEventSuspension: {
          version: 1,
          suspensionId: suspension.suspensionId,
          attempt: suspension.attempt,
        },
      }),
      [],
    );

    expect(mockedCancelAgentEventActor).toHaveBeenCalledWith(
      expect.objectContaining({
        suspension,
        reason: 'expired',
        claimedResumeAttemptId: 'resume-attempt-1',
      }),
      expect.objectContaining({ cancelSuspension: expect.any(Function) }),
    );
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('settles a resumed no-action turn without cancelling its already-closed suspension', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const suspension = {
      version: 1 as const,
      suspensionId: 'suspension-closed',
      attempt: 0,
      invocation: { invocationId: 'trigger_1' },
    };
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: { suspension, status: 'closed', outcome: 'settled' },
      }),
    });

    await handler(
      'conversation-1',
      job({
        agentEventSuspension: {
          version: 1,
          suspensionId: suspension.suspensionId,
          attempt: suspension.attempt,
        },
      }),
      [],
    );

    expect(mockedCancelAgentEventActor).not.toHaveBeenCalled();
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed_no_action' }),
    );
  });

  it('cancels a pending suspension when paused-history persistence terminalizes the job', async () => {
    const suspension = suspensionEvidence('suspension-persistence-error');
    const releaseAgentEventActorAction = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome: jest.fn().mockResolvedValue(true),
      releaseAgentEventActorAction,
      getAgentEventActorSnapshot: jest
        .fn()
        .mockResolvedValueOnce({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: {
            suspension,
            actionId: 'action-1',
            jobCreatedAt: 1_787_000_000_000,
            status: 'pending',
            observedAt: new Date(),
          },
        })
        .mockResolvedValueOnce({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: {
            suspension,
            actionId: 'action-1',
            jobCreatedAt: 1_787_000_000_000,
            status: 'closed',
            outcome: 'cancelled',
            observedAt: new Date(),
          },
        }),
    });

    await handler(
      'conversation-1',
      job({
        status: 'error',
        error: 'Failed to persist the paused response',
        agentEventBindingId: 'binding-1',
        agentEventSuspension: {
          version: 1,
          suspensionId: suspension.suspensionId,
          attempt: suspension.attempt,
        },
      }),
      [],
    );

    expect(mockedCancelAgentEventActor).toHaveBeenCalledWith(
      expect.objectContaining({ suspension, reason: 'cancelled' }),
      expect.any(Object),
    );
    expect(releaseAgentEventActorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        bindingId: 'binding-1',
        admissionId: expect.any(String),
      }),
    );
  });

  it('compensates a claimed resume when termination wins before provider start', async () => {
    const suspension = suspensionEvidence('suspension-pre-projection');
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome: jest.fn().mockResolvedValue(true),
      getAgentEventActorSnapshot: jest
        .fn()
        .mockResolvedValueOnce({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: {
            suspension,
            actionId: 'action-1',
            jobCreatedAt: 1_787_000_000_000,
            status: 'claimed',
            resumeAttemptId: 'provider-new',
            observedAt: new Date(),
          },
        })
        .mockResolvedValueOnce({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: null,
        }),
    });

    await handler(
      'conversation-1',
      job({
        status: 'aborted',
        providerExecutionId: 'provider-old',
        agentEventBindingId: 'binding-1',
        agentEventSuspension: {
          version: 1,
          suspensionId: suspension.suspensionId,
          attempt: suspension.attempt,
        },
      }),
      [],
    );

    expect(mockedCancelAgentEventActor).toHaveBeenCalledWith(
      expect.objectContaining({
        suspension,
        claimedResumeAttemptId: 'provider-new',
      }),
      expect.any(Object),
    );
  });

  it('cancels an unprojected successor re-pause after its predecessor marker was cleared', async () => {
    const suspension = suspensionEvidence('suspension-repause', 1);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome: jest.fn().mockResolvedValue(true),
      getAgentEventActorSnapshot: jest
        .fn()
        .mockResolvedValueOnce({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: {
            suspension,
            actionId: 'action-repause',
            jobCreatedAt: 1_787_000_000_000,
            status: 'pending',
            observedAt: new Date(),
          },
        })
        .mockResolvedValueOnce({
          state: null,
          epoch: 1,
          legacyTurn: null,
          reconciliations: [],
          suspension: null,
        }),
    });

    await handler(
      'conversation-1',
      job({
        status: 'aborted',
        providerExecutionId: 'provider-resume',
        agentEventBindingId: 'binding-1',
        agentEventSuspension: undefined,
      }),
      [],
    );

    expect(mockedCancelAgentEventActor).toHaveBeenCalledWith(
      expect.objectContaining({ suspension, reason: 'cancelled' }),
      expect.any(Object),
    );
  });

  it('does not compensate a claimed resume after its provider start succeeded', async () => {
    const suspension = suspensionEvidence('suspension-projected');
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome: jest.fn().mockResolvedValue(true),
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          suspension,
          actionId: 'action-1',
          jobCreatedAt: 1_787_000_000_000,
          status: 'claimed',
          resumeAttemptId: 'provider-new',
          observedAt: new Date(),
        },
      }),
    });

    await expect(
      handler(
        'conversation-1',
        job({
          status: 'aborted',
          providerExecutionId: 'provider-new',
          providerExecutionStartedId: 'provider-new',
          agentEventSuspension: {
            version: 1,
            suspensionId: suspension.suspensionId,
            attempt: suspension.attempt,
          },
        }),
        [],
      ),
    ).rejects.toThrow('claim is still in flight');
    expect(mockedCancelAgentEventActor).not.toHaveBeenCalled();
  });

  it('releases the delivery-owned admission after the child Conversation disappears', async () => {
    const releaseAgentEventActorAction = jest.fn().mockResolvedValue(true);
    const getAgentEventActorActionAdmission = jest
      .fn()
      .mockResolvedValue('admission-deleted-child');
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      releaseAgentEventActorAction,
      getAgentEventActorActionAdmission,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue(null),
    });

    await handler(
      'conversation-1',
      job({
        status: 'aborted',
        agentEventBindingId: 'binding-1',
        providerExecutionId: 'provider-resume',
      }),
      [],
    );

    expect(getAgentEventActorActionAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        bindingId: 'binding-1',
        conversationId: 'conversation-1',
      }),
    );
    expect(releaseAgentEventActorAction).toHaveBeenCalledWith(
      expect.objectContaining({ admissionId: 'admission-deleted-child' }),
    );
    expect(releaseAgentEventActorAction.mock.invocationCallOrder[0]).toBeLessThan(
      settleAgentTriggerHandlingOutcome.mock.invocationCallOrder[0],
    );
  });

  it('releases the exact action admission after a resumed no-action settlement', async () => {
    const suspension = suspensionEvidence('suspension-no-action');
    const releaseAgentEventActorAction = jest.fn().mockResolvedValue(true);
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      releaseAgentEventActorAction,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        epoch: 1,
        legacyTurn: null,
        reconciliations: [],
        suspension: {
          suspension,
          actionId: 'action-1',
          jobCreatedAt: 1_787_000_000_000,
          status: 'closed',
          resumeAttemptId: 'provider-resume',
          outcome: 'settled',
          observedAt: new Date(),
        },
      }),
    });

    await handler(
      'conversation-1',
      job({
        agentEventBindingId: 'binding-1',
        providerExecutionId: 'provider-resume',
      }),
      [],
    );

    expect(releaseAgentEventActorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        bindingId: 'binding-1',
        admissionId: expect.any(String),
      }),
    );
    expect(releaseAgentEventActorAction.mock.invocationCallOrder[0]).toBeLessThan(
      settleAgentTriggerHandlingOutcome.mock.invocationCallOrder[0],
    );
  });

  it('records applied only from completed tool evidence matching the expected fence', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });

    await handler(
      'conversation-1',
      job({
        agentEventExpectedAction: {
          toolName: 'submit_move',
          argumentSubset: { gameId: 'game-1', expectedPly: 7 },
        },
      }),
      [completedToolStep()],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        generationCreatedAt: 1_787_000_000_000,
        status: 'applied',
        action: { toolName: 'submit_move_mcp_speed-chess', toolCallId: 'call-1' },
      }),
    );
  });

  it('reports a clean terminal generation without matching evidence as completed_no_action', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });

    await handler(
      'conversation-1',
      job({
        agentEventExpectedAction: {
          toolName: 'submit_move',
          argumentSubset: { gameId: 'another-game' },
        },
      }),
      [completedToolStep()],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed_no_action' }),
    );
  });

  it('seals a persisted legacy turn from a non-resume terminal owner', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const completeAgentEventActorLegacyTurn = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      completeAgentEventActorLegacyTurn,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        reconciliations: [],
        legacyTurn: { token: 'legacy-terminal-token', startedAt: new Date() },
      }),
      getMessage: jest.fn().mockImplementation(({ messageId }) =>
        Promise.resolve(
          messageId.endsWith(':user')
            ? {
                messageId,
                conversationId: 'conversation-1',
                isCreatedByUser: true,
              }
            : {
                messageId,
                conversationId: 'conversation-1',
                parentMessageId: 'trigger_1:user',
                isCreatedByUser: false,
              },
        ),
      ),
    });

    await handler(
      'conversation-1',
      job({ status: 'aborted', agentEventLegacyTurnToken: 'legacy-terminal-token' }),
      [],
    );

    expect(completeAgentEventActorLegacyTurn).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
      token: 'legacy-terminal-token',
    });
    expect(completeAgentEventActorLegacyTurn.mock.invocationCallOrder[0]).toBeLessThan(
      settleAgentTriggerHandlingOutcome.mock.invocationCallOrder[0],
    );
  });

  it('keeps a terminal legacy fence closed when required message history is missing', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const completeAgentEventActorLegacyTurn = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      completeAgentEventActorLegacyTurn,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        reconciliations: [],
        legacyTurn: { token: 'legacy-terminal-token', startedAt: new Date() },
      }),
      getMessage: jest.fn().mockResolvedValue(null),
    });

    await expect(
      handler(
        'conversation-1',
        job({ status: 'aborted', agentEventLegacyTurnToken: 'legacy-terminal-token' }),
        [],
      ),
    ).rejects.toThrow('invalid durable message history');

    expect(completeAgentEventActorLegacyTurn).not.toHaveBeenCalled();
    expect(settleAgentTriggerHandlingOutcome).not.toHaveBeenCalled();
  });

  it('replays terminal settlement after the same legacy token was already sealed', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const completeAgentEventActorLegacyTurn = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      completeAgentEventActorLegacyTurn,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        reconciliations: [],
        legacyTurn: null,
      }),
    });

    await handler(
      'conversation-1',
      job({ status: 'aborted', agentEventLegacyTurnToken: 'legacy-terminal-token' }),
      [],
    );

    expect(completeAgentEventActorLegacyTurn).not.toHaveBeenCalled();
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledTimes(1);
  });

  it('matches nested action arrays structurally', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });
    const step = completedToolStep();
    if (step.stepDetails.type !== 'tool_calls' || !step.stepDetails.tool_calls?.[0]) {
      throw new Error('Expected tool evidence');
    }
    const call = step.stepDetails.tool_calls[0];
    if ('function' in call) {
      throw new Error('Expected legacy tool evidence');
    }
    call.args = {
      gameId: 'game-1',
      moves: ['e4', { replies: ['c5', 'Nf3'] }],
    };

    await handler(
      'conversation-1',
      job({
        agentEventExpectedAction: {
          toolName: 'submit_move',
          argumentSubset: { moves: ['e4', { replies: ['c5', 'Nf3'] }] },
        },
      }),
      [step],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'applied' }),
    );
  });

  it('does not treat a background launch handle as applied work', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });
    const step = completedToolStep();
    if (step.stepDetails.type !== 'tool_calls' || !step.stepDetails.tool_calls?.[0]) {
      throw new Error('Expected tool evidence');
    }
    const call = step.stepDetails.tool_calls[0];
    if ('function' in call) {
      throw new Error('Expected legacy tool evidence');
    }
    call.args = { gameId: 'game-1', expectedPly: 7, run_in_background: true };
    call.output = JSON.stringify({
      status: 'running',
      background_task_id: 'task-1',
    });

    await handler(
      'conversation-1',
      job({ agentEventExpectedAction: { toolName: 'submit_move' } }),
      [step],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed_no_action' }),
    );
  });

  it('does not treat a rejected background dispatch as applied work', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });
    const step = completedToolStep();
    if (step.stepDetails.type !== 'tool_calls' || !step.stepDetails.tool_calls?.[0]) {
      throw new Error('Expected tool evidence');
    }
    const call = step.stepDetails.tool_calls[0];
    if ('function' in call) {
      throw new Error('Expected legacy tool evidence');
    }
    call.args = { gameId: 'game-1', expectedPly: 7, run_in_background: true };
    call.output = JSON.stringify({ status: 'rejected', tool: 'submit_move' });

    await handler(
      'conversation-1',
      job({ agentEventExpectedAction: { toolName: 'submit_move' } }),
      [step],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed_no_action' }),
    );
  });

  it('retains a foreground tool-authored rejected status as execution evidence', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });
    const step = completedToolStep();
    if (step.stepDetails.type !== 'tool_calls' || !step.stepDetails.tool_calls?.[0]) {
      throw new Error('Expected tool evidence');
    }
    const call = step.stepDetails.tool_calls[0];
    if ('function' in call) {
      throw new Error('Expected legacy tool evidence');
    }
    call.output = JSON.stringify({ status: 'rejected' });

    await handler(
      'conversation-1',
      job({ agentEventExpectedAction: { toolName: 'submit_move' } }),
      [step],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'applied' }),
    );
  });

  it.each(['decision_response', 'decision_reason'] as const)(
    'does not treat a human-authored %s output as executed tool evidence',
    async (field) => {
      const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
      const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });
      const step = completedToolStep();
      await handler(
        'conversation-1',
        job({
          agentEventExpectedAction: { toolName: 'submit_move' },
          userSubmittedMessageFieldPaths: [{ path: '/content/2/tool_call/output', field }],
        }),
        [step],
        [
          { type: 'text', text: 'before' },
          { type: 'text', text: 'approval' },
          {
            type: 'tool_call',
            tool_call: {
              id: 'call-1',
              name: 'submit_move_mcp_speed-chess',
              output: 'human supplied output',
            },
          },
        ],
      );

      expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed_no_action' }),
      );
    },
  );

  it('does not treat a function-shaped call rejected by input validation as applied', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });
    const step = completedToolStep();
    if (step.stepDetails.type !== 'tool_calls') {
      throw new Error('Expected tool evidence');
    }
    step.stepDetails.tool_calls = [
      {
        id: 'call-invalid',
        type: 'function',
        function: {
          name: 'submit_move_mcp_speed-chess',
          arguments: { gameId: 'game-1', expectedPly: 7 },
          output: '{"rejected":true}',
        },
        inputValidationError: true,
      } as Agents.AgentToolCall,
    ];

    await handler(
      'conversation-1',
      job({
        agentEventExpectedAction: {
          toolName: 'submit_move',
          argumentSubset: { gameId: 'game-1', expectedPly: 7 },
        },
      }),
      [step],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed_no_action' }),
    );
  });

  it.each(['legacy', 'function'] as const)(
    'does not treat a failed %s foreground call as applied',
    async (shape) => {
      const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
      const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });
      const step = completedToolStep();
      step.status = 'failed';
      if (shape === 'function') {
        if (step.stepDetails.type !== 'tool_calls') {
          throw new Error('Expected tool evidence');
        }
        step.stepDetails.tool_calls = [
          {
            id: 'call-failed',
            type: 'function',
            function: {
              name: 'submit_move_mcp_speed-chess',
              arguments: { gameId: 'game-1' },
              output: 'Error: [submit_move] tool call failed: unavailable',
            },
          } as Agents.AgentToolCall,
        ];
      } else if (step.stepDetails.type === 'tool_calls' && step.stepDetails.tool_calls?.[0]) {
        const call = step.stepDetails.tool_calls[0];
        if ('function' in call) {
          throw new Error('Expected legacy tool evidence');
        }
        call.output = 'Error: [submit_move] tool call failed: unavailable';
      }

      await handler(
        'conversation-1',
        job({ agentEventExpectedAction: { toolName: 'submit_move' } }),
        [step],
      );

      expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed_no_action' }),
      );
    },
  );

  it('preserves an applied call when a sibling makes the enclosing step fail', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });
    const step = completedToolStep();
    step.status = 'failed';
    if (step.stepDetails.type !== 'tool_calls') {
      throw new Error('Expected tool evidence');
    }
    step.stepDetails.tool_calls = [
      {
        id: 'call-applied',
        name: 'submit_move_mcp_speed-chess',
        args: { gameId: 'game-1' },
        output: '{"accepted":true}',
        executionStatus: 'success',
      } as Agents.AgentToolCall,
      {
        id: 'call-failed',
        name: 'notify_spectators',
        args: {},
        output: 'Error: [notify_spectators] tool call failed: unavailable',
        executionStatus: 'error',
      } as Agents.AgentToolCall,
    ];

    await handler(
      'conversation-1',
      job({ agentEventExpectedAction: { toolName: 'submit_move' } }),
      [step],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'applied',
        action: { toolName: 'submit_move_mcp_speed-chess', toolCallId: 'call-applied' },
      }),
    );
  });

  it('does not infer that a source action was applied without an explicit evidence contract', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });

    await handler('conversation-1', job(), [completedToolStep()]);

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed_no_action' }),
    );
    expect(settleAgentTriggerHandlingOutcome.mock.calls[0][0]).not.toHaveProperty('action');
  });

  it('preserves terminal generation failures without relying on tool evidence', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });

    await handler('conversation-1', job({ status: 'error', error: 'provider unavailable' }), []);

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'provider unavailable' }),
    );
  });

  it('keeps a verified side effect authoritative when later generation work fails', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });

    await handler(
      'conversation-1',
      job({
        status: 'error',
        error: 'follow-up model call failed',
        agentEventExpectedAction: {
          toolName: 'submit_move',
          argumentSubset: { gameId: 'game-1', expectedPly: 7 },
        },
      }),
      [completedToolStep()],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'applied' }),
    );
    expect(settleAgentTriggerHandlingOutcome.mock.calls[0][0]).not.toHaveProperty('error');
  });

  it('records cancellation when the generation stops before applying the expected action', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const handler = createAgentEventTerminalHandler({ settleAgentTriggerHandlingOutcome });

    await handler(
      'conversation-1',
      job({ status: 'aborted', agentEventExpectedAction: { toolName: 'submit_move' } }),
      [],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('defers terminal settlement until the post-commit history barrier is durable', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const getMessage = jest.fn().mockResolvedValue(null);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: {
          generation: 1,
          checkpoint: {
            threadId: 'conversation-1',
            checkpointId: 'checkpoint-1',
            checkpointNs: 'event-actor/trigger_1',
          },
        },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            status: 'persistence_pending',
            checkpoint: {
              threadId: 'conversation-1',
              checkpointId: 'checkpoint-1',
              checkpointNs: 'event-actor/trigger_1',
            },
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
      }),
      getMessage,
      resolveAgentEventActorReconciliation: jest.fn().mockResolvedValue(true),
    });

    await expect(
      handler('conversation-1', job({ agentEventExpectedAction: { toolName: 'submit_move' } }), [
        completedToolStep(),
      ]),
    ).rejects.toThrow('requires persistence_pending reconciliation');
    expect(getMessage).not.toHaveBeenCalled();
    expect(settleAgentTriggerHandlingOutcome).not.toHaveBeenCalled();
  });

  it('repairs a lost actor acknowledgement from deterministic durable messages before settling', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const resolveAgentEventActorReconciliation = jest.fn().mockResolvedValue(true);
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointId: 'checkpoint-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: { generation: 1, checkpoint },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            actionAdmitted: true,
            status: 'history_persisted',
            checkpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
      }),
      getMessage: jest.fn(async ({ messageId }) => {
        const isUser = messageId.endsWith(':user');
        return {
          messageId,
          conversationId: 'conversation-1',
          isCreatedByUser: isUser,
          parentMessageId: isUser ? 'parent-message' : 'trigger_1:user',
        } as never;
      }),
      resolveAgentEventActorReconciliation,
    });

    await handler(
      'conversation-1',
      job({
        status: 'error',
        error: 'run evidence was lost after the actor commit',
        agentEventExpectedAction: { toolName: 'submit_move' },
      }),
      [],
    );

    expect(resolveAgentEventActorReconciliation).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
      invocationId: 'trigger_1',
      checkpoint,
      resolution: 'checkpoint_verified',
    });
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'applied',
        action: { toolName: 'submit_move' },
      }),
    );
    expect(settleAgentTriggerHandlingOutcome.mock.calls[0][0]).not.toHaveProperty('error');
    /** The receipt's status CAS is the serialization point against concurrent
     * compensation, so verification must resolve BEFORE the public settle. */
    expect(resolveAgentEventActorReconciliation.mock.invocationCallOrder[0]).toBeLessThan(
      settleAgentTriggerHandlingOutcome.mock.invocationCallOrder[0],
    );
  });

  it('settles the actor receipt before clearing the conversation lifecycle', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const settleAgentEventActorReceipt = jest.fn().mockResolvedValue(true);
    const clearAgentEventActorReconciliation = jest.fn().mockResolvedValue(true);
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointId: 'checkpoint-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      settleAgentEventActorReceipt,
      clearAgentEventActorReconciliation,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: { generation: 1, checkpoint },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            actionAdmitted: true,
            status: 'history_persisted',
            checkpoint,
            action: { toolName: 'submit_move', toolCallId: 'call-1' },
            observedAt: new Date(),
          },
        ],
      }),
      getMessage: jest.fn(async ({ messageId }) => {
        const isUser = messageId.endsWith(':user');
        return {
          messageId,
          conversationId: 'conversation-1',
          isCreatedByUser: isUser,
          parentMessageId: isUser ? 'parent-message' : 'trigger_1:user',
        } as never;
      }),
    });

    await handler(
      'conversation-1',
      job({ agentEventBindingId: 'binding-1', status: 'error', error: 'late provider error' }),
      [],
    );

    expect(settleAgentEventActorReceipt).toHaveBeenCalledWith({
      deliveryKey: 'trigger_1',
      user: 'user-1',
      bindingId: 'binding-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 1_787_000_000_000,
      status: 'applied',
      settledAt: new Date(1_787_000_001_000),
      requiresActionAdmission: true,
      receipt: {
        resolution: 'checkpoint_verified',
        checkpoint,
        action: { toolName: 'submit_move', toolCallId: 'call-1' },
      },
    });
    expect(clearAgentEventActorReconciliation).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
      invocationId: 'trigger_1',
      checkpoint,
      resolution: 'checkpoint_verified',
    });
    expect(settleAgentEventActorReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      clearAgentEventActorReconciliation.mock.invocationCallOrder[0],
    );
    expect(settleAgentTriggerHandlingOutcome).not.toHaveBeenCalled();
  });

  it('converges after a crash between actor receipt settlement and marker cleanup', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const settleAgentEventActorReceipt = jest.fn().mockResolvedValue(true);
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointId: 'checkpoint-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const receipt = {
      bindingId: 'binding-1',
      resolution: 'checkpoint_verified' as const,
      checkpoint,
      action: { toolName: 'submit_move' },
      settledAt: new Date(1_787_000_001_000),
    };
    const clearAgentEventActorReconciliation = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const getAgentEventActorReceipt = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(receipt);
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      settleAgentEventActorReceipt,
      clearAgentEventActorReconciliation,
      getAgentEventActorReceipt,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: { generation: 1, checkpoint },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            actionAdmitted: true,
            status: 'history_persisted',
            checkpoint,
            action: receipt.action,
            observedAt: new Date(),
          },
        ],
      }),
      getMessage: jest.fn(async ({ messageId }) => {
        const isUser = messageId.endsWith(':user');
        return {
          messageId,
          conversationId: 'conversation-1',
          isCreatedByUser: isUser,
          parentMessageId: isUser ? 'parent-message' : 'trigger_1:user',
        } as never;
      }),
    });
    const actorJob = job({ agentEventBindingId: 'binding-1' });

    await expect(handler('conversation-1', actorJob, [])).rejects.toThrow(
      'terminal marker could not be cleared',
    );
    await handler('conversation-1', actorJob, []);

    expect(settleAgentEventActorReceipt).toHaveBeenCalledTimes(2);
    expect(settleAgentEventActorReceipt).toHaveBeenLastCalledWith({
      deliveryKey: 'trigger_1',
      user: 'user-1',
      bindingId: 'binding-1',
      conversationId: 'conversation-1',
      generationCreatedAt: 1_787_000_000_000,
      status: 'applied',
      settledAt: receipt.settledAt,
      receipt: {
        resolution: 'checkpoint_verified',
        checkpoint,
        action: receipt.action,
      },
    });
    expect(clearAgentEventActorReconciliation).toHaveBeenCalledTimes(2);
    expect(settleAgentTriggerHandlingOutcome).not.toHaveBeenCalled();
  });

  it('retains authoritative action proof until a failed settlement retry succeeds', async () => {
    const settleAgentTriggerHandlingOutcome = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const resolveAgentEventActorReconciliation = jest.fn().mockResolvedValue(true);
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointId: 'checkpoint-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const action = { toolName: 'submit_move', toolCallId: 'call-1' };
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      /** The first attempt resolves the receipt but dies on the settle write;
       * the retry then observes the already-settled verified receipt. */
      getAgentEventActorSnapshot: jest
        .fn()
        .mockResolvedValueOnce({
          state: { generation: 1, checkpoint },
          reconciliations: [
            {
              invocationId: 'trigger_1',
              status: 'history_persisted',
              checkpoint,
              action,
              observedAt: new Date(),
            },
          ],
        })
        .mockResolvedValue({
          state: { generation: 1, checkpoint },
          reconciliations: [
            {
              invocationId: 'trigger_1',
              status: 'settled',
              resolution: 'checkpoint_verified',
              checkpoint,
              action,
              observedAt: new Date(),
            },
          ],
        }),
      getMessage: jest.fn(async ({ messageId }) => {
        const isUser = messageId.endsWith(':user');
        return {
          messageId,
          conversationId: 'conversation-1',
          isCreatedByUser: isUser,
          parentMessageId: isUser ? 'parent-message' : 'trigger_1:user',
        } as never;
      }),
      resolveAgentEventActorReconciliation,
    });

    await expect(
      handler('conversation-1', job({ status: 'error', error: 'lost run evidence' }), []),
    ).rejects.toThrow('Failed to settle agent event delivery trigger_1');
    expect(resolveAgentEventActorReconciliation).toHaveBeenCalledTimes(1);

    await handler('conversation-1', job({ status: 'error', error: 'lost run evidence' }), []);

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: 'applied',
        action: { toolName: 'submit_move', toolCallId: 'call-1' },
      }),
    );
    expect(resolveAgentEventActorReconciliation).toHaveBeenCalledTimes(1);
  });

  it('honors a compensation that wins the receipt CAS during settlement', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const resolveAgentEventActorReconciliation = jest.fn().mockResolvedValue(false);
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointId: 'checkpoint-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const action = { toolName: 'submit_move', toolCallId: 'call-1' };
    const getAgentEventActorSnapshot = jest
      .fn()
      .mockResolvedValueOnce({
        state: { generation: 1, checkpoint },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            status: 'history_persisted',
            checkpoint,
            action,
            observedAt: new Date(),
          },
        ],
      })
      .mockResolvedValue({
        state: { generation: 1, checkpoint, requiresColdStart: true },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            status: 'settled',
            resolution: 'action_compensated',
            checkpoint,
            action,
            observedAt: new Date(),
          },
        ],
      });
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot,
      getMessage: jest.fn(async ({ messageId }) => {
        const isUser = messageId.endsWith(':user');
        return {
          messageId,
          conversationId: 'conversation-1',
          isCreatedByUser: isUser,
          parentMessageId: isUser ? 'parent-message' : 'trigger_1:user',
        } as never;
      }),
      resolveAgentEventActorReconciliation,
    });

    await handler(
      'conversation-1',
      job({ agentEventExpectedAction: { toolName: 'submit_move' } }),
      [completedToolStep()],
    );

    /** Verification lost the receipt CAS to a concurrent compensation, so the
     * public outcome must honor the compensation, not the stale snapshot. */
    expect(getAgentEventActorSnapshot).toHaveBeenCalledTimes(2);
    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Applied event actor action was explicitly compensated',
      }),
    );
    expect(settleAgentTriggerHandlingOutcome.mock.calls[0][0]).not.toHaveProperty('action');
  });

  it('replays an applied settlement from its durable resolved lifecycle receipt', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const resolveAgentEventActorReconciliation = jest.fn().mockResolvedValue(true);
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointId: 'checkpoint-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: { generation: 1, checkpoint },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            status: 'settled',
            checkpoint,
            action: { toolName: 'submit_move', toolCallId: 'call-1' },
            observedAt: new Date(),
          },
        ],
      }),
      resolveAgentEventActorReconciliation,
    });

    await handler(
      'conversation-1',
      job({ status: 'error', error: 'lost local evidence after settlement' }),
      [],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'applied',
        action: { toolName: 'submit_move', toolCallId: 'call-1' },
      }),
    );
    expect(resolveAgentEventActorReconciliation).not.toHaveBeenCalled();
  });

  it('lazily migrates a legacy settled receipt before deleting its embedded copy', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const backfillAgentEventActorReceipt = jest.fn().mockResolvedValue(true);
    const clearAgentEventActorReconciliation = jest.fn().mockResolvedValue(true);
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointId: 'checkpoint-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const observedAt = new Date('2026-08-25T00:00:00.000Z');
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      backfillAgentEventActorReceipt,
      clearAgentEventActorReconciliation,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: { generation: 1, checkpoint },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            status: 'settled',
            resolution: 'checkpoint_verified',
            checkpoint,
            action: { toolName: 'submit_move', toolCallId: 'call-1' },
            observedAt,
          },
        ],
      }),
    });

    await handler('conversation-1', job({ agentEventBindingId: 'binding-1' }), []);

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith({
      deliveryKey: 'trigger_1',
      conversationId: 'conversation-1',
      generationCreatedAt: job().createdAt,
      status: 'applied',
      settledAt: observedAt,
      action: { toolName: 'submit_move', toolCallId: 'call-1' },
    });
    expect(backfillAgentEventActorReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'trigger_1',
        bindingId: 'binding-1',
        conversationId: 'conversation-1',
        status: 'applied',
        settledAt: observedAt,
        receipt: {
          resolution: 'checkpoint_verified',
          checkpoint,
          action: { toolName: 'submit_move', toolCallId: 'call-1' },
        },
      }),
    );
    expect(backfillAgentEventActorReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      clearAgentEventActorReconciliation.mock.invocationCallOrder[0],
    );
    expect(settleAgentTriggerHandlingOutcome.mock.invocationCallOrder[0]).toBeLessThan(
      backfillAgentEventActorReceipt.mock.invocationCallOrder[0],
    );
  });

  it('keeps legacy proof intact when its public outcome cannot be recovered', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(false);
    const backfillAgentEventActorReceipt = jest.fn();
    const clearAgentEventActorReconciliation = jest.fn();
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointId: 'checkpoint-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      backfillAgentEventActorReceipt,
      clearAgentEventActorReconciliation,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: { generation: 1, checkpoint },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            status: 'settled',
            resolution: 'checkpoint_verified',
            checkpoint,
            action: { toolName: 'submit_move', toolCallId: 'call-1' },
            observedAt: new Date('2026-08-25T00:00:00.000Z'),
          },
        ],
      }),
    });

    await expect(
      handler('conversation-1', job({ agentEventBindingId: 'binding-1' }), []),
    ).rejects.toThrow('legacy public outcome could not be recovered');

    expect(backfillAgentEventActorReceipt).not.toHaveBeenCalled();
    expect(clearAgentEventActorReconciliation).not.toHaveBeenCalled();
  });

  it('never replays a compensated receipt as applied even over fresh run evidence', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const resolveAgentEventActorReconciliation = jest.fn().mockResolvedValue(true);
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointId: 'checkpoint-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: { generation: 1, checkpoint, requiresColdStart: true },
        reconciliations: [
          {
            invocationId: 'trigger_1',
            status: 'settled',
            resolution: 'action_compensated',
            checkpoint,
            action: { toolName: 'submit_move', toolCallId: 'call-1' },
            observedAt: new Date(),
          },
        ],
      }),
      resolveAgentEventActorReconciliation,
    });

    /** The replayed generation still carries the original applied run step,
     * but compensation explicitly undid that effect: the public outcome must
     * not tell the source the operation stands. */
    await handler(
      'conversation-1',
      job({ status: 'error', agentEventExpectedAction: { toolName: 'submit_move' } }),
      [completedToolStep()],
    );

    expect(settleAgentTriggerHandlingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Applied event actor action was explicitly compensated',
      }),
    );
    expect(settleAgentTriggerHandlingOutcome.mock.calls[0][0]).not.toHaveProperty('action');
    expect(resolveAgentEventActorReconciliation).not.toHaveBeenCalled();
  });

  it('preserves an ambiguous pre-action fence when terminal evidence is incomplete', async () => {
    const settleAgentTriggerHandlingOutcome = jest.fn().mockResolvedValue(true);
    const resolveAgentEventActorReconciliation = jest.fn().mockResolvedValue(true);
    const checkpoint = {
      threadId: 'conversation-1',
      checkpointNs: 'event-actor/trigger_1',
    };
    const handler = createAgentEventTerminalHandler({
      settleAgentTriggerHandlingOutcome,
      getAgentEventActorSnapshot: jest.fn().mockResolvedValue({
        state: null,
        reconciliations: [
          {
            invocationId: 'trigger_1',
            status: 'invocation_pending',
            checkpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
      }),
      resolveAgentEventActorReconciliation,
    });

    await expect(handler('conversation-1', job(), [])).rejects.toThrow(
      'requires invocation_pending reconciliation',
    );

    expect(resolveAgentEventActorReconciliation).not.toHaveBeenCalled();
    expect(settleAgentTriggerHandlingOutcome).not.toHaveBeenCalled();
  });
});

describe('createAgentEventActionRecorder', () => {
  const expectedAction = { toolName: 'submit_move', argumentSubset: { gameId: 'game-1' } };
  const successEnd = {
    input: { gameId: 'game-1', move: 'e4' },
    output: { name: 'submit_move', tool_call_id: 'call-1', content: '{"ok":true}' },
  };

  it('records the first qualifying execution and keeps it', async () => {
    const recorder = createAgentEventActionRecorder(expectedAction);
    expect(recorder.read()).toBeUndefined();
    recorder.observeToolEnd(successEnd);
    recorder.observeToolEnd({
      input: { gameId: 'game-1' },
      output: { name: 'submit_move', tool_call_id: 'call-2', content: '{"ok":true}' },
    });
    expect(recorder.read()).toEqual({ toolName: 'submit_move', toolCallId: 'call-1' });
  });

  it('accepts the MCP-suffixed form of the expected tool', async () => {
    const recorder = createAgentEventActionRecorder(expectedAction);
    recorder.observeToolEnd({
      ...successEnd,
      output: { ...successEnd.output, name: 'submit_move_mcp_chess' },
    });
    expect(recorder.read()).toEqual({ toolName: 'submit_move_mcp_chess', toolCallId: 'call-1' });
  });

  it('enforces the fenced argument subset against the execution input', async () => {
    const recorder = createAgentEventActionRecorder(expectedAction);
    recorder.observeToolEnd({ ...successEnd, input: { gameId: 'other-game', move: 'e4' } });
    recorder.observeToolEnd({ ...successEnd, input: undefined });
    expect(recorder.read()).toBeUndefined();
  });

  it('never qualifies an argument-fenced action from an output-only tool end', async () => {
    /** Live-canary shape: the stream-consumer tool-end path delivers no
     * execution input, so a declared argument subset can never be verified —
     * the receipt must starve rather than trust an unfenced match. The
     * execution handler is required to supply the input (see handlers.spec). */
    const recorder = createAgentEventActionRecorder(expectedAction);
    recorder.observeToolEnd({ output: successEnd.output });
    expect(recorder.read()).toBeUndefined();
  });

  it('qualifies a name-only expected action from an output-only tool end', async () => {
    const recorder = createAgentEventActionRecorder({ toolName: 'submit_move' });
    recorder.observeToolEnd({ output: successEnd.output });
    expect(recorder.read()).toEqual({ toolName: 'submit_move', toolCallId: 'call-1' });
  });

  it('accepts policy-withheld output as proof of a successful foreground execution', async () => {
    /** Output filtering blanks the returned content AFTER the side effect
     * happened; reclassifying the turn as actionless would re-execute an
     * applied external action on retry. */
    const recorder = createAgentEventActionRecorder(expectedAction);
    recorder.observeToolEnd({
      input: { gameId: 'game-1', move: 'e4' },
      outputFiltered: true,
      output: { name: 'submit_move', tool_call_id: 'call-filtered', content: '' },
    });
    expect(recorder.read()).toEqual({ toolName: 'submit_move', toolCallId: 'call-filtered' });
  });

  it('never qualifies a withheld output whose call the model detached', async () => {
    const recorder = createAgentEventActionRecorder({ toolName: 'submit_move' });
    recorder.observeToolEnd({
      input: { gameId: 'game-1', run_in_background: true },
      outputFiltered: true,
      output: { name: 'submit_move', tool_call_id: 'call-detached', content: '' },
    });
    expect(recorder.read()).toBeUndefined();
  });

  it('never lets a background-task delivery impersonate a name-only action', async () => {
    /** The poll turn's delivery callback reports the ORIGINAL tool's name for
     * artifact attribution — evidence of work another turn dispatched, not
     * proof this invocation performed its expected action. */
    const recorder = createAgentEventActionRecorder({ toolName: 'submit_move' });
    recorder.observeToolEnd({
      input: { background_task_id: 'task-1' },
      backgroundDelivery: true,
      output: { name: 'submit_move', tool_call_id: 'call-poll', content: '{"ok":true}' },
    });
    expect(recorder.read()).toBeUndefined();
  });

  it('never records name mismatches, errored results, or malformed outputs', async () => {
    const recorder = createAgentEventActionRecorder(expectedAction);
    recorder.observeToolEnd({ ...successEnd, output: { ...successEnd.output, name: 'resign' } });
    recorder.observeToolEnd({
      ...successEnd,
      output: { ...successEnd.output, status: 'error' },
    });
    recorder.observeToolEnd({ ...successEnd, output: { ...successEnd.output, content: null } });
    recorder.observeToolEnd({ ...successEnd, output: undefined });
    recorder.observeToolEnd({ input: successEnd.input, output: 'plain-string' });
    expect(recorder.read()).toBeUndefined();
  });

  it('excludes background non-execution receipts', async () => {
    const recorder = createAgentEventActionRecorder({ toolName: 'submit_move' });
    recorder.observeToolEnd({
      input: { gameId: 'game-1', run_in_background: true },
      output: {
        name: 'submit_move',
        tool_call_id: 'call-bg',
        content: JSON.stringify({ status: 'running', background_task_id: 'task-1' }),
      },
    });
    expect(recorder.read()).toBeUndefined();
  });

  it('records nothing without a declared expected action', async () => {
    const recorder = createAgentEventActionRecorder(undefined);
    recorder.observeToolEnd(successEnd);
    expect(recorder.read()).toBeUndefined();
  });
});
