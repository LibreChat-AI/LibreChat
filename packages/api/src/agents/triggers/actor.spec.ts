import type {
  IAgentEventActorReconciliation,
  IAgentEventActorState,
  IAgentEventActorSuspension,
} from '@librechat/data-schemas';
import type { EventActorInterrupt } from '@librechat/agents';
import {
  captureAgentEventCheckpoint,
  deleteOwnedActorCheckpointScope,
  deleteAgentEventCheckpointReference,
  forkAgentEventCheckpoint,
  getAgentCheckpointer,
} from '../checkpointer';
import { cancelAgentEventActor, executeAgentEventActor, resumeAgentEventActor } from './actor';
import { createAgentEventActionRecorder, findAgentEventAppliedAction } from './outcome';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';
import { createAgentContextFingerprint } from '../compatibility';
import { drainActorPruning } from '../checkpoints/pruning';

jest.mock('../checkpoints/pruning', () => ({
  drainActorPruning: jest.fn(async () => undefined),
  acknowledgeActorPruning: jest.fn(async () => undefined),
}));

jest.mock('../checkpointer', () => ({
  ...jest.requireActual('../checkpointer'),
  captureAgentEventCheckpoint: jest.fn(),
  deleteOwnedActorCheckpointScope: jest.fn(),
  deleteAgentEventCheckpointReference: jest.fn(),
  forkAgentEventCheckpoint: jest.fn(),
  getAgentCheckpointer: jest.fn(),
}));

const mockedCapture = jest.mocked(captureAgentEventCheckpoint);
const mockedDeleteReference = jest.mocked(deleteAgentEventCheckpointReference);
const mockedDelete = jest.mocked(deleteOwnedActorCheckpointScope);
const mockedFork = jest.mocked(forkAgentEventCheckpoint);
const mockedGetCheckpointer = jest.mocked(getAgentCheckpointer);

describe('event actor host adapter', () => {
  const conversationId = 'actor-thread';
  const originalCredsKey = process.env.CREDS_KEY;
  let state: IAgentEventActorState | null;
  let epoch = 0;
  let legacyTurn: { token: string; startedAt: Date } | null = null;
  let nextCheckpoint = 1;

  beforeEach(() => {
    process.env.CREDS_KEY = 'event-actor-test-credentials-key';
    state = null;
    epoch = 0;
    legacyTurn = null;
    nextCheckpoint = 1;
    jest.clearAllMocks();
    mockedGetCheckpointer.mockResolvedValue({
      getTuple: jest.fn(async (config) => ({
        checkpoint: { id: config.configurable.checkpoint_id },
      })),
    } as never);
    mockedFork.mockImplementation(async (source, checkpointNs) => ({
      ...source,
      checkpointNs,
    }));
    mockedCapture.mockImplementation(async (threadId, checkpointNs) => ({
      threadId,
      checkpointNs,
      checkpointId: `checkpoint-${nextCheckpoint++}`,
    }));
    mockedDelete.mockReset();
    mockedDelete.mockResolvedValue();
    mockedDeleteReference.mockReset();
    mockedDeleteReference.mockResolvedValue(true);
  });

  afterAll(() => {
    if (originalCredsKey == null) {
      delete process.env.CREDS_KEY;
    } else {
      process.env.CREDS_KEY = originalCredsKey;
    }
  });

  const deps = () => ({
    getSnapshot: jest.fn(async () => ({
      state,
      reconciliations: [] as IAgentEventActorReconciliation[],
      legacyTurn,
      suspension: null as IAgentEventActorSuspension | null,
      epoch,
    })),
    commitState: jest.fn(
      async ({
        expected,
        expectedEpoch,
        checkpoint,
        contextFingerprint,
        skillManifest,
        discoveredToolNames,
        summary,
        contextMeta,
        compactionSemanticIndex,
      }) => {
        if (
          expectedEpoch !== epoch ||
          (state == null && expected != null) ||
          (state != null &&
            (expected == null ||
              expected.generation !== state.generation ||
              expected.checkpoint.checkpointId !== state.checkpoint.checkpointId ||
              JSON.stringify(expected.skillManifest) !== JSON.stringify(state.skillManifest) ||
              JSON.stringify(expected.discoveredToolNames) !==
                JSON.stringify(state.discoveredToolNames) ||
              JSON.stringify(expected.summary) !== JSON.stringify(state.summary) ||
              JSON.stringify(expected.contextMeta) !== JSON.stringify(state.contextMeta) ||
              JSON.stringify(expected.compactionSemanticIndex) !==
                JSON.stringify(state.compactionSemanticIndex) ||
              (expected.requiresColdStart === true) !== (state.requiresColdStart === true)))
        ) {
          return { status: 'stale' as const, ...(state == null ? {} : { state }) };
        }
        const previous = state?.checkpoint;
        state = {
          generation: (state?.generation ?? 0) + 1,
          checkpoint,
          ...(contextFingerprint == null ? {} : { contextFingerprint }),
          ...(skillManifest == null ? {} : { skillManifest }),
          ...(discoveredToolNames == null ? {} : { discoveredToolNames }),
          ...(summary == null ? {} : { summary }),
          ...(contextMeta == null ? {} : { contextMeta }),
          ...(compactionSemanticIndex == null ? {} : { compactionSemanticIndex }),
          ...(previous == null ? {} : { previousCheckpoint: previous }),
        };
        return { status: 'committed' as const, state };
      },
    ),
    recordReconciliation: jest.fn(async () => true),
    resolveReconciliation: jest.fn(async () => true),
    admitAction: jest.fn(async () => true),
    releaseAction: jest.fn(async () => true),
    hasActionAdmission: jest.fn(async () => false),
  });

  it.each([false, true])(
    'starts the snapshot during pruning and gates execution (failure=%s)',
    async (fail) => {
      let finish!: () => void;
      const pruning = new Promise<void>((resolve) => {
        finish = resolve;
      });
      jest.mocked(drainActorPruning).mockImplementationOnce(async () => {
        await pruning;
        if (fail) throw new Error('pruning failed');
      });
      const dependencies = deps();
      const invoke = jest.fn(async () => 'response');
      const execution = executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-prune',
          event: { id: 'event-prune', type: 'turn' },
          signal: new AbortController().signal,
          invoke,
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      );
      const observed = execution.then(
        (value) => value,
        (error: Error) => error,
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(dependencies.getSnapshot).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();
      finish();
      const result = await observed;
      if (fail) {
        expect(invoke).not.toHaveBeenCalled();
        expect(result).toBeDefined();
      } else expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it('publishes a signed durable suspension instead of discarding a paused fork', async () => {
    const dependencies = {
      ...deps(),
      storeSuspension: jest.fn(async () => ({ status: 'stored' as const })),
    };

    const result = await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-paused',
        event: { id: 'event-paused', type: 'turn' },
        signal: new AbortController().signal,
        invoke: async ({ checkpointNamespace }) => {
          expect(checkpointNamespace).toMatch(/^event-actor\//);
          return 'paused-response';
        },
        readAppliedAction: () => undefined,
        readSuspension: () => ({
          actionId: 'action-paused',
          jobCreatedAt: 123,
          interrupt: {
            id: 'interrupt-paused',
            payload: { type: 'ask_user_question', question: 'Continue?' },
          },
        }),
      },
      dependencies,
    );

    expect(result.value).toBe('paused-response');
    expect(result.execution).toMatchObject({
      status: 'suspended',
      suspension: {
        version: 1,
        attempt: 0,
        invocation: { invocationId: 'event-paused' },
        checkpoint: {
          checkpointId: 'checkpoint-1',
          checkpointNs: expect.stringMatching(/^event-actor\//),
        },
        interrupt: {
          id: 'interrupt-paused',
          payload: { type: 'ask_user_question', question: 'Continue?' },
        },
      },
    });
    expect(dependencies.storeSuspension).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'action-paused',
        jobCreatedAt: 123,
        suspension: expect.objectContaining({ suspensionId: expect.any(String) }),
      }),
    );
    expect(dependencies.storeSuspension).toHaveBeenCalledTimes(1);
    expect(dependencies.commitState).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(mockedDeleteReference).not.toHaveBeenCalled();
  });

  it('preserves a pause reached after the expected action in the same fresh segment', async () => {
    const dependencies = {
      ...deps(),
      storeSuspension: jest.fn(async () => ({ status: 'stored' as const })),
    };

    const result = await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-action-then-pause',
        event: { id: 'event-action-then-pause' },
        signal: new AbortController().signal,
        invoke: async () => 'paused-after-action',
        readAppliedAction: () => ({ toolName: 'submit_move', toolCallId: 'call-before-pause' }),
        readSuspension: () => ({
          actionId: 'action-after-tool',
          jobCreatedAt: 456,
          interrupt: { id: 'interrupt-after-tool', payload: { type: 'tool_approval' } },
        }),
      },
      dependencies,
    );

    expect(result.execution).toMatchObject({
      status: 'suspended',
      suspension: { interrupt: { id: 'interrupt-after-tool' } },
    });
    expect(dependencies.storeSuspension).toHaveBeenCalledTimes(1);
    expect(dependencies.commitState).not.toHaveBeenCalled();
  });

  it('validates and cancels the exact signed suspension before deleting its fork', async () => {
    const dependencies = {
      ...deps(),
      storeSuspension: jest.fn(async () => ({ status: 'stored' as const })),
      cancelSuspension: jest.fn(async () => ({ status: 'cancelled' as const })),
    };
    const paused = await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-cancelled',
        event: { id: 'event-cancelled' },
        signal: new AbortController().signal,
        invoke: async () => 'paused-response',
        readAppliedAction: () => undefined,
        readSuspension: () => ({
          actionId: 'action-cancelled',
          jobCreatedAt: 456,
          interrupt: { id: 'interrupt-cancelled', payload: { type: 'tool_approval' } },
        }),
      },
      dependencies,
    );
    if (paused.execution.status !== 'suspended') {
      throw new Error('test setup did not suspend');
    }

    await expect(
      cancelAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          suspension: JSON.parse(JSON.stringify(paused.execution.suspension)),
          cancelAttemptId: 'cancel-attempt-1',
          reason: 'cancelled',
        },
        dependencies,
      ),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(dependencies.cancelSuspension).toHaveBeenCalledWith(
      expect.objectContaining({
        suspensionId: paused.execution.suspension.suspensionId,
        invocationId: 'event-cancelled',
      }),
    );
    expect(mockedDelete).toHaveBeenCalledWith(
      conversationId,
      paused.execution.suspension.checkpoint.checkpointNs,
      checkpointOwnerNamespacePrefix('user-1'),
      undefined,
    );
  });

  it('resumes signed evidence on a new executor and consumes its claim with the head CAS', async () => {
    let storedSuspension: IAgentEventActorSuspension | undefined;
    let action: { toolName: string; toolCallId?: string } | undefined;
    const dependencies = {
      ...deps(),
      storeSuspension: jest.fn(async (input) => {
        storedSuspension = {
          suspension: input.suspension,
          actionId: input.actionId,
          jobCreatedAt: input.jobCreatedAt,
          status: 'pending',
          observedAt: new Date(),
        };
        return { status: 'stored' as const };
      }),
      claimSuspension: jest.fn(async ({ resumeAttemptId }) => {
        if (storedSuspension == null) {
          throw new Error('test setup did not store a suspension');
        }
        storedSuspension = { ...storedSuspension, status: 'claimed', resumeAttemptId };
        return { status: 'claimed' as const };
      }),
      settleSuspension: jest.fn(async () => ({ status: 'settled' as const })),
    };
    dependencies.getSnapshot.mockImplementation(async () => ({
      state,
      reconciliations: [],
      legacyTurn: null,
      suspension: storedSuspension ?? null,
      epoch,
    }));

    const paused = await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-cross-executor',
        event: { id: 'event-cross-executor' },
        signal: new AbortController().signal,
        invoke: async () => 'paused-response',
        readAppliedAction: () => action,
        readSuspension: () => ({
          actionId: 'action-cross-executor',
          jobCreatedAt: 321,
          interrupt: {
            id: 'interrupt-cross-executor',
            payload: { type: 'tool_approval', actionId: 'action-cross-executor' },
          },
        }),
      },
      dependencies,
    );
    if (paused.execution.status !== 'suspended') {
      throw new Error('test setup did not suspend');
    }
    const evidence = JSON.parse(JSON.stringify(paused.execution.suspension));
    dependencies.getSnapshot.mockClear();
    dependencies.claimSuspension.mockClear();
    dependencies.commitState.mockClear();

    const resumed = await resumeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        bindingId: 'binding-1',
        suspension: evidence,
        resumeAttemptId: 'resume-cross-executor',
        resumeValue: { approved: true },
        signal: new AbortController().signal,
        resume: async ({ checkpointNamespace }) => {
          expect(checkpointNamespace).toMatch(/^event-actor\//);
          action = { toolName: 'submit_move', toolCallId: 'call-resumed' };
          return 'resumed-response';
        },
        readAppliedAction: () => action,
      },
      dependencies,
    );

    expect(resumed).toMatchObject({
      value: 'resumed-response',
      execution: {
        status: 'applied',
        result: { action: { toolName: 'submit_move', toolCallId: 'call-resumed' } },
      },
    });
    expect(dependencies.claimSuspension).toHaveBeenCalledWith(
      expect.objectContaining({
        suspensionId: evidence.suspensionId,
        resumeAttemptId: 'resume-cross-executor',
        actionId: 'action-cross-executor',
      }),
    );
    expect(dependencies.getSnapshot).toHaveBeenCalledTimes(1);
    expect(dependencies.claimSuspension).toHaveBeenCalledTimes(1);
    expect(dependencies.commitState).toHaveBeenCalledTimes(1);
    expect(dependencies.commitState).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementAuthority: expect.objectContaining({
          suspensionId: evidence.suspensionId,
          resumeAttemptId: 'resume-cross-executor',
        }),
      }),
    );
  });

  it('atomically re-pauses after an action and settles a later no-action reply', async () => {
    let storedSuspension: IAgentEventActorSuspension | undefined;
    let pendingPause:
      | { actionId: string; jobCreatedAt: number; interrupt: EventActorInterrupt }
      | undefined;
    const dependencies = {
      ...deps(),
      storeSuspension: jest.fn(async (input) => {
        storedSuspension = {
          suspension: input.suspension,
          actionId: input.actionId,
          jobCreatedAt: input.jobCreatedAt,
          status: 'pending',
          observedAt: new Date(),
        };
        return { status: 'stored' as const };
      }),
      claimSuspension: jest.fn(async ({ resumeAttemptId }) => {
        if (storedSuspension == null) {
          throw new Error('test setup did not store a suspension');
        }
        storedSuspension = { ...storedSuspension, status: 'claimed', resumeAttemptId };
        return { status: 'claimed' as const };
      }),
      settleSuspension: jest.fn(async () => ({ status: 'settled' as const })),
    };
    dependencies.getSnapshot.mockImplementation(async () => ({
      state,
      reconciliations: [],
      legacyTurn: null,
      suspension: storedSuspension ?? null,
      epoch,
    }));

    const initial = await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-repause',
        event: { id: 'event-repause' },
        signal: new AbortController().signal,
        invoke: async () => 'initial-pause',
        readAppliedAction: () => undefined,
        readSuspension: () => ({
          actionId: 'action-first',
          jobCreatedAt: 789,
          interrupt: { id: 'interrupt-first', payload: { type: 'tool_approval' } },
        }),
      },
      dependencies,
    );
    if (initial.execution.status !== 'suspended') {
      throw new Error('test setup did not suspend');
    }
    pendingPause = {
      actionId: 'action-second',
      jobCreatedAt: 789,
      interrupt: { id: 'interrupt-second', payload: { type: 'ask_user_question' } },
    };
    const repaused = await resumeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        suspension: initial.execution.suspension,
        resumeAttemptId: 'resume-first',
        resumeValue: { approved: true },
        signal: new AbortController().signal,
        resume: async () => 'second-pause',
        readAppliedAction: () => ({ toolName: 'submit_move', toolCallId: 'call-before-repause' }),
        readSuspension: () => pendingPause,
      },
      dependencies,
    );
    expect(repaused.execution).toMatchObject({
      status: 'suspended',
      suspension: { attempt: 1, interrupt: { id: 'interrupt-second' } },
    });
    expect(dependencies.storeSuspension).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionId: 'action-second',
        invalidateHead: true,
        previous: {
          suspensionId: initial.execution.suspension.suspensionId,
          attempt: 0,
          resumeAttemptId: 'resume-first',
        },
      }),
    );
    if (repaused.execution.status !== 'suspended') {
      throw new Error('test setup did not re-pause');
    }
    pendingPause = undefined;
    const rejected = await resumeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        suspension: repaused.execution.suspension,
        resumeAttemptId: 'resume-second',
        resumeValue: { rejected: true },
        signal: new AbortController().signal,
        resume: async () => 'rejected-response',
        readAppliedAction: () => undefined,
        readSuspension: () => pendingPause,
      },
      dependencies,
    );
    expect(rejected).toMatchObject({
      value: 'rejected-response',
      execution: { status: 'completed_no_action' },
    });
    expect(dependencies.settleSuspension).toHaveBeenCalledWith(
      expect.objectContaining({
        suspensionId: repaused.execution.suspension.suspensionId,
        attempt: 1,
        resumeAttemptId: 'resume-second',
      }),
    );
    expect(mockedDelete).toHaveBeenCalledWith(
      conversationId,
      repaused.execution.suspension.checkpoint.checkpointNs,
      checkpointOwnerNamespacePrefix('user-1'),
      undefined,
    );
    expect(dependencies.commitState).not.toHaveBeenCalled();
  });

  it('carries applied expected-action evidence across a later re-pause', async () => {
    let storedSuspension: IAgentEventActorSuspension | undefined;
    let pendingPause:
      | {
          actionId: string;
          jobCreatedAt: number;
          interrupt: EventActorInterrupt;
        }
      | undefined;
    let observedAction: { toolName: string; toolCallId?: string } | undefined;
    const dependencies = {
      ...deps(),
      storeSuspension: jest.fn(async (input) => {
        storedSuspension = {
          suspension: input.suspension,
          actionId: input.actionId,
          jobCreatedAt: input.jobCreatedAt,
          appliedAction: input.appliedAction,
          status: 'pending',
          observedAt: new Date(),
        };
        return { status: 'stored' as const };
      }),
      claimSuspension: jest.fn(async ({ resumeAttemptId }) => {
        if (storedSuspension == null) {
          throw new Error('test suspension was not stored');
        }
        storedSuspension = { ...storedSuspension, status: 'claimed', resumeAttemptId };
        return { status: 'claimed' as const };
      }),
      settleSuspension: jest.fn(async () => ({ status: 'settled' as const })),
    };
    dependencies.getSnapshot.mockImplementation(async () => ({
      state,
      reconciliations: [],
      legacyTurn: null,
      suspension: storedSuspension ?? null,
      epoch,
    }));
    const initial = await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-action-repause',
        event: { id: 'event-action-repause' },
        signal: new AbortController().signal,
        invoke: async () => 'initial-pause',
        readAppliedAction: () => undefined,
        readSuspension: () => ({
          actionId: 'detached-task',
          jobCreatedAt: 801,
          interrupt: { id: 'detached-task', payload: { type: 'detached' } },
        }),
      },
      dependencies,
    );
    if (initial.execution.status !== 'suspended') {
      throw new Error('test setup did not suspend');
    }
    observedAction = { toolName: 'submit_move', toolCallId: 'call-detached' };
    pendingPause = {
      actionId: 'ask-user',
      jobCreatedAt: 802,
      interrupt: { id: 'ask-user', payload: { type: 'ask_user_question' } },
    };
    const repaused = await resumeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        suspension: initial.execution.suspension,
        resumeAttemptId: 'resume-detached',
        resumeValue: { status: 'succeeded' },
        signal: new AbortController().signal,
        resume: async () => 'asks-user',
        readAppliedAction: () => observedAction,
        readSuspension: () => pendingPause,
      },
      dependencies,
    );
    expect(repaused.execution.status).toBe('suspended');
    expect(dependencies.storeSuspension).toHaveBeenLastCalledWith(
      expect.objectContaining({ appliedAction: observedAction }),
    );
    if (repaused.execution.status !== 'suspended') {
      throw new Error('test setup did not re-pause');
    }
    observedAction = undefined;
    pendingPause = undefined;
    const completed = await resumeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        suspension: repaused.execution.suspension,
        resumeAttemptId: 'resume-human',
        resumeValue: { answer: 'continue' },
        signal: new AbortController().signal,
        resume: async () => 'completed',
        readAppliedAction: () => observedAction,
        readSuspension: () => pendingPause,
      },
      dependencies,
    );
    expect(completed.execution).toMatchObject({
      status: 'applied',
      result: { action: { toolName: 'submit_move', toolCallId: 'call-detached' } },
    });
  });

  it('cold-starts once, then forks and warm-continues only the next event', async () => {
    const dependencies = deps();
    const invocations: Array<{ continuation: string; checkpointId?: string }> = [];
    const run = async (invocationId: string) =>
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId,
          event: { id: invocationId, type: 'turn' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async (context) => {
            invocations.push({
              continuation: context.continuation,
              ...(context.checkpointId == null ? {} : { checkpointId: context.checkpointId }),
            });
            return `response-${invocationId}`;
          },
          readAppliedAction: () => ({ toolName: 'submit_move', toolCallId: invocationId }),
        },
        dependencies,
      );

    const first = await run('event-1');
    const second = await run('event-2');

    expect(first).toMatchObject({ value: 'response-event-1', execution: { status: 'applied' } });
    expect(second).toMatchObject({ value: 'response-event-2', execution: { status: 'applied' } });
    expect(invocations).toEqual([
      { continuation: 'cold' },
      { continuation: 'warm', checkpointId: 'checkpoint-1' },
    ]);
    expect(mockedFork).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: 'checkpoint-1' }),
      expect.stringMatching(/^event-actor\//),
      'event-2',
      undefined,
      undefined,
      checkpointOwnerNamespacePrefix('user-1'),
    );
    expect(state).toMatchObject({ generation: 2, checkpoint: { checkpointId: 'checkpoint-2' } });
  });

  it('rebuilds on a missing or changed context fingerprint and stamps the new head', async () => {
    const current = createAgentContextFingerprint({ agents: [{ id: 'agent-1', version: 2 }] });
    state = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-old-context',
        checkpointNs: 'event-actor/old-context',
      },
    };
    const dependencies = deps();
    let continuation: 'warm' | 'cold' | undefined;

    await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-new-context',
        event: { id: 'event-new-context', type: 'turn' },
        signal: new AbortController().signal,
        contextFingerprint: current,
        invoke: async (context) => {
          continuation = context.continuation;
          return 'response';
        },
        readAppliedAction: () => ({ toolName: 'submit_move' }),
      },
      dependencies,
    );

    expect(continuation).toBe('cold');
    expect(mockedFork).not.toHaveBeenCalled();
    expect(state?.contextFingerprint).toEqual(current);
  });

  it('validates the stored Skill manifest before warm continuation and commits additions', async () => {
    const current = createAgentContextFingerprint({ agents: [{ id: 'agent-1', version: 2 }] });
    const storedSkill = { id: 'skill-1', name: 'analysis', version: 3 };
    const invokedSkill = { id: 'skill-2', name: 'reporting', version: 1 };
    const storedCompactionSemanticIndex = {
      version: 1 as const,
      entries: [
        {
          type: 'activity_phase' as const,
          sourceMessageId: 'assistant-history',
          sourceContentIndex: 1,
          revision: 1,
          status: 'committed' as const,
          text: 'Verified the release state',
        },
      ],
    };
    state = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-compatible',
        checkpointNs: 'event-actor/compatible',
      },
      contextFingerprint: current,
      skillManifest: [storedSkill],
      discoveredToolNames: ['deferred_lookup'],
      summary: { text: 'Earlier compacted context.', tokenCount: 12 },
      contextMeta: { calibrationRatio: 1.25, encoding: 'o200k_base' },
      compactionSemanticIndex: storedCompactionSemanticIndex,
    };
    let continuation: 'warm' | 'cold' | undefined;
    const checkpointMessageOverlay = { source: 'skill', messages: [] };

    await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-skill-context',
        event: { id: 'event-skill-context', type: 'turn' },
        signal: new AbortController().signal,
        resolveContext: async (observed) => ({
          fingerprint: current,
          skillManifest: observed.skillManifest ?? [],
          discoveredToolNames: observed.discoveredToolNames ?? [],
          summary: observed.summary,
          contextMeta: observed.contextMeta,
          compactionSemanticIndex: observed.compactionSemanticIndex,
          checkpointMessageOverlay,
        }),
        readResultContext: async () => ({
          fingerprint: current,
          skillManifest: [storedSkill, invokedSkill],
          discoveredToolNames: ['deferred_lookup', 'deferred_write'],
          summary: { text: 'Updated compacted context.', tokenCount: 15 },
          contextMeta: { calibrationRatio: 1.3, encoding: 'o200k_base' },
          compactionSemanticIndex: storedCompactionSemanticIndex,
        }),
        invoke: async (context) => {
          continuation = context.continuation;
          return 'response';
        },
        readAppliedAction: () => ({ toolName: 'submit_move' }),
      },
      deps(),
    );

    expect(continuation).toBe('warm');
    expect(state?.skillManifest).toEqual([storedSkill, invokedSkill]);
    expect(state?.discoveredToolNames).toEqual(['deferred_lookup', 'deferred_write']);
    expect(state?.summary).toEqual({ text: 'Updated compacted context.', tokenCount: 15 });
    expect(state?.contextMeta).toEqual({ calibrationRatio: 1.3, encoding: 'o200k_base' });
    expect(state?.compactionSemanticIndex).toEqual(storedCompactionSemanticIndex);
    expect(mockedFork).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'event-skill-context',
      undefined,
      checkpointMessageOverlay,
      checkpointOwnerNamespacePrefix('user-1'),
    );
  });

  it('commits from the execution-time receipt when run steps lag sendMessage', async () => {
    const dependencies = deps();
    const expectedAction = { toolName: 'submit_move', argumentSubset: { gameId: 'game-1' } };
    const invocations: Array<{ continuation: string }> = [];
    let toolExecutions = 0;
    const run = async (invocationId: string) => {
      const recorder = createAgentEventActionRecorder(expectedAction);
      return executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId,
          event: { id: invocationId, type: 'turn' },
          expectedAction,
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async (context) => {
            invocations.push({ continuation: context.continuation });
            toolExecutions += 1;
            recorder.observeToolEnd({
              input: { gameId: 'game-1', move: 'e4' },
              output: {
                name: 'submit_move_mcp_chess',
                tool_call_id: `call-${invocationId}`,
                content: '{"ok":true}',
              },
            });
            return `response-${invocationId}`;
          },
          /** Reproduces the observed race: the run-step collection is still
           * empty the instant sendMessage resolves, so only the graph-context
           * receipt carries the applied-action proof. */
          readAppliedAction: () =>
            recorder.read() ?? findAgentEventAppliedAction(expectedAction, [], []),
        },
        dependencies,
      );
    };

    const first = await run('event-1');
    const second = await run('event-2');

    expect(first.execution).toMatchObject({
      status: 'applied',
      result: { action: { toolName: 'submit_move_mcp_chess', toolCallId: 'call-event-1' } },
    });
    expect(second.execution).toMatchObject({ status: 'applied' });
    expect(invocations).toEqual([{ continuation: 'cold' }, { continuation: 'warm' }]);
    expect(toolExecutions).toBe(2);
    expect(state).toMatchObject({ generation: 2, checkpoint: { checkpointId: 'checkpoint-2' } });
  });

  it('refuses to prepare while a legacy turn fence is open', async () => {
    state = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-fenced',
        checkpointNs: 'event-actor/fenced',
      },
    };
    legacyTurn = { token: 'legacy-live', startedAt: new Date() };
    const dependencies = deps();
    let invoked = false;

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-during-legacy',
          event: { id: 'event-during-legacy' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => {
            invoked = true;
            return 'response';
          },
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('blocked on an in-flight legacy turn');

    expect(invoked).toBe(false);
    expect(mockedFork).not.toHaveBeenCalled();
    expect(dependencies.commitState).not.toHaveBeenCalled();
  });

  it('preserves an old ambiguous fence instead of replaying based on age', async () => {
    legacyTurn = { token: 'legacy-crashed', startedAt: new Date(Date.now() - 120_000) };
    const dependencies = deps();

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-after-crash',
          event: { id: 'event-after-crash' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => 'response',
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('blocked on an in-flight legacy turn');

    /** Elapsed time does not establish whether the external action ran. */
    expect(dependencies.commitState).not.toHaveBeenCalled();
  });

  it('cold-starts after a legacy fallback invalidates the committed head', async () => {
    state = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-before-legacy',
        checkpointNs: 'event-actor/before-legacy',
      },
      requiresColdStart: true,
    };
    const dependencies = deps();
    let continuation: 'warm' | 'cold' | undefined;

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-after-legacy',
          event: { id: 'event-after-legacy' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async (context) => {
            continuation = context.continuation;
            return 'response';
          },
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).resolves.toMatchObject({ execution: { status: 'applied', continuation: 'cold' } });

    expect(continuation).toBe('cold');
    expect(mockedFork).not.toHaveBeenCalled();
    expect(dependencies.commitState).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: expect.objectContaining({ requiresColdStart: true }),
      }),
    );
    expect(state?.requiresColdStart).toBeUndefined();
  });

  it('cannot commit a cold rebuild past a legacy turn its history predates', async () => {
    const dependencies = deps();

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-stale-cold',
          event: { id: 'event-stale-cold' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => {
            /** A concurrent legacy delivery lands after this cold rebuild
             * loaded its history. With no head to mark and nothing else to
             * change, the invalidation epoch is its only durable trace. */
            epoch += 1;
            return 'response';
          },
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('commit_conflict reconciliation');

    expect(state).toBeNull();
    expect(dependencies.commitState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedEpoch: 0 }),
    );
    expect(dependencies.recordReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliation: expect.objectContaining({ status: 'commit_conflict' }),
      }),
    );
  });

  it('cannot clear a cold-start marker written after warm preparation', async () => {
    state = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-warm',
        checkpointNs: 'event-actor/warm',
      },
    };
    const dependencies = deps();

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-raced-by-legacy',
          event: { id: 'event-raced-by-legacy' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => {
            state = { ...state!, requiresColdStart: true };
            return 'response';
          },
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('requires commit_conflict reconciliation');

    expect(dependencies.recordReconciliation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reconciliation: expect.objectContaining({ status: 'commit_conflict' }),
      }),
    );

    expect(dependencies.commitState).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: expect.not.objectContaining({ requiresColdStart: true }),
      }),
    );
    expect(state?.requiresColdStart).toBe(true);
  });

  it('discards a no-action fork without advancing the actor head', async () => {
    state = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-base',
        checkpointNs: 'event-actor/base',
      },
    };
    const dependencies = deps();
    const result = await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-no-action',
        event: { id: 'event-no-action' },
        signal: new AbortController().signal,
        legacyTurnStaleMs: 60_000,
        invoke: async () => 'response',
        readAppliedAction: () => undefined,
      },
      dependencies,
    );

    expect(result.execution.status).toBe('completed_no_action');
    expect(dependencies.commitState).not.toHaveBeenCalled();
    expect(mockedDelete).toHaveBeenCalledWith(
      conversationId,
      expect.stringMatching(/^event-actor\//),
      checkpointOwnerNamespacePrefix('user-1'),
      undefined,
    );
    expect(state.generation).toBe(1);
  });

  it('preserves action evidence when the provider fails after the tool completed', async () => {
    const dependencies = deps();
    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-action-then-error',
          event: { id: 'event-action-then-error' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => {
            throw new Error('provider stream failed after tool');
          },
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('provider stream failed after tool');

    expect(dependencies.commitState).toHaveBeenCalledTimes(1);
    expect(dependencies.recordReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliation: expect.objectContaining({
          invocationId: 'event-action-then-error',
          status: 'invocation_pending',
        }),
      }),
    );
    expect(dependencies.resolveReconciliation).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(mockedDeleteReference).not.toHaveBeenCalled();
  });

  it('retains an applied fork when its terminal checkpoint cannot be observed', async () => {
    mockedCapture.mockResolvedValueOnce(null);
    const dependencies = deps();
    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-checkpoint-indeterminate',
          event: { id: 'event-checkpoint-indeterminate' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => 'response',
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('requires commit_indeterminate reconciliation');

    expect(dependencies.commitState).not.toHaveBeenCalled();
    expect(dependencies.recordReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliation: expect.objectContaining({ status: 'commit_indeterminate' }),
      }),
    );
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(mockedDeleteReference).not.toHaveBeenCalled();
  });

  it('retains applied-action evidence when result context capture fails', async () => {
    const dependencies = deps();
    let toolExecutions = 0;
    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-context-indeterminate',
          event: { id: 'event-context-indeterminate' },
          signal: new AbortController().signal,
          invoke: async () => {
            toolExecutions += 1;
            return 'response';
          },
          readAppliedAction: () => ({ toolName: 'submit_move' }),
          readResultContext: async () => {
            throw new Error('memory partition unavailable');
          },
        },
        dependencies,
      ),
    ).rejects.toThrow('requires commit_indeterminate reconciliation');

    expect(toolExecutions).toBe(1);
    expect(dependencies.commitState).not.toHaveBeenCalled();
    expect(dependencies.recordReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliation: expect.objectContaining({ status: 'commit_indeterminate' }),
      }),
    );
    expect(mockedCapture).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(mockedDeleteReference).not.toHaveBeenCalled();
  });

  it('recovers an indeterminate cleanup after the actor head was committed', async () => {
    state = {
      generation: 2,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-base',
        checkpointNs: 'event-actor/base',
      },
      previousCheckpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-old',
        checkpointNs: 'event-actor/old',
      },
    };
    mockedDeleteReference.mockRejectedValueOnce(new Error('checkpoint cleanup unavailable'));
    const dependencies = deps();
    const result = await executeAgentEventActor(
      {
        user: 'user-1',
        conversationId,
        invocationId: 'event-commit-then-cleanup-error',
        event: { id: 'event-commit-then-cleanup-error' },
        signal: new AbortController().signal,
        legacyTurnStaleMs: 60_000,
        invoke: async () => 'response',
        readAppliedAction: () => ({ toolName: 'submit_move' }),
      },
      dependencies,
    );

    expect(result.execution.status).toBe('applied');
    expect(dependencies.recordReconciliation).toHaveBeenCalledTimes(1);
    expect(dependencies.recordReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliation: expect.objectContaining({ status: 'invocation_pending' }),
      }),
    );
    expect(state.generation).toBe(3);
  });

  it('persists and surfaces a checkpoint conflict after the action was applied', async () => {
    state = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-base',
        checkpointNs: 'event-actor/base',
      },
    };
    const dependencies = deps();

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-conflict',
          event: { id: 'event-conflict' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => {
            state = {
              generation: 2,
              checkpoint: {
                threadId: conversationId,
                checkpointId: 'checkpoint-competing',
                checkpointNs: 'event-actor/competing',
              },
            };
            return 'response';
          },
          readAppliedAction: () => ({ toolName: 'submit_move', toolCallId: 'call-conflict' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('requires commit_conflict reconciliation');

    expect(dependencies.recordReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliation: expect.objectContaining({
          invocationId: 'event-conflict',
          status: 'commit_conflict',
          action: { toolName: 'submit_move', toolCallId: 'call-conflict' },
        }),
      }),
    );
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(mockedDeleteReference).not.toHaveBeenCalled();
  });

  it('still records reconciliation when an indeterminate commit cannot be read back', async () => {
    const baseState: IAgentEventActorState = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-base',
        checkpointNs: 'event-actor/base',
      },
    };
    const dependencies = {
      getSnapshot: jest
        .fn()
        .mockResolvedValueOnce({
          state: baseState,
          reconciliations: [],
          legacyTurn: null,
          suspension: null,
          epoch: 0,
        })
        .mockRejectedValueOnce(new Error('readback unavailable')),
      commitState: jest.fn(async () => {
        throw new Error('commit result unavailable');
      }),
      recordReconciliation: jest.fn(async () => true),
      resolveReconciliation: jest.fn(async () => true),
    };

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-ambiguous-commit',
          event: { id: 'event-ambiguous-commit' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => 'response',
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('requires commit_indeterminate reconciliation');

    expect(dependencies.recordReconciliation).toHaveBeenCalledTimes(2);
    expect(dependencies.recordReconciliation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reconciliation: expect.objectContaining({ status: 'commit_indeterminate' }),
      }),
    );
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(mockedDeleteReference).not.toHaveBeenCalled();
  });

  it('does not clear a checkpoint marker before durable history is verified', async () => {
    const authoritative: IAgentEventActorState = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-authoritative',
        checkpointNs: 'event-actor/authoritative',
      },
    };
    state = authoritative;
    const marker = {
      invocationId: 'event-recovered',
      status: 'commit_indeterminate' as const,
      checkpoint: authoritative.checkpoint,
      action: { toolName: 'submit_move' },
      observedAt: new Date(),
    };
    const dependencies = deps();
    dependencies.getSnapshot.mockResolvedValueOnce({
      state: authoritative,
      reconciliations: [marker],
      legacyTurn: null,
      suspension: null,
      epoch: 0,
    });

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-next',
          event: { id: 'event-next' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => 'response',
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('blocked on commit_indeterminate reconciliation');

    expect(dependencies.resolveReconciliation).not.toHaveBeenCalled();
  });

  it('does not clear a persistence failure merely because its checkpoint is authoritative', async () => {
    const authoritative: IAgentEventActorState = {
      generation: 1,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-with-missing-history',
        checkpointNs: 'event-actor/missing-history',
      },
    };
    const dependencies = {
      ...deps(),
      getSnapshot: jest.fn(async () => ({
        state: authoritative,
        reconciliations: [
          {
            invocationId: 'event-persistence-failed',
            status: 'persistence_failed' as const,
            checkpoint: authoritative.checkpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
        legacyTurn: null,
        suspension: null,
        epoch: 0,
      })),
    };

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-after-persistence-failure',
          event: { id: 'event-after-persistence-failure' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => 'response',
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('blocked on persistence_failed reconciliation');
    expect(dependencies.resolveReconciliation).not.toHaveBeenCalled();
  });

  it('blocks new invocations while a prior applied fork needs reconciliation', async () => {
    const dependencies = {
      getSnapshot: jest.fn(async () => ({
        state: null,
        reconciliations: [
          {
            invocationId: 'event-conflict',
            status: 'commit_conflict' as const,
            checkpoint: {
              threadId: conversationId,
              checkpointNs: 'event-actor/conflict',
            },
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
        legacyTurn: null,
        suspension: null,
        epoch: 0,
      })),
      commitState: jest.fn(),
      recordReconciliation: jest.fn(),
      resolveReconciliation: jest.fn(),
    };

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-after-conflict',
          event: { id: 'event-after-conflict' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => 'response',
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('blocked on commit_conflict reconciliation');
    expect(mockedGetCheckpointer).not.toHaveBeenCalled();
  });

  it('refuses a cold start after its bound child disappeared', async () => {
    const dependencies = {
      getSnapshot: jest.fn(async () => undefined),
      commitState: jest.fn(),
      recordReconciliation: jest.fn(),
      resolveReconciliation: jest.fn(),
    };

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          invocationId: 'event-after-delete',
          event: { id: 'event-after-delete' },
          signal: new AbortController().signal,
          legacyTurnStaleMs: 60_000,
          invoke: async () => 'response',
          readAppliedAction: () => ({ toolName: 'submit_move' }),
        },
        dependencies,
      ),
    ).rejects.toThrow('Event actor binding is no longer active');
    expect(mockedGetCheckpointer).not.toHaveBeenCalled();
  });

  it('replays a delivery receipt and cleans its stranded active marker without executing', async () => {
    const checkpoint = {
      threadId: conversationId,
      checkpointId: 'checkpoint-terminal',
      checkpointNs: 'event-actor/event-replay',
    };
    const invoke = jest.fn(async () => 'must not run');
    const clearReconciliation = jest.fn(async () => true);
    const dependencies = {
      ...deps(),
      getSnapshot: jest.fn(async () => ({
        state: { generation: 1, checkpoint },
        reconciliations: [
          {
            invocationId: 'event-replay',
            status: 'history_persisted' as const,
            checkpoint,
            action: { toolName: 'submit_move' },
            observedAt: new Date(),
          },
        ],
        legacyTurn: null,
        suspension: null,
        epoch: 0,
      })),
      getReceipt: jest.fn(async () => ({
        bindingId: 'binding-1',
        resolution: 'checkpoint_verified' as const,
        checkpoint,
        action: { toolName: 'submit_move' },
        settledAt: new Date(),
      })),
      clearReconciliation,
    };

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          bindingId: 'binding-1',
          invocationId: 'event-replay',
          event: { id: 'event-replay' },
          signal: new AbortController().signal,
          invoke,
          readAppliedAction: () => undefined,
        },
        dependencies,
      ),
    ).rejects.toThrow('already has a terminal receipt');

    expect(clearReconciliation).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId,
      invocationId: 'event-replay',
      checkpoint,
      resolution: 'checkpoint_verified',
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(dependencies.recordReconciliation).not.toHaveBeenCalled();
  });

  it('abandons the lifecycle when delivery-owned action admission already settled', async () => {
    const invoke = jest.fn(async () => 'must not run');
    const resolveReconciliation = jest.fn(async () => true);
    const dependencies = {
      ...deps(),
      getReceipt: jest.fn().mockResolvedValue(null),
      admitAction: jest.fn().mockResolvedValue(false),
      resolveReconciliation,
    };

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          bindingId: 'binding-1',
          invocationId: 'event-race',
          event: { id: 'event-race' },
          signal: new AbortController().signal,
          invoke,
          readAppliedAction: () => undefined,
        },
        dependencies,
      ),
    ).rejects.toThrow('action admission was already consumed or settled');

    expect(dependencies.recordReconciliation).toHaveBeenCalledTimes(1);
    expect(dependencies.admitAction).toHaveBeenCalledWith({
      deliveryKey: 'event-race',
      user: 'user-1',
      bindingId: 'binding-1',
      conversationId,
      admittedAt: expect.any(Date),
      admissionId: expect.any(String),
    });
    expect(resolveReconciliation).toHaveBeenNthCalledWith(1, {
      user: 'user-1',
      conversationId,
      invocationId: 'event-race',
      checkpoint: expect.objectContaining({ threadId: conversationId }),
      expectedActionAdmitted: false,
      resolution: 'invocation_abandoned',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('releases delivery admission when the actor completes without an external action', async () => {
    const dependencies = {
      ...deps(),
      getReceipt: jest.fn().mockResolvedValue(null),
    };

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          bindingId: 'binding-1',
          invocationId: 'event-no-action',
          event: { id: 'event-no-action' },
          signal: new AbortController().signal,
          invoke: async () => 'no action',
          readAppliedAction: () => undefined,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({ execution: { status: 'completed_no_action' } });

    expect(dependencies.releaseAction).toHaveBeenCalledWith({
      deliveryKey: 'event-no-action',
      user: 'user-1',
      bindingId: 'binding-1',
      conversationId,
      admissionId: expect.any(String),
    });
    expect(dependencies.releaseAction.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.resolveReconciliation.mock.invocationCallOrder[0],
    );
  });

  it('recovers a no-action lifecycle after admission was released before owner exit', async () => {
    const invoke = jest.fn(async () => 'retried without action');
    const checkpoint = {
      threadId: conversationId,
      checkpointNs: 'event-actor/orphaned-no-action',
    };
    const dependencies = {
      ...deps(),
      getReceipt: jest.fn().mockResolvedValue(null),
    };
    dependencies.getSnapshot.mockResolvedValue({
      state: null,
      reconciliations: [
        {
          invocationId: 'event-orphaned-no-action',
          actionAdmitted: true,
          status: 'invocation_pending',
          checkpoint,
          action: { toolName: 'submit_move' },
          observedAt: new Date(),
        },
      ],
      legacyTurn: null,
      suspension: null,
      epoch: 0,
    });

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          bindingId: 'binding-1',
          invocationId: 'event-orphaned-no-action',
          event: { id: 'event-orphaned-no-action' },
          signal: new AbortController().signal,
          invoke,
          readAppliedAction: () => undefined,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({ execution: { status: 'completed_no_action' } });

    expect(dependencies.hasActionAdmission).toHaveBeenCalledWith({
      deliveryKey: 'event-orphaned-no-action',
      user: 'user-1',
      bindingId: 'binding-1',
      conversationId,
      admissionId: expect.any(String),
    });
    expect(dependencies.resolveReconciliation).toHaveBeenNthCalledWith(1, {
      user: 'user-1',
      conversationId,
      invocationId: 'event-orphaned-no-action',
      checkpoint,
      expectedActionAdmitted: true,
      resolution: 'invocation_abandoned',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('never invokes after a retry supersedes its pre-admission lifecycle', async () => {
    const invoke = jest.fn(async () => 'must not run');
    const dependencies = {
      ...deps(),
      recordReconciliation: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      admitAction: jest.fn().mockResolvedValue(true),
      releaseAction: jest.fn().mockResolvedValue(true),
      getReceipt: jest.fn().mockResolvedValue(null),
    };

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          bindingId: 'binding-1',
          invocationId: 'event-pre-admission-race',
          event: { id: 'event-pre-admission-race' },
          signal: new AbortController().signal,
          invoke,
          readAppliedAction: () => undefined,
        },
        dependencies,
      ),
    ).rejects.toThrow('admission lifecycle was superseded before invoke');

    expect(dependencies.admitAction).toHaveBeenCalledTimes(1);
    expect(dependencies.releaseAction).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not clear an admission it failed to acquire', async () => {
    const invoke = jest.fn(async () => 'must not run');
    const dependencies = {
      ...deps(),
      recordReconciliation: jest.fn().mockResolvedValue(true),
      admitAction: jest.fn().mockResolvedValue(false),
      getReceipt: jest.fn().mockResolvedValue(null),
    };

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          bindingId: 'binding-1',
          invocationId: 'event-orphaned-admission',
          event: { id: 'event-orphaned-admission' },
          signal: new AbortController().signal,
          invoke,
          readAppliedAction: () => undefined,
        },
        dependencies,
      ),
    ).rejects.toThrow('action admission was already consumed or settled');

    expect(dependencies.resolveReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'event-orphaned-admission',
        expectedActionAdmitted: false,
        resolution: 'invocation_abandoned',
      }),
    );
    expect(dependencies.releaseAction).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not release or replay while legacy terminal proof awaits migration', async () => {
    const invoke = jest.fn(async () => 'must not run');
    const dependencies = {
      ...deps(),
      getReceipt: jest.fn().mockResolvedValue(null),
    };
    dependencies.getSnapshot.mockResolvedValue({
      state: null,
      reconciliations: [
        {
          invocationId: 'event-legacy-terminal',
          status: 'settled',
          resolution: 'checkpoint_verified',
          checkpoint: {
            threadId: conversationId,
            checkpointId: 'checkpoint-terminal',
            checkpointNs: 'event-actor/terminal',
          },
          action: { toolName: 'submit_move' },
          observedAt: new Date(),
        },
      ],
      legacyTurn: null,
      suspension: null,
      epoch: 0,
    });

    await expect(
      executeAgentEventActor(
        {
          user: 'user-1',
          conversationId,
          bindingId: 'binding-1',
          invocationId: 'event-legacy-terminal',
          event: { id: 'event-legacy-terminal' },
          signal: new AbortController().signal,
          invoke,
          readAppliedAction: () => undefined,
        },
        dependencies,
      ),
    ).rejects.toThrow('legacy terminal proof awaiting migration');

    expect(dependencies.admitAction).not.toHaveBeenCalled();
    expect(dependencies.releaseAction).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
