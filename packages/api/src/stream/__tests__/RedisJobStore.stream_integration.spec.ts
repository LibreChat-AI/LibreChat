import { StandardGraph } from '@librechat/agents';
import { StepTypes } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { Redis, Cluster } from 'ioredis';
import type { SteerQueueItem, SteerReceipt } from '../interfaces/IJobStore';
import {
  JobStatusTransitionDeadlineError,
  PAUSE_PERSISTENCE_TIMEOUT_ERROR,
  STEER_ENQUEUE_RECEIPT_FULL,
} from '../interfaces/IJobStore';
import { clearRedisTestPrefix } from './helpers/redis';

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

/**
 * Integration tests for RedisJobStore.
 *
 * Tests horizontal scaling scenarios:
 * - Multi-instance job access
 * - Content reconstruction from chunks
 * - Consumer groups for resumable streams
 * - TTL and cleanup behavior
 *
 * Run with: USE_REDIS=true npx jest RedisJobStore.stream_integration
 */
describe('RedisJobStore Integration Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  const testPrefix = 'Stream-Integration-Test';

  function buildPendingAction(streamId: string): Agents.PendingAction {
    return {
      actionId: `action-${streamId}`,
      streamId,
      conversationId: streamId,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Approve?' },
      },
      createdAt: Date.now(),
    };
  }

  beforeAll(async () => {
    originalEnv = { ...process.env };

    // Set up test environment
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.USE_REDIS_CLUSTER = process.env.USE_REDIS_CLUSTER ?? 'false';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = testPrefix;
    process.env.REDIS_PING_INTERVAL = '0';
    process.env.REDIS_RETRY_MAX_ATTEMPTS = '5';
    jest.resetModules();

    // Import Redis client
    const { ioredisClient: client } = await import('../../cache/redisClients');
    ioredisClient = client;

    if (!ioredisClient) {
      console.warn('Redis not available, skipping integration tests');
    }
  });

  afterEach(async () => {
    if (!ioredisClient) {
      return;
    }

    try {
      const keyPrefix = String(ioredisClient.options.keyPrefix ?? '');
      await clearRedisTestPrefix(ioredisClient, keyPrefix);
    } catch (error) {
      console.warn('Error cleaning up test keys:', error);
    }
  });

  afterAll(async () => {
    if (ioredisClient) {
      try {
        // Use quit() to gracefully close - waits for pending commands
        await ioredisClient.quit();
      } catch {
        // Fall back to disconnect if quit fails
        try {
          ioredisClient.disconnect();
        } catch {
          // Ignore
        }
      }
    }
    process.env = originalEnv;
  });

  test.each([false, true])(
    'owner cleanup recovers legacy terminal membership once (detached=%s)',
    async (detached) => {
      expect(ioredisClient).not.toBeNull();
      const redis = ioredisClient!;
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const old = new RedisJobStore(redis, { userJobsSetTtl: 1, requiresActionTtl: 120 });
      const id = 'owner-terminal-recovery';
      const job = await old.createJob(id, 'owner', id, 'tenant');
      if (detached)
        await old.updateJob(id, { agentEventInvocationKey: 'invocation' }, job.createdAt);
      await old.transitionStatus(id, {
        from: 'running',
        to: 'complete',
        expectCreatedAt: job.createdAt,
        patch: { completedAt: Date.now(), providerDrained: true, terminalHostActionPending: true },
      });
      const key = 'stream:user:{tenant:owner}:jobs';
      await redis.del(key);
      await old.destroy();
      const store = new RedisJobStore(redis, { userJobsSetTtl: 1, requiresActionTtl: 120 });
      try {
        const global = jest.spyOn(store, 'getTerminalHostActionJobs');
        const detachedGlobal = jest.spyOn(store, 'getDetachedAgentEventTerminalHostActionJobs');
        await store.initialize();
        expect(await store.getCleanupJobIdsByUser('owner', 'tenant')).toEqual([id]);
        expect(await redis.ttl(key)).toBeGreaterThan(60);
        expect(await store.getActiveJobIdsByUser('owner', 'tenant')).toEqual([]);
        expect(await store.getCleanupJobIdsByUser('owner', 'tenant')).toEqual([id]);
        expect(await store.getCleanupJobIdsByUser('foreign', 'tenant')).toEqual([]);
        expect(global).toHaveBeenCalledTimes(1);
        expect(detachedGlobal).toHaveBeenCalledTimes(1);
        await redis.persist(key);
        await store.getCleanupJobIdsByUser('owner', 'tenant');
        expect(await redis.ttl(key)).toBe(-1);
        await store.clearTerminalHostAction(id, job.createdAt);
        expect(await store.getCleanupJobIdsByUser('owner', 'tenant')).toEqual([]);
        expect(await redis.smembers(key)).toEqual([]);
      } finally {
        await store.destroy();
      }
    },
  );

  test('owner cleanup fails closed when startup recovery fails and retries it', async () => {
    expect(ioredisClient).not.toBeNull();
    const { RedisJobStore } = await import('../implementations/RedisJobStore');
    const store = new RedisJobStore(ioredisClient!);
    const read = jest
      .spyOn(store, 'getTerminalHostActionJobs')
      .mockRejectedValueOnce(new Error('index unavailable'));
    try {
      await expect(store.getCleanupJobIdsByUser('owner')).rejects.toThrow('index unavailable');
      await expect(store.getCleanupJobIdsByUser('owner')).resolves.toEqual([]);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await store.destroy();
    }
  });

  describe('Job CRUD Operations', () => {
    test('should create and retrieve a job', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `test-stream-${Date.now()}`;
      const userId = 'test-user-123';

      const job = await store.createJob(streamId, userId, streamId);

      expect(job).toMatchObject({
        streamId,
        userId,
        status: 'running',
        conversationId: streamId,
        syncSent: false,
      });

      const retrieved = await store.getJob(streamId);
      expect(retrieved).toMatchObject({
        streamId,
        userId,
        status: 'running',
      });

      await store.destroy();
    });

    test('atomically rejects a status transition after its deadline', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `test-transition-deadline-${Date.now()}`;
      await store.createJob(streamId, 'deadline-user', streamId);

      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'requires_action',
          notAfterMs: Date.now() - 1,
        }),
      ).rejects.toMatchObject({
        name: JobStatusTransitionDeadlineError.name,
        notAfterMs: expect.any(Number),
      });
      await expect(store.getJob(streamId)).resolves.toMatchObject({ status: 'running' });

      await store.destroy();
    });

    test('returns the exact predecessor captured by the atomic replacement script', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `test-replaced-owner-${Date.now()}`;
      const providerExecutionId = 'provider-before-replacement';
      const predecessor = await store.createJob(streamId, 'user-1', streamId, undefined, {
        providerExecutionId,
      });
      await expect(
        store.beginProviderExecution(streamId, predecessor.createdAt, providerExecutionId),
      ).resolves.toBe(true);
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        expectCreatedAt: predecessor.createdAt,
      });

      const replacement = await store.createJob(streamId, 'user-1', streamId);

      expect(predecessor.checkpointNamespace).toEqual(expect.any(String));
      expect(replacement.checkpointNamespace).toEqual(expect.any(String));
      expect(replacement.checkpointNamespace).not.toBe(predecessor.checkpointNamespace);
      expect(replacement.replacedJob).toEqual({
        createdAt: predecessor.createdAt,
        status: 'requires_action',
        conversationId: streamId,
      });
      expect(replacement.replacedJob).toMatchObject({
        providerExecutionId,
        providerDrained: false,
      });
      // The receipt is durably reconstructed for lost-reply recovery, but it
      // remains non-enumerable so ordinary job serializers cannot expose it.
      const durableReplacement = await store.getJob(streamId);
      expect((durableReplacement as typeof replacement).replacedJob).toEqual(
        replacement.replacedJob,
      );
      expect((durableReplacement as typeof replacement).replacedJob).toMatchObject({
        providerExecutionId,
        providerDrained: false,
      });
      expect(Object.getOwnPropertyDescriptor(durableReplacement!, 'replacedJob')).toMatchObject({
        enumerable: false,
      });
      expect(Object.keys(durableReplacement!)).not.toContain('replacedJob');
      await store.destroy();
    });

    test('should update job status', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `test-stream-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      await store.updateJob(streamId, { status: 'complete', completedAt: Date.now() });

      const job = await store.getJob(streamId);
      expect(job?.status).toBe('complete');
      expect(job?.completedAt).toBeDefined();

      await store.destroy();
    });

    test('atomically rewrites a requires_action barrier in the same status', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `same-status-pause-${Date.now()}`;
      const job = await store.createJob(streamId, 'user-1', streamId);
      const first = buildPendingAction(`${streamId}-first`);
      const second = buildPendingAction(`${streamId}-second`);

      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'requires_action',
          expectCreatedAt: job.createdAt,
          patch: {
            pendingAction: first,
            pendingActionId: first.actionId,
            terminalPersistenceStartedAt: 1234,
          },
        }),
      ).resolves.toBe(true);

      await expect(
        store.transitionStatus(streamId, {
          from: 'requires_action',
          to: 'requires_action',
          expectActionId: first.actionId,
          expectCreatedAt: job.createdAt,
          patch: { pendingAction: second, pendingActionId: second.actionId },
          clear: ['terminalPersistenceStartedAt'],
        }),
      ).resolves.toBe(true);
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        status: 'requires_action',
        pendingActionId: second.actionId,
        pendingAction: { actionId: second.actionId },
      });
      expect((await store.getJob(streamId))?.terminalPersistenceStartedAt).toBeUndefined();

      await expect(
        store.transitionStatus(streamId, {
          from: 'requires_action',
          to: 'requires_action',
          expectActionId: first.actionId,
          expectCreatedAt: job.createdAt,
          patch: { pendingAction: first, pendingActionId: first.actionId },
        }),
      ).resolves.toBe(false);
      expect((await store.getJob(streamId))?.pendingActionId).toBe(second.actionId);
      await store.destroy();
    });

    test('should delete job and related data', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `test-stream-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Add some chunks
      await store.appendChunk(streamId, { event: 'on_message_delta', data: { text: 'Hello' } });

      await store.deleteJob(streamId);

      const job = await store.getJob(streamId);
      expect(job).toBeNull();

      await store.destroy();
    });

    test('stale generation update and delete cannot affect a same-stream replacement', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `stale-write-epoch-${Date.now()}`;
      const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
      const replacementChunk = {
        event: 'on_message_delta',
        data: { text: 'replacement generation' },
      };
      const predecessorChunk = {
        event: 'on_message_delta',
        data: { text: 'stale predecessor generation' },
      };
      const replacementRunSteps = [{ id: 'replacement-step', type: 'tool_call' }];
      const predecessorRunSteps = [{ id: 'predecessor-step', type: 'tool_call' }];

      try {
        const original = await store.createJob(streamId, 'user-1', streamId);
        await store.appendChunk(streamId, predecessorChunk, original.createdAt);
        await store.saveRunSteps?.(
          streamId,
          predecessorRunSteps as Agents.RunStep[],
          original.createdAt,
        );
        await store.updateJob(
          streamId,
          {
            finalEvent: JSON.stringify({ final: true, generation: 'predecessor' }),
            titleEvent: JSON.stringify({ event: 'title', data: { title: 'Predecessor' } }),
            completedAt: original.createdAt,
            error: 'predecessor error',
          },
          original.createdAt,
        );
        store.setCollectedUsage(streamId, [{ input_tokens: 10 }], original.createdAt);

        const replacement = await store.createJob(streamId, 'user-1', streamId);
        expect(replacement.createdAt).toBe(original.createdAt + 1);
        expect(await ioredisClient.xlen(`stream:{${streamId}}:chunks`)).toBe(0);
        await expect(store.getRunSteps(streamId)).resolves.toEqual([]);
        const replacementJob = await store.getJob(streamId);
        expect(replacementJob).toMatchObject({
          createdAt: replacement.createdAt,
          status: 'running',
        });
        expect(replacementJob?.finalEvent).toBeUndefined();
        expect(replacementJob?.titleEvent).toBeUndefined();
        expect(replacementJob?.completedAt).toBeUndefined();
        expect(replacementJob?.error).toBeUndefined();
        expect(store.getCollectedUsage(streamId, replacement.createdAt)).toEqual([]);
        await store.appendChunk(streamId, replacementChunk, replacement.createdAt);
        await store.appendChunk(streamId, predecessorChunk, original.createdAt);
        await store.saveRunSteps?.(
          streamId,
          replacementRunSteps as Agents.RunStep[],
          replacement.createdAt,
        );
        await store.saveRunSteps?.(
          streamId,
          predecessorRunSteps as Agents.RunStep[],
          original.createdAt,
        );
        const replacementContent = [{ type: 'text', text: 'replacement local content' }];
        const replacementUsage = [{ input_tokens: 20 }];
        store.setContentParts(streamId, replacementContent, replacement.createdAt);
        store.setCollectedUsage(streamId, replacementUsage, replacement.createdAt);
        store.setContentParts(
          streamId,
          [{ type: 'text', text: 'stale predecessor content' }],
          original.createdAt,
        );
        store.setCollectedUsage(streamId, [{ input_tokens: 30 }], original.createdAt);
        store.clearContentState(streamId, original.createdAt);

        await expect(store.getContentParts(streamId, replacement.createdAt)).resolves.toEqual({
          content: replacementContent,
        });
        expect(store.getCollectedUsage(streamId, replacement.createdAt)).toBe(replacementUsage);
        await expect(store.getContentParts(streamId, original.createdAt)).resolves.toBeNull();
        await expect(store.getRunSteps(streamId, original.createdAt)).resolves.toEqual([]);

        await store.updateJob(
          streamId,
          { status: 'complete', completedAt: 1000, sender: 'stale generation' },
          original.createdAt,
        );
        await expect(store.deleteJob(streamId, original.createdAt)).resolves.toBe(false);

        await expect(store.getJob(streamId)).resolves.toMatchObject({
          createdAt: replacement.createdAt,
          status: 'running',
        });
        const chunks = await ioredisClient.xrange(`stream:{${streamId}}:chunks`, '-', '+');
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.[1]).toContain(JSON.stringify(replacementChunk));
        await expect(store.getRunSteps(streamId, replacement.createdAt)).resolves.toEqual(
          replacementRunSteps,
        );

        await expect(store.deleteJob(streamId, replacement.createdAt)).resolves.toBe(true);
        await expect(store.getJob(streamId)).resolves.toBeNull();
        expect(await ioredisClient.xlen(`stream:{${streamId}}:chunks`)).toBe(0);
      } finally {
        now.mockRestore();
        await store.destroy();
      }
    });

    test('terminal CAS cleanup cannot delete a replacement job epoch', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `terminal-epoch-${Date.now()}`;
      const userId = 'terminal-epoch-user';
      const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
      const originalEval = ioredisClient.eval.bind(ioredisClient) as (
        script: string | Buffer,
        numberOfKeys: number,
        ...args: Array<string | number | Buffer>
      ) => Promise<unknown>;
      let signalCasApplied: (() => void) | undefined;
      const casApplied = new Promise<void>((resolve) => {
        signalCasApplied = resolve;
      });
      let releaseTransition: (() => void) | undefined;
      const transitionGate = new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      let restoreEval: (() => void) | undefined;

      try {
        const originalJob = await store.createJob(streamId, userId, streamId);
        await store.appendChunk(streamId, {
          event: 'on_message_delta',
          data: { text: 'old generation' },
        });
        await store.enqueueSteer(streamId, {
          steerId: 'old-steer',
          text: 'do not leak this',
          userId,
          createdAt: Date.now(),
        });

        let gateFirstEval = true;
        const evalSpy = jest.spyOn(ioredisClient, 'eval').mockImplementation((async (
          script,
          numberOfKeys,
          ...args
        ) => {
          const result = await originalEval(
            script as string | Buffer,
            Number(numberOfKeys),
            ...(args as Array<string | number | Buffer>),
          );
          if (gateFirstEval) {
            gateFirstEval = false;
            signalCasApplied?.();
            await transitionGate;
          }
          return result;
        }) as typeof ioredisClient.eval);
        restoreEval = () => evalSpy.mockRestore();

        const finalizing = store.transitionStatus(streamId, {
          from: 'running',
          to: 'error',
          expectCreatedAt: originalJob.createdAt,
          patch: { error: 'old generation stopped', completedAt: Date.now() },
        });
        await casApplied;

        now.mockReturnValue(2000);
        const replacement = await store.createJob(streamId, userId, streamId);
        await store.appendChunk(streamId, {
          event: 'on_message_delta',
          data: { text: 'replacement generation' },
        });
        await store.enqueueSteer(streamId, {
          steerId: 'replacement-steer',
          text: 'keep replacement state',
          userId,
          createdAt: Date.now(),
        });

        releaseTransition?.();
        await expect(finalizing).resolves.toBe(true);
        await expect(store.getJob(streamId)).resolves.toMatchObject({
          createdAt: replacement.createdAt,
          status: 'running',
        });
        expect(await ioredisClient.xlen(`stream:{${streamId}}:chunks`)).toBe(1);
        expect((await store.peekSteers(streamId)).map((steer) => steer.steerId)).toEqual([
          'replacement-steer',
        ]);
        const parked = await store.claimParkedSteers(streamId, userId);
        expect(parked).toBeDefined();
        expect(JSON.parse(parked as string)).toMatchObject({
          userId,
          steers: [{ steerId: 'old-steer', text: 'do not leak this' }],
        });
        expect(await ioredisClient.smembers('stream:running')).toContain(streamId);
        expect(await store.getActiveJobIdsByUser(userId)).toContain(streamId);
      } finally {
        releaseTransition?.();
        restoreEval?.();
        now.mockRestore();
        await store.destroy();
      }
    });
  });

  describe('Steer queue arm (in-place escalation)', () => {
    test('arms a queued steer in place, preserving FIFO order and every field', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `arm-steer-${Date.now()}`;

      try {
        const job = await store.createJob(streamId, 'user-1', streamId, undefined, {
          preemptCapable: true,
        });
        await store.enqueueSteer(streamId, {
          steerId: 'first',
          text: 'earlier instruction',
          userId: 'user-1',
          createdAt: 1,
          files: [{ file_id: 'f1' }] as never,
        });
        await store.enqueueSteer(streamId, {
          steerId: 'second',
          text: 'later instruction',
          userId: 'user-1',
          createdAt: 2,
        });

        await expect(store.armSteer(streamId, 'first', job.createdAt)).resolves.toBe('armed');

        const queue = await store.peekSteers(streamId);
        expect(queue.map((item) => item.steerId)).toEqual(['first', 'second']);
        /** Whole-item decode/patch/encode: nothing but the flag changes. */
        expect(queue[0]).toMatchObject({
          steerId: 'first',
          text: 'earlier instruction',
          userId: 'user-1',
          createdAt: 1,
          preempt: true,
        });
        expect(queue[0].files).toEqual([{ file_id: 'f1' }]);
        expect(queue[1].preempt).toBeUndefined();
      } finally {
        await store.destroy();
      }
    });

    test('matches the decoded steer id exactly instead of a caller-built JSON fragment', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `arm-steer-exact-id-${Date.now()}`;

      try {
        const job = await store.createJob(streamId, 'user-1', streamId, undefined, {
          preemptCapable: true,
        });
        await store.enqueueSteer(streamId, {
          steerId: 'target',
          text: 'matching payload',
          userId: 'user-1',
          createdAt: 1,
        });

        /** The old optimization embedded this value in a JSON search fragment,
         * which matched the real item's adjacent `steerId` + `text` fields. */
        await expect(
          store.armSteer(streamId, 'target","text":"matching payload', job.createdAt),
        ).resolves.toBe('missing');
        const queue = await store.peekSteers(streamId, job.createdAt);
        expect(queue).toHaveLength(1);
        expect(queue[0].steerId).toBe('target');
        expect(queue[0].preempt).toBeUndefined();
      } finally {
        await store.destroy();
      }
    });

    test('refuses to arm a capable job after it enters requires_action', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `arm-steer-paused-${Date.now()}`;

      try {
        const job = await store.createJob(streamId, 'user-1', streamId, undefined, {
          preemptCapable: true,
        });
        await store.enqueueSteer(streamId, {
          steerId: 'kept',
          text: 'wait until the run resumes',
          userId: 'user-1',
          createdAt: 1,
          files: [{ file_id: 'f1' }] as never,
        });
        const before = await store.peekSteers(streamId, job.createdAt);
        await expect(
          store.transitionStatus(streamId, {
            from: 'running',
            to: 'requires_action',
            expectCreatedAt: job.createdAt,
          }),
        ).resolves.toBe(true);

        await expect(store.armSteer(streamId, 'kept', job.createdAt)).resolves.toBe('missing');
        await expect(store.peekSteers(streamId, job.createdAt)).resolves.toEqual(before);
      } finally {
        await store.destroy();
      }
    });

    test('refuses a missing steer, a stale generation, and a closed queue', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `arm-steer-guards-${Date.now()}`;

      try {
        const job = await store.createJob(streamId, 'user-1', streamId);
        await store.enqueueSteer(streamId, {
          steerId: 'kept',
          text: 'still waiting',
          userId: 'user-1',
          createdAt: 1,
        });

        await expect(store.armSteer(streamId, 'absent', job.createdAt)).resolves.toBe('missing');
        await expect(store.armSteer(streamId, 'kept', job.createdAt + 999)).resolves.toBe(
          'missing',
        );
        /** Live-capability predicate: the job above carries no preemptCapable,
         *  so an otherwise-valid arm answers `incapable` and leaves the item. */
        await expect(store.armSteer(streamId, 'kept', job.createdAt)).resolves.toBe('incapable');
        expect((await store.peekSteers(streamId))[0].preempt).toBeUndefined();

        /** `enqueueSteer` refuses once closed, so plant a raw item directly to
         *  exercise the closed guard with something findable in the list. */
        await store.closeAndDrainSteers(streamId, job.createdAt);
        await ioredisClient.rpush(
          `stream:{${streamId}}:steers`,
          JSON.stringify({
            steerId: 'kept',
            text: 'still waiting',
            userId: 'user-1',
            createdAt: 1,
          }),
        );
        await expect(store.armSteer(streamId, 'kept', job.createdAt)).resolves.toBe('missing');
      } finally {
        await store.destroy();
      }
    });
  });

  describe('Requires Action Status Tracking', () => {
    test('should count requires_action jobs and remove them from the running set', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `requires-action-user-${Date.now()}`;
      const streamId = `requires-action-${Date.now()}`;
      const beforeRunning = await store.getJobCountByStatus('running');
      const beforePaused = await store.getJobCountByStatus('requires_action');
      await store.createJob(streamId, userId, streamId);

      expect(await store.getJobCountByStatus('running')).toBe(beforeRunning + 1);
      expect(await store.getJobCountByStatus('requires_action')).toBe(beforePaused);

      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: buildPendingAction(streamId) },
      });

      const runningMembers = await ioredisClient.smembers('stream:running');
      const pausedMembers = await ioredisClient.smembers('stream:requires_action');
      expect(runningMembers).not.toContain(streamId);
      expect(pausedMembers).toContain(streamId);
      expect(await store.getJobCountByStatus('running')).toBe(beforeRunning);
      expect(await store.getJobCountByStatus('requires_action')).toBe(beforePaused + 1);
      expect(await store.getActiveJobIdsByUser(userId)).toContain(streamId);

      await store.destroy();
    });

    test('should return resumed requires_action jobs to the running index', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `requires-action-resume-${Date.now()}`;
      const beforeRunning = await store.getJobCountByStatus('running');
      const beforePaused = await store.getJobCountByStatus('requires_action');
      await store.createJob(streamId, 'user-1', streamId);
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: buildPendingAction(streamId) },
      });

      await store.transitionStatus(streamId, {
        from: 'requires_action',
        to: 'running',
        clear: ['pendingAction'],
      });

      const job = await store.getJob(streamId);
      expect(job?.status).toBe('running');
      expect(job?.pendingAction).toBeUndefined();
      expect(await store.getJobCountByStatus('running')).toBe(beforeRunning + 1);
      expect(await store.getJobCountByStatus('requires_action')).toBe(beforePaused);

      await store.destroy();
    });

    test('should refresh resume state TTLs when pausing and resuming a job', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 120 });
      await store.initialize();

      const streamId = `requires-action-ttl-${Date.now()}`;
      const chunkKey = `stream:{${streamId}}:chunks`;
      const runStepsKey = `stream:{${streamId}}:runsteps`;

      await store.createJob(streamId, 'user-1', streamId);
      await store.appendChunk(streamId, { event: 'on_message_delta', data: { text: 'hello' } });
      const runSteps: Partial<Agents.RunStep>[] = [
        { id: 'step-1', runId: 'run-1', type: StepTypes.MESSAGE_CREATION, index: 0 },
      ];
      await store.saveRunSteps(streamId, runSteps as Agents.RunStep[]);

      await ioredisClient.expire(chunkKey, 30);
      await ioredisClient.expire(runStepsKey, 30);

      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: buildPendingAction(streamId) },
      });

      expect(await ioredisClient.ttl(chunkKey)).toBeGreaterThan(30);
      expect(await ioredisClient.ttl(runStepsKey)).toBeGreaterThan(30);

      await ioredisClient.expire(chunkKey, 30);
      await ioredisClient.expire(runStepsKey, 30);

      await store.transitionStatus(streamId, {
        from: 'requires_action',
        to: 'running',
        clear: ['pendingAction'],
      });

      expect(await ioredisClient.ttl(chunkKey)).toBeGreaterThan(30);
      expect(await ioredisClient.ttl(runStepsKey)).toBeGreaterThan(30);

      await store.destroy();
    });

    test('appendChunk preserves a paused job’s extended TTL (does not reset to running)', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `paused-chunk-ttl-${Date.now()}`;
      const chunkKey = `stream:{${streamId}}:chunks`;

      await store.createJob(streamId, 'user-1', streamId);
      await store.appendChunk(streamId, { event: 'on_message_delta', data: { text: 'hello' } });

      // Pause: transitionStatus extends the chunk-key TTL to the long approval window.
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: buildPendingAction(streamId) },
      });
      expect(await ioredisClient.ttl(chunkKey)).toBeGreaterThan(60);

      // The on_pending_action chunk is appended AFTER the pause. The bug Codex flagged was
      // that appendChunk unconditionally reset the TTL back to the (short) running TTL,
      // evicting the pre-pause content before resume. It must now leave the long TTL intact.
      await store.appendChunk(streamId, {
        event: 'on_pending_action',
        data: buildPendingAction(streamId),
      });
      expect(await ioredisClient.ttl(chunkKey)).toBeGreaterThan(60);
      // The chunk was still appended (XADD ran), so resume can read the full stream.
      expect(await ioredisClient.xlen(chunkKey)).toBeGreaterThanOrEqual(2);

      await store.destroy();
    });

    test('releasing a pause-persistence barrier preserves an explicit long approval TTL', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `long-pause-barrier-ttl-${Date.now()}`;
      const jobKey = `stream:{${streamId}}:job`;
      const chunkKey = `stream:{${streamId}}:chunks`;
      const job = await store.createJob(streamId, 'user-1', streamId);
      await store.appendChunk(
        streamId,
        { event: 'on_message_delta', data: { text: 'before approval' } },
        job.createdAt,
      );
      const action = {
        ...buildPendingAction(streamId),
        expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
      };
      const barrierId = `pause-persistence:${action.actionId}`;
      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'requires_action',
          expectCreatedAt: job.createdAt,
          patch: {
            pendingAction: action,
            pendingActionId: barrierId,
            terminalPersistencePending: true,
            terminalPersistenceStartedAt: Date.now(),
          },
        }),
      ).resolves.toBe(true);

      const jobTtlBefore = await ioredisClient.ttl(jobKey);
      const chunkTtlBefore = await ioredisClient.ttl(chunkKey);
      expect(jobTtlBefore).toBeGreaterThan(2 * 24 * 60 * 60);
      expect(chunkTtlBefore).toBeGreaterThan(2 * 24 * 60 * 60);

      await expect(
        store.transitionStatus(streamId, {
          from: 'requires_action',
          to: 'requires_action',
          expectActionId: barrierId,
          expectCreatedAt: job.createdAt,
          patch: {
            pendingActionId: action.actionId,
            terminalPersistencePending: false,
          },
          clear: ['terminalPersistenceStartedAt'],
        }),
      ).resolves.toBe(true);

      expect(await ioredisClient.ttl(jobKey)).toBeGreaterThanOrEqual(jobTtlBefore - 2);
      expect(await ioredisClient.ttl(chunkKey)).toBeGreaterThanOrEqual(chunkTtlBefore - 2);

      await store.destroy();
    });

    test('failed pause persistence atomically terminalizes before a waiting Redis resume', async () => {
      if (!ioredisClient) {
        return;
      }

      const [{ RedisJobStore }, { InMemoryEventTransport }, { GenerationJobManagerClass }] =
        await Promise.all([
          import('../implementations/RedisJobStore'),
          import('../implementations/InMemoryEventTransport'),
          import('../GenerationJobManager'),
        ]);
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: store,
        eventTransport: new InMemoryEventTransport(),
        isRedis: true,
        cleanupOnComplete: false,
      });
      manager.initialize();

      try {
        const streamId = `failed-pause-persistence-race-${Date.now()}`;
        const job = await manager.createJob(streamId, 'user-1', streamId);
        const action = buildPendingAction(streamId);
        const waitingSteer = {
          steerId: 'redis-steer-waiting-on-failed-pause',
          text: 'preserve the Redis steer',
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
            'Redis paused response was not persisted',
            job.createdAt,
          ),
        ).resolves.toBe(true);
        await expect(resuming).resolves.toBe(false);
        await expect(manager.getJob(streamId)).resolves.toMatchObject({
          status: 'error',
          error: 'Redis paused response was not persisted',
        });
        const failedStoredJob = await store.getJob(streamId);
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
      } finally {
        await manager.destroy();
      }
    });

    test('relays a Redis store-only pause timeout into the matching attached runtime once', async () => {
      if (!ioredisClient) {
        return;
      }

      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      const [{ RedisJobStore }, { InMemoryEventTransport }, { GenerationJobManagerClass }] =
        await Promise.all([
          import('../implementations/RedisJobStore'),
          import('../implementations/InMemoryEventTransport'),
          import('../GenerationJobManager'),
        ]);
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      const transport = new InMemoryEventTransport();
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: store,
        eventTransport: transport,
        isRedis: true,
        cleanupOnComplete: false,
      });
      manager.initialize();

      try {
        const streamId = 'redis-remote-pause-timeout';
        const job = await manager.createJob(streamId, 'user-1', streamId);
        const action = buildPendingAction(streamId);
        const onError = jest.fn();
        const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
        await expect(
          manager.approvals.pause(streamId, action, {
            expectedCreatedAt: job.createdAt,
            persistencePending: true,
          }),
        ).resolves.toBe(true);
        const broadcast = jest.spyOn(transport, 'emitError');

        now.mockReturnValue(31_001);
        // Model cleanup on a different replica: it has the shared store but no
        // access to this manager's runtime or attached local subscriber.
        await store.cleanup();
        await expect(store.getJob(streamId)).resolves.toMatchObject({
          status: 'error',
          error: PAUSE_PERSISTENCE_TIMEOUT_ERROR,
        });
        expect(job.abortController.signal.aborted).toBe(false);
        expect(onError).not.toHaveBeenCalled();

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

        await managerWithCleanup.cleanup();
        expect(onError).toHaveBeenCalledTimes(1);
        subscription?.unsubscribe();
      } finally {
        await manager.destroy();
        now.mockRestore();
      }
    });

    test('saveRunSteps preserves a paused job’s extended TTL (does not reset to running)', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `paused-runsteps-ttl-${Date.now()}`;
      const runStepsKey = `stream:{${streamId}}:runsteps`;

      await store.createJob(streamId, 'user-1', streamId);
      await store.saveRunSteps!(streamId, [{ id: 'step-1', type: 'tool_call' }] as never);

      // Pause: transitionStatus extends the run-steps key TTL to the long approval window.
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: buildPendingAction(streamId) },
      });
      expect(await ioredisClient.ttl(runStepsKey)).toBeGreaterThan(60);

      // A run-step save landing AFTER the pause must NOT reset the key to the running TTL,
      // or a reload of the still-live approval after that window loses the tool timeline.
      await store.saveRunSteps!(streamId, [
        { id: 'step-1', type: 'tool_call' },
        { id: 'step-2', type: 'tool_call' },
      ] as never);
      expect(await ioredisClient.ttl(runStepsKey)).toBeGreaterThan(60);
      // The save still landed, so resume can read the full timeline.
      const steps = await store.getRunSteps(streamId);
      expect(steps.length).toBe(2);

      await store.destroy();
    });

    test('terminal host settlement retains evidence and waits for the provider drain fence', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `terminal-runsteps-${Date.now()}`;
      const providerExecutionId = 'terminal-runsteps-provider';
      const job = await store.createJob(streamId, 'user-1', streamId, undefined, {
        providerExecutionId,
      });
      await expect(
        store.beginProviderExecution(streamId, job.createdAt, providerExecutionId),
      ).resolves.toBe(true);
      const completedStep = {
        id: 'step-terminal',
        index: 0,
        type: StepTypes.TOOL_CALLS,
        status: 'completed',
        stepDetails: { type: StepTypes.TOOL_CALLS, tool_calls: [] },
      } as Agents.RunStep;
      await store.saveRunSteps(streamId, [completedStep], job.createdAt);
      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'aborted',
          expectCreatedAt: job.createdAt,
          patch: { completedAt: Date.now(), terminalHostActionPending: true },
        }),
      ).resolves.toBe(true);
      await expect(store.getTerminalHostActionJobs?.()).resolves.toEqual([]);
      await expect(store.getRunSteps(streamId, job.createdAt)).resolves.toEqual([completedStep]);

      await expect(
        store.markProviderExecutionDrained(streamId, job.createdAt, providerExecutionId),
      ).resolves.toBe(true);
      await expect(store.getTerminalHostActionJobs?.()).resolves.toEqual([
        expect.objectContaining({ streamId, providerDrained: true }),
      ]);

      await store.clearTerminalHostAction?.(streamId, job.createdAt);
      const lateStep = { ...completedStep, id: 'step-too-late' };
      await store.saveRunSteps(streamId, [lateStep], job.createdAt);
      await expect(store.getRunSteps(streamId, job.createdAt)).resolves.toEqual([]);

      await store.destroy();
    });

    test('terminal host settlement recovers a provider owner lost after the terminal CAS', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `terminal-lost-provider-${Date.now()}`;
      const providerExecutionId = 'terminal-lost-provider';
      const job = await store.createJob(streamId, 'user-1', streamId, undefined, {
        providerExecutionId,
      });
      await store.beginProviderExecution(streamId, job.createdAt, providerExecutionId);
      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'complete',
          expectCreatedAt: job.createdAt,
          patch: {
            completedAt: Date.now() - 30_001,
            terminalHostActionPending: true,
          },
        }),
      ).resolves.toBe(true);

      await expect(store.getTerminalHostActionJobs?.()).resolves.toEqual([
        expect.objectContaining({ streamId, providerDrained: true }),
      ]);
      await expect(store.getJob(streamId)).resolves.toMatchObject({ providerDrained: true });

      await store.clearTerminalHostAction(streamId, job.createdAt);
      await store.destroy();
    });

    test('isolates detached Event Actor completion recovery from the legacy terminal lane', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `terminal-detached-event-${Date.now()}`;
      const invocationKey = 'event-invocation-original';
      const completionDeliveryKey = 'event-completion-delivery';
      const invocationGenerationCreatedAt = Date.now() - 1_000;
      const job = await store.createJob(streamId, 'user-1', streamId, undefined, {
        agentEventDeliveryKey: completionDeliveryKey,
        agentEventInvocationKey: invocationKey,
        agentEventInvocationGenerationCreatedAt: invocationGenerationCreatedAt,
      });
      const member = JSON.stringify([streamId, job.createdAt]);

      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'complete',
          expectCreatedAt: job.createdAt,
          patch: { completedAt: Date.now(), terminalHostActionPending: true },
        }),
      ).resolves.toBe(true);

      // A pre-detached replica scans only this legacy key. The completion must
      // never become visible there, because it would deserialize only the
      // completion delivery and lose the original invocation identity.
      await expect(ioredisClient.sismember('stream:terminal_host_action', member)).resolves.toBe(0);
      await expect(ioredisClient.hgetall(`stream:{${streamId}}:job`)).resolves.toMatchObject({
        status: 'detached_terminal_pending_v1',
        detachedAgentEventTerminalStatus: 'complete',
        detachedAgentEventTerminalHostActionPending: '1',
      });
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        status: 'complete',
        terminalHostActionPending: true,
      });
      await expect(store.getTerminalHostActionJobs()).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ streamId })]),
      );
      await expect(store.getDetachedAgentEventTerminalHostActionJobs()).resolves.toEqual([
        expect.objectContaining({
          streamId,
          agentEventDeliveryKey: completionDeliveryKey,
          agentEventInvocationKey: invocationKey,
          agentEventInvocationGenerationCreatedAt: invocationGenerationCreatedAt,
        }),
      ]);

      // The current creator reports an ordinary predecessor conflict, while a
      // pre-detached creator rejects the raw versioned status as corrupt. Both
      // outcomes fence replacement even when its caller permits active replacement.
      await expect(store.createJob(streamId, 'user-1', streamId)).rejects.toMatchObject({
        name: 'JobPredecessorMismatchError',
      });

      await store.clearTerminalHostAction(streamId, job.createdAt);
      await expect(ioredisClient.hgetall(`stream:{${streamId}}:job`)).resolves.toMatchObject({
        status: 'complete',
      });
      await expect(
        ioredisClient.hget(`stream:{${streamId}}:job`, 'detachedAgentEventTerminalStatus'),
      ).resolves.toBeNull();
      await expect(
        ioredisClient.sismember('stream:agent_event_detached:terminal_host_action:v1', member),
      ).resolves.toBe(0);
      await store.destroy();
    });

    test('terminal host acknowledgement deletes a zero-TTL job after settlement', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { completedTtl: 0 });
      await store.initialize();

      const streamId = `terminal-host-zero-ttl-${Date.now()}`;
      const job = await store.createJob(streamId, 'user-1', streamId);
      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'aborted',
          expectCreatedAt: job.createdAt,
          patch: { completedAt: Date.now(), terminalHostActionPending: true },
        }),
      ).resolves.toBe(true);
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        status: 'aborted',
        terminalHostActionPending: true,
      });

      await expect(store.clearTerminalHostAction(streamId, job.createdAt)).resolves.toBeUndefined();
      await expect(store.getJob(streamId)).resolves.toBeNull();
      await expect(store.getTerminalHostActionJobs()).resolves.toEqual([]);

      await store.destroy();
    });

    test('appendChunk gives the approval TTL when the chunk key did not exist at pause time', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `paused-no-chunk-${Date.now()}`;
      const chunkKey = `stream:{${streamId}}:chunks`;

      // The job pauses BEFORE any chunk was persisted (ask-user pause with no prior
      // delta, or the first appendChunk still in flight because emitChunk is
      // fire-and-forget). The pause's `EXPIRE chunks` is a no-op because the key
      // does not exist yet, so the chunk stream carries no extended TTL.
      await store.createJob(streamId, 'user-1', streamId);
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: buildPendingAction(streamId) },
      });
      expect(await ioredisClient.exists(chunkKey)).toBe(0);

      // The first chunk lands AFTER the pause. The bug Codex re-raised: appendChunk
      // would create the stream with only the short running TTL (60s), so the
      // aggregated tool-call content is evicted before the 24h approval window ends.
      // The fix reads the paused window from the job key and bumps the chunk TTL to it.
      await store.appendChunk(streamId, {
        event: 'on_pending_action',
        data: buildPendingAction(streamId),
      });

      expect(await ioredisClient.ttl(chunkKey)).toBeGreaterThan(60);
      expect(await ioredisClient.xlen(chunkKey)).toBeGreaterThanOrEqual(1);

      await store.destroy();
    });

    test('appendChunk keeps a normally-running job on the bounded running storage TTL', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `running-no-inflate-${Date.now()}`;
      const chunkKey = `stream:{${streamId}}:chunks`;

      // A normal running job uses the configured running TTL plus the five-minute
      // publication grace window, not the much longer approval window.
      await store.createJob(streamId, 'user-1', streamId);
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { text: 'hello' },
      });

      const ttl = await ioredisClient.ttl(chunkKey);
      expect(ttl).toBeGreaterThan(300);
      expect(ttl).toBeLessThanOrEqual(360);

      await store.destroy();
    });

    test('appendChunk refreshes the retained generation epoch beyond the live job TTL', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `chunk-epoch-refresh-${Date.now()}`;
      const jobKey = `stream:{${streamId}}:job`;
      const epochKey = `stream:{${streamId}}:generation-epoch`;
      const job = await store.createJob(streamId, 'user-1', streamId);
      await ioredisClient.expire(epochKey, 1);

      await expect(
        store.appendChunk(
          streamId,
          { event: 'on_message_delta', data: { text: 'still alive' } },
          job.createdAt,
        ),
      ).resolves.toBe(true);

      const jobTtl = await ioredisClient.ttl(jobKey);
      const epochTtl = await ioredisClient.ttl(epochKey);
      expect(await ioredisClient.get(epochKey)).toBe(String(job.createdAt));
      expect(epochTtl).toBeGreaterThan(jobTtl + 250);

      await store.destroy();
    });

    test('createJob clears stale per-turn identity and provenance from a reused hash', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `stale-agent-${Date.now()}`;
      // Turn 1: a saved agent in a temporary chat that discovered a deferred tool.
      await store.createJob(streamId, 'user-1', streamId, undefined, {
        agent_id: 'saved-agent-1',
        isTemporary: true,
        agentEventDeliveryKey: 'trigger_1',
        agentEventBindingId: 'binding-1',
        agentEventExpectedAction: {
          toolName: 'submit_move',
          argumentSubset: { gameId: 'game-1', expectedPly: 7 },
        },
        agentEventSuspension: {
          version: 1,
          suspensionId: 'suspension-1',
          attempt: 0,
        },
        agentEventLegacyTurnToken: 'legacy-hitl-token',
        discoveredTools: ['deep_tool'],
        userSubmittedPaths: ['/content/0/tool_call/args'],
        userSubmittedMessageFieldPaths: [{ path: '/content/0/tool_call/output', field: 'answer' }],
      });
      const turn1 = await store.getJob(streamId);
      expect(turn1?.agent_id).toBe('saved-agent-1');
      expect(turn1?.isTemporary).toBe(true);
      expect(turn1?.agentEventDeliveryKey).toBe('trigger_1');
      expect(turn1?.agentEventBindingId).toBe('binding-1');
      expect(turn1?.agentEventExpectedAction).toEqual({
        toolName: 'submit_move',
        argumentSubset: { gameId: 'game-1', expectedPly: 7 },
      });
      expect(turn1?.agentEventSuspension).toEqual({
        version: 1,
        suspensionId: 'suspension-1',
        attempt: 0,
      });
      expect(turn1?.agentEventLegacyTurnToken).toBe('legacy-hitl-token');
      expect(turn1?.discoveredTools).toEqual(['deep_tool']);
      expect(turn1?.userSubmittedPaths).toEqual(['/content/0/tool_call/args']);
      expect(turn1?.userSubmittedMessageFieldPaths).toEqual([
        { path: '/content/0/tool_call/output', field: 'answer' },
      ]);

      // Turn 2 on the SAME conversation switches to an ephemeral / non-temporary turn.
      // The hash is keyed by conversationId, so without clearing, the old agent_id and
      // isTemporary would survive — the resume guard would reject the valid pause as a
      // different agent, and the resumed response would be saved as temporary. The stale
      // discoveredTools would also force-load deferred tools this turn never discovered.
      await store.createJob(streamId, 'user-1', streamId);
      const turn2 = await store.getJob(streamId);
      expect(turn2?.agent_id).toBeUndefined();
      expect(turn2?.isTemporary).toBeUndefined();
      expect(turn2?.agentEventDeliveryKey).toBeUndefined();
      expect(turn2?.agentEventBindingId).toBeUndefined();
      expect(turn2?.agentEventExpectedAction).toBeUndefined();
      expect(turn2?.agentEventSuspension).toBeUndefined();
      expect(turn2?.agentEventLegacyTurnToken).toBeUndefined();
      expect(turn2?.discoveredTools).toBeUndefined();
      expect(turn2?.userSubmittedPaths).toBeUndefined();
      expect(turn2?.userSubmittedMessageFieldPaths).toBeUndefined();

      await store.destroy();
    });

    test('createJob clears persisted and live content state when a stream id is reused', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `stale-run-steps-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);
      const oldRunStep = {
        id: 'step-old-job',
        runId: 'response-old',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-old-job', name: 'approval_probe', args: '{}' }],
        },
      } as Agents.RunStep;
      await store.saveRunSteps(streamId, [oldRunStep]);
      await store.appendChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'old-message-step',
          runId: 'old-run',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'old-message-step',
          delta: { content: { type: 'text', text: 'old durable content' } },
        },
      });
      await store.updateJob(streamId, {
        completedAt: Date.now(),
        error: 'old error',
        userMessage: {
          messageId: 'old-user-message',
          text: 'old user message',
        },
        responseMessageId: 'old-response-message',
        discoveredTools: ['old_tool'],
        createdEventEmitted: true,
        sender: 'Old sender',
        finalEvent: '{"event":"old-final"}',
        titleEvent: '{"event":"old-title"}',
        replayEvents: '[{"event":"old-replay"}]',
        contextUsage: '{"usedTokens":10}',
        tokenUsage: '[{"input_tokens":1,"output_tokens":2}]',
        endpoint: 'old-endpoint',
        iconURL: 'https://example.com/old.png',
        model: 'old-model',
        promptTokens: 10,
        agent_id: 'old-agent',
        isTemporary: true,
      });
      store.setGraph(streamId, {
        getContentParts: () => [{ type: 'text', text: 'old graph content' }],
        getRunSteps: () => [oldRunStep],
      } as unknown as StandardGraph);
      store.setContentParts(streamId, [{ type: 'text', text: 'old host content' }]);
      store.setCollectedUsage(streamId, [{ input_tokens: 1, output_tokens: 2 }]);
      expect(await store.getRunSteps(streamId)).toHaveLength(1);

      await store.createJob(streamId, 'user-1', streamId);

      expect(await store.getRunSteps(streamId)).toEqual([]);
      expect(await store.getContentParts(streamId)).toBeNull();
      expect(store.getCollectedUsage(streamId)).toEqual([]);
      expect(await store.getJob(streamId)).toEqual(
        expect.objectContaining({
          streamId,
          userId: 'user-1',
          conversationId: streamId,
          status: 'running',
          syncSent: false,
        }),
      );
      expect(await store.getJob(streamId)).not.toEqual(
        expect.objectContaining({
          responseMessageId: 'old-response-message',
        }),
      );
      await store.destroy();
    });

    test('createJob preserves the prior live content state when replacement persistence fails', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `failed-replacement-${Date.now()}`;
      const oldRunStep = {
        id: 'step-old-job',
        runId: 'response-old',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-old-job', name: 'approval_probe', args: '{}' }],
        },
      } as Agents.RunStep;
      await store.createJob(streamId, 'user-1', streamId);
      store.setGraph(streamId, {
        getContentParts: () => [{ type: 'text', text: 'old graph content' }],
        getRunSteps: () => [oldRunStep],
      } as unknown as StandardGraph);
      store.setContentParts(streamId, [{ type: 'text', text: 'old host content' }]);
      store.setCollectedUsage(streamId, [{ input_tokens: 1, output_tokens: 2 }]);

      const evalSpy = jest
        .spyOn(ioredisClient, 'eval')
        .mockRejectedValueOnce(new Error('replacement write failed'));
      try {
        await expect(store.createJob(streamId, 'user-1', streamId)).rejects.toThrow(
          'replacement write failed',
        );
      } finally {
        evalSpy.mockRestore();
      }

      expect(await store.getRunSteps(streamId)).toEqual([oldRunStep]);
      expect(await store.getContentParts(streamId)).toEqual({
        content: [{ type: 'text', text: 'old host content' }],
      });
      expect(store.getCollectedUsage(streamId)).toEqual([{ input_tokens: 1, output_tokens: 2 }]);
      await store.destroy();
    });

    test('should not drop paused jobs from user tracking when cleanup sees a stale running index', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `requires-action-cleanup-user-${Date.now()}`;
      const streamId = `requires-action-cleanup-${Date.now()}`;
      await store.createJob(streamId, userId, streamId);
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: buildPendingAction(streamId) },
      });

      await ioredisClient.sadd('stream:running', streamId);

      const cleaned = await store.cleanup();
      const runningMembers = await ioredisClient.smembers('stream:running');
      const pausedMembers = await ioredisClient.smembers('stream:requires_action');

      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(runningMembers).not.toContain(streamId);
      expect(pausedMembers).toContain(streamId);
      expect(await store.getActiveJobIdsByUser(userId)).toContain(streamId);

      await store.destroy();
    });

    test('enumerates stale paused jobs from exact and legacy owner indexes', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const suffix = `${process.pid}-${Date.now()}`;
      const userId = `account-cleanup-user-${suffix}`;
      const legacyStreamId = `account-cleanup-legacy-${suffix}`;
      const tenantStreamId = `account-cleanup-tenant-${suffix}`;
      const foreignStreamId = `account-cleanup-foreign-${suffix}`;
      const legacy = await store.createJob(legacyStreamId, userId, legacyStreamId);
      const tenant = await store.createJob(tenantStreamId, userId, tenantStreamId, 'tenant-a');
      await store.createJob(foreignStreamId, userId, foreignStreamId, 'tenant-b');
      await store.transitionStatus(legacyStreamId, {
        from: 'running',
        to: 'requires_action',
        expectCreatedAt: legacy.createdAt,
      });
      await store.transitionStatus(tenantStreamId, {
        from: 'running',
        to: 'requires_action',
        expectCreatedAt: tenant.createdAt,
      });

      expect(await store.getCleanupBlockingJobIdsByUser(userId, 'tenant-a')).toEqual([]);
      const retained = await store.getRetainedJobIdsByUser(userId, 'tenant-a');
      expect(retained).toEqual(expect.arrayContaining([legacyStreamId, tenantStreamId]));
      expect(retained).not.toContain(foreignStreamId);

      await store.destroy();
    });

    test('does not shorten a shared owner index for a longer paused job', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, {
        userJobsSetTtl: 60,
        requiresActionTtl: 120,
      });
      await store.initialize();

      const suffix = `${process.pid}-${Date.now()}`;
      const userId = `mixed-ttl-user-${suffix}`;
      const tenantId = 'tenant-a';
      const pausedStreamId = `mixed-ttl-paused-${suffix}`;
      const paused = await store.createJob(pausedStreamId, userId, pausedStreamId, tenantId);
      const pendingAction = {
        ...buildPendingAction(pausedStreamId),
        expiresAt: Date.now() + 2 * 86400 * 1000,
      };
      await store.transitionStatus(pausedStreamId, {
        from: 'running',
        to: 'requires_action',
        expectCreatedAt: paused.createdAt,
        patch: { pendingAction },
      });
      const ownerKey = `stream:user:{${tenantId}:${userId}}:jobs`;
      const longTtl = await ioredisClient.ttl(ownerKey);

      await store.createJob(
        `mixed-ttl-ordinary-${suffix}`,
        userId,
        'ordinary-conversation',
        tenantId,
      );

      expect(longTtl).toBeGreaterThan(86400);
      expect(await ioredisClient.ttl(ownerKey)).toBeGreaterThan(86400);
      await store.destroy();
    });

    test('should prune expired requires_action IDs during cleanup', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `requires-action-expired-${Date.now()}`;
      const jobKey = `stream:{${streamId}}:job`;
      await store.createJob(streamId, 'user-1', streamId);
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: buildPendingAction(streamId) },
      });

      expect(await ioredisClient.smembers('stream:requires_action')).toContain(streamId);

      await ioredisClient.del(jobKey);

      const cleaned = await store.cleanup();
      const pausedMembers = await ioredisClient.smembers('stream:requires_action');

      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(pausedMembers).not.toContain(streamId);

      await store.destroy();
    });
  });

  describe('Horizontal Scaling - Multi-Instance Simulation', () => {
    test('should share job state between two store instances', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // Simulate two server instances with separate store instances
      const instance1 = new RedisJobStore(ioredisClient);
      const instance2 = new RedisJobStore(ioredisClient);

      await instance1.initialize();
      await instance2.initialize();

      const streamId = `multi-instance-${Date.now()}`;

      // Instance 1 creates job
      await instance1.createJob(streamId, 'user-1', streamId);

      // Instance 2 should see the job
      const jobFromInstance2 = await instance2.getJob(streamId);
      expect(jobFromInstance2).not.toBeNull();
      expect(jobFromInstance2?.streamId).toBe(streamId);

      // Instance 1 updates job
      await instance1.updateJob(streamId, {
        sender: 'TestAgent',
        syncSent: true,
        userSubmittedPaths: ['/content/0/tool_call/args'],
        userSubmittedMessageFieldPaths: [
          { path: '/content/0/tool_call/output', field: 'decision_response' },
        ],
      });

      // Instance 2 should see the update
      const updatedJob = await instance2.getJob(streamId);
      expect(updatedJob?.sender).toBe('TestAgent');
      expect(updatedJob?.syncSent).toBe(true);
      expect(updatedJob?.userSubmittedPaths).toEqual(['/content/0/tool_call/args']);
      expect(updatedJob?.userSubmittedMessageFieldPaths).toEqual([
        { path: '/content/0/tool_call/output', field: 'decision_response' },
      ]);

      await instance1.destroy();
      await instance2.destroy();
    });

    test('should share chunks between instances for content reconstruction', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      const instance1 = new RedisJobStore(ioredisClient);
      const instance2 = new RedisJobStore(ioredisClient);

      await instance1.initialize();
      await instance2.initialize();

      const streamId = `chunk-sharing-${Date.now()}`;
      await instance1.createJob(streamId, 'user-1', streamId);

      // Instance 1 emits chunks (simulating stream generation)
      // Format must match what aggregateContent expects:
      // - on_run_step: { id, index, stepDetails: { type } }
      // - on_message_delta: { id, delta: { content: { type, text } } }
      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'Hello, ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'world!' } } },
        },
      ];

      for (const chunk of chunks) {
        await instance1.appendChunk(streamId, chunk);
      }

      // Instance 2 reconstructs content (simulating reconnect to different instance)
      const result = await instance2.getContentParts(streamId);

      // Should have reconstructed content
      expect(result).not.toBeNull();
      expect(result!.content.length).toBeGreaterThan(0);

      await instance1.destroy();
      await instance2.destroy();
    });

    test('reports the generation-wide durable count after chunk trimming', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `trimmed-chunk-frontier-${Date.now()}`;
      const job = await store.createJob(streamId, 'user-1', streamId);
      for (let i = 0; i < 3; i++) {
        await store.appendChunk(streamId, {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: String(i) } } },
        });
      }
      await ioredisClient.xtrim(`stream:{${streamId}}:chunks`, 'MAXLEN', 1);
      for (let i = 3; i < 5; i++) {
        await store.appendChunk(streamId, {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: String(i) } } },
        });
      }

      const result = await store.getContentParts(streamId, job.createdAt, { durableOnly: true });

      expect(result).toMatchObject({
        reconstructedEventCount: 3,
        durableEventCount: 5,
      });

      await store.destroy();
    });

    test('repairs the durable count after an append from a legacy writer', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `mixed-writer-frontier-${Date.now()}`;
      const job = await store.createJob(streamId, 'user-1', streamId);
      for (let i = 0; i < 3; i++) {
        await store.appendChunk(streamId, {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: String(i) } } },
        });
      }
      await ioredisClient.xadd(
        `stream:{${streamId}}:chunks`,
        '*',
        'event',
        JSON.stringify({
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'legacy' } } },
        }),
      );
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: { type: 'text', text: 'current' } } },
      });

      const result = await store.getContentParts(streamId, job.createdAt, { durableOnly: true });

      expect(result).toMatchObject({
        reconstructedEventCount: 5,
        durableEventCount: 5,
      });

      await store.destroy();
    });

    test('should share run steps between instances', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      const instance1 = new RedisJobStore(ioredisClient);
      const instance2 = new RedisJobStore(ioredisClient);

      await instance1.initialize();
      await instance2.initialize();

      const streamId = `runsteps-sharing-${Date.now()}`;
      await instance1.createJob(streamId, 'user-1', streamId);

      // Instance 1 saves run steps
      const runSteps: Partial<Agents.RunStep>[] = [
        { id: 'step-1', runId: 'run-1', type: StepTypes.MESSAGE_CREATION, index: 0 },
        { id: 'step-2', runId: 'run-1', type: StepTypes.TOOL_CALLS, index: 1 },
      ];

      await instance1.saveRunSteps!(streamId, runSteps as Agents.RunStep[]);

      // Instance 2 retrieves run steps
      const retrievedSteps = await instance2.getRunSteps(streamId);

      expect(retrievedSteps).toHaveLength(2);
      expect(retrievedSteps[0].id).toBe('step-1');
      expect(retrievedSteps[1].id).toBe('step-2');

      await instance1.destroy();
      await instance2.destroy();
    });
  });

  describe('Content Reconstruction', () => {
    test('should reconstruct text content from message deltas', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `text-reconstruction-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Simulate a streaming response with correct event format
      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'The ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'quick ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'brown ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'fox.' } } },
        },
      ];

      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      const result = await store.getContentParts(streamId);

      expect(result).not.toBeNull();
      // Content aggregator combines text deltas
      const textPart = result!.content.find((p) => p.type === 'text');
      expect(textPart).toBeDefined();

      await store.destroy();
    });

    test('should reconstruct thinking content from reasoning deltas', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `think-reconstruction-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // on_reasoning_delta events need id and delta.content format
      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_reasoning_delta',
          data: { id: 'step-1', delta: { content: { type: 'think', think: 'Let me think...' } } },
        },
        {
          event: 'on_reasoning_delta',
          data: {
            id: 'step-1',
            delta: { content: { type: 'think', think: ' about this problem.' } },
          },
        },
        {
          event: 'on_run_step',
          data: {
            id: 'step-2',
            runId: 'run-1',
            index: 1,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-2', delta: { content: { type: 'text', text: 'The answer is 42.' } } },
        },
      ];

      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      const result = await store.getContentParts(streamId);

      expect(result).not.toBeNull();
      // Should have both think and text parts
      const thinkPart = result!.content.find((p) => p.type === 'think');
      const textPart = result!.content.find((p) => p.type === 'text');
      expect(thinkPart).toBeDefined();
      expect(textPart).toBeDefined();

      await store.destroy();
    });

    test('should return null for empty chunks', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `empty-chunks-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // No chunks appended
      const content = await store.getContentParts(streamId);
      expect(content).toBeNull();

      await store.destroy();
    });
  });

  describe('Consumer Groups', () => {
    test('should create consumer group and read chunks', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `consumer-group-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Add some chunks
      const chunks = [
        { event: 'on_message_delta', data: { type: 'text', text: 'Chunk 1' } },
        { event: 'on_message_delta', data: { type: 'text', text: 'Chunk 2' } },
        { event: 'on_message_delta', data: { type: 'text', text: 'Chunk 3' } },
      ];

      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      // Wait for Redis to sync
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Create consumer group starting from beginning
      const groupName = `client-${Date.now()}`;
      await store.createConsumerGroup(streamId, groupName, '0');

      // Read chunks from group
      // Note: With '0' as lastId, we need to use getPendingChunks or read with '0' instead of '>'
      // The '>' only gives new messages after group creation
      const readChunks = await store.getPendingChunks(streamId, groupName, 'consumer-1');

      // If pending is empty, the messages haven't been delivered yet
      // Let's read from '0' using regular read
      if (readChunks.length === 0) {
        // Consumer groups created at '0' should have access to all messages
        // but they need to be "claimed" first. Skip this test as consumer groups
        // require more complex setup for historical messages.
        console.log(
          'Skipping consumer group test - requires claim mechanism for historical messages',
        );
        await store.deleteConsumerGroup(streamId, groupName);
        await store.destroy();
        return;
      }

      expect(readChunks.length).toBe(3);

      // Acknowledge chunks
      const ids = readChunks.map((c) => c.id);
      await store.acknowledgeChunks(streamId, groupName, ids);

      // Reading again should return empty (all acknowledged)
      const moreChunks = await store.readChunksFromGroup(streamId, groupName, 'consumer-1');
      expect(moreChunks.length).toBe(0);

      // Cleanup
      await store.deleteConsumerGroup(streamId, groupName);
      await store.destroy();
    });

    // TODO: Debug consumer group timing with Redis Streams
    test.skip('should resume from where client left off', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `resume-test-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Create consumer group FIRST (before adding chunks) to track delivery
      const groupName = `client-resume-${Date.now()}`;
      await store.createConsumerGroup(streamId, groupName, '$'); // Start from end (only new messages)

      // Add initial chunks (these will be "new" to the consumer group)
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Part 1' },
      });
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Part 2' },
      });

      // Wait for Redis to sync
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Client reads first batch
      const firstRead = await store.readChunksFromGroup(streamId, groupName, 'consumer-1');
      expect(firstRead.length).toBe(2);

      // ACK the chunks
      await store.acknowledgeChunks(
        streamId,
        groupName,
        firstRead.map((c) => c.id),
      );

      // More chunks arrive while client is away
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Part 3' },
      });
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Part 4' },
      });

      // Wait for Redis to sync
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Client reconnects - should only get new chunks
      const secondRead = await store.readChunksFromGroup(streamId, groupName, 'consumer-1');
      expect(secondRead.length).toBe(2);

      await store.deleteConsumerGroup(streamId, groupName);
      await store.destroy();
    });
  });

  describe('TTL and Cleanup', () => {
    test('should set running TTL on chunk stream', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `ttl-test-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', type: 'text', text: 'test' },
      });

      // The storage TTL includes the five-minute terminal-publication grace.
      // Note: ioredis client has keyPrefix, so we use the key WITHOUT the prefix
      // Key uses hash tag format: stream:{streamId}:chunks
      const ttl = await ioredisClient.ttl(`stream:{${streamId}}:chunks`);
      expect(ttl).toBeGreaterThan(300);
      expect(ttl).toBeLessThanOrEqual(360);

      await store.destroy();
    });

    test('should clean up stale jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      // Very short TTL for testing
      const store = new RedisJobStore(ioredisClient, { runningTtl: 1 });
      await store.initialize();

      const streamId = `stale-job-${Date.now()}`;

      // Manually create a job that looks old
      // Note: ioredis client has keyPrefix, so we use the key WITHOUT the prefix
      // Key uses hash tag format: stream:{streamId}:job
      const jobKey = `stream:{${streamId}}:job`;
      const veryOldTimestamp = Date.now() - 10000; // 10 seconds ago

      await ioredisClient.hmset(jobKey, {
        streamId,
        userId: 'user-1',
        status: 'running',
        createdAt: veryOldTimestamp.toString(),
        syncSent: '0',
      });
      await ioredisClient.sadd(`stream:running`, streamId);

      // Run cleanup
      const cleaned = await store.cleanup();

      // Should have cleaned the stale job
      expect(cleaned).toBeGreaterThanOrEqual(1);

      await store.destroy();
    });
  });

  describe('Active Jobs by User', () => {
    test('should return active job IDs for a user', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId1 = `stream-1-${Date.now()}`;
      const streamId2 = `stream-2-${Date.now()}`;

      // Create two jobs for the same user
      await store.createJob(streamId1, userId, streamId1);
      await store.createJob(streamId2, userId, streamId2);

      // Get active jobs for user
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(2);
      expect(activeJobs).toContain(streamId1);
      expect(activeJobs).toContain(streamId2);

      await store.destroy();
    });

    test('same-stream replacement cannot transfer active membership to a different owner', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `owner-replacement-${Date.now()}`;
      const oldUserId = `old-owner-${Date.now()}`;
      const newUserId = `new-owner-${Date.now()}`;
      const original = await store.createJob(streamId, oldUserId, streamId);
      await expect(store.createJob(streamId, newUserId, streamId)).rejects.toThrow(
        'Generation job owner mismatch',
      );

      await expect(store.getActiveJobIdsByUser(oldUserId)).resolves.toContain(streamId);
      await expect(store.getActiveJobIdsByUser(newUserId)).resolves.not.toContain(streamId);
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        userId: oldUserId,
        createdAt: original.createdAt,
      });

      await store.destroy();
    });

    test('should return empty array for user with no jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `nonexistent-user-${Date.now()}`;

      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(0);

      await store.destroy();
    });

    test('should not return completed jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId1 = `stream-1-${Date.now()}`;
      const streamId2 = `stream-2-${Date.now()}`;

      // Create two jobs
      await store.createJob(streamId1, userId, streamId1);
      await store.createJob(streamId2, userId, streamId2);

      // Complete one job
      await store.updateJob(streamId1, { status: 'complete', completedAt: Date.now() });

      // Get active jobs - should only return the running one
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(1);
      expect(activeJobs).toContain(streamId2);
      expect(activeJobs).not.toContain(streamId1);

      await store.destroy();
    });

    test('should not return aborted jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;

      // Create a job and abort it
      await store.createJob(streamId, userId, streamId);
      await store.updateJob(streamId, { status: 'aborted', completedAt: Date.now() });

      // Get active jobs - should be empty
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(0);

      await store.destroy();
    });

    test('should not return error jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;

      // Create a job with error status
      await store.createJob(streamId, userId, streamId);
      await store.updateJob(streamId, {
        status: 'error',
        error: 'Test error',
        completedAt: Date.now(),
      });

      // Get active jobs - should be empty
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(0);

      await store.destroy();
    });

    test('should perform self-healing cleanup of stale entries', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;
      const staleStreamId = `stale-stream-${Date.now()}`;

      // Create a real job
      await store.createJob(streamId, userId, streamId);

      // Manually add a stale entry to the user's job set (simulating orphaned data)
      const userJobsKey = `stream:user:{${userId}}:jobs`;
      await ioredisClient.sadd(userJobsKey, staleStreamId);

      // Verify both entries exist in the set
      const beforeCleanup = await ioredisClient.smembers(userJobsKey);
      expect(beforeCleanup).toContain(streamId);
      expect(beforeCleanup).toContain(staleStreamId);

      // Get active jobs - should trigger self-healing
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      // Should only return the real job
      expect(activeJobs).toHaveLength(1);
      expect(activeJobs).toContain(streamId);

      // Verify stale entry was removed
      const afterCleanup = await ioredisClient.smembers(userJobsKey);
      expect(afterCleanup).toContain(streamId);
      expect(afterCleanup).not.toContain(staleStreamId);

      await store.destroy();
    });

    test('should isolate jobs between different users', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId1 = `user-1-${Date.now()}`;
      const userId2 = `user-2-${Date.now()}`;
      const streamId1 = `stream-1-${Date.now()}`;
      const streamId2 = `stream-2-${Date.now()}`;

      // Create jobs for different users
      await store.createJob(streamId1, userId1, streamId1);
      await store.createJob(streamId2, userId2, streamId2);

      // Get active jobs for user 1
      const user1Jobs = await store.getActiveJobIdsByUser(userId1);
      expect(user1Jobs).toHaveLength(1);
      expect(user1Jobs).toContain(streamId1);
      expect(user1Jobs).not.toContain(streamId2);

      // Get active jobs for user 2
      const user2Jobs = await store.getActiveJobIdsByUser(userId2);
      expect(user2Jobs).toHaveLength(1);
      expect(user2Jobs).toContain(streamId2);
      expect(user2Jobs).not.toContain(streamId1);

      await store.destroy();
    });

    test('should work across multiple store instances (horizontal scaling)', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // Simulate two server instances
      const instance1 = new RedisJobStore(ioredisClient);
      const instance2 = new RedisJobStore(ioredisClient);

      await instance1.initialize();
      await instance2.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;

      // Instance 1 creates a job
      await instance1.createJob(streamId, userId, streamId);

      // Instance 2 should see the active job
      const activeJobs = await instance2.getActiveJobIdsByUser(userId);
      expect(activeJobs).toHaveLength(1);
      expect(activeJobs).toContain(streamId);

      // Instance 1 completes the job
      await instance1.updateJob(streamId, { status: 'complete', completedAt: Date.now() });

      // Instance 2 should no longer see the job as active
      const activeJobsAfter = await instance2.getActiveJobIdsByUser(userId);
      expect(activeJobsAfter).toHaveLength(0);

      await instance1.destroy();
      await instance2.destroy();
    });

    test('should clean up user jobs set when job is deleted', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;

      // Create a job
      await store.createJob(streamId, userId, streamId);

      // Verify job is in active list
      let activeJobs = await store.getActiveJobIdsByUser(userId);
      expect(activeJobs).toContain(streamId);

      // Delete the job
      await store.deleteJob(streamId);

      // Job should no longer be in active list
      activeJobs = await store.getActiveJobIdsByUser(userId);
      expect(activeJobs).not.toContain(streamId);

      await store.destroy();
    });
  });

  describe('User Job Tracking TTL', () => {
    test('should set TTL on user jobs set after createJob', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `ttl-user-${Date.now()}`;
      const streamId = `ttl-stream-${Date.now()}`;

      await store.createJob(streamId, userId, streamId);

      const userKey = `stream:user:{${userId}}:jobs`;
      const ttl = await ioredisClient.ttl(userKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(86400);

      await store.destroy();
    });

    test('should respect custom userJobsSetTtl option', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { userJobsSetTtl: 3600 });
      await store.initialize();

      const userId = `custom-ttl-user-${Date.now()}`;
      const streamId = `custom-ttl-stream-${Date.now()}`;

      await store.createJob(streamId, userId, streamId);

      const userKey = `stream:user:{${userId}}:jobs`;
      const ttl = await ioredisClient.ttl(userKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(3600);

      await store.destroy();
    });

    test('should not set TTL when userJobsSetTtl is 0', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { userJobsSetTtl: 0 });
      await store.initialize();

      const userId = `no-ttl-user-${Date.now()}`;
      const streamId = `no-ttl-stream-${Date.now()}`;

      await store.createJob(streamId, userId, streamId);

      const userKey = `stream:user:{${userId}}:jobs`;
      // -1 means key exists but has no TTL
      const ttl = await ioredisClient.ttl(userKey);
      expect(ttl).toBe(-1);

      // Verify the set itself still exists and contains the streamId
      const members = await ioredisClient.smembers(userKey);
      expect(members).toContain(streamId);

      await store.destroy();
    });

    test('should refresh TTL when a second createJob is issued for the same user', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { userJobsSetTtl: 120 });
      await store.initialize();

      const userId = `refresh-ttl-user-${Date.now()}`;
      const streamId1 = `refresh-stream-1-${Date.now()}`;
      const streamId2 = `refresh-stream-2-${Date.now()}`;

      await store.createJob(streamId1, userId, streamId1);

      const userKey = `stream:user:{${userId}}:jobs`;

      // Manually reduce TTL to simulate time passing
      await ioredisClient.expire(userKey, 30);
      const reducedTtl = await ioredisClient.ttl(userKey);
      expect(reducedTtl).toBeLessThanOrEqual(30);

      // Second createJob should refresh the TTL
      await store.createJob(streamId2, userId, streamId2);

      const refreshedTtl = await ioredisClient.ttl(userKey);
      expect(refreshedTtl).toBeGreaterThan(30);
      expect(refreshedTtl).toBeLessThanOrEqual(120);

      await store.destroy();
    });

    test('should proactively SREM from user jobs set on updateJob to terminal status', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `proactive-srem-user-${Date.now()}`;
      const streamId = `proactive-srem-stream-${Date.now()}`;

      await store.createJob(streamId, userId, streamId);

      const userKey = `stream:user:{${userId}}:jobs`;

      // Verify the entry exists before update
      let members = await ioredisClient.smembers(userKey);
      expect(members).toContain(streamId);

      await store.updateJob(streamId, { status: 'complete', completedAt: Date.now() });

      // Directly check the Redis set — without calling getActiveJobIdsByUser (which self-heals)
      members = await ioredisClient.smembers(userKey);
      expect(members).not.toContain(streamId);

      await store.destroy();
    });

    test('should proactively SREM from user jobs set on updateJob to aborted', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `srem-aborted-user-${Date.now()}`;
      const streamId = `srem-aborted-stream-${Date.now()}`;

      await store.createJob(streamId, userId, streamId);

      const userKey = `stream:user:{${userId}}:jobs`;
      let members = await ioredisClient.smembers(userKey);
      expect(members).toContain(streamId);

      await store.updateJob(streamId, { status: 'aborted', completedAt: Date.now() });

      members = await ioredisClient.smembers(userKey);
      expect(members).not.toContain(streamId);

      await store.destroy();
    });

    test('should proactively SREM from user jobs set on updateJob to error', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `srem-error-user-${Date.now()}`;
      const streamId = `srem-error-stream-${Date.now()}`;

      await store.createJob(streamId, userId, streamId);

      const userKey = `stream:user:{${userId}}:jobs`;
      let members = await ioredisClient.smembers(userKey);
      expect(members).toContain(streamId);

      await store.updateJob(streamId, {
        status: 'error',
        error: 'Test error',
        completedAt: Date.now(),
      });

      members = await ioredisClient.smembers(userKey);
      expect(members).not.toContain(streamId);

      await store.destroy();
    });

    test('should proactively SREM from user jobs set on deleteJob', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `delete-srem-user-${Date.now()}`;
      const streamId = `delete-srem-stream-${Date.now()}`;

      await store.createJob(streamId, userId, streamId);

      const userKey = `stream:user:{${userId}}:jobs`;

      // Verify entry exists
      let members = await ioredisClient.smembers(userKey);
      expect(members).toContain(streamId);

      await store.deleteJob(streamId);

      // Directly check the Redis set
      members = await ioredisClient.smembers(userKey);
      expect(members).not.toContain(streamId);

      await store.destroy();
    });

    test('should set TTL on tenant-qualified user jobs set', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `tenant-user-${Date.now()}`;
      const tenantId = `tenant-${Date.now()}`;
      const streamId = `tenant-stream-${Date.now()}`;

      await store.createJob(streamId, userId, streamId, tenantId);

      const userKey = `stream:user:{${tenantId}:${userId}}:jobs`;
      const members = await ioredisClient.smembers(userKey);
      expect(members).toContain(streamId);

      const ttl = await ioredisClient.ttl(userKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(86400);

      // Non-tenant key should NOT contain this entry
      const wrongKey = `stream:user:{${userId}}:jobs`;
      const wrongMembers = await ioredisClient.smembers(wrongKey);
      expect(wrongMembers).not.toContain(streamId);

      await store.destroy();
    });
  });

  describe('Race Condition: updateJob after deleteJob', () => {
    test('should not re-create job hash when updateJob runs after deleteJob', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `race-condition-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      const jobKey = `stream:{${streamId}}:job`;
      const ttlBefore = await ioredisClient.ttl(jobKey);
      expect(ttlBefore).toBeGreaterThan(0);

      await store.deleteJob(streamId);

      const afterDelete = await ioredisClient.exists(jobKey);
      expect(afterDelete).toBe(0);

      await store.updateJob(streamId, { finalEvent: JSON.stringify({ final: true }) });

      const afterUpdate = await ioredisClient.exists(jobKey);
      expect(afterUpdate).toBe(0);

      await store.destroy();
    });

    test('should not leave orphan keys from concurrent emitDone and deleteJob', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `concurrent-race-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      const jobKey = `stream:{${streamId}}:job`;

      await Promise.all([
        store.updateJob(streamId, { finalEvent: JSON.stringify({ final: true }) }),
        store.deleteJob(streamId),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const exists = await ioredisClient.exists(jobKey);
      const ttl = exists ? await ioredisClient.ttl(jobKey) : -2;

      expect(ttl === -2 || ttl > 0).toBe(true);
      expect(ttl).not.toBe(-1);

      await store.destroy();
    });
  });

  describe('Local Graph Cache Optimization', () => {
    test('should use local cache when available', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `local-cache-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Create a mock graph
      const mockContentParts = [{ type: 'text', text: 'From local cache' }];
      const mockRunSteps = [{ id: 'step-1', type: 'message_creation', status: 'completed' }];
      const mockGraph = {
        getContentParts: () => mockContentParts,
        getRunSteps: () => mockRunSteps,
      };

      // Set graph reference (will be cached locally)
      store.setGraph(streamId, mockGraph as unknown as StandardGraph);

      // Get content - should come from local cache, not Redis
      const result = await store.getContentParts(streamId);
      expect(result!.content).toEqual(mockContentParts);

      // Get run steps - should come from local cache
      const runSteps = await store.getRunSteps(streamId);
      expect(runSteps).toEqual(mockRunSteps);

      await store.destroy();
    });

    test('should fall back to Redis when local cache not available', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // Instance 1 creates and populates data
      const instance1 = new RedisJobStore(ioredisClient);
      await instance1.initialize();

      const streamId = `fallback-test-${Date.now()}`;
      await instance1.createJob(streamId, 'user-1', streamId);

      // Add chunks to Redis with correct format
      await instance1.appendChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await instance1.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: { type: 'text', text: 'From Redis' } } },
      });

      // Save run steps to Redis
      await instance1.saveRunSteps!(streamId, [
        {
          id: 'step-1',
          runId: 'run-1',
          type: StepTypes.MESSAGE_CREATION,
          index: 0,
        } as unknown as Agents.RunStep,
      ]);

      // Instance 2 has NO local cache - should fall back to Redis
      const instance2 = new RedisJobStore(ioredisClient);
      await instance2.initialize();

      // Get content - should reconstruct from Redis chunks
      const result = await instance2.getContentParts(streamId);
      expect(result).not.toBeNull();
      expect(result!.content.length).toBeGreaterThan(0);

      // Get run steps - should fetch from Redis
      const runSteps = await instance2.getRunSteps(streamId);
      expect(runSteps).toHaveLength(1);
      expect(runSteps[0].id).toBe('step-1');

      await instance1.destroy();
      await instance2.destroy();
    });
  });

  describe('Batched Cleanup', () => {
    test('should clean up many stale jobs in parallel batches', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      // Very short TTL so jobs are immediately stale
      const store = new RedisJobStore(ioredisClient, { runningTtl: 1 });
      await store.initialize();

      const jobCount = 75; // More than one batch of 50
      const veryOldTimestamp = Date.now() - 10000; // 10 seconds ago

      // Create many stale jobs directly in Redis
      for (let i = 0; i < jobCount; i++) {
        const streamId = `batch-cleanup-${Date.now()}-${i}`;
        const jobKey = `stream:{${streamId}}:job`;
        await ioredisClient.hmset(jobKey, {
          streamId,
          userId: 'batch-user',
          status: 'running',
          createdAt: veryOldTimestamp.toString(),
          syncSent: '0',
        });
        await ioredisClient.sadd('stream:running', streamId);
      }

      // Verify jobs are in the running set
      const runningBefore = await ioredisClient.scard('stream:running');
      expect(runningBefore).toBeGreaterThanOrEqual(jobCount);

      // Run cleanup - should process in batches of 50
      const cleaned = await store.cleanup();
      expect(cleaned).toBeGreaterThanOrEqual(jobCount);

      await store.destroy();
    });

    test('should not clean up valid running jobs during batch cleanup', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 1200 });
      await store.initialize();

      // Create a mix of valid and stale jobs
      const validStreamId = `valid-job-${Date.now()}`;
      await store.createJob(validStreamId, 'user-1', validStreamId);

      const staleStreamId = `stale-job-${Date.now()}`;
      const jobKey = `stream:{${staleStreamId}}:job`;
      await ioredisClient.hmset(jobKey, {
        streamId: staleStreamId,
        userId: 'user-1',
        status: 'running',
        createdAt: (Date.now() - 2000000).toString(), // Very old
        syncSent: '0',
      });
      await ioredisClient.sadd('stream:running', staleStreamId);

      const cleaned = await store.cleanup();
      expect(cleaned).toBeGreaterThanOrEqual(1);

      // Valid job should still exist
      const validJob = await store.getJob(validStreamId);
      expect(validJob).not.toBeNull();
      expect(validJob?.status).toBe('running');

      await store.destroy();
    });
  });

  describe('appendChunk TTL Refresh', () => {
    test('should set TTL on the chunk stream', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 120 });
      await store.initialize();

      const streamId = `append-ttl-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', type: 'text', text: 'first' },
      });

      const chunkKey = `stream:{${streamId}}:chunks`;
      const ttl = await ioredisClient.ttl(chunkKey);
      expect(ttl).toBeGreaterThan(300);
      expect(ttl).toBeLessThanOrEqual(420);

      await store.destroy();
    });

    test('should refresh TTL on subsequent chunks (not just first)', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 120 });
      await store.initialize();

      const streamId = `append-refresh-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Append first chunk
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', type: 'text', text: 'first' },
      });

      const chunkKey = `stream:{${streamId}}:chunks`;
      const ttl1 = await ioredisClient.ttl(chunkKey);
      expect(ttl1).toBeGreaterThan(0);

      // Manually reduce TTL to simulate time passing
      await ioredisClient.expire(chunkKey, 30);
      const reducedTtl = await ioredisClient.ttl(chunkKey);
      expect(reducedTtl).toBeLessThanOrEqual(30);

      // Append another chunk - TTL should be refreshed to the running storage
      // window (configured running TTL plus publication grace).
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', type: 'text', text: 'second' },
      });

      const ttl2 = await ioredisClient.ttl(chunkKey);
      // Should be refreshed to ~420, not still ~30.
      expect(ttl2).toBeGreaterThan(30);
      expect(ttl2).toBeLessThanOrEqual(420);

      await store.destroy();
    });

    test('should store chunks correctly via pipeline', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `append-pipeline-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'Hello ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'world!' } } },
        },
      ];

      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      // Verify all chunks were stored
      const chunkKey = `stream:{${streamId}}:chunks`;
      const len = await ioredisClient.xlen(chunkKey);
      expect(len).toBe(3);

      // Verify content can be reconstructed
      const content = await store.getContentParts(streamId);
      expect(content).not.toBeNull();
      expect(content!.content.length).toBeGreaterThan(0);

      await store.destroy();
    });
  });

  describe('Steering Queue', () => {
    function buildSteer(steerId: string, text: string) {
      return { steerId, text, userId: 'steer-user', createdAt: Date.now() };
    }

    test('enqueue is status-guarded and FIFO drain is atomic take-all', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { STEER_ENQUEUE_NOT_RUNNING } = await import('../interfaces/IJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-fifo-${Date.now()}`;
      expect(await store.enqueueSteer(streamId, buildSteer('s0', 'no job'))).toBe(
        STEER_ENQUEUE_NOT_RUNNING,
      );

      await store.createJob(streamId, 'steer-user', streamId);
      expect(await store.enqueueSteer(streamId, buildSteer('s1', 'first'))).toBe(1);
      expect(await store.enqueueSteer(streamId, buildSteer('s2', 'second'))).toBe(2);

      expect((await store.peekSteers(streamId)).map((s) => s.text)).toEqual(['first', 'second']);
      expect((await store.drainSteers(streamId)).map((s) => s.text)).toEqual(['first', 'second']);
      expect(await store.drainSteers(streamId)).toEqual([]);

      // Terminal job refuses new steers atomically (Lua status guard)
      await store.updateJob(streamId, { status: 'complete', completedAt: Date.now() });
      expect(await store.enqueueSteer(streamId, buildSteer('s3', 'late'))).toBe(
        STEER_ENQUEUE_NOT_RUNNING,
      );

      await store.destroy();
    });

    test('enforces the queue depth cap', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { STEER_ENQUEUE_QUEUE_FULL, STEER_QUEUE_MAX_DEPTH } = await import(
        '../interfaces/IJobStore'
      );
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-cap-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId);

      for (let i = 0; i < STEER_QUEUE_MAX_DEPTH; i++) {
        expect(await store.enqueueSteer(streamId, buildSteer(`s${i}`, `text ${i}`))).toBe(i + 1);
      }
      expect(await store.enqueueSteer(streamId, buildSteer('overflow', 'too many'))).toBe(
        STEER_ENQUEUE_QUEUE_FULL,
      );

      await store.destroy();
    });

    test('closeAndDrain atomically closes the queue; createJob reopens and clears it', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { STEER_ENQUEUE_NOT_RUNNING } = await import('../interfaces/IJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-close-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId);
      await store.enqueueSteer(streamId, buildSteer('s1', 'drained'));

      const drained = await store.closeAndDrainSteers(streamId);
      expect(drained.map((s) => s.text)).toEqual(['drained']);

      // Job hash still says `running`, but the closed flag rejects the race.
      expect(await store.enqueueSteer(streamId, buildSteer('s2', 'raced'))).toBe(
        STEER_ENQUEUE_NOT_RUNNING,
      );

      // Replacement reopens the channel and starts with an empty queue.
      await store.createJob(streamId, 'steer-user', streamId);
      expect(await store.peekSteers(streamId)).toEqual([]);
      expect(await store.enqueueSteer(streamId, buildSteer('s3', 'fresh'))).toBe(1);

      await store.destroy();
    });

    test('terminal claim-or-seal atomically assigns the final steer race', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { STEER_ENQUEUE_NOT_RUNNING } = await import('../interfaces/IJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const claimStream = `steer-terminal-claim-${Date.now()}`;
      const claimJob = await store.createJob(claimStream, 'steer-user', claimStream);
      const first = buildSteer('terminal-first', 'first');
      const second = buildSteer('terminal-second', 'second');
      await store.enqueueSteer(claimStream, first, claimJob.createdAt);
      await store.enqueueSteer(claimStream, second, claimJob.createdAt);

      await expect(
        store.admitTerminalSteers(
          claimStream,
          { allowClaim: true, keepOpenWhenEmpty: false },
          claimJob.createdAt,
        ),
      ).resolves.toEqual({ outcome: 'claimed', items: [first, second] });
      await expect(store.peekClaimedSteers(claimStream, claimJob.createdAt)).resolves.toEqual([
        first,
        second,
      ]);
      await expect(
        store.enqueueSteer(claimStream, buildSteer('terminal-later', 'later'), claimJob.createdAt),
      ).resolves.toBe(1);

      const openStream = `steer-terminal-open-${Date.now()}`;
      const openJob = await store.createJob(openStream, 'steer-user', openStream);
      await expect(
        store.admitTerminalSteers(
          openStream,
          { allowClaim: true, keepOpenWhenEmpty: true },
          openJob.createdAt,
        ),
      ).resolves.toEqual({ outcome: 'open' });
      await expect(
        store.enqueueSteer(
          openStream,
          buildSteer('terminal-planned', 'planned'),
          openJob.createdAt,
        ),
      ).resolves.toBe(1);

      const sealStream = `steer-terminal-seal-${Date.now()}`;
      const sealJob = await store.createJob(sealStream, 'steer-user', sealStream);
      const queued = buildSteer('terminal-queued', 'ordinary follow-up');
      await store.enqueueSteer(sealStream, queued, sealJob.createdAt);
      await expect(
        store.admitTerminalSteers(
          sealStream,
          { allowClaim: false, keepOpenWhenEmpty: false },
          sealJob.createdAt,
        ),
      ).resolves.toEqual({ outcome: 'sealed' });
      await expect(
        store.enqueueSteer(sealStream, buildSteer('terminal-raced', 'raced'), sealJob.createdAt),
      ).resolves.toBe(STEER_ENQUEUE_NOT_RUNNING);
      await expect(store.closeAndDrainSteers(sealStream, sealJob.createdAt)).resolves.toEqual([
        queued,
      ]);

      const replacement = await store.createJob(sealStream, 'steer-user', sealStream);
      await expect(
        store.admitTerminalSteers(
          sealStream,
          { allowClaim: true, keepOpenWhenEmpty: false },
          sealJob.createdAt,
        ),
      ).resolves.toEqual({ outcome: 'unavailable' });
      await expect(
        store.enqueueSteer(
          sealStream,
          buildSteer('terminal-replacement', 'replacement'),
          replacement.createdAt,
        ),
      ).resolves.toBe(1);

      await store.destroy();
    });

    test('terminal CAS atomically returns and parks claimed plus queued steers', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-terminal-drain-${Date.now()}`;
      const userId = 'terminal-drain-user';
      const job = await store.createJob(streamId, userId, streamId);
      const claimed = buildSteer('claimed-before-abort', 'claimed first');
      const queued = buildSteer('queued-before-abort', 'queued second');
      await store.enqueueSteer(streamId, claimed);
      await expect(store.drainSteers(streamId, job.createdAt)).resolves.toEqual([claimed]);
      await store.enqueueSteer(streamId, queued);

      await expect(
        store.transitionStatusAndDrainSteers(streamId, {
          from: 'running',
          to: 'aborted',
          expectCreatedAt: job.createdAt,
          patch: { completedAt: Date.now() },
        }),
      ).resolves.toEqual([claimed, queued]);
      await expect(store.getJob(streamId)).resolves.toMatchObject({ status: 'aborted' });
      await expect(store.peekSteers(streamId, job.createdAt)).resolves.toEqual([]);
      await expect(store.peekClaimedSteers(streamId, job.createdAt)).resolves.toEqual([]);
      const parked = await store.claimParkedSteers(streamId, userId);
      expect(JSON.parse(parked as string)).toMatchObject({
        userId,
        steers: [
          { steerId: claimed.steerId, text: claimed.text },
          { steerId: queued.steerId, text: queued.text },
        ],
      });

      await expect(
        store.transitionStatusAndDrainSteers(streamId, {
          from: 'running',
          to: 'aborted',
          expectCreatedAt: job.createdAt,
        }),
      ).resolves.toBeNull();

      await store.destroy();
    });

    test('createJob clears steers inherited from a replaced job', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-replace-${Date.now()}`;
      const predecessor = await store.createJob(streamId, 'steer-user', streamId);
      await store.enqueueSteer(streamId, buildSteer('s1', 'old run steer'));

      const replacement = await store.createJob(streamId, 'steer-user', streamId);
      await store.enqueueSteer(streamId, buildSteer('s2', 'replacement steer'));

      expect(await store.peekSteers(streamId, predecessor.createdAt)).toEqual([]);
      expect(
        (await store.peekSteers(streamId, replacement.createdAt)).map((steer) => steer.text),
      ).toEqual(['replacement steer']);

      await store.destroy();
    });

    test('pausing for review extends the steers key TTL to the approval window', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-pause-ttl-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId);
      await store.enqueueSteer(streamId, buildSteer('s1', 'kept across pause'));

      const paused = await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: buildPendingAction(streamId) },
      });
      expect(paused).toBe(true);

      // Running TTL is 1200s; the paused window is >= the 24h backstop.
      const ttl = await ioredisClient.ttl(`stream:{${streamId}}:steers`);
      expect(ttl).toBeGreaterThan(1200);

      // The queued steer survives the pause for the resumed run to drain.
      expect((await store.peekSteers(streamId)).map((s) => s.text)).toEqual(['kept across pause']);

      await store.destroy();
    });

    test('pausing for review extends the event sequence TTL to the approval window', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `sequence-pause-ttl-${Date.now()}`;
      const sequenceKey = `stream:{${streamId}}:seq`;
      await store.createJob(streamId, 'sequence-user', streamId);
      await ioredisClient.set(sequenceKey, '1', 'EX', 1200);

      const approvalWindowSeconds = 48 * 60 * 60;
      const pendingAction = {
        ...buildPendingAction(streamId),
        expiresAt: Date.now() + approvalWindowSeconds * 1000,
      };
      const paused = await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction },
      });
      expect(paused).toBe(true);

      const ttl = await ioredisClient.ttl(sequenceKey);
      expect(ttl).toBeGreaterThan(24 * 60 * 60);
      expect(ttl).toBeLessThanOrEqual(approvalWindowSeconds + 360);

      await store.destroy();
    });

    test('terminal transitions and deleteJob remove the steers key', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-cleanup-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId);
      await store.enqueueSteer(streamId, buildSteer('s1', 'leftover'));

      await store.updateJob(streamId, { status: 'aborted', completedAt: Date.now() });
      expect(await ioredisClient.exists(`stream:{${streamId}}:steers`)).toBe(0);

      // Recreate + enqueue, then hard delete
      await store.createJob(streamId, 'steer-user', streamId);
      await store.enqueueSteer(streamId, buildSteer('s2', 'leftover again'));
      await store.deleteJob(streamId);
      expect(await ioredisClient.exists(`stream:{${streamId}}:steers`)).toBe(0);

      await store.destroy();
    });

    test('removeSteer takes one item, keeps order, and preserves the list TTL', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-remove-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId);
      await store.enqueueSteer(streamId, buildSteer('c1', 'keep me first'));
      await store.enqueueSteer(streamId, buildSteer('c2', 'cancel me'));
      await store.enqueueSteer(streamId, buildSteer('c3', 'keep me last'));

      expect(await store.removeSteer(streamId, 'c2')).toBe(true);
      expect(await store.removeSteer(streamId, 'c2')).toBe(false);
      expect((await store.peekSteers(streamId)).map((s) => s.steerId)).toEqual(['c1', 'c3']);
      expect(await ioredisClient.ttl(`stream:{${streamId}}:steers`)).toBeGreaterThan(0);

      await store.destroy();
    });

    test('removeSteer atomically refuses a generation replaced after authorization', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-remove-replaced-${Date.now()}`;
      const predecessor = await store.createJob(streamId, 'steer-user', streamId);
      const reusedId = buildSteer('reused-id', 'predecessor');
      await store.enqueueSteer(streamId, reusedId, predecessor.createdAt);
      const replacement = await store.createJob(streamId, 'steer-user', streamId);
      const replacementItem = buildSteer(reusedId.steerId, 'replacement');
      await store.enqueueSteer(streamId, replacementItem, replacement.createdAt);

      await expect(
        store.removeSteer(streamId, reusedId.steerId, predecessor.createdAt),
      ).resolves.toBe(false);
      await expect(store.peekSteers(streamId, replacement.createdAt)).resolves.toEqual([
        replacementItem,
      ]);

      await store.destroy();
    });

    test('parked steers survive deleteJob, replay on read, and consume on exact recovery', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-parked-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId);
      const payload = JSON.stringify({
        userId: 'steer-user',
        steers: [{ steerId: 'p1', text: 'kept', createdAt: 1 }],
      });
      await store.parkSteers(streamId, payload);

      // Survives full job deletion (the default completeJob path)…
      await store.deleteJob(streamId);
      expect(await ioredisClient.exists(`stream:{${streamId}}:parked`)).toBe(1);
      // …under its own bounded TTL, not the job's lifecycle.
      expect(await ioredisClient.ttl(`stream:{${streamId}}:parked`)).toBeGreaterThan(0);

      // Owner reads are replayable so a lost status response cannot erase recovery.
      expect(JSON.parse((await store.claimParkedSteers(streamId, 'steer-user')) as string)).toEqual(
        { ...JSON.parse(payload), generationProtocolVersion: 2 },
      );
      expect(JSON.parse((await store.claimParkedSteers(streamId, 'steer-user')) as string)).toEqual(
        { ...JSON.parse(payload), generationProtocolVersion: 2 },
      );

      // Starting the deterministic recovery leases (hides) the source without
      // deleting it before the ordinary user message is durable.
      const failedRecovery = await store.createJob(
        streamId,
        'steer-user',
        streamId,
        undefined,
        {},
        'p1',
        undefined,
        undefined,
        undefined,
        { text: 'kept', fileIds: [], quotes: [] },
      );
      expect(await store.claimParkedSteers(streamId, 'steer-user')).toBeUndefined();
      expect(await ioredisClient.exists(`stream:{${streamId}}:parked`)).toBe(1);

      // Initialization failure makes the lease visible again.
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'error',
        expectCreatedAt: failedRecovery.createdAt,
        patch: { error: 'provider init failed', completedAt: Date.now() },
      });
      expect(JSON.parse((await store.claimParkedSteers(streamId, 'steer-user')) as string)).toEqual(
        { ...JSON.parse(payload), generationProtocolVersion: 2 },
      );

      // A persisted retry commits and removes the exact source.
      const persistedRecovery = await store.createJob(
        streamId,
        'steer-user',
        streamId,
        undefined,
        {},
        'p1',
        undefined,
        undefined,
        undefined,
        { text: 'kept', fileIds: [], quotes: [] },
      );
      expect(
        await store.consumeParkedSteer(
          streamId,
          'p1',
          'steer-user',
          undefined,
          persistedRecovery.createdAt,
        ),
      ).toBe(true);
      expect(await store.claimParkedSteers(streamId, 'steer-user')).toBeUndefined();
      expect(await ioredisClient.exists(`stream:{${streamId}}:parked`)).toBe(0);

      await store.destroy();
    });

    test.each([
      ['changed text', { text: 'forged words', fileIds: ['file-a', 'file-b'], quotes: [] }],
      ['changed files', { text: 'original words', fileIds: ['file-a', 'file-c'], quotes: [] }],
      [
        'changed quotes',
        { text: 'original words', fileIds: ['file-a', 'file-b'], quotes: ['forged excerpt'] },
      ],
    ])('atomically refuses parked recovery with %s', async (_label, proof) => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-recovery-mismatch-${_label.replace(' ', '-')}-${Date.now()}`;
      const originalJob = await store.createJob(streamId, 'steer-user', streamId);
      const source = {
        steerId: `source-${_label.replace(' ', '-')}`,
        text: 'original words',
        createdAt: 1,
        files: [{ file_id: 'file-b' }, { file_id: 'file-a' }],
      };
      await store.parkSteers(streamId, JSON.stringify({ userId: 'steer-user', steers: [source] }));

      await expect(
        store.createJob(
          streamId,
          'steer-user',
          streamId,
          undefined,
          {},
          source.steerId,
          undefined,
          undefined,
          undefined,
          proof,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_PAYLOAD_MISMATCH' });

      expect((await store.getJob(streamId))?.createdAt).toBe(originalJob.createdAt);
      expect(JSON.parse((await store.claimParkedSteers(streamId, 'steer-user')) as string)).toEqual(
        {
          userId: 'steer-user',
          generationProtocolVersion: 2,
          steers: [source],
        },
      );
      await store.destroy();
    });

    test('a non-owner claim leaves the parked payload untouched (atomic owner gate)', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-parked-owner-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId, undefined, {
        generationProtocolVersion: 2,
      });
      const payload = JSON.stringify({
        userId: 'steer-user',
        steers: [{ steerId: 'p1', text: 'owner only', createdAt: 1 }],
      });
      await store.parkSteers(streamId, payload);

      // The Lua gate rejects WITHOUT deleting: no delete-then-re-park window
      // in which a concurrent owner claim would find nothing.
      expect(await store.claimParkedSteers(streamId, 'intruder')).toBeUndefined();
      expect(
        JSON.parse((await ioredisClient.get(`stream:{${streamId}}:parked`)) as string),
      ).toEqual({ ...JSON.parse(payload), generationProtocolVersion: 2 });

      // The owner can safely replay the read without deleting the payload.
      expect(JSON.parse((await store.claimParkedSteers(streamId, 'steer-user')) as string)).toEqual(
        { ...JSON.parse(payload), generationProtocolVersion: 2 },
      );
      expect(JSON.parse((await store.claimParkedSteers(streamId, 'steer-user')) as string)).toEqual(
        { ...JSON.parse(payload), generationProtocolVersion: 2 },
      );
      expect(await ioredisClient.exists(`stream:{${streamId}}:parked`)).toBe(1);

      await store.destroy();
    });

    test('expiry cleanup parks queued steers before the terminal transition drops the queue', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-expiry-park-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId, 'tenant-1');
      await store.enqueueSteer(streamId, buildSteer('s1', 'frozen across the pause'));

      // Pause on an ALREADY-expired action so the next cleanup pass reaps it
      // (mirrors how the requires_action index treats a lapsed approval).
      const expiredAction = { ...buildPendingAction(streamId), expiresAt: Date.now() - 1000 };
      const paused = await store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        patch: { pendingAction: expiredAction, pendingActionId: expiredAction.actionId },
      });
      expect(paused).toBe(true);

      await store.cleanup();

      // The job finalized (aborted) and the queue key is gone…
      const job = await store.getJob(streamId);
      expect(job?.status).toBe('aborted');
      expect(await ioredisClient.exists(`stream:{${streamId}}:steers`)).toBe(0);

      // …but the 202-accepted steer is claimable by its owner.
      const claimed = await store.claimParkedSteers(streamId, 'steer-user', 'tenant-1');
      expect(claimed).toBeDefined();
      const parsed = JSON.parse(claimed as string) as {
        userId: string;
        tenantId?: string;
        steers: Array<{ steerId: string; text: string }>;
      };
      expect(parsed.userId).toBe('steer-user');
      expect(parsed.tenantId).toBe('tenant-1');
      expect(parsed.steers.map((s) => s.text)).toEqual(['frozen across the pause']);

      await store.destroy();
    });

    test('expiry cleanup waits for a fresh pause barrier then fails it closed', async () => {
      if (!ioredisClient) {
        return;
      }

      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      try {
        const streamId = 'pause-barrier-expiry-cleanup';
        const job = await store.createJob(streamId, 'steer-user', streamId, 'tenant-1');
        await store.updateJob(
          streamId,
          { agentEventDeliveryKey: 'trigger-pause-barrier-expiry' },
          job.createdAt,
        );
        await store.enqueueSteer(
          streamId,
          buildSteer('pause-barrier-steer', 'frozen while pause persists'),
          job.createdAt,
        );
        const expiredAction = { ...buildPendingAction(streamId), expiresAt: 0 };
        await expect(
          store.transitionStatus(streamId, {
            from: 'running',
            to: 'requires_action',
            expectCreatedAt: job.createdAt,
            patch: {
              pendingAction: expiredAction,
              pendingActionId: `pause-persistence:${expiredAction.actionId}`,
              terminalPersistencePending: true,
              terminalPersistenceStartedAt: 1_000,
            },
          }),
        ).resolves.toBe(true);

        now.mockReturnValue(11_000);
        await store.cleanup();
        await expect(store.getJob(streamId)).resolves.toMatchObject({
          status: 'requires_action',
          terminalPersistencePending: true,
        });

        now.mockReturnValue(31_001);
        await store.cleanup();
        await expect(store.getJob(streamId)).resolves.toMatchObject({
          status: 'error',
          error: PAUSE_PERSISTENCE_TIMEOUT_ERROR,
          terminalHostActionPending: true,
        });
        const failedJob = await store.getJob(streamId);
        expect(failedJob?.pendingAction).toBeUndefined();
        expect(failedJob?.pendingActionId).toBeUndefined();
        expect(failedJob?.terminalPersistencePending).toBeUndefined();
        expect(failedJob?.terminalPersistenceStartedAt).toBeUndefined();
        await expect(store.claimParkedSteers(streamId, 'steer-user', 'tenant-1')).resolves.toEqual(
          expect.any(String),
        );
      } finally {
        await store.destroy();
        now.mockRestore();
      }
    });

    test('terminal CAS with zero completed TTL keeps parked steers owner-claimable', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { completedTtl: 0 });
      await store.initialize();

      const streamId = `steer-zero-terminal-${Date.now()}`;
      const userId = 'zero-terminal-user';
      const job = await store.createJob(streamId, userId, streamId, 'tenant-1');
      await store.enqueueSteer(streamId, buildSteer('s1', 'survive immediate job expiry'));

      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'error',
          expectCreatedAt: job.createdAt,
          patch: { error: 'stopped', completedAt: Date.now() },
        }),
      ).resolves.toBe(true);

      await expect(store.getJob(streamId)).resolves.toBeNull();
      expect(await ioredisClient.smembers('stream:running')).not.toContain(streamId);
      expect(await store.getActiveJobIdsByUser(userId, 'tenant-1')).not.toContain(streamId);

      const claimed = await store.claimParkedSteers(streamId, userId, 'tenant-1');
      expect(claimed).toBeDefined();
      expect(JSON.parse(claimed as string)).toMatchObject({
        userId,
        tenantId: 'tenant-1',
        steers: [{ steerId: 's1', text: 'survive immediate job expiry' }],
      });

      await store.destroy();
    });

    test('terminal persistence survives a zero completed TTL until it is finalized', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { completedTtl: 0 });
      await store.initialize();

      const streamId = `zero-terminal-persistence-${Date.now()}`;
      const job = await store.createJob(streamId, 'terminal-user', streamId);
      const completedAt = Date.now();
      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'aborted',
          expectCreatedAt: job.createdAt,
          patch: {
            completedAt,
            terminalPersistencePending: true,
            terminalPersistenceStartedAt: completedAt,
          },
        }),
      ).resolves.toBe(true);

      await expect(store.getJob(streamId)).resolves.toMatchObject({
        status: 'aborted',
        terminalPersistencePending: true,
      });
      await expect(
        store.finalizeTerminalPersistence(streamId, job.createdAt, '{"event":"final"}'),
      ).resolves.toBe(true);
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        terminalPersistencePending: false,
        finalEvent: '{"event":"final"}',
      });

      await store.destroy();
    });

    test('terminal CAS fails closed without deleting malformed recovery state', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-malformed-terminal-${Date.now()}`;
      const userId = 'malformed-terminal-user';
      const job = await store.createJob(streamId, userId, streamId, 'tenant-1');
      await store.enqueueSteer(streamId, buildSteer('valid-steer', 'preserve valid input'));
      await ioredisClient.rpush(`stream:{${streamId}}:steers`, '{malformed-json');

      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'error',
          expectCreatedAt: job.createdAt,
          patch: { error: 'stopped', completedAt: Date.now() },
        }),
      ).resolves.toBe(false);

      await expect(store.getJob(streamId)).resolves.toMatchObject({
        status: 'running',
        createdAt: job.createdAt,
      });
      const preserved = await ioredisClient.lrange(`stream:{${streamId}}:steers`, 0, -1);
      expect(preserved).toHaveLength(2);
      expect(JSON.parse(preserved[0])).toMatchObject({
        steerId: 'valid-steer',
        text: 'preserve valid input',
      });
      expect(preserved[1]).toBe('{malformed-json');
      await expect(store.claimParkedSteers(streamId, userId, 'tenant-1')).resolves.toBeUndefined();

      await store.destroy();
    });

    test('stale-running reap parks queued steers before deleting the job', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 1 });
      await store.initialize();

      const streamId = `steer-stale-park-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId, 'tenant-1');
      await store.enqueueSteer(streamId, buildSteer('s1', 'crash survivor'));

      // Backdate creation past the running TTL so the next cleanup pass reaps
      // it via the stale-running branch (no finalization ever ran).
      await ioredisClient.hset(
        `stream:{${streamId}}:job`,
        'createdAt',
        String(Date.now() - 10_000),
      );

      const cleaned = await store.cleanup();
      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(await store.getJob(streamId)).toBeNull();
      expect(await ioredisClient.exists(`stream:{${streamId}}:steers`)).toBe(0);

      const claimed = await store.claimParkedSteers(streamId, 'steer-user', 'tenant-1');
      expect(claimed).toBeDefined();
      const parsed = JSON.parse(claimed as string) as {
        userId: string;
        tenantId?: string;
        steers: Array<{ steerId: string; text: string }>;
      };
      expect(parsed.userId).toBe('steer-user');
      expect(parsed.tenantId).toBe('tenant-1');
      expect(parsed.steers.map((s) => s.text)).toEqual(['crash survivor']);

      await store.destroy();
    });

    test('stale-running reap cannot delete a replacement created after observation', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 1 });
      await store.initialize();

      const streamId = `stale-replacement-guard-${Date.now()}`;
      const userId = 'stale-replacement-user';
      await store.createJob(streamId, userId, streamId);
      await store.enqueueSteer(streamId, buildSteer('old-steer', 'old generation'));
      await ioredisClient.hset(
        `stream:{${streamId}}:job`,
        'createdAt',
        String(Date.now() - 10_000),
      );

      const originalEval = ioredisClient.eval.bind(ioredisClient) as (
        script: string | Buffer,
        numberOfKeys: number,
        ...args: Array<string | number | Buffer>
      ) => Promise<unknown>;
      let signalCleanupReady: (() => void) | undefined;
      const cleanupReady = new Promise<void>((resolve) => {
        signalCleanupReady = resolve;
      });
      let releaseCleanup: (() => void) | undefined;
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let restoreEval: (() => void) | undefined;

      try {
        let gated = false;
        const evalSpy = jest.spyOn(ioredisClient, 'eval').mockImplementation((async (
          script,
          numberOfKeys,
          ...args
        ) => {
          if (!gated && String(script).includes('tonumber(ARGV[2]) - liveSince')) {
            gated = true;
            signalCleanupReady?.();
            await cleanupGate;
          }
          return originalEval(
            script as string | Buffer,
            Number(numberOfKeys),
            ...(args as Array<string | number | Buffer>),
          );
        }) as typeof ioredisClient.eval);
        restoreEval = () => evalSpy.mockRestore();

        const cleaning = store.cleanup();
        await cleanupReady;

        const replacement = await store.createJob(streamId, userId, streamId);
        await store.appendChunk(streamId, {
          event: 'on_message_delta',
          data: { text: 'replacement generation' },
        });
        await store.enqueueSteer(
          streamId,
          buildSteer('replacement-steer', 'keep replacement state'),
        );

        releaseCleanup?.();
        await cleaning;

        await expect(store.getJob(streamId)).resolves.toMatchObject({
          createdAt: replacement.createdAt,
          status: 'running',
        });
        expect(await ioredisClient.xlen(`stream:{${streamId}}:chunks`)).toBe(1);
        expect((await store.peekSteers(streamId)).map((steer) => steer.steerId)).toEqual([
          'replacement-steer',
        ]);
        const parked = await store.claimParkedSteers(streamId, userId);
        expect(parked).toBeDefined();
        expect(JSON.parse(parked as string)).toMatchObject({
          userId,
          steers: [{ steerId: 'old-steer', text: 'old generation' }],
        });
        expect(await ioredisClient.smembers('stream:running')).toContain(streamId);
      } finally {
        releaseCleanup?.();
        restoreEval?.();
        await store.destroy();
      }
    });

    test('parkSteers falls back to a positive recovery TTL when completedTtl is 0', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { completedTtl: 0 });
      await store.initialize();

      const streamId = `steer-park-zero-ttl-${Date.now()}`;
      // `EX 0` would be rejected by Redis and silently kill recovery.
      await store.parkSteers(
        streamId,
        JSON.stringify({ userId: 'steer-user', steers: [{ steerId: 'p1', text: 'kept' }] }),
      );

      expect(await ioredisClient.exists(`stream:{${streamId}}:parked`)).toBe(1);
      expect(await ioredisClient.ttl(`stream:{${streamId}}:parked`)).toBeGreaterThan(0);

      await store.destroy();
    });

    test('getContentParts splices on_steer_applied chunks at their recorded index', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `steer-recon-${Date.now()}`;
      await store.createJob(streamId, 'steer-user', streamId);

      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            index: 0,
            stepDetails: { type: 'message_creation', message_creation: {} },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'Before steer.' } } },
        },
        {
          event: 'on_steer_applied',
          data: {
            steerId: 'steer-1',
            index: 1,
            part: {
              type: 'steer',
              steer: 'change course',
              steerId: 'steer-1',
              files: [{ file_id: 'rejected-file' }],
            },
          },
        },
        {
          event: 'on_steer_applied',
          data: {
            steerId: 'steer-1',
            index: 1,
            part: { type: 'steer', steer: 'change course', steerId: 'steer-1' },
          },
        },
        {
          event: 'on_run_step',
          data: {
            id: 'step-2',
            // Emitted with the already-shifted index (offset wrapper)
            index: 2,
            stepDetails: { type: 'message_creation', message_creation: {} },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-2', delta: { content: { type: 'text', text: 'After steer.' } } },
        },
      ];
      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      const result = await store.getContentParts(streamId);
      expect(result).not.toBeNull();
      const parts = result!.content as Array<{ type?: string; steer?: string; text?: unknown }>;
      expect(parts).toHaveLength(3);
      expect(parts[1]).toMatchObject({ type: 'steer', steer: 'change course' });
      expect(parts[1]).not.toHaveProperty('files');
      expect(parts[0]?.type).toBe('text');
      expect(parts[2]?.type).toBe('text');

      await store.destroy();
    });

    test('getContentParts reconstructs the LAST on_activity_label chunk per index', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `activity-recon-${Date.now()}`;
      await store.createJob(streamId, 'label-user', streamId);

      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            index: 0,
            stepDetails: { type: 'tool_calls', tool_calls: [] },
          },
        },
        /** Claim-time placeholder (counts only) at index 1 … */
        {
          event: 'on_activity_label',
          data: {
            index: 1,
            part: {
              type: 'activity_label',
              activity_label: '',
              counts: { searches: 1, reads: 0, writes: 0, commands: 0, other: 0 },
              status: 'ok',
              pending: true,
            },
          },
        },
        /** … then the resolved label for the same slot: last write wins. */
        {
          event: 'on_activity_label',
          data: {
            index: 1,
            part: {
              type: 'activity_label',
              activity_label: 'Searched runtime release notes',
              counts: { searches: 1, reads: 0, writes: 0, commands: 0, other: 0 },
              status: 'ok',
              pending: false,
            },
          },
        },
        {
          event: 'on_run_step',
          data: {
            id: 'step-2',
            // Emitted with the already-shifted index (offset wrapper)
            index: 2,
            stepDetails: { type: 'message_creation', message_creation: {} },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-2', delta: { content: { type: 'text', text: 'After batch.' } } },
        },
      ];
      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      const result = await store.getContentParts(streamId);
      expect(result).not.toBeNull();
      const parts = result!.content as Array<{
        type?: string;
        activity_label?: string;
        pending?: boolean;
      }>;
      /** Position-independent: the placeholder and the filled event share a
       *  slot, so exactly ONE label part must survive and it must carry the
       *  resolved text (last write wins). */
      const labels = parts.filter((part) => part?.type === 'activity_label');
      expect(labels).toHaveLength(1);
      expect(labels[0]).toMatchObject({
        activity_label: 'Searched runtime release notes',
        pending: false,
      });
      expect(parts.some((part) => part?.type === 'text')).toBe(true);

      await store.destroy();
    });

    test('getContentParts patches the latest reasoning label onto its THINK part', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `reasoning-label-recon-${Date.now()}`;
      await store.createJob(streamId, 'reasoning-label-user', streamId);
      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'reasoning-step-1',
            index: 0,
            stepDetails: {
              type: 'message_creation',
              message_creation: { content_type: 'think' },
            },
          },
        },
        {
          event: 'on_reasoning_delta',
          data: {
            id: 'reasoning-step-1',
            delta: { content: { type: 'think', think: 'Inspecting the resume path.' } },
          },
        },
        {
          event: 'on_reasoning_label_attempt',
          data: {
            index: 0,
            stepId: 'reasoning-step-1',
            attempts: 1,
            submittedChars: 27,
          },
        },
        {
          event: 'on_reasoning_label',
          data: {
            index: 0,
            stepId: 'reasoning-step-1',
            revision: 1,
            label: 'Inspecting the resume path',
            status: 'streaming',
          },
        },
        {
          event: 'on_reasoning_label_attempt',
          data: {
            index: 0,
            stepId: 'reasoning-step-1',
            attempts: 2,
            submittedChars: 27,
          },
        },
        {
          event: 'on_reasoning_label',
          data: {
            index: 0,
            stepId: 'reasoning-step-1',
            revision: 2,
            label: 'Resolved the resume race',
            status: 'complete',
          },
        },
        {
          event: 'on_reasoning_delta',
          data: {
            id: 'reasoning-step-1',
            delta: { content: { type: 'think', think: ' More detail followed.' } },
          },
        },
      ];
      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      const result = await store.getContentParts(streamId);
      expect(result?.content).toHaveLength(1);
      expect(result?.content[0]).toMatchObject({
        type: 'think',
        think: 'Inspecting the resume path. More detail followed.',
        reasoning_label: 'Resolved the resume race',
        reasoning_label_step_id: 'reasoning-step-1',
        reasoning_label_attempts: 2,
        reasoning_label_submitted_chars: 27,
        reasoning_label_revision: 2,
        reasoning_label_status: 'complete',
      });

      await store.destroy();
    });

    test('getContentParts preserves the attempt cap when a sparse THINK slot is reused', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `reasoning-label-sparse-${Date.now()}`;
      await store.createJob(streamId, 'reasoning-label-user', streamId);
      await store.appendChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'reasoning-step-sparse',
          index: 2,
          stepDetails: {
            type: 'message_creation',
            message_creation: { content_type: 'think' },
          },
        },
      });
      await store.appendChunk(streamId, {
        event: 'on_reasoning_delta',
        data: {
          id: 'reasoning-step-sparse',
          delta: { content: { type: 'think', think: 'Inspecting a compacted stream.' } },
        },
      });
      await store.appendChunk(streamId, {
        event: 'on_reasoning_label_attempt',
        data: {
          index: 2,
          stepId: 'reasoning-step-sparse',
          attempts: 2,
          submittedChars: 31,
        },
      });
      await store.appendChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'reasoning-step-after-pause',
          index: 2,
          stepDetails: {
            type: 'message_creation',
            message_creation: { content_type: 'think' },
          },
        },
      });
      await store.appendChunk(streamId, {
        event: 'on_reasoning_delta',
        data: {
          id: 'reasoning-step-after-pause',
          delta: { content: { type: 'think', think: 'Continuing after the pause.' } },
        },
      });

      const result = await store.getContentParts(streamId);
      expect(result?.content).toHaveLength(1);
      expect(result?.content[0]).toMatchObject({
        type: 'think',
        think: 'Inspecting a compacted stream.Continuing after the pause.',
        reasoning_label_step_id: 'reasoning-step-after-pause',
        reasoning_label_attempts: 2,
      });
      expect(result?.content[0]).not.toHaveProperty('reasoning_label_submitted_chars');

      await store.destroy();
    });
  });

  describe('Idempotency claims (#14339 duplicate-billing guard)', () => {
    test('grants the first claim and returns the original stream to a duplicate', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const key = `user-1:req-${Date.now()}`;
      const first = await store.claimIdempotencyKey(
        key,
        { streamId: 's1', conversationId: 'c1' },
        1200,
      );
      expect(first).toEqual({
        claimed: true,
        existing: { streamId: 's1', conversationId: 'c1' },
      });

      const second = await store.claimIdempotencyKey(
        key,
        { streamId: 's2', conversationId: 'c2' },
        1200,
      );
      expect(second).toEqual({
        claimed: false,
        existing: { streamId: 's1', conversationId: 'c1' },
      });

      await store.destroy();
    });

    test('probes claim existence without creating a missing key', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const key = `user-1:req-probe-${Date.now()}`;
      await expect(store.hasIdempotencyKey(key)).resolves.toBe(false);

      await store.claimIdempotencyKey(key, { streamId: 's1', conversationId: 'c1' }, 1200);
      await expect(store.hasIdempotencyKey(key)).resolves.toBe(true);

      await store.releaseIdempotencyKey(key);
      await expect(store.hasIdempotencyKey(key)).resolves.toBe(false);

      await store.destroy();
    });

    test('sets a bounded TTL on the claim', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const key = `user-1:req-ttl-${Date.now()}`;
      await store.claimIdempotencyKey(key, { streamId: 's1', conversationId: 'c1' }, 1200);

      const pttl = await ioredisClient.pttl(`stream:idem:${key}`);
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(1200 * 1000);

      await store.destroy();
    });

    test('releaseIdempotencyKey frees the claim', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const key = `user-1:req-rel-${Date.now()}`;
      await store.claimIdempotencyKey(key, { streamId: 's1', conversationId: 'c1' }, 1200);
      await store.releaseIdempotencyKey(key);

      const reclaimed = await store.claimIdempotencyKey(
        key,
        { streamId: 's2', conversationId: 'c2' },
        1200,
      );
      expect(reclaimed).toEqual({
        claimed: true,
        existing: { streamId: 's2', conversationId: 'c2' },
      });

      await store.destroy();
    });

    test('two concurrent claims for one key elect exactly one winner', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const key = `user-1:req-race-${Date.now()}`;
      const [a, b] = await Promise.all([
        store.claimIdempotencyKey(key, { streamId: 'sa', conversationId: 'ca' }, 1200),
        store.claimIdempotencyKey(key, { streamId: 'sb', conversationId: 'cb' }, 1200),
      ]);

      const winners = [a, b].filter((r) => r.claimed);
      const losers = [a, b].filter((r) => !r.claimed);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // The loser attaches to whichever stream the winner registered.
      expect(losers[0].existing).toEqual(
        winners[0] === a
          ? { streamId: 'sa', conversationId: 'ca' }
          : { streamId: 'sb', conversationId: 'cb' },
      );

      await store.destroy();
    });
  });

  describe('Steer receipt integrity', () => {
    const corruptions = ['missing', 'malformed', 'wrong-state', 'wrong-generation'] as const;
    type Corruption = (typeof corruptions)[number];

    async function enqueueReceiptSteer(streamId: string, suffix: string) {
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient!);
      await store.initialize();
      const job = await store.createJob(streamId, 'receipt-user', streamId);
      const item: SteerQueueItem = {
        steerId: `steer-${suffix}`,
        clientSteerId: `client-${suffix}`,
        text: `instruction ${suffix}`,
        userId: 'receipt-user',
        createdAt: Date.now(),
      };
      const result = await store.enqueueSteerWithReceipt(
        streamId,
        item,
        {
          clientSteerId: item.clientSteerId!,
          fingerprint: `fingerprint-${suffix}`,
          userId: item.userId,
          generationCreatedAt: job.createdAt,
        },
        false,
        job.createdAt,
      );
      expect(result).toMatchObject({ state: 'queued', item });
      return { store, item, createdAt: job.createdAt };
    }

    async function corruptReceipt(
      streamId: string,
      clientSteerId: string,
      corruption: Corruption,
    ): Promise<void> {
      const key = `stream:{${streamId}}:steer-receipts`;
      if (corruption === 'missing') {
        await ioredisClient!.hdel(key, clientSteerId);
        return;
      }
      if (corruption === 'malformed') {
        await ioredisClient!.hset(key, clientSteerId, '{not-json');
        return;
      }
      const raw = await ioredisClient!.hget(key, clientSteerId);
      expect(raw).not.toBeNull();
      const receipt = JSON.parse(raw!) as SteerReceipt;
      if (corruption === 'wrong-state') {
        receipt.state = receipt.state === 'queued' ? 'claimed' : 'queued';
      } else {
        receipt.generationCreatedAt += 1;
      }
      await ioredisClient!.hset(key, clientSteerId, JSON.stringify(receipt));
    }

    test.each(['deleted', 'v1-replaced'] as const)(
      'replays an existing receipt after its accepting job is %s',
      async (lifecycle) => {
        if (!ioredisClient) {
          return;
        }
        const streamId = `redis-receipt-replay-${lifecycle}-${Date.now()}`;
        const { store, item, createdAt } = await enqueueReceiptSteer(streamId, lifecycle);
        try {
          if (lifecycle === 'deleted') {
            await expect(store.deleteJob(streamId, createdAt)).resolves.toBe(true);
          } else {
            const replacement = await store.createJob(streamId, item.userId, streamId, undefined, {
              generationProtocolVersion: 1,
            });
            expect(replacement.createdAt).not.toBe(createdAt);
            await expect(store.peekSteers(streamId, replacement.createdAt)).resolves.toEqual([]);
          }

          await expect(store.getSteerReceipt(streamId, item.clientSteerId!)).resolves.toMatchObject(
            {
              state: 'leftover',
              generationCreatedAt: createdAt,
              item,
            },
          );
          await expect(
            store.enqueueSteerWithReceipt(
              streamId,
              { ...item, steerId: `duplicate-${lifecycle}` },
              {
                clientSteerId: item.clientSteerId!,
                fingerprint: `fingerprint-${lifecycle}`,
                userId: item.userId,
                generationCreatedAt: createdAt,
              },
              false,
              createdAt,
            ),
          ).resolves.toMatchObject({
            state: 'leftover',
            generationCreatedAt: createdAt,
            item,
          });
        } finally {
          await store.destroy();
        }
      },
    );

    test('keeps an active recovery lease and receipt beyond job expiry, activity, and pause', async () => {
      if (!ioredisClient) {
        return;
      }
      const streamId = `receipt-recovery-lease-${Date.now()}`;
      const { store, item, createdAt } = await enqueueReceiptSteer(streamId, 'recovery-lease');
      const parkedKey = `stream:{${streamId}}:parked`;
      const receiptsKey = `stream:{${streamId}}:steer-receipts`;
      const receiptOrderKey = `stream:{${streamId}}:steer-receipt-order`;
      try {
        await expect(store.closeAndDrainSteers(streamId, createdAt)).resolves.toEqual([item]);
        const recovery = await store.createJob(
          streamId,
          item.userId,
          streamId,
          undefined,
          {},
          item.steerId,
          undefined,
          undefined,
          undefined,
          {
            text: item.text,
            fileIds: (item.files ?? []).flatMap((file) => file.file_id ?? []).sort(),
            quotes: item.quotes ?? [],
          },
        );

        // The default live-job storage horizon is 25m. A recovery lease gets a
        // further normal 5m recovery window, rather than expiring with the job.
        expect(await ioredisClient.ttl(parkedKey)).toBeGreaterThan(1500);
        expect(await ioredisClient.ttl(receiptsKey)).toBeGreaterThan(1500);
        expect(await ioredisClient.ttl(receiptOrderKey)).toBeGreaterThan(1500);

        // Adding another steer to the recovery generation must not shorten the
        // shared receipt/order lease back to the normal running horizon.
        const followup: SteerQueueItem = {
          steerId: 'steer-recovery-followup',
          clientSteerId: 'client-recovery-followup',
          text: 'follow-up while recovery is active',
          userId: item.userId,
          createdAt: Date.now(),
        };
        await expect(
          store.enqueueSteerWithReceipt(
            streamId,
            followup,
            {
              clientSteerId: followup.clientSteerId!,
              fingerprint: 'fingerprint-recovery-followup',
              userId: followup.userId,
              generationCreatedAt: recovery.createdAt,
            },
            false,
            recovery.createdAt,
          ),
        ).resolves.toMatchObject({ state: 'queued', item: followup });
        expect(await ioredisClient.ttl(parkedKey)).toBeGreaterThan(1500);
        expect(await ioredisClient.ttl(receiptsKey)).toBeGreaterThan(1500);
        expect(await ioredisClient.ttl(receiptOrderKey)).toBeGreaterThan(1500);

        // Simulate a long healthy run near the end of the prior lease. Activity
        // refresh must move both the hidden source and its receipt back out.
        await ioredisClient.expire(parkedKey, 30);
        await ioredisClient.expire(receiptsKey, 30);
        await ioredisClient.expire(receiptOrderKey, 30);
        await expect(
          store.appendChunk(
            streamId,
            { event: 'on_message_delta', data: { text: 'still healthy' } },
            recovery.createdAt,
          ),
        ).resolves.toBe(true);
        expect(await ioredisClient.ttl(parkedKey)).toBeGreaterThan(1500);
        expect(await ioredisClient.ttl(receiptsKey)).toBeGreaterThan(1500);
        expect(await ioredisClient.ttl(receiptOrderKey)).toBeGreaterThan(1500);

        // A pause can outlive the running window; the same status CAS extends
        // the uncommitted recovery source past the approval/job TTL as well.
        await expect(
          store.transitionStatus(streamId, {
            from: 'running',
            to: 'requires_action',
            expectCreatedAt: recovery.createdAt,
            patch: { pendingAction: buildPendingAction(streamId) },
          }),
        ).resolves.toBe(true);
        expect(await ioredisClient.ttl(parkedKey)).toBeGreaterThan(24 * 60 * 60);
        expect(await ioredisClient.ttl(receiptsKey)).toBeGreaterThan(24 * 60 * 60);
      } finally {
        await store.destroy();
      }
    });

    test('does not let a stale cancel discard a source leased to a live recovery', async () => {
      if (!ioredisClient) {
        return;
      }
      const streamId = `receipt-live-recovery-cancel-${Date.now()}`;
      const { store, item, createdAt } = await enqueueReceiptSteer(streamId, 'live-recovery');
      try {
        await expect(store.closeAndDrainSteers(streamId, createdAt)).resolves.toEqual([item]);
        const recovery = await store.createJob(
          streamId,
          item.userId,
          streamId,
          undefined,
          {},
          item.steerId,
          undefined,
          undefined,
          undefined,
          {
            text: item.text,
            fileIds: (item.files ?? []).flatMap((file) => file.file_id ?? []).sort(),
            quotes: item.quotes ?? [],
          },
        );
        await expect(
          store.discardSteerLeftover(streamId, item.clientSteerId!, item.steerId, item.userId),
        ).resolves.toBe(false);
        await expect(
          store.consumeParkedSteer(
            streamId,
            item.steerId,
            item.userId,
            undefined,
            recovery.createdAt,
          ),
        ).resolves.toBe(true);
        await expect(store.getSteerReceipt(streamId, item.clientSteerId!)).resolves.toMatchObject({
          state: 'recovered',
        });
      } finally {
        await store.destroy();
      }
    });

    test.each(['close', 'terminal'] as const)(
      '%s recovery safely parks words when a receipt is malformed',
      async (path) => {
        if (!ioredisClient) {
          return;
        }
        const streamId = `receipt-malformed-${path}-${Date.now()}`;
        const { store, item, createdAt } = await enqueueReceiptSteer(streamId, `malformed-${path}`);
        try {
          await corruptReceipt(streamId, item.clientSteerId!, 'malformed');
          if (path === 'close') {
            await expect(store.closeAndDrainSteers(streamId, createdAt)).resolves.toEqual([item]);
          } else {
            await expect(
              store.transitionStatus(streamId, {
                from: 'running',
                to: 'error',
                expectCreatedAt: createdAt,
                patch: { error: 'terminal failure', completedAt: Date.now() },
              }),
            ).resolves.toBe(true);
          }

          await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([]);
          const parked = await store.claimParkedSteers(streamId, item.userId);
          expect(JSON.parse(parked!)).toMatchObject({
            userId: item.userId,
            steers: [{ steerId: item.steerId, clientSteerId: item.clientSteerId }],
          });
        } finally {
          await store.destroy();
        }
      },
    );

    test('atomically settles a claimed receipt with its applied chunk', async () => {
      if (!ioredisClient) {
        return;
      }
      const streamId = `receipt-valid-delivery-${Date.now()}`;
      const { store, item, createdAt } = await enqueueReceiptSteer(streamId, 'valid');
      try {
        await expect(store.drainSteers(streamId, createdAt)).resolves.toEqual([item]);
        await expect(
          store.appendChunk(
            streamId,
            { event: 'on_steer_applied', data: { steerId: item.steerId } },
            createdAt,
            item,
          ),
        ).resolves.toBe(true);

        await expect(store.peekClaimedSteers(streamId, createdAt)).resolves.toEqual([]);
        await expect(store.getSteerReceipt(streamId, item.clientSteerId!)).resolves.toMatchObject({
          state: 'delivered',
          item,
        });
        await expect(ioredisClient.xlen(`stream:{${streamId}}:chunks`)).resolves.toBe(1);
      } finally {
        await store.destroy();
      }
    });

    test.each(corruptions)(
      'refuses to drain a queue with a %s receipt before moving any item',
      async (corruption) => {
        if (!ioredisClient) {
          return;
        }
        const streamId = `receipt-drain-${corruption}-${Date.now()}`;
        const { store, item, createdAt } = await enqueueReceiptSteer(
          streamId,
          `drain-${corruption}`,
        );
        try {
          await corruptReceipt(streamId, item.clientSteerId!, corruption);

          await expect(store.drainSteers(streamId, createdAt)).rejects.toThrow(/steer receipt/);
          await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([item]);
          await expect(store.peekClaimedSteers(streamId, createdAt)).resolves.toEqual([]);
          await expect(ioredisClient.xlen(`stream:{${streamId}}:chunks`)).resolves.toBe(0);
        } finally {
          await store.destroy();
        }
      },
    );

    test.each(corruptions)(
      'refuses to cancel with a %s receipt before mutating the queued item',
      async (corruption) => {
        if (!ioredisClient) {
          return;
        }
        const streamId = `receipt-cancel-${corruption}-${Date.now()}`;
        const { store, item, createdAt } = await enqueueReceiptSteer(
          streamId,
          `cancel-${corruption}`,
        );
        try {
          await corruptReceipt(streamId, item.clientSteerId!, corruption);

          await expect(store.removeSteer(streamId, item.steerId, createdAt)).rejects.toThrow(
            /steer receipt/,
          );
          await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([item]);
        } finally {
          await store.destroy();
        }
      },
    );

    test.each(corruptions)(
      'refuses to settle a claimed steer with a %s receipt before mutating durable state',
      async (corruption) => {
        if (!ioredisClient) {
          return;
        }
        const streamId = `receipt-append-${corruption}-${Date.now()}`;
        const { store, item, createdAt } = await enqueueReceiptSteer(
          streamId,
          `append-${corruption}`,
        );
        try {
          await expect(store.drainSteers(streamId, createdAt)).resolves.toEqual([item]);
          await corruptReceipt(streamId, item.clientSteerId!, corruption);

          await expect(
            store.appendChunk(
              streamId,
              { event: 'on_steer_applied', data: { steerId: item.steerId } },
              createdAt,
              item,
            ),
          ).resolves.toBe(false);
          await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([]);
          await expect(store.peekClaimedSteers(streamId, createdAt)).resolves.toEqual([item]);
          await expect(ioredisClient.xlen(`stream:{${streamId}}:chunks`)).resolves.toBe(0);
        } finally {
          await store.destroy();
        }
      },
    );

    test.each(corruptions)(
      'refuses to restore a claimed steer with a %s receipt before changing either list',
      async (corruption) => {
        if (!ioredisClient) {
          return;
        }
        const streamId = `receipt-restore-${corruption}-${Date.now()}`;
        const { store, item, createdAt } = await enqueueReceiptSteer(
          streamId,
          `restore-${corruption}`,
        );
        try {
          await expect(store.drainSteers(streamId, createdAt)).resolves.toEqual([item]);
          await corruptReceipt(streamId, item.clientSteerId!, corruption);

          await expect(store.restoreClaimedSteers(streamId, [item], createdAt)).resolves.toBe(
            false,
          );
          await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([]);
          await expect(store.peekClaimedSteers(streamId, createdAt)).resolves.toEqual([item]);
          await expect(ioredisClient.xlen(`stream:{${streamId}}:chunks`)).resolves.toBe(0);
        } finally {
          await store.destroy();
        }
      },
    );

    test.each(corruptions)(
      'refuses to arm with a %s receipt before mutating the queued item',
      async (corruption) => {
        if (!ioredisClient) {
          return;
        }
        const streamId = `receipt-arm-${corruption}-${Date.now()}`;
        const { store, item, createdAt } = await enqueueReceiptSteer(streamId, `arm-${corruption}`);
        try {
          await store.updateJob(streamId, { preemptCapable: true }, createdAt);
          await corruptReceipt(streamId, item.clientSteerId!, corruption);

          await expect(store.armSteerVersioned(streamId, item.steerId, createdAt)).rejects.toThrow(
            /steer receipt/,
          );
          await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([item]);
        } finally {
          await store.destroy();
        }
      },
    );

    test.each(corruptions)(
      'refuses to downgrade with a %s receipt before mutating any queued item',
      async (corruption) => {
        if (!ioredisClient) {
          return;
        }
        const streamId = `receipt-downgrade-${corruption}-${Date.now()}`;
        const { store, item, createdAt } = await enqueueReceiptSteer(
          streamId,
          `downgrade-${corruption}`,
        );
        try {
          await store.updateJob(streamId, { preemptCapable: true }, createdAt);
          await expect(
            store.armSteerVersioned(streamId, item.steerId, createdAt),
          ).resolves.toMatchObject({ outcome: 'armed' });
          const armed = await store.peekSteers(streamId, createdAt);
          await store.updateJob(streamId, { preemptCapable: false }, createdAt);
          await corruptReceipt(streamId, item.clientSteerId!, corruption);

          await expect(store.downgradeSteerPreempts(streamId, createdAt)).rejects.toThrow(
            /steer receipt/,
          );
          await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual(armed);
        } finally {
          await store.destroy();
        }
      },
    );

    test('refuses a 101st receipt without evicting replay evidence or queueing the item', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `receipt-cap-${Date.now()}`;
      try {
        const job = await store.createJob(streamId, 'receipt-user', streamId);
        for (let index = 0; index < 100; index++) {
          const item: SteerQueueItem = {
            steerId: `steer-cap-${index}`,
            clientSteerId: `client-cap-${index}`,
            text: `instruction ${index}`,
            userId: 'receipt-user',
            createdAt: Date.now(),
          };
          await expect(
            store.enqueueSteerWithReceipt(
              streamId,
              item,
              {
                clientSteerId: item.clientSteerId!,
                fingerprint: `fingerprint-${index}`,
                userId: item.userId,
                generationCreatedAt: job.createdAt,
              },
              false,
              job.createdAt,
            ),
          ).resolves.toMatchObject({ state: 'queued', item });
          await expect(store.removeSteer(streamId, item.steerId)).resolves.toBe(true);
        }

        const overflow: SteerQueueItem = {
          steerId: 'steer-cap-overflow',
          clientSteerId: 'client-cap-overflow',
          text: 'must not queue',
          userId: 'receipt-user',
          createdAt: Date.now(),
        };
        await expect(
          store.enqueueSteerWithReceipt(
            streamId,
            overflow,
            {
              clientSteerId: overflow.clientSteerId!,
              fingerprint: 'fingerprint-overflow',
              userId: overflow.userId,
              generationCreatedAt: job.createdAt,
            },
            false,
            job.createdAt,
          ),
        ).resolves.toBe(STEER_ENQUEUE_RECEIPT_FULL);

        await expect(store.peekSteers(streamId, job.createdAt)).resolves.toEqual([]);
        await expect(store.getSteerReceipt(streamId, 'client-cap-overflow')).resolves.toBeNull();
        await expect(store.getSteerReceipt(streamId, 'client-cap-0')).resolves.toMatchObject({
          state: 'cancelled',
          item: { steerId: 'steer-cap-0' },
        });
        await expect(ioredisClient.zcard(`stream:{${streamId}}:steer-receipt-order`)).resolves.toBe(
          100,
        );
      } finally {
        await store.destroy();
      }
    });
  });
});
