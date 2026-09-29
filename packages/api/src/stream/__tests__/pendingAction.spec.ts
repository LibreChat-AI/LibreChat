import type { Agents } from 'librechat-data-provider';
import {
  GenerationPublicationFencedError,
  PAUSE_PERSISTENCE_TIMEOUT_ERROR,
} from '~/stream/interfaces/IJobStore';
import { ApprovalLifecycle, PendingActionExpiredError } from '~/stream/ApprovalLifecycle';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';

jest.spyOn(console, 'log').mockImplementation();

describe('ApprovalLifecycle via GenerationJobManager.approvals (in-memory)', () => {
  let manager: GenerationJobManagerClass;
  let jobStore: InMemoryJobStore;
  let eventTransport: InMemoryEventTransport;

  beforeEach(() => {
    jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    eventTransport = new InMemoryEventTransport();
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  function buildAction(streamId: string, overrides: Partial<Agents.PendingAction> = {}) {
    const payload = buildToolApprovalPayload([
      { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_abc' },
    ]);
    const action = buildPendingAction(payload, {
      streamId,
      conversationId: streamId,
      runId: 'run-1',
      responseMessageId: 'msg-1',
    });
    return { ...action, ...overrides };
  }

  describe('pause', () => {
    test('running → requires_action, persisting the pending record', async () => {
      const streamId = 'stream-pause';
      await manager.createJob(streamId, 'user-1');

      const action = buildAction(streamId);
      expect(await manager.approvals.pause(streamId, action)).toBe(true);

      expect(await manager.getJobStatus(streamId)).toBe('requires_action');
      const pending = await manager.approvals.peek(streamId);
      expect(pending?.actionId).toBe(action.actionId);
      expect(pending?.payload.type).toBe('tool_approval');
      if (pending?.payload.type === 'tool_approval') {
        expect(pending.payload.action_requests[0].name).toBe('shell');
      }
    });

    test('refuses an action whose deadline passed before the pause transition', async () => {
      const streamId = 'stream-expired-before-pause';
      await manager.createJob(streamId, 'user-1');

      await expect(
        manager.approvals.pause(streamId, buildAction(streamId, { expiresAt: Date.now() - 1 })),
      ).rejects.toBeInstanceOf(PendingActionExpiredError);
      await expect(manager.getJob(streamId)).resolves.toMatchObject({ status: 'running' });
      await expect(manager.approvals.peek(streamId)).resolves.toBeNull();
    });

    test('refuses an action that expires while the pause transition is waiting on storage', async () => {
      const streamId = 'stream-expired-during-pause';
      await manager.createJob(streamId, 'user-1');
      const expiresAt = Date.now() + 1000;
      const originalTransition = jobStore.transitionStatus.bind(jobStore);
      const now = jest.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
      const transition = jest
        .spyOn(jobStore, 'transitionStatus')
        .mockImplementationOnce(async (...args) => {
          now.mockReturnValue(expiresAt);
          return originalTransition(...args);
        });

      try {
        await expect(
          manager.approvals.pause(streamId, buildAction(streamId, { expiresAt })),
        ).rejects.toBeInstanceOf(PendingActionExpiredError);
      } finally {
        transition.mockRestore();
        now.mockRestore();
      }
      await expect(manager.getJob(streamId)).resolves.toMatchObject({ status: 'running' });
      await expect(manager.approvals.peek(streamId)).resolves.toBeNull();
    });

    test('a later ask retains a legacy answer for ordered cross-replica reconstruction', async () => {
      const streamId = 'stream-repause-retains-legacy-answer';
      await manager.createJob(streamId, 'user-1');
      const firstAction = buildAction(streamId);
      expect(await manager.approvals.pause(streamId, firstAction)).toBe(true);
      expect(
        await manager.approvals.resolve(streamId, firstAction.actionId, {
          resolvedAskUserQuestions: [
            {
              request: 'Which environment?',
              output: 'staging',
            },
          ],
        }),
      ).toBe(true);

      expect(
        await manager.approvals.pause(
          streamId,
          buildAction(streamId, {
            payload: {
              type: 'ask_user_question',
              question: { question: 'Approve deployment?' },
              tool_call_id: 'ask-2',
            },
          }),
        ),
      ).toBe(true);

      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        status: 'requires_action',
        metadata: {
          resolvedAskUserQuestions: [
            {
              request: 'Which environment?',
              output: 'staging',
            },
          ],
        },
      });
    });

    test('a later tool approval retains a legacy answer for cross-replica reconstruction', async () => {
      const streamId = 'stream-repause-retains-legacy-answer';
      await manager.createJob(streamId, 'user-1');
      const firstAction = buildAction(streamId);
      expect(await manager.approvals.pause(streamId, firstAction)).toBe(true);
      expect(
        await manager.approvals.resolve(streamId, firstAction.actionId, {
          resolvedAskUserQuestions: [
            {
              request: 'Which environment?',
              output: 'staging',
            },
          ],
        }),
      ).toBe(true);

      expect(await manager.approvals.pause(streamId, buildAction(streamId))).toBe(true);

      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        status: 'requires_action',
        metadata: {
          resolvedAskUserQuestions: [
            {
              request: 'Which environment?',
              output: 'staging',
            },
          ],
        },
      });
    });

    test('a later pause retains an exact-ID answer for cross-replica reconstruction', async () => {
      const streamId = 'stream-repause-retains-exact-answer';
      await manager.createJob(streamId, 'user-1');
      const firstAction = buildAction(streamId);
      expect(await manager.approvals.pause(streamId, firstAction)).toBe(true);
      expect(
        await manager.approvals.resolve(streamId, firstAction.actionId, {
          resolvedAskUserQuestions: [
            {
              request: 'Which environment?',
              output: 'staging',
              toolCallId: 'ask-1',
            },
          ],
        }),
      ).toBe(true);

      expect(await manager.approvals.pause(streamId, buildAction(streamId))).toBe(true);

      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        status: 'requires_action',
        metadata: {
          resolvedAskUserQuestions: [
            {
              request: 'Which environment?',
              output: 'staging',
              toolCallId: 'ask-1',
            },
          ],
        },
      });
    });

    test('persists discovered tools in the same transition that makes the pause visible', async () => {
      const streamId = 'stream-pause-discoveries';
      await manager.createJob(streamId, 'user-1');

      const action = buildAction(streamId);
      expect(
        await manager.approvals.pause(streamId, action, {
          discoveredTools: ['save_issue_mcp_linear'],
        }),
      ).toBe(true);

      const paused = await manager.getJob(streamId);
      expect(paused?.status).toBe('requires_action');
      expect(paused?.metadata.discoveredTools).toEqual(['save_issue_mcp_linear']);
    });

    test('persists activity phase state in the same transition as the pause', async () => {
      const streamId = 'stream-pause-activity-phase';
      await manager.createJob(streamId, 'user-1');
      const activityPhaseSnapshot = {
        version: 1 as const,
        generated: 0,
        activityCount: 1,
        failedActivityCount: 0,
        partialActivityCount: 0,
        agentIds: [],
        activities: [
          {
            label: 'Inspected the deployment',
            status: 'success' as const,
            startIndex: 0,
          },
        ],
        assistantContext: ['Checking the remaining replicas'],
        pendingReasoning: [],
      };

      expect(
        await manager.approvals.pause(streamId, buildAction(streamId), {
          activityPhaseSnapshot,
        }),
      ).toBe(true);

      const paused = await manager.getJob(streamId);
      expect(paused?.metadata.activityPhaseSnapshot).toEqual(activityPhaseSnapshot);
    });

    test('persists compaction guidance in the same transition as the pause', async () => {
      const streamId = 'stream-pause-compaction-index';
      await manager.createJob(streamId, 'user-1');
      const compactionSemanticIndex = {
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

      expect(
        await manager.approvals.pause(streamId, buildAction(streamId), {
          compactionSemanticIndex,
        }),
      ).toBe(true);

      const paused = await manager.getJob(streamId);
      expect(paused?.metadata.compactionSemanticIndex).toEqual(compactionSemanticIndex);
    });

    test('persists context meta in the same transition as the pause', async () => {
      const streamId = 'stream-pause-context-meta';
      await manager.createJob(streamId, 'user-1');
      const contextMeta = {
        calibrationRatio: 1.25,
        encoding: 'claude',
        fading: { v: 1 as const, budgetTokens: 50_000, masked: true },
        fadingTiers: [{ agentId: 'agent-123', v: 1 as const, budgetTokens: 50_000, masked: true }],
      };

      expect(await manager.approvals.pause(streamId, buildAction(streamId), { contextMeta })).toBe(
        true,
      );

      const paused = await manager.getJob(streamId);
      expect(paused?.metadata.contextMeta).toEqual(contextMeta);
    });

    test('clears the previous pause context meta when a re-pause has none', async () => {
      const streamId = 'stream-pause-context-meta-cleared';
      await manager.createJob(streamId, 'user-1');
      const firstAction = buildAction(streamId);
      const contextMeta = {
        calibrationRatio: 1.25,
        encoding: 'claude',
        fading: { v: 1 as const, budgetTokens: 50_000, masked: true },
        fadingTiers: [{ agentId: 'agent-123', v: 1 as const, budgetTokens: 50_000, masked: true }],
      };

      expect(await manager.approvals.pause(streamId, firstAction, { contextMeta })).toBe(true);
      expect(await manager.approvals.resolve(streamId, firstAction.actionId)).toBe(true);
      expect(await manager.approvals.pause(streamId, buildAction(streamId))).toBe(true);

      const repaused = await manager.getJob(streamId);
      expect(repaused?.status).toBe('requires_action');
      expect(repaused?.metadata.contextMeta).toBeUndefined();
    });

    test('does not write a stale pause or discoveries onto a replacement job', async () => {
      const streamId = 'stream-pause-replaced';
      const original = await manager.createJob(streamId, 'user-1');
      const replacement = await manager.createJob(streamId, 'user-1');

      expect(
        await manager.approvals.pause(streamId, buildAction(streamId), {
          discoveredTools: ['stale_tool'],
          expectedCreatedAt: original.createdAt,
        }),
      ).toBe(false);

      const liveJob = await manager.getJob(streamId);
      expect(liveJob?.createdAt).toBe(replacement.createdAt);
      expect(liveJob?.status).toBe('running');
      expect(liveJob?.metadata.discoveredTools).toBeUndefined();
    });

    test('commits discoveries and the response barrier in the visible pause transition', async () => {
      const streamId = 'stream-pause-discoveries-and-persistence';
      const job = await manager.createJob(streamId, 'user-1');
      const action = buildAction(streamId);

      await expect(
        manager.approvals.pause(streamId, action, {
          expectedCreatedAt: job.createdAt,
          discoveredTools: ['save_issue_mcp_linear'],
          persistencePending: true,
        }),
      ).resolves.toBe(true);
      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        status: 'requires_action',
        metadata: {
          discoveredTools: ['save_issue_mcp_linear'],
          terminalPersistencePending: true,
        },
      });
    });

    test('holds abort behind the paused-response persistence barrier', async () => {
      const streamId = 'stream-pause-persistence-abort-race';
      const job = await manager.createJob(streamId, 'user-1');
      const action = buildAction(streamId);
      await expect(
        manager.approvals.pause(streamId, action, {
          expectedCreatedAt: job.createdAt,
          persistencePending: true,
        }),
      ).resolves.toBe(true);

      let abortSettled = false;
      const aborting = manager
        .abortJob(streamId, { expectedCreatedAt: job.createdAt })
        .then((result) => {
          abortSettled = true;
          return result;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(abortSettled).toBe(false);
      await expect(
        manager.approvals.ownsPausePersistence(streamId, action.actionId, job.createdAt),
      ).resolves.toBe(true);
      await expect(
        manager.approvals.finishPausePersistence(streamId, action.actionId, job.createdAt),
      ).resolves.toBe(true);
      await expect(aborting).resolves.toMatchObject({
        success: true,
        finalEvent: expect.objectContaining({ aborted: true }),
      });
    });

    test('holds approval resume behind the paused-response persistence barrier', async () => {
      const streamId = 'stream-pause-persistence-resume-race';
      const job = await manager.createJob(streamId, 'user-1');
      const action = buildAction(streamId);
      await expect(
        manager.approvals.pause(streamId, action, {
          expectedCreatedAt: job.createdAt,
          persistencePending: true,
        }),
      ).resolves.toBe(true);

      let resumeSettled = false;
      const resuming = manager.approvals
        .resolve(streamId, action.actionId, undefined, job.createdAt)
        .then((result) => {
          resumeSettled = true;
          return result;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(resumeSettled).toBe(false);
      await expect(
        manager.approvals.finishPausePersistence(streamId, action.actionId, job.createdAt),
      ).resolves.toBe(true);
      await expect(resuming).resolves.toBe(true);
      await expect(manager.getJobStatus(streamId)).resolves.toBe('running');
    });

    test('failed pause persistence atomically beats a waiting resume and parks steers', async () => {
      const streamId = 'stream-pause-persistence-failure-race';
      const job = await manager.createJob(streamId, 'user-1');
      const action = buildAction(streamId);
      const waitingSteer = {
        steerId: 'steer-waiting-on-failed-pause',
        text: 'preserve me after the failed pause',
        userId: 'user-1',
        createdAt: Date.now(),
      };
      await expect(manager.steering.enqueue(streamId, waitingSteer, job.createdAt)).resolves.toBe(
        1,
      );
      await expect(
        manager.approvals.pause(streamId, action, {
          expectedCreatedAt: job.createdAt,
          persistencePending: true,
        }),
      ).resolves.toBe(true);

      let resumeSettled = false;
      const resuming = manager.approvals
        .resolve(streamId, action.actionId, undefined, job.createdAt)
        .then((result) => {
          resumeSettled = true;
          return result;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resumeSettled).toBe(false);

      await expect(
        manager.failPausePersistence(
          streamId,
          action.actionId,
          'paused response was not persisted',
          job.createdAt,
        ),
      ).resolves.toBe(true);
      await expect(resuming).resolves.toBe(false);
      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        status: 'error',
        error: 'paused response was not persisted',
      });
      const failedStoredJob = await jobStore.getJob(streamId);
      expect(failedStoredJob?.pendingAction).toBeUndefined();
      expect(failedStoredJob?.pendingActionId).toBeUndefined();
      expect(failedStoredJob?.terminalPersistencePending).toBeUndefined();
      expect(failedStoredJob?.terminalPersistenceStartedAt).toBeUndefined();
      await expect(manager.steering.peek(streamId, job.createdAt)).resolves.toEqual([]);
      await expect(manager.steering.claim(streamId, { userId: 'user-1' })).resolves.toEqual([
        expect.objectContaining({
          steerId: waitingSteer.steerId,
          text: waitingSteer.text,
        }),
      ]);
    });

    test('failed pause persistence is fenced to the exact action and generation', async () => {
      const streamId = 'stream-pause-persistence-failure-fence';
      const predecessor = await manager.createJob(streamId, 'user-1');
      const action = buildAction(streamId, { actionId: 'reused-pause-action' });
      await expect(
        manager.approvals.pause(streamId, action, {
          expectedCreatedAt: predecessor.createdAt,
          persistencePending: true,
        }),
      ).resolves.toBe(true);

      await expect(
        manager.failPausePersistence(
          streamId,
          'different-action',
          'must not win',
          predecessor.createdAt,
        ),
      ).resolves.toBe(false);
      await expect(
        manager.approvals.ownsPausePersistence(streamId, action.actionId, predecessor.createdAt),
      ).resolves.toBe(true);

      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      const replacement = await manager.createJob(streamId, 'user-1');
      await expect(
        manager.failPausePersistence(
          streamId,
          action.actionId,
          'stale predecessor failure',
          predecessor.createdAt,
        ),
      ).resolves.toBe(false);
      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
    });

    test('fails a crashed pause writer closed after the bounded barrier deadline', async () => {
      const streamId = 'stream-stale-pause-persistence';
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

      try {
        const job = await manager.createJob(streamId, 'user-1');
        const action = buildAction(streamId);
        const waitingSteer = {
          steerId: 'stale-pause-steer',
          text: 'recover me instead of resuming unsafe history',
          userId: 'user-1',
          createdAt: 1_000,
        };
        await expect(manager.steering.enqueue(streamId, waitingSteer, job.createdAt)).resolves.toBe(
          1,
        );
        const onError = jest.fn();
        const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
        await expect(
          manager.approvals.pause(streamId, action, {
            expectedCreatedAt: job.createdAt,
            persistencePending: true,
          }),
        ).resolves.toBe(true);

        now.mockReturnValue(31_001);
        await expect(
          manager.approvals.resolve(streamId, action.actionId, undefined, job.createdAt),
        ).resolves.toBe(false);
        await expect(manager.getJob(streamId)).resolves.toMatchObject({
          status: 'error',
          error: PAUSE_PERSISTENCE_TIMEOUT_ERROR,
        });
        const failedJob = await jobStore.getJob(streamId);
        expect(failedJob?.pendingAction).toBeUndefined();
        expect(failedJob?.pendingActionId).toBeUndefined();
        expect(failedJob?.terminalPersistencePending).toBeUndefined();
        expect(failedJob?.terminalPersistenceStartedAt).toBeUndefined();
        expect(job.abortController.signal.aborted).toBe(true);
        expect(onError).toHaveBeenCalledWith(PAUSE_PERSISTENCE_TIMEOUT_ERROR);
        await expect(manager.steering.claim(streamId, { userId: 'user-1' })).resolves.toEqual([
          expect.objectContaining({ steerId: waitingSteer.steerId, text: waitingSteer.text }),
        ]);
        subscription?.unsubscribe();
      } finally {
        now.mockRestore();
      }
    });

    test('relays a store-only pause timeout into the matching attached runtime once', async () => {
      const streamId = 'stream-remote-stale-pause-persistence';
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

      try {
        const job = await manager.createJob(streamId, 'user-1');
        const action = buildAction(streamId);
        const onError = jest.fn();
        const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
        await expect(
          manager.approvals.pause(streamId, action, {
            expectedCreatedAt: job.createdAt,
            persistencePending: true,
          }),
        ).resolves.toBe(true);
        const broadcast = jest.spyOn(eventTransport, 'emitError');
        const clearContentState = jest.spyOn(jobStore, 'clearContentState');
        expect(job.abortController.signal.aborted).toBe(false);

        now.mockReturnValue(31_001);
        // Model another replica/store cleanup winning the terminal CAS without
        // access to this manager's in-process runtime.
        await jobStore.cleanup();
        await expect(manager.getJob(streamId)).resolves.toMatchObject({
          status: 'error',
          error: PAUSE_PERSISTENCE_TIMEOUT_ERROR,
        });
        expect(onError).not.toHaveBeenCalled();
        expect(clearContentState).not.toHaveBeenCalled();

        const managerWithCleanup = manager as unknown as { cleanup(): Promise<void> };
        await managerWithCleanup.cleanup();
        expect(job.abortController.signal.aborted).toBe(true);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(PAUSE_PERSISTENCE_TIMEOUT_ERROR);
        expect(broadcast).toHaveBeenCalledWith(
          streamId,
          PAUSE_PERSISTENCE_TIMEOUT_ERROR,
          job.createdAt,
        );
        expect(clearContentState).toHaveBeenCalledWith(streamId, job.createdAt);

        await managerWithCleanup.cleanup();
        expect(onError).toHaveBeenCalledTimes(1);
        subscription?.unsubscribe();
      } finally {
        now.mockRestore();
      }
    });

    test('notifies the attached runtime when a locally-won timeout row is immediately evicted', async () => {
      const streamId = 'stream-zero-ttl-stale-pause-persistence';
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

      try {
        const job = await manager.createJob(streamId, 'user-1');
        const action = buildAction(streamId);
        const onError = jest.fn();
        const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
        await expect(
          manager.approvals.pause(streamId, action, {
            expectedCreatedAt: job.createdAt,
            persistencePending: true,
          }),
        ).resolves.toBe(true);
        const originalGetJob = jobStore.getJob.bind(jobStore);
        jest.spyOn(jobStore, 'getJob').mockImplementation(async (...args) => {
          const stored = await originalGetJob(...args);
          return stored?.status === 'error' ? null : stored;
        });

        now.mockReturnValue(31_001);
        await expect(
          manager.approvals.resolve(streamId, action.actionId, undefined, job.createdAt),
        ).resolves.toBe(false);
        expect(job.abortController.signal.aborted).toBe(true);
        expect(onError).toHaveBeenCalledWith(PAUSE_PERSISTENCE_TIMEOUT_ERROR);
        subscription?.unsubscribe();
      } finally {
        now.mockRestore();
      }
    });

    test('returns false when the job is already terminal', async () => {
      const streamId = 'stream-pause-dead';
      await manager.createJob(streamId, 'user-1');
      await manager.completeJob(streamId, 'terminated mid-flight');

      expect(await manager.approvals.pause(streamId, buildAction(streamId))).toBe(false);
      // a late interrupt must NOT resurrect a terminal job into requires_action
      expect(await manager.getJobStatus(streamId)).not.toBe('requires_action');
    });

    test('returns false when the job does not exist', async () => {
      expect(await manager.approvals.pause('nonexistent', buildAction('nonexistent'))).toBe(false);
    });

    test('replacing a paused generation removes its approval and rejects a late decision', async () => {
      const streamId = 'stream-replace-paused-generation';
      const predecessor = await manager.createJob(streamId, 'user-1');
      const action = buildAction(streamId);
      await manager.approvals.pause(streamId, action);
      const replacement = await manager.createJob(streamId, 'user-1');

      expect(replacement.createdAt).not.toBe(predecessor.createdAt);
      expect(await manager.approvals.peek(streamId)).toBeNull();
      expect((await manager.getResumeState(streamId))?.pendingAction).toBeUndefined();
      expect(await manager.approvals.resolve(streamId, action.actionId)).toBe(false);
      expect(await manager.getJobStatus(streamId)).toBe('running');
    });

    test('a predecessor interrupt cannot pause a replacement generation', async () => {
      const streamId = 'stream-pause-epoch-fence';
      const predecessor = await manager.createJob(streamId, 'user-1');
      const replacement = await manager.createJob(streamId, 'user-1');

      await expect(
        manager.approvals.pause(streamId, buildAction(streamId), {
          expectedCreatedAt: predecessor.createdAt,
        }),
      ).resolves.toBe(false);
      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
    });

    test('client-facing copies omit resumeContext/requestFingerprint; the stored record keeps them', async () => {
      const streamId = 'stream-redact';
      await manager.createJob(streamId, 'user-1');

      const action = buildAction(streamId, {
        requestFingerprint: 'fp-hash',
        resumeContext: {
          endpoint: 'agents',
          model_parameters: { temperature: 0.7 },
        },
      });
      expect(await manager.approvals.pause(streamId, action)).toBe(true);

      const resumeState = await manager.getResumeState(streamId);
      expect(resumeState?.pendingAction?.actionId).toBe(action.actionId);
      expect(resumeState?.pendingAction?.resumeContext).toBeUndefined();
      expect(resumeState?.pendingAction?.requestFingerprint).toBeUndefined();

      // The resume route replays from the job store, which must retain the full record.
      const job = await manager.getJob(streamId);
      expect(job?.metadata.pendingAction?.resumeContext).toEqual(action.resumeContext);
      expect(job?.metadata.pendingAction?.requestFingerprint).toBe('fp-hash');
    });
  });

  describe('peek', () => {
    test('returns null for jobs not in requires_action', async () => {
      const streamId = 'stream-running';
      await manager.createJob(streamId, 'user-1');
      expect(await manager.approvals.peek(streamId)).toBeNull();
    });

    test('returns null when the job does not exist', async () => {
      expect(await manager.approvals.peek('nonexistent')).toBeNull();
    });

    test('treats a past-expiresAt record as gone (lazy expiry)', async () => {
      const streamId = 'stream-expired-peek';
      await manager.createJob(streamId, 'user-1');
      const expiresAt = Date.now() + 1000;
      await manager.approvals.pause(streamId, buildAction(streamId, { expiresAt }));

      const now = jest.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
      try {
        expect(await manager.approvals.peek(streamId)).toBeNull();
      } finally {
        now.mockRestore();
      }
    });
  });

  describe('resolve', () => {
    test('requires_action → running, clearing the record, returns true once', async () => {
      const streamId = 'stream-resolve';
      await manager.createJob(streamId, 'user-1');
      await manager.approvals.pause(streamId, buildAction(streamId));

      expect(await manager.approvals.resolve(streamId)).toBe(true);
      expect(await manager.getJobStatus(streamId)).toBe('running');
      expect(await manager.approvals.peek(streamId)).toBeNull();
    });

    test('clears the predecessor Event Actor suspension projection on resume', async () => {
      const streamId = 'stream-resolve-event-actor-suspension';
      const job = await manager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { providerExecutionId: 'provider-paused' },
      });
      const pausedProviderExecutionId = job.metadata.providerExecutionId!;
      const action = buildAction(streamId);
      expect(
        await manager.beginProviderExecution(streamId, job.createdAt, pausedProviderExecutionId),
      ).toBe(true);
      await manager.approvals.pause(streamId, action, {
        expectedCreatedAt: job.createdAt,
        agentEventSuspension: { version: 1, suspensionId: 'suspension-1', attempt: 0 },
      });

      expect(
        await manager.approvals.resolve(
          streamId,
          action.actionId,
          { providerExecutionId: 'provider-resume', providerDrained: true },
          job.createdAt,
        ),
      ).toBe(true);
      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        status: 'running',
        metadata: { providerExecutionId: 'provider-resume' },
      });
      expect((await manager.getJob(streamId))?.metadata.agentEventSuspension).toBeUndefined();
      expect((await manager.getJob(streamId))?.metadata.providerExecutionStartedId).toBeUndefined();
      expect(await manager.beginProviderExecution(streamId, job.createdAt, 'provider-resume')).toBe(
        true,
      );
      expect((await manager.getJob(streamId))?.metadata.providerExecutionStartedId).toBe(
        'provider-resume',
      );
    });

    test('a concurrent double-resolve wins exactly once (race-safe)', async () => {
      const streamId = 'stream-double-resolve';
      await manager.createJob(streamId, 'user-1');
      await manager.approvals.pause(streamId, buildAction(streamId));

      const results = await Promise.all([
        manager.approvals.resolve(streamId),
        manager.approvals.resolve(streamId),
      ]);

      // Exactly one caller may drive the run — the other must be rejected.
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await manager.getJobStatus(streamId)).toBe('running');
    });

    test('publishes the new owner capability in the same CAS that reopens steering', async () => {
      const streamId = 'stream-resolve-capability';
      const job = await manager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { preemptCapable: true },
      });
      await manager.steering.enqueue(streamId, {
        steerId: 'waiting-steer',
        text: 'wait for the new owner',
        userId: 'user-1',
        createdAt: Date.now(),
      });
      const action = buildAction(streamId);
      await manager.approvals.pause(streamId, action);

      expect(
        await manager.approvals.resolve(streamId, action.actionId, {
          preemptCapable: false,
        }),
      ).toBe(true);

      expect((await manager.getJob(streamId))?.metadata.preemptCapable).toBe(false);
      await expect(manager.steering.arm(streamId, 'waiting-steer', job.createdAt)).resolves.toBe(
        'incapable',
      );
    });

    test('returns false when the job is not paused', async () => {
      const streamId = 'stream-resolve-running';
      await manager.createJob(streamId, 'user-1');
      expect(await manager.approvals.resolve(streamId)).toBe(false);
    });

    test('rejects a resolve whose actionId no longer matches (stale-decision guard)', async () => {
      const streamId = 'stream-stale-action';
      await manager.createJob(streamId, 'user-1');
      const action = buildAction(streamId);
      await manager.approvals.pause(streamId, action);

      // A decision targeting a different action must not resume this one.
      expect(await manager.approvals.resolve(streamId, 'some-other-action-id')).toBe(false);
      expect(await manager.getJobStatus(streamId)).toBe('requires_action');

      // The matching actionId resolves it.
      expect(await manager.approvals.resolve(streamId, action.actionId)).toBe(true);
      expect(await manager.getJobStatus(streamId)).toBe('running');
    });

    test('does not resolve a replacement paused on the same action id', async () => {
      const streamId = 'stream-resolve-epoch-fence';
      const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
      try {
        const predecessor = await manager.createJob(streamId, 'user-1');
        const action = buildAction(streamId, { actionId: 'reused-action-id' });
        await manager.approvals.pause(streamId, action);

        now.mockReturnValue(2000);
        const replacement = await manager.createJob(streamId, 'user-1');
        await manager.approvals.pause(streamId, action);

        expect(
          await manager.approvals.resolve(
            streamId,
            action.actionId,
            undefined,
            predecessor.createdAt,
          ),
        ).toBe(false);
        expect(await manager.getJob(streamId)).toMatchObject({
          createdAt: replacement.createdAt,
          status: 'requires_action',
        });
      } finally {
        now.mockRestore();
      }
    });

    test('an expired pending action expires instead of resuming', async () => {
      const streamId = 'stream-resolve-expired';
      await manager.createJob(streamId, 'user-1');
      const expiresAt = Date.now() + 1000;
      await manager.approvals.pause(streamId, buildAction(streamId, { expiresAt }));

      const now = jest.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
      try {
        expect(await manager.approvals.resolve(streamId)).toBe(false);
        expect(await manager.getJobStatus(streamId)).toBe('aborted');
      } finally {
        now.mockRestore();
      }
    });
  });

  describe('expire', () => {
    test('requires_action → aborted, clearing the record, returns true once', async () => {
      const streamId = 'stream-expire';
      await manager.createJob(streamId, 'user-1');
      await manager.approvals.pause(streamId, buildAction(streamId));

      expect(await manager.approvals.expire(streamId)).toBe(true);
      expect(await manager.getJobStatus(streamId)).toBe('aborted');
      expect(await manager.approvals.peek(streamId)).toBeNull();

      // idempotent — a second expire does not fire again
      expect(await manager.approvals.expire(streamId)).toBe(false);
    });

    test('returns false when the job is not paused', async () => {
      const streamId = 'stream-expire-running';
      await manager.createJob(streamId, 'user-1');
      expect(await manager.approvals.expire(streamId)).toBe(false);
    });

    test('a mismatched expectedActionId no-ops (protects a re-paused action from a stale sweep)', async () => {
      const streamId = 'stream-expire-mismatch';
      await manager.createJob(streamId, 'user-1');
      await manager.approvals.pause(streamId, buildAction(streamId, { actionId: 'action-A' }));

      // A sweep that observed an OLDER (now-resolved) action must not abort the current
      // pause — its CAS only fires when the live pendingActionId still matches.
      expect(await manager.approvals.expire(streamId, 'stale-other-action')).toBe(false);
      expect(await manager.getJobStatus(streamId)).toBe('requires_action');

      // The matching id still expires it.
      expect(await manager.approvals.expire(streamId, 'action-A')).toBe(true);
      expect(await manager.getJobStatus(streamId)).toBe('aborted');
    });

    test('sets completedAt so terminal cleanup can reclaim the job', async () => {
      const streamId = 'stream-expire-completed';
      await manager.createJob(streamId, 'user-1');
      await manager.approvals.pause(streamId, buildAction(streamId));

      expect(await manager.approvals.expire(streamId)).toBe(true);
      const job = await manager.getJob(streamId);
      expect(job?.status).toBe('aborted');
      expect(job?.completedAt).toBeGreaterThan(0);
    });
  });

  describe('expireApproval notification', () => {
    test('delivers the exact expired generation to the host lifecycle hook', async () => {
      const streamId = 'stream-expire-host-hook';
      const job = await manager.createJob(streamId, 'user-1');
      await manager.updateMetadata(streamId, {
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      });
      await manager.approvals.pause(streamId, buildAction(streamId));
      const onApprovalExpired = jest.fn(async () => undefined);
      manager.setApprovalExpiredHandler(onApprovalExpired);

      expect(await manager.expireApproval(streamId)).toBe(true);

      expect(onApprovalExpired).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({
          createdAt: job.createdAt,
          status: 'aborted',
          scheduleId: 'schedule-1',
          scheduledFor: '2026-08-17T12:00:00.000Z',
        }),
      );
    });

    test('expires a durable paused job even when no process-local runtime survived', async () => {
      const streamId = 'stream-expire-ownerless-host-hook';
      const job = await jobStore.createJob(streamId, 'user-1', streamId, undefined, {
        scheduleId: 'schedule-ownerless',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      });
      const lifecycle = new ApprovalLifecycle(jobStore);
      const expiresAt = Date.now() + 1_000;
      await lifecycle.pause(streamId, buildAction(streamId, { expiresAt }));
      const onApprovalExpired = jest.fn(async () => undefined);
      manager.setApprovalExpiredHandler(onApprovalExpired);

      const now = jest.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
      try {
        await (
          manager as unknown as { expireStaleApprovals: () => Promise<void> }
        ).expireStaleApprovals();
      } finally {
        now.mockRestore();
      }

      expect(onApprovalExpired).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({
          createdAt: job.createdAt,
          scheduleId: 'schedule-ownerless',
          status: 'aborted',
        }),
      );
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({ status: 'aborted' });
    });

    test('does not expire a replacement paused on the same action id', async () => {
      const streamId = 'stream-expire-epoch-fence';
      const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
      try {
        const predecessor = await manager.createJob(streamId, 'user-1');
        const action = buildAction(streamId, { actionId: 'reused-action-id' });
        await manager.approvals.pause(streamId, action);

        now.mockReturnValue(2000);
        const replacement = await manager.createJob(streamId, 'user-1');
        await manager.approvals.pause(streamId, action);

        expect(await manager.expireApproval(streamId, action.actionId, predecessor.createdAt)).toBe(
          false,
        );
        expect(await manager.getJob(streamId)).toMatchObject({
          createdAt: replacement.createdAt,
          status: 'requires_action',
        });
      } finally {
        now.mockRestore();
      }
    });

    test('publishes a generation-tagged expiry to local and remote subscribers', async () => {
      const streamId = 'stream-expire-local-notification';
      const job = await manager.createJob(streamId, 'user-1');
      const onError = jest.fn();
      const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
      await manager.approvals.pause(streamId, buildAction(streamId));
      const broadcast = jest.spyOn(eventTransport, 'emitError');

      expect(await manager.expireApproval(streamId)).toBe(true);
      expect(onError).toHaveBeenCalledWith('Approval expired before a decision was made');
      expect(broadcast).toHaveBeenCalledWith(
        streamId,
        'Approval expired before a decision was made',
        job.createdAt,
      );

      subscription?.unsubscribe();
    });

    test('does not invoke local expiry fallback when publication is fenced', async () => {
      const streamId = 'stream-expire-publication-fenced';
      const job = await manager.createJob(streamId, 'user-1');
      const onError = jest.fn();
      const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
      await manager.approvals.pause(streamId, buildAction(streamId));
      jest.spyOn(eventTransport, 'emitError').mockImplementation(() => {
        throw new GenerationPublicationFencedError('error', streamId, job.createdAt);
      });

      expect(await manager.expireApproval(streamId)).toBe(true);
      expect(onError).not.toHaveBeenCalled();

      subscription?.unsubscribe();
    });

    test('delivers the stored expiry error to a late subscriber', async () => {
      const streamId = 'stream-expire-late-subscriber';
      await manager.createJob(streamId, 'user-1');
      await manager.approvals.pause(streamId, buildAction(streamId));
      expect(await manager.approvals.expire(streamId)).toBe(true);

      const onError = jest.fn();
      const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(onError).toHaveBeenCalledWith('Approval expired before a decision was made');
      subscription?.unsubscribe();
    });

    test('notifies the observed runtime when zero terminal TTL removes the job hash', async () => {
      const streamId = 'stream-expire-zero-terminal-ttl';
      await manager.createJob(streamId, 'user-1');
      const onError = jest.fn();
      const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
      await manager.approvals.pause(streamId, buildAction(streamId));
      const originalGetJob = jobStore.getJob.bind(jobStore);
      jest.spyOn(jobStore, 'getJob').mockImplementation(async (...args) => {
        const job = await originalGetJob(...args);
        return job?.status === 'aborted' ? null : job;
      });

      expect(await manager.expireApproval(streamId)).toBe(true);
      expect(onError).toHaveBeenCalledWith('Approval expired before a decision was made');
      subscription?.unsubscribe();
    });

    test('notifies after the manager pre-read fails and the expiry CAS removes the job hash', async () => {
      const streamId = 'stream-expire-read-failure-zero-terminal-ttl';
      await manager.createJob(streamId, 'user-1');
      const onError = jest.fn();
      const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
      await manager.approvals.pause(streamId, buildAction(streamId));
      const originalGetJob = jobStore.getJob.bind(jobStore);
      jest
        .spyOn(jobStore, 'getJob')
        .mockRejectedValueOnce(new Error('transient read failure'))
        .mockImplementation(async (...args) => {
          const job = await originalGetJob(...args);
          return job?.status === 'aborted' ? null : job;
        });

      expect(await manager.expireApproval(streamId)).toBe(true);
      expect(onError).toHaveBeenCalledWith('Approval expired before a decision was made');
      subscription?.unsubscribe();
    });

    test('does not notify or mutate a replacement created after the expiry CAS', async () => {
      const streamId = 'stream-expire-replacement-notification';
      const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
      const originalTransition = jobStore.transitionStatus.bind(jobStore);
      let signalExpired: (() => void) | undefined;
      const expired = new Promise<void>((resolve) => {
        signalExpired = resolve;
      });
      let releaseTransition: (() => void) | undefined;
      const transitionGate = new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      jest.spyOn(jobStore, 'transitionStatus').mockImplementation(async (...args) => {
        const transitioned = await originalTransition(...args);
        if (args[1].to === 'aborted' && transitioned) {
          signalExpired?.();
          await transitionGate;
        }
        return transitioned;
      });

      try {
        await manager.createJob(streamId, 'user-1');
        await manager.approvals.pause(streamId, buildAction(streamId));
        const expiring = manager.expireApproval(streamId);
        await expired;

        now.mockReturnValue(2000);
        await manager.createJob(streamId, 'user-1');
        const replacementError = jest.fn();
        const replacementSubscription = await manager.subscribe(
          streamId,
          () => undefined,
          undefined,
          replacementError,
        );

        releaseTransition?.();
        await expect(expiring).resolves.toBe(true);
        await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
          createdAt: 2000,
          status: 'running',
        });
        expect(replacementError).not.toHaveBeenCalled();
        replacementSubscription?.unsubscribe();
      } finally {
        releaseTransition?.();
        now.mockRestore();
      }
    });
  });

  describe('durable approval-expiry host action', () => {
    const sweep = (m: GenerationJobManagerClass) =>
      (m as unknown as { expireStaleApprovals: () => Promise<void> }).expireStaleApprovals();

    async function pauseScheduled(streamId: string) {
      const job = await manager.createJob(streamId, 'user-1');
      await manager.updateMetadata(streamId, {
        scheduleId: 's1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      });
      await manager.approvals.pause(streamId, buildAction(streamId));
      return job;
    }

    test('retains the marker on hook failure and retries it on a later cleanup pass', async () => {
      const streamId = 'stream-host-retry';
      await pauseScheduled(streamId);
      const handler = jest
        .fn<Promise<void>, [string, { scheduleId?: string }]>()
        .mockRejectedValueOnce(new Error('mongo down'))
        .mockResolvedValue(undefined);
      manager.setApprovalExpiredHandler(handler);

      // First expiry wins its CAS, but the host hook FAILS: the durable marker is retained.
      expect(await manager.expireApproval(streamId)).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect((await jobStore.getJob(streamId))?.terminalHostActionPending).toBe(true);
      expect(await jobStore.getTerminalHostActionJobs()).toHaveLength(1);

      // A later cleanup pass re-enumerates the aborted job and retries; it now succeeds
      // and clears the marker.
      await sweep(manager);
      expect(handler).toHaveBeenCalledTimes(2);
      expect((await jobStore.getJob(streamId))?.terminalHostActionPending).toBeUndefined();
      expect(await jobStore.getTerminalHostActionJobs()).toHaveLength(0);
    });

    test('a fresh manager (restart / other replica) retries the pending host action', async () => {
      const streamId = 'stream-host-restart';
      const job = await pauseScheduled(streamId);
      manager.setApprovalExpiredHandler(jest.fn().mockRejectedValue(new Error('down')));
      expect(await manager.expireApproval(streamId)).toBe(true);
      expect((await jobStore.getJob(streamId))?.terminalHostActionPending).toBe(true);

      // Another replica / a restarted process: a fresh manager over the SAME durable store,
      // with NO local runtime for this stream.
      const other = new GenerationJobManagerClass();
      other.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });
      other.initialize();
      const succeeding = jest.fn().mockResolvedValue(undefined);
      other.setApprovalExpiredHandler(succeeding);

      await sweep(other);

      expect(succeeding).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({ createdAt: job.createdAt, scheduleId: 's1' }),
      );
      expect((await jobStore.getJob(streamId))?.terminalHostActionPending).toBeUndefined();
      await other.destroy();
    });

    test('a successful acknowledgement prevents duplicate work on later sweeps', async () => {
      const streamId = 'stream-host-ack';
      await pauseScheduled(streamId);
      const handler = jest.fn().mockResolvedValue(undefined);
      manager.setApprovalExpiredHandler(handler);

      expect(await manager.expireApproval(streamId)).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await jobStore.getTerminalHostActionJobs()).toHaveLength(0);

      await sweep(manager);
      expect(handler).toHaveBeenCalledTimes(1); // no duplicate invocation
    });

    test('passes the committed aborted state to an event outcome handler', async () => {
      const streamId = 'stream-host-event-expiry-state';
      await manager.createJob(streamId, 'user-1');
      await manager.updateMetadata(streamId, { agentEventDeliveryKey: 'delivery-expired' });
      await manager.approvals.pause(streamId, buildAction(streamId));
      const handler = jest.fn().mockResolvedValue(undefined);
      manager.setTerminalHostActionHandler(handler);

      expect(await manager.expireApproval(streamId)).toBe(true);

      expect(handler).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({
          status: 'aborted',
          error: 'Approval expired before a decision was made',
          terminalHostActionPending: true,
        }),
        expect.any(Array),
        expect.any(Array),
      );
    });

    test('clearTerminalHostAction is identity-fenced against a replacement generation', async () => {
      const streamId = 'stream-host-fence';
      const job = await pauseScheduled(streamId);
      manager.setApprovalExpiredHandler(jest.fn().mockRejectedValue(new Error('down')));
      await manager.expireApproval(streamId);
      expect((await jobStore.getJob(streamId))?.terminalHostActionPending).toBe(true);

      // A clear fenced to a DIFFERENT generation must not clear this one's action.
      await jobStore.clearTerminalHostAction(streamId, job.createdAt + 1);
      expect((await jobStore.getJob(streamId))?.terminalHostActionPending).toBe(true);

      // The exact generation clears it.
      await jobStore.clearTerminalHostAction(streamId, job.createdAt);
      expect((await jobStore.getJob(streamId))?.terminalHostActionPending).toBeUndefined();
    });

    test('terminalizes and delivers the terminal state even when the first hook fails', async () => {
      const streamId = 'stream-host-notify';
      await pauseScheduled(streamId);
      manager.setApprovalExpiredHandler(jest.fn().mockRejectedValue(new Error('down')));

      // The CAS + terminal notification proceed regardless of the host hook outcome.
      expect(await manager.expireApproval(streamId)).toBe(true);
      expect(await manager.getJobStatus(streamId)).toBe('aborted');
    });

    test('retention is refreshed on each retry so a long host outage keeps the evidence', async () => {
      const streamId = 'stream-host-refresh';
      await pauseScheduled(streamId);
      manager.setApprovalExpiredHandler(jest.fn().mockRejectedValue(new Error('mongo down')));
      expect(await manager.expireApproval(streamId)).toBe(true);

      const before = (await jobStore.getJob(streamId))?.terminalHostActionRefreshedAt;

      // A later cleanup pass re-enumerates it for retry; the hook still fails.
      await sweep(manager);

      const after = await jobStore.getJob(streamId);
      // Still pending, and its retention basis moved forward — so the bounded retention
      // window measures from the LAST retry, not from when the approval expired.
      expect(after?.terminalHostActionPending).toBe(true);
      expect(after?.terminalHostActionRefreshedAt).toEqual(expect.any(Number));
      if (before != null) {
        expect(after!.terminalHostActionRefreshedAt!).toBeGreaterThanOrEqual(before);
      }
    });

    test('a non-scheduled job with a no-op host hook accumulates no marker', async () => {
      const streamId = 'stream-host-nonsched';
      await manager.createJob(streamId, 'user-1'); // no schedule metadata
      await manager.approvals.pause(streamId, buildAction(streamId));
      // The schedule adapter is installed but owns no action for a non-scheduled job.
      manager.setApprovalExpiredHandler(
        jest.fn(async (_streamId: string, job: { scheduleId?: string }) => {
          if (!job.scheduleId) {
            return;
          }
        }),
      );

      expect(await manager.expireApproval(streamId)).toBe(true);
      // Marked atomically then cleared on the no-op success — nothing lingers.
      expect((await jobStore.getJob(streamId))?.terminalHostActionPending).toBeUndefined();
      expect(await jobStore.getTerminalHostActionJobs()).toHaveLength(0);
    });
  });

  describe('facade integration', () => {
    test('requires_action drops the running count but keeps the user-active set', async () => {
      const streamId = 'stream-counts';
      await manager.createJob(streamId, 'user-counts');

      const before = await manager.getJobCountByStatus();
      expect(before.running).toBe(1);
      expect(before.requires_action).toBe(0);

      await manager.approvals.pause(streamId, buildAction(streamId));

      const after = await manager.getJobCountByStatus();
      expect(after.running).toBe(0);
      expect(after.requires_action).toBe(1);

      // Pending-approval jobs still occupy the user's conversation slot.
      expect(await manager.getActiveJobIdsForUser('user-counts')).toContain(streamId);
    });

    test('getActiveJobIdsForUser excludes terminal jobs but includes requires_action', async () => {
      await manager.createJob('s-running', 'user-mix');
      await manager.createJob('s-paused', 'user-mix');
      await manager.createJob('s-done', 'user-mix');

      await manager.approvals.pause('s-paused', buildAction('s-paused'));
      await manager.completeJob('s-done');

      const active = await manager.getActiveJobIdsForUser('user-mix');
      expect(active.sort()).toEqual(['s-paused', 's-running']);
    });

    test('excludes a pending-approval job whose prompt has expired', async () => {
      const streamId = 'stream-expired-active';
      await manager.createJob(streamId, 'user-exp');
      const expiresAt = Date.now() + 1000;
      await manager.approvals.pause(streamId, buildAction(streamId, { expiresAt }));

      const now = jest.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
      try {
        // Still requires_action, but the prompt is past expiry → no longer active.
        expect(await manager.getActiveJobIdsForUser('user-exp')).not.toContain(streamId);
      } finally {
        now.mockRestore();
      }
    });
  });
});

describe('InMemoryJobStore — approval expiry cleanup', () => {
  test('guards status transitions against a replaced job epoch', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const job = await store.createJob('epoch-guard', 'u1');

    expect(
      await store.transitionStatus('epoch-guard', {
        from: 'running',
        to: 'error',
        expectCreatedAt: job.createdAt + 1,
      }),
    ).toBe(false);
    expect((await store.getJob('epoch-guard'))?.status).toBe('running');

    expect(
      await store.transitionStatus('epoch-guard', {
        from: 'running',
        to: 'error',
        expectCreatedAt: job.createdAt,
      }),
    ).toBe(true);
    expect((await store.getJob('epoch-guard'))?.status).toBe('error');
  });

  test('cleanup() finalizes a past-expiry approval, retaining it for host-hook retry', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    const job = await store.createJob('s1', 'u1');

    const action = buildPendingAction(
      buildToolApprovalPayload([{ name: 'shell', arguments: {}, tool_call_id: 'c1' }]),
      { streamId: 's1', ttlMs: -1000 },
    );
    await store.transitionStatus('s1', {
      from: 'running',
      to: 'requires_action',
      patch: { pendingAction: action, pendingActionId: action.actionId },
    });

    // A past-expiry approval is finalized (aborted) but RETAINED with a pending host-action
    // marker so the manager relay can still run its lifecycle hook (the store cannot know
    // whether one is owed); it is enumerable for that retry.
    await store.cleanup();
    const aborted = await store.getJob('s1');
    expect(aborted?.status).toBe('aborted');
    expect(aborted?.terminalHostActionPending).toBe(true);
    expect(await store.getTerminalHostActionJobs()).toHaveLength(1);

    // Once the host action acknowledges, the marker clears and the next cleanup reclaims it.
    await store.clearTerminalHostAction('s1', job.createdAt);
    await store.cleanup();
    expect(await store.getJob('s1')).toBeNull();
  });

  test('cleanup() preserves a fresh pause-persistence barrier before expiring the action', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    try {
      const job = await store.createJob('fresh-pause-barrier', 'u1');
      const action = buildPendingAction(
        buildToolApprovalPayload([{ name: 'shell', arguments: {}, tool_call_id: 'c1' }]),
        { streamId: 'fresh-pause-barrier', ttlMs: -1_000 },
      );
      await store.transitionStatus('fresh-pause-barrier', {
        from: 'running',
        to: 'requires_action',
        expectCreatedAt: job.createdAt,
        patch: {
          pendingAction: action,
          pendingActionId: `pause-persistence:${action.actionId}`,
          terminalPersistencePending: true,
          terminalPersistenceStartedAt: 1_000,
        },
      });

      now.mockReturnValue(11_000);
      await store.cleanup();
      await expect(store.getJob('fresh-pause-barrier')).resolves.toMatchObject({
        status: 'requires_action',
        terminalPersistencePending: true,
      });

      now.mockReturnValue(31_001);
      await store.cleanup();
      await expect(store.getJob('fresh-pause-barrier')).resolves.toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  test('cleanup() fails a stale pause-persistence barrier closed and parks steers', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    try {
      const job = await store.createJob('stale-pause-barrier', 'u1');
      await store.updateJob(
        'stale-pause-barrier',
        { agentEventDeliveryKey: 'trigger-stale-pause' },
        job.createdAt,
      );
      await store.enqueueSteer(
        'stale-pause-barrier',
        {
          steerId: 'stale-cleanup-steer',
          text: 'park me when the pause writer disappears',
          userId: 'u1',
          createdAt: 1_000,
        },
        job.createdAt,
      );
      const action = buildPendingAction(
        buildToolApprovalPayload([{ name: 'shell', arguments: {}, tool_call_id: 'c1' }]),
        { streamId: 'stale-pause-barrier' },
      );
      await store.transitionStatus('stale-pause-barrier', {
        from: 'running',
        to: 'requires_action',
        expectCreatedAt: job.createdAt,
        patch: {
          pendingAction: action,
          pendingActionId: `pause-persistence:${action.actionId}`,
          terminalPersistencePending: true,
          terminalPersistenceStartedAt: 1_000,
        },
      });

      now.mockReturnValue(31_001);
      await store.cleanup();
      await expect(store.getJob('stale-pause-barrier')).resolves.toMatchObject({
        status: 'error',
        error: PAUSE_PERSISTENCE_TIMEOUT_ERROR,
        terminalHostActionPending: true,
      });
      const failedJob = await store.getJob('stale-pause-barrier');
      expect(failedJob?.pendingAction).toBeUndefined();
      expect(failedJob?.pendingActionId).toBeUndefined();
      expect(failedJob?.terminalPersistencePending).toBeUndefined();
      expect(failedJob?.terminalPersistenceStartedAt).toBeUndefined();
      await expect(store.peekSteers('stale-pause-barrier', job.createdAt)).resolves.toEqual([]);
      await expect(store.claimParkedSteers('stale-pause-barrier', 'u1')).resolves.toEqual(
        expect.any(String),
      );
    } finally {
      now.mockRestore();
    }
  });

  test('cleanup() retains a terminal persistence barrier when normal retention is zero', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    const completedAt = Date.now();
    const job = await store.createJob('terminal-persistence-barrier', 'u1');
    await store.transitionStatus('terminal-persistence-barrier', {
      from: 'running',
      to: 'aborted',
      expectCreatedAt: job.createdAt,
      patch: {
        completedAt,
        terminalPersistencePending: true,
        terminalPersistenceStartedAt: completedAt,
      },
    });

    await store.cleanup();
    await expect(store.getJob('terminal-persistence-barrier')).resolves.toMatchObject({
      status: 'aborted',
      terminalPersistencePending: true,
    });
    await expect(
      store.finalizeTerminalPersistence('terminal-persistence-barrier', job.createdAt, 'final'),
    ).resolves.toBe(true);
    await expect(store.getJob('terminal-persistence-barrier')).resolves.toMatchObject({
      terminalPersistencePending: false,
      finalEvent: 'final',
    });
  });
});

describe('ApprovalLifecycle ownership callbacks', () => {
  test('notifies ownership changes only after successful lifecycle transitions', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const callbacks = {
      onPaused: jest.fn(),
      onResumed: jest.fn(),
      onExpired: jest.fn(),
    };
    const lifecycle = new ApprovalLifecycle(store, callbacks);
    const streamId = 'ownership-callbacks';
    const job = await store.createJob(streamId, 'u1');
    const action = buildPendingAction(
      buildToolApprovalPayload([{ name: 'shell', arguments: {}, tool_call_id: 'c1' }]),
      { streamId },
    );

    expect(await lifecycle.pause(streamId, action)).toBe(true);
    expect(await lifecycle.pause(streamId, action)).toBe(false);
    expect(callbacks.onPaused).toHaveBeenCalledTimes(1);
    expect(callbacks.onPaused).toHaveBeenCalledWith(streamId, job.createdAt);

    expect(await lifecycle.resolve(streamId, action.actionId)).toBe(true);
    expect(await lifecycle.resolve(streamId, action.actionId)).toBe(false);
    expect(callbacks.onResumed).toHaveBeenCalledTimes(1);
    expect(callbacks.onResumed).toHaveBeenCalledWith(streamId, job.createdAt);

    const nextAction = { ...action, actionId: 'next-action' };
    expect(await lifecycle.pause(streamId, nextAction)).toBe(true);
    expect(await lifecycle.expire(streamId, nextAction.actionId)).toBe(true);
    expect(await lifecycle.expire(streamId, nextAction.actionId)).toBe(false);
    expect(callbacks.onExpired).toHaveBeenCalledTimes(1);
    expect(callbacks.onExpired).toHaveBeenCalledWith(streamId, job.createdAt);
  });

  test('does not resume a replacement that appeared after the pending action was read', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const onResumed = jest.fn();
    const lifecycle = new ApprovalLifecycle(store, { onResumed });
    const streamId = 'resolve-replacement-guard';
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);

    try {
      await store.createJob(streamId, 'u1');
      const action = buildPendingAction(
        buildToolApprovalPayload([{ name: 'shell', arguments: {}, tool_call_id: 'c1' }]),
        { streamId },
      );
      await lifecycle.pause(streamId, action);
      const observedJob = await store.getJob(streamId);
      if (!observedJob) {
        throw new Error('Expected paused job');
      }

      now.mockReturnValue(2000);
      const replacement = await store.createJob(streamId, 'u1');
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: action, pendingActionId: action.actionId },
      });

      jest.spyOn(store, 'getJob').mockResolvedValueOnce(observedJob);

      expect(await lifecycle.resolve(streamId, action.actionId)).toBe(false);
      expect(await store.getJob(streamId)).toMatchObject({
        createdAt: replacement.createdAt,
        status: 'requires_action',
      });
      expect(onResumed).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});

describe('GenerationJobManager HITL resume metadata (round 19)', () => {
  let manager: GenerationJobManagerClass;

  beforeEach(() => {
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  function buildAction(streamId: string) {
    const payload = buildToolApprovalPayload([
      { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_abc' },
    ]);
    return buildPendingAction(payload, {
      streamId,
      conversationId: streamId,
      runId: 'run-1',
      responseMessageId: 'msg-1',
    });
  }

  // H1: round-18 captured discoveredTools but the metadata allowlists (updateMetadata,
  // Redis deserialize, buildJobFacade) dropped it, so resume replayed `undefined`.
  test('updateMetadata persists discoveredTools and the job facade exposes them', async () => {
    const streamId = 'stream-discovered';
    await manager.createJob(streamId, 'user-1');
    await manager.updateMetadata(streamId, { discoveredTools: ['deep_tool', 'other_tool'] });
    const job = await manager.getJob(streamId);
    expect(job?.metadata.discoveredTools).toEqual(['deep_tool', 'other_tool']);
  });

  test('updateMetadata exposes a paused legacy-event fence through the job facade', async () => {
    const streamId = 'stream-legacy-event';
    await manager.createJob(streamId, 'user-1');
    await manager.updateMetadata(streamId, {
      agentEventLegacyTurnToken: 'legacy-hitl-token',
    });

    const job = await manager.getJob(streamId);

    expect(job?.metadata.agentEventLegacyTurnToken).toBe('legacy-hitl-token');
  });

  // H4: a pause that lands AFTER the resume snapshot but before the subscription must
  // still reach the client. subscribeWithResume re-reads the live job and surfaces it.
  test('subscribeWithResume surfaces a pause that the resume snapshot missed', async () => {
    const streamId = 'stream-race';
    await manager.createJob(streamId, 'user-1');
    const action = buildAction(streamId);
    await manager.approvals.pause(streamId, action);

    // Simulate the snapshot being taken BEFORE the pause: drop pendingAction from the
    // resume state even though the live job is now requires_action.
    const realGetResumeState = manager.getResumeState.bind(manager);
    jest.spyOn(manager, 'getResumeState').mockImplementation(async (id: string) => {
      const state = await realGetResumeState(id);
      return state ? { ...state, pendingAction: undefined } : state;
    });

    const result = await manager.subscribeWithResume(streamId, () => {});
    const pending = result.pendingEvents.find(
      (e) => 'event' in e && e.event === 'on_pending_action',
    );
    expect(pending).toBeDefined();
    expect((pending as unknown as { data: { actionId: string } }).data.actionId).toBe(
      action.actionId,
    );
    result.subscription?.unsubscribe();
  });

  // H4 negative: when the snapshot already carried the action, the re-read is skipped
  // (the client gets it via resumeState.pendingAction) — no duplicate pending event.
  test('does not re-surface the pending action when the snapshot already carried it', async () => {
    const streamId = 'stream-norace';
    await manager.createJob(streamId, 'user-1');
    const action = buildAction(streamId);
    await manager.approvals.pause(streamId, action);

    const result = await manager.subscribeWithResume(streamId, () => {});
    const pendingCount = result.pendingEvents.filter(
      (e) => 'event' in e && e.event === 'on_pending_action',
    ).length;
    expect(pendingCount).toBe(0);
    expect(result.resumeState?.pendingAction?.actionId).toBe(action.actionId);
    result.subscription?.unsubscribe();
  });
});
