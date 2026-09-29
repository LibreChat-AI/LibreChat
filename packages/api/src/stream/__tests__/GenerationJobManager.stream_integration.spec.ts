/* eslint jest/no-standalone-expect: ["error", { "additionalTestBlockFunctions": ["testRedis"] }] */
import type { Redis, Cluster } from 'ioredis';
import type { ServerSentEvent, StreamEvent, CreatedEvent } from '~/types';
import type { IJobStoreV2 } from '~/stream/interfaces/IJobStore';
import {
  GenerationJobManagerClass,
  GENERATION_RECOVERY_FAILED_ERROR,
  TERMINAL_PUBLICATION_RECONNECT_ERROR,
} from '~/stream/GenerationJobManager';
import {
  ioredisClient as staticRedisClient,
  keyvRedisClient as staticKeyvClient,
  keyvRedisClientReady,
} from '~/cache/redisClients';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { RedisEventTransport } from '~/stream/implementations/RedisEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { STEER_ENQUEUE_NOT_RUNNING } from '~/stream/interfaces/IJobStore';
import { RedisJobStore } from '~/stream/implementations/RedisJobStore';
import { createStreamServices } from '~/stream/createStreamServices';
import { GenerationJobManager } from '~/stream/GenerationJobManager';

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

/**
 * Integration tests for GenerationJobManager.
 *
 * Tests the job manager with both in-memory and Redis backends
 * to ensure consistent behavior across deployment modes.
 *
 * Run with: USE_REDIS=true npx jest GenerationJobManager.stream_integration
 */
describe('GenerationJobManager Integration Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  let dynamicKeyvClient: unknown = null;
  let dynamicKeyvReady: Promise<unknown> | null = null;
  const testPrefix = 'JobManager-Integration-Test';
  const redisConfigured = process.env.USE_REDIS === 'true';
  const describeRedis = redisConfigured ? describe : describe.skip;
  const testRedis = redisConfigured ? test : test.skip;

  beforeAll(async () => {
    originalEnv = { ...process.env };

    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = testPrefix;

    jest.resetModules();

    const redisModule = await import('~/cache/redisClients');
    ioredisClient = redisModule.ioredisClient;
    dynamicKeyvClient = redisModule.keyvRedisClient;
    dynamicKeyvReady = redisModule.keyvRedisClientReady;
  });

  afterEach(async () => {
    // Clean up module state
    jest.resetModules();

    // Clean up Redis keys (delete individually for cluster compatibility)
    if (ioredisClient) {
      try {
        const keys = await ioredisClient.keys(`${testPrefix}*`);
        const streamKeys = await ioredisClient.keys(`stream:*`);
        const allKeys = [...keys, ...streamKeys];
        await Promise.all(allKeys.map((key) => ioredisClient!.del(key)));
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  afterAll(async () => {
    for (const ready of [keyvRedisClientReady, dynamicKeyvReady]) {
      if (ready) {
        await ready.catch(() => {});
      }
    }

    const clients = [ioredisClient, staticRedisClient, staticKeyvClient, dynamicKeyvClient];
    for (const client of clients) {
      if (!client) {
        continue;
      }
      try {
        await (client as { disconnect: () => void | Promise<void> }).disconnect();
      } catch {
        /* ignore */
      }
    }

    process.env = originalEnv;
  });

  function createInMemoryManager(): GenerationJobManagerClass {
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    return manager;
  }

  function createRedisManager(): GenerationJobManagerClass {
    const manager = new GenerationJobManagerClass();
    manager.configure(
      createStreamServices({
        useRedis: true,
        redisClient: ioredisClient!,
      }),
    );
    manager.initialize();
    return manager;
  }

  async function setupDisconnectedStream(
    manager: GenerationJobManagerClass,
    streamId: string,
    delay: number,
  ): Promise<ServerSentEvent[]> {
    const firstEvents: ServerSentEvent[] = [];
    const sub = await manager.subscribe(streamId, (event) => firstEvents.push(event));

    await new Promise((resolve) => setTimeout(resolve, delay));

    await manager.emitChunk(streamId, {
      event: 'on_run_step',
      data: {
        id: 'step-1',
        runId: 'run-1',
        index: 0,
        stepDetails: { type: 'message_creation' },
      },
    });
    await manager.emitChunk(streamId, {
      event: 'on_message_delta',
      data: {
        id: 'step-1',
        delta: { content: { type: 'text', text: 'Hello' } },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, delay));
    expect(firstEvents.length).toBe(2);

    sub?.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, delay));

    await manager.emitChunk(streamId, {
      event: 'on_message_delta',
      data: {
        id: 'step-1',
        delta: { content: { type: 'text', text: ' world' } },
      },
    });
    await manager.emitChunk(streamId, {
      event: 'on_message_delta',
      data: { id: 'step-1', delta: { content: { type: 'text', text: '!' } } },
    });

    await new Promise((resolve) => setTimeout(resolve, delay));

    return firstEvents;
  }

  describe('In-Memory Mode', () => {
    test('should create and manage jobs', async () => {
      // Configure with in-memory
      // cleanupOnComplete: false so we can verify completed status
      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });

      GenerationJobManager.initialize();

      const streamId = `inmem-job-${Date.now()}`;
      const userId = 'test-user-1';

      // Create job (async)
      const job = await GenerationJobManager.createJob(streamId, userId);
      expect(job.streamId).toBe(streamId);
      expect(job.status).toBe('running');

      // Check job exists
      const hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(true);

      // Get job
      const retrieved = await GenerationJobManager.getJob(streamId);
      expect(retrieved?.streamId).toBe(streamId);

      // Update job
      await GenerationJobManager.updateMetadata(streamId, {
        sender: 'TestAgent',
      });
      const updated = await GenerationJobManager.getJob(streamId);
      expect(updated?.metadata?.sender).toBe('TestAgent');

      // Complete job
      await GenerationJobManager.completeJob(streamId);
      const completed = await GenerationJobManager.getJob(streamId);
      expect(completed?.status).toBe('complete');

      await GenerationJobManager.destroy();
    });

    test('should handle event streaming', async () => {
      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });

      GenerationJobManager.initialize();

      const streamId = `inmem-events-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const receivedChunks: unknown[] = [];

      // Subscribe to events (subscribe takes separate args, not an object)
      const subscription = await GenerationJobManager.subscribe(streamId, (event) =>
        receivedChunks.push(event),
      );
      const { unsubscribe } = subscription!;

      // Wait for first subscriber to be registered
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit chunks (emitChunk takes { event, data } format, now async for Redis ordering)
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Hello' },
      });
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: ' world' },
      });

      // Give time for events to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify chunks were received
      expect(receivedChunks.length).toBeGreaterThan(0);

      // Complete the job (this cleans up resources)
      await GenerationJobManager.completeJob(streamId);

      unsubscribe();
      await GenerationJobManager.destroy();
    });
  });

  describeRedis('Redis Mode', () => {
    test('should create and manage jobs via Redis', async () => {
      // Create Redis services
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      expect(services.isRedis).toBe(true);

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId = `redis-job-${Date.now()}`;
      const userId = 'test-user-redis';

      // Create job (async)
      const job = await GenerationJobManager.createJob(streamId, userId);
      expect(job.streamId).toBe(streamId);

      // Verify in Redis
      const hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(true);

      // Update and verify
      await GenerationJobManager.updateMetadata(streamId, {
        sender: 'RedisAgent',
      });
      const updated = await GenerationJobManager.getJob(streamId);
      expect(updated?.metadata?.sender).toBe('RedisAgent');

      await GenerationJobManager.destroy();
    });

    test('should persist chunks for cross-instance resume', async () => {
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId = `redis-chunks-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Emit chunks (these should be persisted to Redis)
      // emitChunk takes { event, data } format, now async for Redis ordering
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'Persisted ' } },
        },
      });
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'content' } },
        },
      });

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Simulate getting resume state (as if from different instance)
      const resumeState = await GenerationJobManager.getResumeState(streamId);

      expect(resumeState).not.toBeNull();
      expect(resumeState!.aggregatedContent?.length).toBeGreaterThan(0);

      await GenerationJobManager.destroy();
    });

    test('should handle abort and return content', async () => {
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId = `redis-abort-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Emit some content (emitChunk takes { event, data } format, now async)
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'Partial response...' } },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Abort the job
      const abortResult = await GenerationJobManager.abortJob(streamId);

      expect(abortResult.success).toBe(true);
      expect(abortResult.content.length).toBeGreaterThan(0);

      await GenerationJobManager.destroy();
    });
  });

  describe('Cross-Mode Consistency', () => {
    test('should have consistent API between in-memory and Redis modes', async () => {
      // This test verifies that the same operations work identically
      // regardless of backend mode

      const runTestWithMode = async (isRedis: boolean) => {
        jest.resetModules();

        if (isRedis && ioredisClient) {
          GenerationJobManager.configure({
            ...createStreamServices({
              useRedis: true,
              redisClient: ioredisClient,
            }),
            cleanupOnComplete: false, // Keep job for verification
          });
        } else {
          GenerationJobManager.configure({
            jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
            eventTransport: new InMemoryEventTransport(),
            isRedis: false,
            cleanupOnComplete: false,
          });
        }

        GenerationJobManager.initialize();

        const streamId = `consistency-${isRedis ? 'redis' : 'inmem'}-${Date.now()}`;

        // Test sequence
        const job = await GenerationJobManager.createJob(streamId, 'user-1');
        expect(job.streamId).toBe(streamId);
        expect(job.status).toBe('running');

        const hasJob = await GenerationJobManager.hasJob(streamId);
        expect(hasJob).toBe(true);

        await GenerationJobManager.updateMetadata(streamId, {
          sender: 'ConsistencyAgent',
          responseMessageId: 'resp-123',
          iconURL: 'https://example.com/spec-icon.png',
          model: 'gpt-4.1',
        });

        const updated = await GenerationJobManager.getJob(streamId);
        expect(updated?.metadata?.sender).toBe('ConsistencyAgent');
        expect(updated?.metadata?.responseMessageId).toBe('resp-123');
        expect(updated?.metadata?.iconURL).toBe('https://example.com/spec-icon.png');
        expect(updated?.metadata?.model).toBe('gpt-4.1');

        const resumeState = await GenerationJobManager.getResumeState(streamId);
        expect(resumeState?.sender).toBe('ConsistencyAgent');
        expect(resumeState?.responseMessageId).toBe('resp-123');
        expect(resumeState?.iconURL).toBe('https://example.com/spec-icon.png');
        expect(resumeState?.model).toBe('gpt-4.1');

        await GenerationJobManager.completeJob(streamId);

        const completed = await GenerationJobManager.getJob(streamId);
        expect(completed?.status).toBe('complete');

        await GenerationJobManager.destroy();
      };

      // Test in-memory mode
      await runTestWithMode(false);

      // Test Redis mode if available
      if (ioredisClient) {
        await runTestWithMode(true);
      }
    });
  });

  describeRedis('Cross-Replica Support (Redis)', () => {
    /**
     * Problem: In k8s with Redis and multiple replicas, when a user sends a message:
     * 1. POST /api/agents/chat hits Replica A, creates job
     * 2. GET /api/agents/chat/stream/:streamId hits Replica B
     * 3. Replica B calls getJob() which returned undefined because runtimeState
     *    was only in Replica A's memory
     * 4. Stream endpoint returns 404
     *
     * Fix: getJob() and subscribe() now lazily create runtime state from Redis
     * when the job exists in Redis but not in local memory.
     */
    test('should NOT return 404 when stream endpoint hits different replica than job creator', async () => {
      // === REPLICA A: Creates the job ===
      // Simulate Replica A creating the job directly in Redis
      // (In real scenario, this happens via GenerationJobManager.createJob on Replica A)
      const replicaAJobStore = new RedisJobStore(ioredisClient!);
      await replicaAJobStore.initialize();

      const streamId = `cross-replica-404-test-${Date.now()}`;
      const userId = 'test-user';

      // Create job in Redis (simulates Replica A's createJob)
      await replicaAJobStore.createJob(streamId, userId);

      // === REPLICA B: Receives the stream request ===
      // Fresh GenerationJobManager that does NOT have this job in its local runtimeState
      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      // This is what the stream endpoint does:
      // const job = await GenerationJobManager.getJob(streamId);
      // if (!job) return res.status(404).json({ error: 'Stream not found' });

      const job = await GenerationJobManager.getJob(streamId);

      // BEFORE FIX: job would be undefined → 404
      // AFTER FIX: job should exist via lazy runtime state creation
      expect(job).not.toBeNull();
      expect(job).toBeDefined();
      expect(job?.streamId).toBe(streamId);

      // The stream endpoint then calls subscribe:
      // const result = await GenerationJobManager.subscribe(streamId, onChunk, onDone, onError);
      // if (!result) return res.status(404).json({ error: 'Failed to subscribe' });

      const subscription = await GenerationJobManager.subscribe(
        streamId,
        () => {}, // onChunk
        () => {}, // onDone
        () => {}, // onError
      );

      // BEFORE FIX: subscription would be null → 404
      // AFTER FIX: subscription should succeed
      expect(subscription).not.toBeNull();
      expect(subscription).toBeDefined();
      expect(typeof subscription?.unsubscribe).toBe('function');

      // Cleanup
      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
      await replicaAJobStore.destroy();
    });

    test('should lazily create runtime state for jobs created on other replicas', async () => {
      // Instance 1: Create the job directly in Redis (simulating another replica)
      const jobStore = new RedisJobStore(ioredisClient!);
      await jobStore.initialize();

      const streamId = `cross-replica-${Date.now()}`;
      const userId = 'test-user';

      // Create job data directly in jobStore (as if from another instance)
      await jobStore.createJob(streamId, userId);

      // Instance 2: Fresh GenerationJobManager that doesn't have this job in memory
      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      // This should work even though the job was created by "another instance"
      // The manager should lazily create runtime state from Redis data
      const job = await GenerationJobManager.getJob(streamId);

      expect(job).not.toBeNull();
      expect(job?.streamId).toBe(streamId);
      expect(job?.status).toBe('running');

      // Should also be able to subscribe
      const chunks: unknown[] = [];
      const subscription = await GenerationJobManager.subscribe(streamId, (event) => {
        chunks.push(event);
      });

      expect(subscription).not.toBeNull();

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
      await jobStore.destroy();
    });

    test('should persist syncSent to Redis for cross-replica consistency', async () => {
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId = `sync-sent-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Initially syncSent should be false
      let wasSent = await GenerationJobManager.wasSyncSent(streamId);
      expect(wasSent).toBe(false);

      // Mark sync sent
      GenerationJobManager.markSyncSent(streamId);

      // Wait for async Redis update
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should now be true
      wasSent = await GenerationJobManager.wasSyncSent(streamId);
      expect(wasSent).toBe(true);

      // Verify it's actually in Redis by checking via jobStore
      const jobStore = services.jobStore;
      const jobData = await jobStore.getJob(streamId);
      expect(jobData?.syncSent).toBe(true);

      await GenerationJobManager.destroy();
    });

    test('should persist finalEvent to Redis for cross-replica access', async () => {
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure({
        ...services,
        cleanupOnComplete: false, // Keep job for verification
      });
      GenerationJobManager.initialize();

      const streamId = `final-event-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Emit done event with final data
      const finalEventData = {
        final: true,
        conversation: { conversationId: streamId },
        responseMessage: { text: 'Hello world' },
      };
      await GenerationJobManager.emitDone(streamId, finalEventData as never);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify finalEvent is in Redis
      const jobStore = services.jobStore;
      const jobData = await jobStore.getJob(streamId);
      expect(jobData?.finalEvent).toBeDefined();

      const storedFinalEvent = JSON.parse(jobData!.finalEvent!);
      expect(storedFinalEvent.final).toBe(true);
      expect(storedFinalEvent.conversation.conversationId).toBe(streamId);

      await GenerationJobManager.destroy();
    });

    test('should emit cross-replica abort signal via Redis pub/sub', async () => {
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId = `abort-signal-${Date.now()}`;
      const job = await GenerationJobManager.createJob(streamId, 'user-1');

      // Track if abort controller was signaled
      let abortSignaled = false;
      job.abortController.signal.addEventListener('abort', () => {
        abortSignaled = true;
      });

      // Wait for abort listener setup
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Abort the job - this should emit abort signal via Redis
      await GenerationJobManager.abortJob(streamId);

      // Wait for signal propagation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The local abort controller should be signaled
      expect(abortSignaled).toBe(true);
      expect(job.abortController.signal.aborted).toBe(true);

      await GenerationJobManager.destroy();
    });

    test('should handle abort for lazily-initialized cross-replica jobs', async () => {
      // This test validates that jobs created on Replica A and lazily-initialized
      // on Replica B can still receive and handle abort signals.

      // === Replica A: Create job directly in Redis ===
      const replicaAJobStore = new RedisJobStore(ioredisClient!);
      await replicaAJobStore.initialize();

      const streamId = `lazy-abort-${Date.now()}`;
      await replicaAJobStore.createJob(streamId, 'user-1');

      // === Replica B: Fresh manager that lazily initializes the job ===
      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      // Get job triggers lazy initialization of runtime state
      const job = await GenerationJobManager.getJob(streamId);
      expect(job).not.toBeNull();

      // Track abort signal
      let abortSignaled = false;
      job!.abortController.signal.addEventListener('abort', () => {
        abortSignaled = true;
      });

      // Wait for abort listener to be set up via Redis subscription
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Abort the job - this should emit abort signal via Redis pub/sub
      // The lazily-initialized runtime should receive it
      await GenerationJobManager.abortJob(streamId);

      // Wait for signal propagation
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify the lazily-initialized job received the abort signal
      expect(abortSignaled).toBe(true);
      expect(job!.abortController.signal.aborted).toBe(true);

      await GenerationJobManager.destroy();
      await replicaAJobStore.destroy();
    });

    test('should abort generation when abort signal received from another replica', async () => {
      // This test simulates:
      // 1. Replica A creates a job and starts generation
      // 2. Replica B receives abort request and emits abort signal
      // 3. Replica A receives signal and aborts its AbortController

      // Create the job on "Replica A"
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId = `cross-abort-${Date.now()}`;
      const job = await GenerationJobManager.createJob(streamId, 'user-1');

      let abortSignaled = false;
      job.abortController.signal.addEventListener('abort', () => {
        abortSignaled = true;
      });

      // Wait for abort listener to be set up via Redis subscription
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Simulate "Replica B" emitting abort signal directly via Redis
      // This is what would happen if abortJob was called on a different replica
      const subscriber2 = (ioredisClient as unknown as { duplicate: () => unknown }).duplicate();
      const replicaBTransport = new RedisEventTransport(
        ioredisClient as never,
        subscriber2 as never,
      );

      // Emit abort signal (as if from Replica B)
      replicaBTransport.emitAbort(streamId);

      // Wait for cross-replica signal propagation
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Replica A's abort controller should be signaled
      expect(abortSignaled).toBe(true);
      expect(job.abortController.signal.aborted).toBe(true);

      replicaBTransport.destroy();
      (subscriber2 as { disconnect: () => void }).disconnect();
      await GenerationJobManager.destroy();
    });

    test('should handle wasSyncSent for cross-replica scenarios', async () => {
      // Create job directly in Redis with syncSent: true
      const jobStore = new RedisJobStore(ioredisClient!);
      await jobStore.initialize();

      const streamId = `cross-sync-${Date.now()}`;
      await jobStore.createJob(streamId, 'user-1');
      await jobStore.updateJob(streamId, { syncSent: true });

      // Fresh manager that doesn't have this job locally
      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      // wasSyncSent should check Redis even without local runtime
      const wasSent = await GenerationJobManager.wasSyncSent(streamId);
      expect(wasSent).toBe(true);

      await GenerationJobManager.destroy();
      await jobStore.destroy();
    });

    test('should emit created event from metadata on cross-replica subscribe', async () => {
      const replicaAJobStore = new RedisJobStore(ioredisClient!);
      await replicaAJobStore.initialize();

      const streamId = `cross-created-${Date.now()}`;
      const userId = 'test-user';

      await replicaAJobStore.createJob(streamId, userId);
      await replicaAJobStore.updateJob(streamId, {
        userMessage: {
          messageId: 'msg-123',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          conversationId: streamId,
          text: 'hello world',
        },
      });

      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const received: unknown[] = [];
      const subscription = await GenerationJobManager.subscribe(streamId, (event) =>
        received.push(event),
      );

      expect(subscription).not.toBeNull();
      expect(received.length).toBe(1);

      const created = received[0] as CreatedEvent;
      expect(created.created).toBe(true);
      expect(created.streamId).toBe(streamId);
      expect(created.message.messageId).toBe('msg-123');
      expect(created.message.conversationId).toBe(streamId);
      expect(created.message.sender).toBe('User');
      expect(created.message.isCreatedByUser).toBe(true);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
      await replicaAJobStore.destroy();
    });

    test('should NOT emit created event from metadata when userMessage is not set', async () => {
      const replicaAJobStore = new RedisJobStore(ioredisClient!);
      await replicaAJobStore.initialize();

      const streamId = `cross-no-created-${Date.now()}`;
      await replicaAJobStore.createJob(streamId, 'test-user');

      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const received: unknown[] = [];
      const subscription = await GenerationJobManager.subscribe(streamId, (event) =>
        received.push(event),
      );

      expect(subscription).not.toBeNull();
      expect(received.length).toBe(0);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
      await replicaAJobStore.destroy();
    });

    test('should NOT emit created event when skipBufferReplay is true (resume path)', async () => {
      const replicaAJobStore = new RedisJobStore(ioredisClient!);
      await replicaAJobStore.initialize();

      const streamId = `cross-no-replay-${Date.now()}`;
      await replicaAJobStore.createJob(streamId, 'test-user');
      await replicaAJobStore.updateJob(streamId, {
        userMessage: {
          messageId: 'msg-456',
          conversationId: streamId,
          text: 'hi',
        },
      });

      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const received: unknown[] = [];
      const subscription = await GenerationJobManager.subscribe(
        streamId,
        (event) => received.push(event),
        undefined,
        undefined,
        { skipBufferReplay: true },
      );

      expect(subscription).not.toBeNull();
      expect(received.length).toBe(0);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
      await replicaAJobStore.destroy();
    });
  });

  describeRedis('Sequential Event Ordering (Redis)', () => {
    /**
     * These tests verify that events are delivered in strict sequential order
     * when using Redis mode. This is critical because:
     * 1. LLM streaming tokens must arrive in order for coherent output
     * 2. Tool call argument deltas must be concatenated in order
     * 3. Run step events must precede their deltas
     *
     * The fix: emitChunk now awaits Redis publish to ensure ordered delivery.
     */
    test('should maintain strict order for rapid sequential emits', async () => {
      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId = `order-rapid-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const receivedIndices: number[] = [];

      const subscription = await GenerationJobManager.subscribe(streamId, (event) => {
        const data = event as { event: string; data: { index: number } };
        if (data.event === 'test') {
          receivedIndices.push(data.data.index);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Emit 30 events rapidly - with await, they must arrive in order
      for (let i = 0; i < 30; i++) {
        await GenerationJobManager.emitChunk(streamId, {
          event: 'test',
          data: { index: i },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify all events arrived in correct order
      expect(receivedIndices.length).toBe(30);
      for (let i = 0; i < 30; i++) {
        expect(receivedIndices[i]).toBe(i);
      }

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('should maintain order for tool call argument deltas', async () => {
      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId = `tool-args-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const receivedArgs: string[] = [];

      const subscription = await GenerationJobManager.subscribe(streamId, (event) => {
        const data = event as {
          event: string;
          data: { delta: { tool_calls: { args: string }[] } };
        };
        if (data.event === 'on_run_step_delta') {
          receivedArgs.push(data.data.delta.tool_calls[0].args);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Simulate streaming JSON args: {"code": "print('hello')"}
      const argChunks = ['{"', 'code', '": "', 'print', "('", 'hello', "')", '"}'];

      for (const chunk of argChunks) {
        await GenerationJobManager.emitChunk(streamId, {
          event: 'on_run_step_delta',
          data: {
            id: 'step-1',
            delta: {
              type: 'tool_calls',
              tool_calls: [{ index: 0, args: chunk }],
            },
          },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      // This was the original bug - args would arrive scrambled without await
      expect(receivedArgs).toEqual(argChunks);
      expect(receivedArgs.join('')).toBe(`{"code": "print('hello')"}`);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('should maintain order: on_run_step before on_run_step_delta', async () => {
      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId = `step-order-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const receivedEvents: string[] = [];

      const subscription = await GenerationJobManager.subscribe(streamId, (event) => {
        const data = event as { event: string };
        receivedEvents.push(data.event);
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Emit in correct order: step first, then deltas
      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step',
        data: { id: 'step-1', type: 'tool_calls', index: 0 },
      });

      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step_delta',
        data: {
          id: 'step-1',
          delta: { type: 'tool_calls', tool_calls: [{ args: '{' }] },
        },
      });

      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step_delta',
        data: {
          id: 'step-1',
          delta: { type: 'tool_calls', tool_calls: [{ args: '}' }] },
        },
      });

      await GenerationJobManager.emitChunk(streamId, {
        event: 'on_run_step_completed',
        data: { id: 'step-1', result: { content: '{}' } },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify ordering: step -> deltas -> completed
      expect(receivedEvents).toEqual([
        'on_run_step',
        'on_run_step_delta',
        'on_run_step_delta',
        'on_run_step_completed',
      ]);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('should not block other streams when awaiting emitChunk', async () => {
      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure(services);
      GenerationJobManager.initialize();

      const streamId1 = `concurrent-1-${Date.now()}`;
      const streamId2 = `concurrent-2-${Date.now()}`;

      await GenerationJobManager.createJob(streamId1, 'user-1');
      await GenerationJobManager.createJob(streamId2, 'user-2');

      const stream1Events: number[] = [];
      const stream2Events: number[] = [];

      const sub1 = await GenerationJobManager.subscribe(streamId1, (event) => {
        const data = event as { event: string; data: { index: number } };
        if (data.event === 'test') {
          stream1Events.push(data.data.index);
        }
      });

      const sub2 = await GenerationJobManager.subscribe(streamId2, (event) => {
        const data = event as { event: string; data: { index: number } };
        if (data.event === 'test') {
          stream2Events.push(data.data.index);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Emit to both streams concurrently (simulating two LLM responses)
      const emitPromises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        emitPromises.push(
          GenerationJobManager.emitChunk(streamId1, {
            event: 'test',
            data: { index: i },
          }),
        );
        emitPromises.push(
          GenerationJobManager.emitChunk(streamId2, {
            event: 'test',
            data: { index: i * 100 },
          }),
        );
      }
      await Promise.all(emitPromises);

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Each stream should have all events, in order within their stream
      expect(stream1Events.length).toBe(10);
      expect(stream2Events.length).toBe(10);

      // Verify each stream's internal order
      for (let i = 0; i < 10; i++) {
        expect(stream1Events[i]).toBe(i);
        expect(stream2Events[i]).toBe(i * 100);
      }

      sub1?.unsubscribe();
      sub2?.unsubscribe();
      await GenerationJobManager.destroy();
    });
  });

  describe('Race Condition: Events Before Subscriber Ready', () => {
    /**
     * These tests verify the fix for the race condition where early events
     * (like the 'created' event at seq 0) are lost because the Redis SUBSCRIBE
     * command hasn't completed when events are published.
     *
     * Symptom: "[RedisEventTransport] Stream <id>: timeout waiting for seq 0"
     *          followed by truncated responses in the UI.
     *
     * Root cause: RedisEventTransport.subscribe() fired Redis SUBSCRIBE as
     * fire-and-forget. GenerationJobManager set hasSubscriber=true immediately,
     * disabling the earlyEventBuffer before Redis was actually listening.
     *
     * Fix: subscribe() now returns a `ready` promise that resolves when the
     * Redis subscription is confirmed. earlyEventBuffer stays active until then.
     */

    test('should buffer and replay events emitted before subscribe (in-memory)', async () => {
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });

      manager.initialize();

      const streamId = `early-buf-inmem-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      await manager.emitChunk(streamId, {
        created: true,
        message: { text: 'hello' },
        streamId,
      } as CreatedEvent);
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'First chunk' } } },
      });

      const receivedEvents: unknown[] = [];
      const subscription = await manager.subscribe(streamId, (event: unknown) =>
        receivedEvents.push(event),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedEvents.length).toBe(2);
      expect((receivedEvents[0] as Record<string, unknown>).created).toBe(true);

      subscription?.unsubscribe();
      await manager.destroy();
    });

    testRedis('should buffer and replay events emitted before subscribe (Redis)', async () => {
      const manager = new GenerationJobManagerClass();
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      manager.configure(services);
      manager.initialize();

      const streamId = `early-buf-redis-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      await manager.emitChunk(streamId, {
        created: true,
        message: { text: 'hello' },
        streamId,
      } as CreatedEvent);
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'First' } } },
      });
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: ' chunk' } } },
      });

      const receivedEvents: unknown[] = [];
      const subscription = await manager.subscribe(streamId, (event: unknown) =>
        receivedEvents.push(event),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedEvents.length).toBe(3);
      expect((receivedEvents[0] as Record<string, unknown>).created).toBe(true);
      expect(
        ((receivedEvents[1] as Record<string, unknown>).data as Record<string, unknown>).delta,
      ).toBeDefined();

      subscription?.unsubscribe();
      await manager.destroy();
    });

    testRedis(
      'should not lose events when emitting before and after subscribe (Redis)',
      async () => {
        const manager = new GenerationJobManagerClass();
        const services = createStreamServices({
          useRedis: true,
          redisClient: ioredisClient,
        });

        manager.configure(services);
        manager.initialize();

        const streamId = `no-loss-${Date.now()}`;
        await manager.createJob(streamId, 'user-1');

        await manager.emitChunk(streamId, {
          created: true,
          message: { text: 'hello' },
          streamId,
        } as CreatedEvent);
        await manager.emitChunk(streamId, {
          event: 'on_run_step',
          data: { id: 'step-1', type: 'message_creation', index: 0 },
        });

        const receivedEvents: unknown[] = [];
        const subscription = await manager.subscribe(streamId, (event: unknown) =>
          receivedEvents.push(event),
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        for (let i = 0; i < 10; i++) {
          await manager.emitChunk(streamId, {
            event: 'on_message_delta',
            data: {
              delta: { content: { type: 'text', text: `word${i} ` } },
              index: i,
            },
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(receivedEvents.length).toBe(12);
        expect((receivedEvents[0] as Record<string, unknown>).created).toBe(true);
        expect((receivedEvents[1] as Record<string, unknown>).event).toBe('on_run_step');
        for (let i = 0; i < 10; i++) {
          expect((receivedEvents[i + 2] as Record<string, unknown>).event).toBe('on_message_delta');
        }

        subscription?.unsubscribe();
        await manager.destroy();
      },
    );

    testRedis('RedisEventTransport.subscribe() should return a ready promise', async () => {
      const subscriber = (ioredisClient as unknown as { duplicate: () => unknown }).duplicate();
      const transport = new RedisEventTransport(ioredisClient as never, subscriber as never);

      const streamId = `ready-promise-${Date.now()}`;
      const result = transport.subscribe(streamId, {
        onChunk: () => {},
      });

      expect(result.ready).toBeDefined();
      expect(result.ready).toBeInstanceOf(Promise);

      await result.ready;

      result.unsubscribe();
      transport.destroy();
      (subscriber as { disconnect: () => void }).disconnect();
    });

    test('InMemoryEventTransport.subscribe() should not have a ready promise', () => {
      const transport = new InMemoryEventTransport();
      const streamId = `no-ready-${Date.now()}`;
      const result = transport.subscribe(streamId, {
        onChunk: () => {},
      });

      expect(result.ready).toBeUndefined();

      result.unsubscribe();
      transport.destroy();
    });
  });

  describe('Resume: skipBufferReplay prevents duplication', () => {
    /**
     * Verifies the fix for duplicated content when navigating away from an
     * in-progress conversation and back. Events accumulate in earlyEventBuffer
     * while the subscriber is absent. On resume, the sync event delivers all
     * accumulated content via aggregatedContent, so buffer replay must be
     * skipped to prevent duplication.
     */

    test('should NOT replay buffer when skipBufferReplay is true (resume scenario)', async () => {
      const manager = createInMemoryManager();
      const streamId = `skip-buf-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      await setupDisconnectedStream(manager, streamId, 10);

      const resumeState = await manager.getResumeState(streamId);
      expect(resumeState).not.toBeNull();

      const resumeEvents: ServerSentEvent[] = [];
      const sub2 = await manager.subscribe(
        streamId,
        (event) => resumeEvents.push(event),
        undefined,
        undefined,
        { skipBufferReplay: true },
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(resumeEvents.length).toBe(0);

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: ' Live!' } },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(resumeEvents.length).toBe(1);
      expect((resumeEvents[0] as StreamEvent).event).toBe('on_message_delta');

      sub2?.unsubscribe();
      await manager.destroy();
    });

    test('should include emitted title event in resume state', async () => {
      const manager = createInMemoryManager();
      const streamId = `title-resume-${Date.now()}`;
      await manager.createJob(streamId, 'user-1', streamId);

      const titleEvent = {
        event: 'title',
        data: {
          conversationId: streamId,
          title: 'Resumed Title',
        },
      } satisfies ServerSentEvent;

      await manager.emitChunk(streamId, titleEvent);

      const resumeState = await manager.getResumeState(streamId);

      expect(resumeState?.titleEvent).toEqual(titleEvent);

      await manager.destroy();
    });

    test('should replay buffer by default when no options are passed', async () => {
      const manager = createInMemoryManager();
      const streamId = `replay-buf-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const sub1Events: ServerSentEvent[] = [];
      const sub1 = await manager.subscribe(streamId, (event) => sub1Events.push(event));
      await new Promise((resolve) => setTimeout(resolve, 10));

      await manager.emitChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      sub1?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'buffered' } },
        },
      });

      const sub2Events: ServerSentEvent[] = [];
      const sub2 = await manager.subscribe(streamId, (event) => sub2Events.push(event));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(sub2Events.length).toBe(1);
      expect((sub2Events[0] as StreamEvent).event).toBe('on_message_delta');

      sub2?.unsubscribe();
      await manager.destroy();
    });

    test('should clear earlyEventBuffer even when skipping replay (no memory leak)', async () => {
      const manager = createInMemoryManager();
      const streamId = `buf-clear-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const sub1 = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      sub1?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'buf1' } } },
      });
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'buf2' } } },
      });

      const sub2Events: ServerSentEvent[] = [];
      const sub2 = await manager.subscribe(
        streamId,
        (event) => sub2Events.push(event),
        undefined,
        undefined,
        { skipBufferReplay: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sub2Events.length).toBe(0);

      sub2?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'new-event' } } },
      });

      const sub3Events: ServerSentEvent[] = [];
      const sub3 = await manager.subscribe(streamId, (event) => sub3Events.push(event));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(sub3Events.length).toBe(1);
      const event = sub3Events[0] as {
        event: string;
        data: { delta: { content: { text: string } } };
      };
      expect(event.data.delta.content.text).toBe('new-event');

      sub3?.unsubscribe();
      await manager.destroy();
    });

    test('should handle multiple disconnect/reconnect cycles with skipBufferReplay', async () => {
      const manager = createInMemoryManager();
      const streamId = `multi-reconnect-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const sub1 = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 10));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'initial' } } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      sub1?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'buffered-1' } } },
      });

      const resumeState1 = await manager.getResumeState(streamId);
      expect(resumeState1).not.toBeNull();

      const sub2Events: ServerSentEvent[] = [];
      const sub2 = await manager.subscribe(
        streamId,
        (event) => sub2Events.push(event),
        undefined,
        undefined,
        { skipBufferReplay: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sub2Events.length).toBe(0);

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'live-1' } } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sub2Events.length).toBe(1);

      sub2?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'buffered-2' } } },
      });

      const resumeState2 = await manager.getResumeState(streamId);
      expect(resumeState2).not.toBeNull();

      const sub3Events: ServerSentEvent[] = [];
      const sub3 = await manager.subscribe(
        streamId,
        (event) => sub3Events.push(event),
        undefined,
        undefined,
        { skipBufferReplay: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sub3Events.length).toBe(0);

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'live-2' } } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sub3Events.length).toBe(1);

      sub3?.unsubscribe();
      await manager.destroy();
    });

    testRedis('should NOT replay buffer when skipBufferReplay is true (Redis)', async () => {
      const manager = createRedisManager();
      const streamId = `skip-buf-redis-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      await setupDisconnectedStream(manager, streamId, 100);

      const resumeState = await manager.getResumeState(streamId);
      expect(resumeState).not.toBeNull();
      expect(resumeState!.aggregatedContent?.length).toBeGreaterThan(0);

      const resumeEvents: ServerSentEvent[] = [];
      const sub2 = await manager.subscribe(
        streamId,
        (event) => resumeEvents.push(event),
        undefined,
        undefined,
        { skipBufferReplay: true },
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(resumeEvents.length).toBe(0);

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: ' Live!' } },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(resumeEvents.length).toBe(1);
      expect((resumeEvents[0] as StreamEvent).event).toBe('on_message_delta');

      sub2?.unsubscribe();
      await manager.destroy();
    });

    testRedis('should not re-buffer detached events after first attachment (Redis)', async () => {
      /**
       * After the first attachment, the durable chunk log owns recovery for
       * detached events; re-buffering them locally grew without bound for
       * long detached generations. A late subscriber gets live events only,
       * and resume reconstructs the detached content from the chunk log.
       */
      const manager = createRedisManager();
      const streamId = `no-rebuffer-redis-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const sub1 = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      await manager.emitChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      sub1?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 100));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'detached-redis' } },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.getRuntimeStats().earlyBufferedEvents).toBe(0);

      const sub2Events: ServerSentEvent[] = [];
      const sub2 = await manager.subscribe(streamId, (event) => sub2Events.push(event));

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sub2Events.length).toBe(0);

      const resumeState = await manager.getResumeState(streamId);
      expect(JSON.stringify(resumeState?.aggregatedContent ?? [])).toContain('detached-redis');

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: ' live' } },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sub2Events.length).toBe(1);
      expect((sub2Events[0] as StreamEvent).event).toBe('on_message_delta');

      sub2?.unsubscribe();
      await manager.destroy();
    });
  });

  describe('Early event buffer bounds', () => {
    /**
     * Regression tests for a production incident: a model streamed a malformed
     * 150k-character tool argument for ~26 minutes after the browser
     * disconnected (~40 events/sec, ~58,800 publications). Every event was
     * retained in earlyEventBuffer, so heap and GC cost climbed for the whole
     * detached run.
     */

    async function forceEarlyBufferOverflow(
      manager: GenerationJobManagerClass,
      streamId: string,
    ): Promise<void> {
      const runtime = (
        manager as unknown as {
          runtimeState: Map<string, unknown>;
        }
      ).runtimeState.get(streamId)!;
      await (
        manager as unknown as {
          overflowEarlyEventBuffer: (id: string, runtime: unknown) => Promise<void>;
        }
      ).overflowEarlyEventBuffer(streamId, runtime);
    }

    testRedis(
      'detached generation keeps the local buffer empty after first attachment (Redis)',
      async () => {
        const manager = createRedisManager();
        const streamId = `detached-flat-${Date.now()}`;
        await manager.createJob(streamId, 'user-1');

        const sub1 = await manager.subscribe(streamId, () => {});
        await new Promise((resolve) => setTimeout(resolve, 100));
        sub1?.unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 100));

        for (let i = 0; i < 200; i++) {
          await manager.emitChunk(streamId, {
            event: 'on_run_step_delta',
            data: {
              id: 'step-1',
              delta: { type: 'tool_call_delta', args: `"table_${i}", ` },
            },
          });
        }

        const stats = manager.getRuntimeStats();
        expect(stats.earlyBufferedEvents).toBe(0);
        expect(stats.earlyBufferedBytes).toBe(0);

        await manager.destroy();
      },
    );

    test('discards and closes the buffer when the byte budget is exceeded (never attached)', async () => {
      const manager = createInMemoryManager();
      const streamId = `buf-byte-cap-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const bigText = 'x'.repeat(2 * 1024 * 1024);
      for (let i = 0; i < 5; i++) {
        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            id: 'step-1',
            delta: { content: { type: 'text', text: bigText } },
          },
        });
      }

      const stats = manager.getRuntimeStats();
      expect(stats.earlyBufferedEvents).toBe(0);
      expect(stats.earlyBufferedBytes).toBe(0);
      const overflow = (await manager.getJob(streamId))?.metadata.earlyBufferOverflow;
      expect(overflow?.droppedEvents).toBe(4);
      expect(overflow?.droppedBytes).toBeGreaterThan(8 * 1024 * 1024);

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'after-overflow' } },
        },
      });
      expect(manager.getRuntimeStats().earlyBufferedEvents).toBe(0);

      const errors: string[] = [];
      const events: ServerSentEvent[] = [];
      const sub = await manager.subscribe(
        streamId,
        (event) => events.push(event),
        undefined,
        (error) => errors.push(error),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      /** A non-resume attachment cannot be made whole once the buffer was
       * discarded, so it is closed with the reconnect signal; the client then
       * re-attaches with resume=true and syncs from snapshot state. */
      expect(errors).toEqual([TERMINAL_PUBLICATION_RECONNECT_ERROR]);
      expect(events).toEqual([]);

      sub?.unsubscribe();
      await manager.destroy();
    });

    test('replays a completed result after the overflow reconnect was forced', async () => {
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });
      manager.initialize();
      const streamId = `overflow-complete-reconnect-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      await forceEarlyBufferOverflow(manager, streamId);

      const reconnectErrors: string[] = [];
      await manager.subscribe(
        streamId,
        () => {},
        undefined,
        (error) => reconnectErrors.push(error),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reconnectErrors).toEqual([TERMINAL_PUBLICATION_RECONNECT_ERROR]);

      const finalEvent = {
        final: true,
        conversation: { conversationId: streamId },
        responseMessage: { text: 'complete' },
      } as ServerSentEvent;
      await manager.emitDone(streamId, finalEvent);
      await manager.completeJob(streamId);

      const terminalEvents: ServerSentEvent[] = [];
      const resumed = await manager.subscribeWithResume(
        streamId,
        () => {},
        (event) => terminalEvents.push(event),
      );
      resumed.subscription?.activate();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(terminalEvents).toEqual([finalEvent]);
      resumed.subscription?.unsubscribe();
      await manager.destroy();
    });

    test('reconciles a generation replaced while recovery settles', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const streamId = `overflow-replaced-during-settlement-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      const originalCreatedAt = (await jobStore.getJob(streamId))!.createdAt;
      await forceEarlyBufferOverflow(manager, streamId);
      jest.spyOn(jobStore, 'settleEarlyBufferRecovery').mockImplementationOnce(async () => {
        await jobStore.createJob(streamId, 'user-1');
        return false;
      });

      const errors: string[] = [];
      const result = await manager.subscribeWithResume(
        streamId,
        () => {},
        undefined,
        (error) => errors.push(error),
        { expectedCreatedAt: originalCreatedAt },
      );
      expect(result.subscription).toBeNull();
      expect(errors).not.toContain(GENERATION_RECOVERY_FAILED_ERROR);
      expect((await jobStore.getJob(streamId))!.createdAt).toBeGreaterThan(originalCreatedAt);

      await manager.destroy();
    });

    test('reconciles a generation replaced while a recovery error settles', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const streamId = `overflow-replaced-during-error-settlement-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      const originalCreatedAt = (await jobStore.getJob(streamId))!.createdAt;
      await forceEarlyBufferOverflow(manager, streamId);
      jest
        .spyOn(manager, 'getResumeState')
        .mockRejectedValueOnce(new Error('snapshot unavailable'));
      jest.spyOn(jobStore, 'settleEarlyBufferRecovery').mockImplementationOnce(async () => {
        await jobStore.createJob(streamId, 'user-1');
        return false;
      });

      const errors: string[] = [];
      const result = await manager.subscribeWithResume(
        streamId,
        () => {},
        undefined,
        (error) => errors.push(error),
        { expectedCreatedAt: originalCreatedAt },
      );
      expect(result.subscription).toBeNull();
      expect(errors).not.toContain(GENERATION_RECOVERY_FAILED_ERROR);
      expect((await jobStore.getJob(streamId))!.createdAt).toBeGreaterThan(originalCreatedAt);

      await manager.destroy();
    });

    test('does not overwrite recovery settlement when the overflow owner finishes flushing', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });
      manager.initialize();
      const streamId = `overflow-finalize-settlement-race-${Date.now()}`;
      const job = await manager.createJob(streamId, 'user-1');
      const originalFinalize = jobStore.finalizeEarlyBufferOverflow.bind(jobStore);
      jest
        .spyOn(jobStore, 'finalizeEarlyBufferOverflow')
        .mockImplementationOnce(async (id, createdAt, overflowId, finalizedOverflow) => {
          await jobStore.settleEarlyBufferRecovery(id, createdAt, overflowId, {
            recoveryMethod: 'snapshot',
            recoveryOutcome: 'failed',
            recoveryCompletedAt: Date.now(),
            recoveryFailureReason: 'overflow_marker_persistence_failed',
          });
          return originalFinalize(id, createdAt, overflowId, finalizedOverflow);
        });

      await expect(forceEarlyBufferOverflow(manager, streamId)).rejects.toThrow(
        GENERATION_RECOVERY_FAILED_ERROR,
      );
      expect((await jobStore.getJob(streamId))?.earlyBufferOverflow).toMatchObject({
        recoveryOutcome: 'failed',
        recoveryFailureReason: 'overflow_marker_persistence_failed',
      });
      expect((await jobStore.getJob(streamId))?.createdAt).toBe(job.createdAt);

      await manager.destroy();
    });

    test('coalesces pending overflow waiters and backs off their store read', async () => {
      jest.useFakeTimers();
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore, eventTransport: new InMemoryEventTransport(), isRedis: false });
      manager.initialize();
      const streamId = `overflow-shared-waiter-${Date.now()}`;
      const job = await manager.createJob(streamId, 'user-1');
      const pendingOverflow = {
        id: 'pending-overflow',
        occurredAt: Date.now(),
        durableEvents: 1,
        droppedEvents: 1,
        droppedBytes: 1,
        persistencePending: true,
      };
      await jobStore.updateJob(streamId, { earlyBufferOverflow: pendingOverflow }, job.createdAt);
      const pendingJob = (await jobStore.getJob(streamId))!;
      const getJob = jest.spyOn(jobStore, 'getJob');
      const waitForFinalized = (
        manager as unknown as {
          waitForFinalizedEarlyBufferOverflow: (
            id: string,
            data: typeof pendingJob,
          ) => Promise<typeof pendingJob | null>;
        }
      ).waitForFinalizedEarlyBufferOverflow.bind(manager);

      const first = waitForFinalized(streamId, pendingJob);
      const second = waitForFinalized(streamId, pendingJob);
      await jest.advanceTimersByTimeAsync(99);
      expect(getJob).not.toHaveBeenCalled();
      await jobStore.updateJob(
        streamId,
        { earlyBufferOverflow: { ...pendingOverflow, persistencePending: false } },
        job.createdAt,
      );
      await jest.advanceTimersByTimeAsync(1);

      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({
          earlyBufferOverflow: expect.objectContaining({ persistencePending: false }),
        }),
        expect.objectContaining({
          earlyBufferOverflow: expect.objectContaining({ persistencePending: false }),
        }),
      ]);
      expect(getJob).toHaveBeenCalledTimes(1);

      await manager.destroy();
      jest.useRealTimers();
    });

    test('fences publication only until generation-wide subscriber admission', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const eventTransport = new InMemoryEventTransport();
      let releaseAppend!: (appended: boolean) => void;
      const pendingAppend = new Promise<boolean>((resolve) => {
        releaseAppend = resolve;
      });
      const append = jest.spyOn(jobStore, 'appendChunk').mockReturnValueOnce(pendingAppend);
      jest.spyOn(jobStore, 'hasSubscriberAttached').mockResolvedValue(true);
      const publish = jest.spyOn(eventTransport, 'emitChunk');
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore, eventTransport, isRedis: true });
      manager.initialize();
      const streamId = `detached-append-before-publish-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const emission = manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'durable first' } } },
      });
      await Promise.resolve();
      expect(publish).not.toHaveBeenCalled();
      releaseAppend(true);
      await emission;
      expect(publish).toHaveBeenCalledTimes(1);

      append.mockReturnValueOnce(new Promise<boolean>(() => {}));
      await expect(
        manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: { delta: { content: { type: 'text', text: 'publish without append wait' } } },
        }),
      ).resolves.toBeUndefined();
      expect(publish).toHaveBeenCalledTimes(2);
      expect(jobStore.hasSubscriberAttached).toHaveBeenCalledTimes(1);

      await manager.destroy();
    });

    test('validates an in-memory HITL snapshot with the event frontier', async () => {
      const manager = createInMemoryManager();
      const streamId = `overflow-hitl-memory-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      const createdAt = (await manager.getJob(streamId))!.createdAt;
      await forceEarlyBufferOverflow(manager, streamId);
      manager.setContentParts(
        streamId,
        [{ type: 'text', text: 'complete snapshot' }] as never,
        createdAt,
      );
      const getRuntimeSpy = jest.spyOn(
        manager as unknown as {
          getOrCreateRuntimeState: (...args: unknown[]) => Promise<unknown>;
        },
        'getOrCreateRuntimeState',
      );

      await expect(
        manager.getResumeState(streamId, createdAt, { validateEarlyBufferRecovery: true }),
      ).resolves.toMatchObject({ aggregatedContent: expect.any(Array) });
      expect(getRuntimeSpy).toHaveBeenCalledWith(streamId, expect.objectContaining({ createdAt }));
      expect((await manager.getJob(streamId))?.metadata.earlyBufferOverflow).toMatchObject({
        durableEvents: 0,
        recoveryOutcome: 'success',
      });

      await manager.destroy();
    });

    test('rejects a durable failed outcome before exposing HITL state', async () => {
      const manager = createInMemoryManager();
      const streamId = `overflow-hitl-failed-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      const createdAt = (await manager.getJob(streamId))!.createdAt;
      await forceEarlyBufferOverflow(manager, streamId);
      const overflow = (await manager.getJob(streamId))!.metadata.earlyBufferOverflow!;
      await (manager.getJobStore() as IJobStoreV2).settleEarlyBufferRecovery(
        streamId,
        createdAt,
        overflow.id,
        {
          recoveryMethod: 'snapshot',
          recoveryOutcome: 'failed',
          recoveryCompletedAt: Date.now(),
          recoveryFailureReason: 'snapshot_missing',
        },
      );

      await expect(
        manager.getResumeState(streamId, createdAt, { validateEarlyBufferRecovery: true }),
      ).rejects.toThrow(GENERATION_RECOVERY_FAILED_ERROR);

      await manager.destroy();
    });

    test('contains subscriber lease lookup failure during terminal cleanup', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });
      manager.initialize();
      const streamId = `overflow-lease-read-failure-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      await forceEarlyBufferOverflow(manager, streamId);
      jest.spyOn(jobStore, 'hasActiveSubscriber').mockRejectedValueOnce(new Error('unavailable'));

      await expect(manager.completeJob(streamId)).resolves.toBe(true);
      expect((await manager.getJob(streamId))?.status).toBe('complete');
      expect((await manager.getJob(streamId))?.metadata.earlyBufferOverflow).not.toHaveProperty(
        'recoveryOutcome',
      );

      await manager.destroy();
    });

    test('leaves recovery unresolved when terminal lifecycle lookup fails', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });
      manager.initialize();
      const streamId = `overflow-lifecycle-read-failure-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      await forceEarlyBufferOverflow(manager, streamId);
      const originalGetJob = jobStore.getJob.bind(jobStore);
      jest
        .spyOn(jobStore, 'getJob')
        .mockImplementationOnce(originalGetJob)
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockImplementation(originalGetJob);

      await expect(manager.completeJob(streamId)).resolves.toBe(true);
      expect((await manager.getJob(streamId))?.metadata.earlyBufferOverflow).not.toHaveProperty(
        'recoveryOutcome',
      );

      await manager.destroy();
    });

    test('removes in-memory capture handlers when another attachment wins recovery', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });
      manager.initialize();
      const streamId = `overflow-recovery-loser-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      await forceEarlyBufferOverflow(manager, streamId);
      const originalSettle = jobStore.settleEarlyBufferRecovery.bind(jobStore);
      jest
        .spyOn(jobStore, 'settleEarlyBufferRecovery')
        .mockImplementationOnce(async (id, createdAt, recoveryId) => {
          await originalSettle(id, createdAt, recoveryId, {
            recoveryMethod: 'snapshot',
            recoveryOutcome: 'not_required',
            recoveryCompletedAt: Date.now(),
          });
          return false;
        });

      const result = await manager.subscribeWithResume(streamId, () => {});

      expect(result.subscription).toBeNull();
      const runtime = (
        manager as unknown as {
          runtimeState: Map<string, { resumeCaptureHandlers: Set<unknown> }>;
        }
      ).runtimeState.get(streamId);
      expect(runtime?.resumeCaptureHandlers.size).toBe(0);

      await manager.destroy();
    });

    testRedis('redirects a post-overflow first attachment to resume recovery (Redis)', async () => {
      const manager = createRedisManager();
      const streamId = `overflow-redirect-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      await manager.emitChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'durable-overflow-content' } },
        },
      });
      await forceEarlyBufferOverflow(manager, streamId);
      expect(manager.getRuntimeStats().earlyBufferedEvents).toBe(0);

      const errors: string[] = [];
      const sub = await manager.subscribe(
        streamId,
        () => {},
        undefined,
        (error) => errors.push(error),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errors).toEqual([TERMINAL_PUBLICATION_RECONNECT_ERROR]);
      sub?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 100));

      /** The resume path the client falls back to reconstructs the
       * discarded output from the durable chunk log. */
      const { subscription, resumeState } = await manager.subscribeWithResume(streamId, () => {});
      expect(JSON.stringify(resumeState?.aggregatedContent ?? [])).toContain(
        'durable-overflow-content',
      );
      subscription?.unsubscribe();
      const recoveredJob = await manager.getJob(streamId);
      expect(recoveredJob?.metadata.earlyBufferOverflow).toMatchObject({
        recoveryMethod: 'redis',
        recoveryOutcome: 'success',
      });

      await manager.destroy();
    });

    testRedis('refreshes an overflow marker before activating a resume attachment', async () => {
      const owner = createRedisManager();
      const streamId = `overflow-marker-attachment-race-${Date.now()}`;
      await owner.createJob(streamId, 'user-1');
      await owner.emitChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await owner.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'durable-before-marker' } },
        },
      });
      await forceEarlyBufferOverflow(owner, streamId);

      const replica = createRedisManager();
      const replicaStore = replica.getJobStore();
      const originalGetJob = replicaStore.getJob.bind(replicaStore);
      let jobReads = 0;
      jest.spyOn(replicaStore, 'getJob').mockImplementation(async (id) => {
        const job = await originalGetJob(id);
        jobReads++;
        if (jobReads <= 4 && job != null) {
          return { ...job, earlyBufferOverflow: undefined };
        }
        return job;
      });

      const result = await replica.subscribeWithResume(streamId, () => {});

      expect(jobReads).toBeGreaterThan(4);
      expect(JSON.stringify(result.resumeState?.aggregatedContent ?? [])).toContain(
        'durable-before-marker',
      );
      expect((await originalGetJob(streamId))?.earlyBufferOverflow).toMatchObject({
        recoveryMethod: 'redis',
        recoveryOutcome: 'success',
      });
      result.subscription?.unsubscribe();

      const followup = await replica.subscribeWithResume(streamId, () => {});
      expect(JSON.stringify(followup.resumeState?.aggregatedContent ?? [])).toContain(
        'durable-before-marker',
      );
      followup.subscription?.unsubscribe();

      await Promise.all([owner.destroy(), replica.destroy()]);
    });

    testRedis(
      'reconstructs more than 5,000 pre-attachment events across replica reconnects (Redis)',
      async () => {
        const owner = createRedisManager();
        const streamId = `overflow-cross-replica-${Date.now()}`;
        await owner.createJob(streamId, 'user-1');
        const createdAt = (await owner.getJob(streamId))!.createdAt;
        const firstReplica = createRedisManager();
        /** Cache a pre-overflow runtime so resume must refresh the later
         * durable marker rather than trust process-local state. */
        await firstReplica.getJob(streamId);
        /** Created envelopes are published but not durably appendable, so they
         * must not advance the durable recovery frontier. */
        await owner.emitChunk(streamId, {
          created: true,
          message: { text: 'hello' },
          streamId,
        } as CreatedEvent);
        await owner.emitChunk(streamId, {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        });
        for (let i = 0; i < 5_001; i++) {
          await firstReplica.emitChunk(streamId, {
            event: 'on_message_delta',
            data: {
              id: 'step-1',
              delta: { content: { type: 'text', text: `${i},` } },
            },
          });
        }

        const first = await firstReplica.subscribeWithResume(streamId, () => {});
        expect(first.resumeState?.aggregatedContent).toHaveLength(1);
        expect(JSON.stringify(first.resumeState?.aggregatedContent)).toContain('5000,');
        first.subscription?.activate();
        first.subscription?.unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const firstAttachedAt = await ioredisClient!.hget(
          `stream:{${streamId}}:job`,
          'firstSubscriberAttachedAt',
        );
        expect(firstAttachedAt).not.toBeNull();
        expect(
          await (firstReplica.getJobStore() as IJobStoreV2).hasActiveSubscriber(
            streamId,
            createdAt,
            Date.now(),
          ),
        ).toBe(false);

        await owner.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            id: 'step-1',
            delta: { content: { type: 'text', text: 'after-disconnect' } },
          },
        });

        const secondReplica = createRedisManager();
        const second = await secondReplica.subscribeWithResume(streamId, () => {});
        expect(JSON.stringify(second.resumeState?.aggregatedContent)).toContain('after-disconnect');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(
          await (secondReplica.getJobStore() as IJobStoreV2).hasActiveSubscriber(
            streamId,
            createdAt,
            Date.now(),
          ),
        ).toBe(true);
        second.subscription?.unsubscribe();
        expect(
          await ioredisClient!.hget(`stream:{${streamId}}:job`, 'firstSubscriberAttachedAt'),
        ).toBe(firstAttachedAt);

        const recoveredJob = await secondReplica.getJob(streamId);
        expect(recoveredJob?.metadata.earlyBufferOverflow).toMatchObject({
          durableEvents: 5_002,
          recoveryMethod: 'redis',
          recoveryOutcome: 'success',
        });

        await Promise.all([owner.destroy(), firstReplica.destroy(), secondReplica.destroy()]);
      },
      60_000,
    );

    testRedis(
      'terminalizes an overflow when durable reconstruction is missing (Redis)',
      async () => {
        const owner = createRedisManager();
        const streamId = `overflow-missing-durable-${Date.now()}`;
        await owner.createJob(streamId, 'user-1');
        await forceEarlyBufferOverflow(owner, streamId);
        await ioredisClient!.del(`stream:{${streamId}}:chunks`);

        const replica = createRedisManager();
        const errors: string[] = [];
        const result = await replica.subscribeWithResume(
          streamId,
          () => {},
          undefined,
          (error) => errors.push(error),
        );

        expect(result.subscription).toBeNull();
        expect(errors).toEqual([GENERATION_RECOVERY_FAILED_ERROR]);
        const failedJob = await replica.getJob(streamId);
        expect(failedJob?.status).toBe('error');
        expect(failedJob?.error).toBe(GENERATION_RECOVERY_FAILED_ERROR);
        expect(failedJob?.metadata.earlyBufferOverflow).toMatchObject({
          recoveryMethod: 'redis',
          recoveryOutcome: 'failed',
          recoveryFailureReason: 'durable_state_missing',
        });

        await Promise.all([owner.destroy(), replica.destroy()]);
      },
    );

    testRedis('replays a durable terminal payload with unresolved overflow (Redis)', async () => {
      const owner = createRedisManager();
      const streamId = `overflow-durable-terminal-${Date.now()}`;
      const job = await owner.createJob(streamId, 'user-1');
      await forceEarlyBufferOverflow(owner, streamId);
      const claim = await owner.claimTerminalJob(streamId, 'complete', undefined, job.createdAt, {
        persistencePending: true,
      });
      expect(claim).not.toBeNull();
      const finalEvent = {
        final: true,
        conversation: { conversationId: streamId },
        responseMessage: { text: 'complete' },
      } as ServerSentEvent;
      await owner.publishTerminalClaim(claim!, finalEvent);
      expect((await owner.getJob(streamId))?.metadata.earlyBufferOverflow).not.toHaveProperty(
        'recoveryOutcome',
      );

      const replica = createRedisManager();
      const terminalEvents: ServerSentEvent[] = [];
      const errors: string[] = [];
      const resumed = await replica.subscribeWithResume(
        streamId,
        () => {},
        (event) => terminalEvents.push(event),
        (error) => errors.push(error),
        { expectedCreatedAt: job.createdAt },
      );
      resumed.subscription?.activate();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(terminalEvents).toEqual([finalEvent]);
      expect(errors).toEqual([]);
      expect((await replica.getJob(streamId))?.status).toBe('complete');

      resumed.subscription?.unsubscribe();
      await Promise.all([owner.destroy(), replica.destroy()]);
    });

    testRedis('validates overflow recovery before exposing HITL resume state', async () => {
      const manager = createRedisManager();
      const streamId = `overflow-hitl-validation-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      await forceEarlyBufferOverflow(manager, streamId);
      const createdAt = (await manager.getJob(streamId))!.createdAt;
      await ioredisClient!.del(`stream:{${streamId}}:chunks`);

      await expect(
        manager.getResumeState(streamId, createdAt, { validateEarlyBufferRecovery: true }),
      ).rejects.toThrow(GENERATION_RECOVERY_FAILED_ERROR);
      expect((await manager.getJob(streamId))?.status).toBe('error');

      await manager.destroy();
    });

    testRedis(
      'terminalizes a durable failed outcome left running by a crashed replica',
      async () => {
        const owner = createRedisManager();
        const streamId = `overflow-failed-outcome-${Date.now()}`;
        await owner.createJob(streamId, 'user-1');
        await forceEarlyBufferOverflow(owner, streamId);

        const overflowJob = await owner.getJob(streamId);
        const overflow = overflowJob?.metadata.earlyBufferOverflow;
        expect(overflow).toBeDefined();
        await (owner.getJobStore() as IJobStoreV2).settleEarlyBufferRecovery(
          streamId,
          overflowJob!.createdAt,
          overflow!.id,
          {
            recoveryMethod: 'redis',
            recoveryOutcome: 'failed',
            recoveryCompletedAt: Date.now(),
            recoveryFailureReason: 'reconstruction_error',
          },
        );

        const replica = createRedisManager();
        const errors: string[] = [];
        const result = await replica.subscribeWithResume(
          streamId,
          () => {},
          undefined,
          (error) => errors.push(error),
        );
        expect(result.subscription).toBeNull();
        expect(errors).toEqual([GENERATION_RECOVERY_FAILED_ERROR]);
        expect((await replica.getJob(streamId))?.status).toBe('error');

        await Promise.all([owner.destroy(), replica.destroy()]);
      },
    );

    test('buffers detached events until the cap in in-memory mode', async () => {
      const manager = createInMemoryManager();
      const streamId = `buf-below-cap-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      await setupDisconnectedStream(manager, streamId, 10);

      const stats = manager.getRuntimeStats();
      expect(stats.earlyBufferedEvents).toBe(2);
      expect(stats.earlyBufferedBytes).toBeGreaterThan(0);

      await manager.destroy();
    });

    test('caps captured events restored by a resume canceled before activation', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const streamId = `restore-cap-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      await setupDisconnectedStream(manager, streamId, 10);

      /** Arm only after the snapshot completes so the gate parks the resume
       * in its post-attachment steer reconciliation, the window where
       * emissions are captured per-resume instead of buffered. */
      let armed = false;
      const originalGetResumeState = manager.getResumeState.bind(manager);
      jest
        .spyOn(manager, 'getResumeState')
        .mockImplementation(
          async (...args: Parameters<GenerationJobManagerClass['getResumeState']>) => {
            const result = await originalGetResumeState(...args);
            armed = true;
            return result;
          },
        );
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => (releaseGate = resolve));
      let gateReached!: () => void;
      const reached = new Promise<void>((resolve) => (gateReached = resolve));
      const originalPeek = jobStore.peekSteers.bind(jobStore);
      let gated = true;
      jest
        .spyOn(jobStore, 'peekSteers')
        .mockImplementation(async (...args: Parameters<InMemoryJobStore['peekSteers']>) => {
          if (armed && gated) {
            gated = false;
            gateReached();
            await gate;
          }
          return originalPeek(...args);
        });

      const resumePromise = manager.subscribeWithResume(streamId, () => {});

      await reached;
      const bigText = 'z'.repeat(2 * 1024 * 1024);
      for (let i = 0; i < 5; i++) {
        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            id: 'step-1',
            delta: { content: { type: 'text', text: bigText } },
          },
        });
      }
      releaseGate();

      const { subscription } = await resumePromise;
      expect(subscription).not.toBeNull();
      subscription!.unsubscribe();

      /** The ~10MB of captured events must not survive restoration. */
      const stats = manager.getRuntimeStats();
      expect(stats.earlyBufferedEvents).toBe(0);
      expect(stats.earlyBufferedBytes).toBe(0);

      /** Restoration overflowed, so a non-resume attach takes the redirect. */
      const errors: string[] = [];
      const probe = await manager.subscribe(
        streamId,
        () => {},
        undefined,
        (error) => errors.push(error),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(errors).toEqual([TERMINAL_PUBLICATION_RECONNECT_ERROR]);
      probe?.unsubscribe();

      await manager.destroy();
    });
  });

  describe('Atomic subscribeWithResume', () => {
    test('retries a failed first-subscriber lease claim while attached', async () => {
      jest.useFakeTimers();
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const originalClaim = jobStore.claimFirstSubscriber.bind(jobStore);
      const claim = jest
        .spyOn(jobStore, 'claimFirstSubscriber')
        .mockRejectedValueOnce(new Error('store unavailable'))
        .mockImplementation(originalClaim);
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const streamId = `subscriber-claim-retry-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      const createdAt = (await jobStore.getJob(streamId))!.createdAt;
      const subscription = await manager.subscribe(streamId, () => {});
      await jest.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledTimes(1);
      const runtime = (
        manager as unknown as {
          runtimeState: Map<string, { onFirstSubscriberLeaseClaim?: (first: boolean) => void }>;
        }
      ).runtimeState.get(streamId)!;
      expect(runtime.onFirstSubscriberLeaseClaim).toBeDefined();

      await jest.advanceTimersByTimeAsync(10_000);

      expect(claim).toHaveBeenCalledTimes(2);
      expect(runtime.onFirstSubscriberLeaseClaim).toBeUndefined();
      await expect(jobStore.hasActiveSubscriber(streamId, createdAt, Date.now())).resolves.toBe(
        true,
      );
      subscription?.unsubscribe();
      await manager.destroy();
      jest.useRealTimers();
    });

    test('coalesces subscriber lease renewals while a store write is pending', async () => {
      jest.useFakeTimers();
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const originalClaim = jobStore.claimFirstSubscriber.bind(jobStore);
      let releaseRenewal!: (claimed: boolean) => void;
      const pendingRenewal = new Promise<boolean>((resolve) => {
        releaseRenewal = resolve;
      });
      const claim = jest
        .spyOn(jobStore, 'claimFirstSubscriber')
        .mockImplementationOnce(originalClaim)
        .mockReturnValueOnce(pendingRenewal)
        .mockImplementation(originalClaim);
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const streamId = `subscriber-renewal-coalesce-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      const subscription = await manager.subscribe(streamId, () => {});
      await jest.advanceTimersByTimeAsync(30_000);

      expect(claim).toHaveBeenCalledTimes(2);
      releaseRenewal(false);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(claim).toHaveBeenCalledTimes(3);
      const lastCall = claim.mock.calls[2];
      expect(lastCall[4] - lastCall[2]).toBe(30_000);

      subscription?.unsubscribe();
      await manager.destroy();
      jest.useRealTimers();
    });

    test('stops the predecessor lease timer when a durable generation replaces it', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: true,
      });
      manager.initialize();
      const streamId = `subscriber-runtime-replacement-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      const subscription = await manager.subscribe(streamId, () => {});
      const predecessor = (
        manager as unknown as {
          runtimeState: Map<string, { subscriberLeaseTimer?: ReturnType<typeof setInterval> }>;
        }
      ).runtimeState.get(streamId)!;
      expect(predecessor.subscriberLeaseTimer).toBeDefined();

      await jobStore.createJob(streamId, 'user-1');
      await manager.getJob(streamId);

      expect(predecessor.subscriberLeaseTimer).toBeUndefined();
      subscription?.unsubscribe();
      await manager.destroy();
    });

    test('keeps ordinary HITL resume reads on the cached content path', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const streamId = `hitl-cached-content-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      const createdAt = (await jobStore.getJob(streamId))!.createdAt;
      const getContentParts = jest.spyOn(jobStore, 'getContentParts');

      await manager.getResumeState(streamId, createdAt, {
        validateEarlyBufferRecovery: true,
      });

      expect(getContentParts).toHaveBeenCalledWith(streamId, createdAt, {
        durableOnly: false,
      });
      await manager.destroy();
    });

    test('renews the subscriber lease after an ambiguous detach failure', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const claim = jest.spyOn(jobStore, 'claimFirstSubscriber');
      jest
        .spyOn(jobStore, 'detachSubscriber')
        .mockRejectedValueOnce(new Error('store unavailable'));
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const streamId = `subscriber-detach-retry-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const first = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      first?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(claim).toHaveBeenCalledTimes(2);

      second?.unsubscribe();
      await manager.destroy();
    });

    test('tracks active subscriber groups across local reattachments', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const streamId = `subscriber-lifecycle-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');
      const createdAt = (await jobStore.getJob(streamId))!.createdAt;

      const first = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(jobStore.hasActiveSubscriber(streamId, createdAt, Date.now())).resolves.toBe(
        true,
      );
      first?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(jobStore.hasActiveSubscriber(streamId, createdAt, Date.now())).resolves.toBe(
        false,
      );

      const second = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(jobStore.hasActiveSubscriber(streamId, createdAt, Date.now())).resolves.toBe(
        true,
      );
      second?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await jobStore.claimFirstSubscriber(
        streamId,
        createdAt,
        Date.now(),
        'crashed-subscriber',
        Date.now() - 1,
      );
      await expect(jobStore.hasActiveSubscriber(streamId, createdAt, Date.now())).resolves.toBe(
        false,
      );
      await manager.destroy();
    });

    test('keeps the first-subscriber telemetry claim off the attachment path', async () => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      let releaseClaim!: (claimed: boolean) => void;
      const pendingClaim = new Promise<boolean>((resolve) => {
        releaseClaim = resolve;
      });
      jest.spyOn(jobStore, 'claimFirstSubscriber').mockReturnValue(pendingClaim);
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const streamId = `nonblocking-attachment-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const attachment = manager.subscribe(streamId, () => {});
      const result = await Promise.race([
        attachment,
        new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 50)),
      ]);
      expect(result).not.toBe('timed_out');
      releaseClaim(true);
      await pendingClaim;
      if (result !== 'timed_out') {
        result?.unsubscribe();
      }
      await manager.destroy();
    });

    test('should return empty pendingEvents for pre-snapshot buffer events (in-memory)', async () => {
      const manager = createInMemoryManager();
      const streamId = `atomic-drain-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const sub1 = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      sub1?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await manager.emitChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          id: 'step-1',
          delta: { content: { type: 'text', text: 'buffered' } },
        },
      });

      const liveEvents: ServerSentEvent[] = [];
      const { subscription, resumeState, pendingEvents } = await manager.subscribeWithResume(
        streamId,
        (event) => liveEvents.push(event),
      );

      expect(resumeState).not.toBeNull();
      expect(pendingEvents.length).toBe(0);
      expect(liveEvents.length).toBe(0);

      subscription?.unsubscribe();
      await manager.destroy();
    });

    test('should return empty pendingEvents when buffer is empty', async () => {
      const manager = createInMemoryManager();
      const streamId = `atomic-empty-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const sub1 = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 10));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'delivered' } } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      sub1?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const { pendingEvents } = await manager.subscribeWithResume(streamId, () => {});

      expect(pendingEvents.length).toBe(0);

      await manager.destroy();
    });

    test('should defer live events until a resumed subscription is activated', async () => {
      const manager = createInMemoryManager();
      const streamId = `atomic-live-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const sub1 = await manager.subscribe(streamId, () => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      sub1?.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          delta: { content: { type: 'text', text: 'buffered-pre-snapshot' } },
        },
      });

      const liveEvents: ServerSentEvent[] = [];
      const { subscription, pendingEvents } = await manager.subscribeWithResume(streamId, (event) =>
        liveEvents.push(event),
      );

      expect(pendingEvents.length).toBe(0);
      expect(liveEvents.length).toBe(0);

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'live-after' } } },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(liveEvents.length).toBe(0);

      subscription?.activate();
      expect(liveEvents.length).toBe(1);
      const liveEvent = liveEvents[0] as {
        event: string;
        data: { delta: { content: { text: string } } };
      };
      expect(liveEvent.data.delta.content.text).toBe('live-after');

      subscription?.unsubscribe();
      await manager.destroy();
    });

    testRedis(
      'should return empty pendingEvents in Redis mode (chunks already persisted)',
      async () => {
        const manager = createRedisManager();
        const streamId = `atomic-redis-${Date.now()}`;
        await manager.createJob(streamId, 'user-1');

        const sub1 = await manager.subscribe(streamId, () => {});
        await new Promise((resolve) => setTimeout(resolve, 100));
        sub1?.unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 100));

        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            delta: { content: { type: 'text', text: 'buffered-redis' } },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 100));

        const liveEvents: ServerSentEvent[] = [];
        const { subscription, resumeState, pendingEvents } = await manager.subscribeWithResume(
          streamId,
          (event) => liveEvents.push(event),
        );

        expect(resumeState).not.toBeNull();
        expect(pendingEvents.length).toBe(0);

        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: { delta: { content: { type: 'text', text: 'live-redis' } } },
        });

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(liveEvents.length).toBe(0);

        subscription?.activate();
        expect(liveEvents.length).toBe(1);

        subscription?.unsubscribe();
        await manager.destroy();
      },
    );
  });

  describe('Error Preservation for Late Subscribers', () => {
    /**
     * These tests verify the fix for the race condition where errors
     * (like INPUT_LENGTH) occur before the SSE client connects.
     *
     * Problem: Error → emitError → completeJob → job deleted → client connects → 404
     * Fix: Store error, don't delete job immediately, send error to late subscriber
     */

    test('should store error in emitError for late-connecting subscribers', async () => {
      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });

      GenerationJobManager.initialize();

      const streamId = `error-store-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const errorMessage = '{ "type": "INPUT_LENGTH", "info": "234856 / 172627" }';

      // Emit error (no subscribers yet - simulates race condition)
      await GenerationJobManager.emitError(streamId, errorMessage);

      // Wait for async job store update
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify error is stored in job store
      const job = await GenerationJobManager.getJob(streamId);
      expect(job?.error).toBe(errorMessage);

      await GenerationJobManager.destroy();
    });

    test('should NOT delete job immediately when completeJob is called with error', async () => {
      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: true, // Default behavior
      });

      GenerationJobManager.initialize();

      const streamId = `error-no-delete-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const errorMessage = 'Test error message';

      // Complete with error
      await GenerationJobManager.completeJob(streamId, errorMessage);

      // Job should still exist (not deleted)
      const hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(true);

      // Job should have error status
      const job = await GenerationJobManager.getJob(streamId);
      expect(job?.status).toBe('error');
      expect(job?.error).toBe(errorMessage);

      await GenerationJobManager.destroy();
    });

    test('should send stored error to late-connecting subscriber', async () => {
      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: true,
      });

      GenerationJobManager.initialize();

      const streamId = `error-late-sub-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const errorMessage = '{ "type": "INPUT_LENGTH", "info": "234856 / 172627" }';

      // Simulate race condition: error occurs before client connects
      await GenerationJobManager.emitError(streamId, errorMessage);
      await GenerationJobManager.completeJob(streamId, errorMessage);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now client connects (late subscriber)
      let receivedError: string | undefined;
      const subscription = await GenerationJobManager.subscribe(
        streamId,
        () => {}, // onChunk
        () => {}, // onDone
        (error) => {
          receivedError = error;
        }, // onError
      );

      expect(subscription).not.toBeNull();

      // Wait for setImmediate in subscribe to fire
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Late subscriber should receive the stored error
      expect(receivedError).toBe(errorMessage);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    test('should prioritize error status over finalEvent in subscribe', async () => {
      GenerationJobManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: false,
      });

      GenerationJobManager.initialize();

      const streamId = `error-priority-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      const errorMessage = 'Error should take priority';

      // Emit error and complete with error
      await GenerationJobManager.emitError(streamId, errorMessage);
      await GenerationJobManager.completeJob(streamId, errorMessage);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Subscribe and verify error is received (not a done event)
      let receivedError: string | undefined;
      let receivedDone = false;

      const subscription = await GenerationJobManager.subscribe(
        streamId,
        () => {},
        () => {
          receivedDone = true;
        },
        (error) => {
          receivedError = error;
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Error should be received, not done
      expect(receivedError).toBe(errorMessage);
      expect(receivedDone).toBe(false);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
    });

    testRedis('should handle error preservation in Redis mode (cross-replica)', async () => {
      // === Replica A: Creates job and emits error ===
      const replicaAJobStore = new RedisJobStore(ioredisClient!);
      await replicaAJobStore.initialize();

      const streamId = `redis-error-${Date.now()}`;
      const errorMessage = '{ "type": "INPUT_LENGTH", "info": "234856 / 172627" }';

      await replicaAJobStore.createJob(streamId, 'user-1');
      await replicaAJobStore.updateJob(streamId, {
        status: 'error',
        error: errorMessage,
        completedAt: Date.now(),
      });

      // === Replica B: Fresh manager receives client connection ===
      jest.resetModules();

      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      GenerationJobManager.configure({
        ...services,
        cleanupOnComplete: false,
      });
      GenerationJobManager.initialize();

      // Client connects to Replica B (job created on Replica A)
      let receivedError: string | undefined;
      const subscription = await GenerationJobManager.subscribe(
        streamId,
        () => {},
        () => {},
        (error) => {
          receivedError = error;
        },
      );

      expect(subscription).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Error should be loaded from Redis and sent to subscriber
      expect(receivedError).toBe(errorMessage);

      subscription?.unsubscribe();
      await GenerationJobManager.destroy();
      await replicaAJobStore.destroy();
    });

    test('error jobs should be cleaned up by periodic cleanup after TTL', async () => {
      // Use a very short TTL for testing
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 100 });

      GenerationJobManager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: true,
      });

      GenerationJobManager.initialize();

      const streamId = `error-cleanup-${Date.now()}`;
      await GenerationJobManager.createJob(streamId, 'user-1');

      // Complete with error
      await GenerationJobManager.completeJob(streamId, 'Test error');

      // Job should exist immediately after error
      let hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(true);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Trigger cleanup
      await jobStore.cleanup();

      // Job should be cleaned up after TTL
      hasJob = await GenerationJobManager.hasJob(streamId);
      expect(hasJob).toBe(false);

      await GenerationJobManager.destroy();
    });
  });

  describeRedis('Cross-Replica Live Streaming (Redis)', () => {
    test('should publish events to Redis even when no local subscriber exists', async () => {
      const replicaA = new GenerationJobManagerClass();
      const servicesA = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      replicaA.configure(servicesA);
      replicaA.initialize();

      const replicaB = new GenerationJobManagerClass();
      const servicesB = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      replicaB.configure(servicesB);
      replicaB.initialize();

      const streamId = `cross-live-${Date.now()}`;
      await replicaA.createJob(streamId, 'user-1');

      const receivedOnB: unknown[] = [];
      const subB = await replicaB.subscribe(streamId, (event: unknown) => receivedOnB.push(event));

      await new Promise((resolve) => setTimeout(resolve, 100));

      for (let i = 0; i < 5; i++) {
        await replicaA.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            delta: { content: { type: 'text', text: `token${i} ` } },
            index: i,
          },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(receivedOnB.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect((receivedOnB[i] as Record<string, unknown>).event).toBe('on_message_delta');
      }

      subB?.unsubscribe();
      await replicaA.destroy();
      await replicaB.destroy();
    });

    test('should not cause data loss on cross-replica subscribers when local subscriber joins', async () => {
      const replicaA = new GenerationJobManagerClass();
      const servicesA = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      replicaA.configure(servicesA);
      replicaA.initialize();

      const replicaB = new GenerationJobManagerClass();
      const servicesB = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      replicaB.configure(servicesB);
      replicaB.initialize();

      const streamId = `cross-seq-safe-${Date.now()}`;

      await replicaA.createJob(streamId, 'user-1');

      const receivedOnB: unknown[] = [];
      const subB = await replicaB.subscribe(streamId, (event: unknown) => receivedOnB.push(event));
      await new Promise((resolve) => setTimeout(resolve, 100));

      for (let i = 0; i < 3; i++) {
        await replicaA.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            delta: { content: { type: 'text', text: `pre-local-${i}` } },
            index: i,
          },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(receivedOnB.length).toBe(3);

      const receivedOnA: unknown[] = [];
      const subA = await replicaA.subscribe(streamId, (event: unknown) => receivedOnA.push(event));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedOnA.length).toBe(3);

      for (let i = 0; i < 3; i++) {
        await replicaA.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            delta: { content: { type: 'text', text: `post-local-${i}` } },
            index: i + 3,
          },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(receivedOnB.length).toBe(6);
      expect(receivedOnA.length).toBe(6);

      for (let i = 0; i < 3; i++) {
        const data = (receivedOnB[i] as Record<string, unknown>).data as Record<string, unknown>;
        const delta = data.delta as Record<string, unknown>;
        const content = delta.content as Record<string, unknown>;
        expect(content.text).toBe(`pre-local-${i}`);
      }
      for (let i = 0; i < 3; i++) {
        const data = (receivedOnB[i + 3] as Record<string, unknown>).data as Record<
          string,
          unknown
        >;
        const delta = data.delta as Record<string, unknown>;
        const content = delta.content as Record<string, unknown>;
        expect(content.text).toBe(`post-local-${i}`);
      }

      subA?.unsubscribe();
      subB?.unsubscribe();
      await replicaA.destroy();
      await replicaB.destroy();
    });

    test('should deliver buffered events locally AND publish live events cross-replica', async () => {
      const replicaA = new GenerationJobManagerClass();
      const servicesA = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      replicaA.configure(servicesA);
      replicaA.initialize();

      const streamId = `cross-buf-live-${Date.now()}`;
      await replicaA.createJob(streamId, 'user-1');

      await replicaA.emitChunk(streamId, {
        created: true,
        message: { text: 'hello' },
        streamId,
      } as CreatedEvent);

      const receivedOnA: unknown[] = [];
      const subA = await replicaA.subscribe(streamId, (event: unknown) => receivedOnA.push(event));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedOnA.length).toBe(1);
      expect((receivedOnA[0] as Record<string, unknown>).created).toBe(true);

      const replicaB = new GenerationJobManagerClass();
      const servicesB = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      replicaB.configure(servicesB);
      replicaB.initialize();

      const receivedOnB: unknown[] = [];
      const subB = await replicaB.subscribe(streamId, (event: unknown) => receivedOnB.push(event));

      await new Promise((resolve) => setTimeout(resolve, 100));

      for (let i = 0; i < 3; i++) {
        await replicaA.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            delta: { content: { type: 'text', text: `word${i} ` } },
            index: i,
          },
        });
      }

      /** B joined after A published seq 0, so B's reorder buffer force-flushes after REORDER_TIMEOUT_MS (500ms) */
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(receivedOnA.length).toBe(4);
      expect(receivedOnB.length).toBe(4);
      expect((receivedOnB[0] as CreatedEvent).created).toBe(true);

      subA?.unsubscribe();
      subB?.unsubscribe();
      await replicaA.destroy();
      await replicaB.destroy();
    });
  });

  describeRedis('Concurrent Subscriber Readiness (Redis)', () => {
    test('should return ready promise to all concurrent subscribers for same stream', async () => {
      const subscriber = (
        ioredisClient as unknown as { duplicate: () => typeof ioredisClient }
      ).duplicate()!;
      const transport = new RedisEventTransport(ioredisClient as never, subscriber as never);

      const streamId = `concurrent-sub-${Date.now()}`;

      const sub1 = transport.subscribe(streamId, {
        onChunk: () => {},
        onDone: () => {},
      });
      const sub2 = transport.subscribe(streamId, {
        onChunk: () => {},
        onDone: () => {},
      });

      expect(sub1.ready).toBeDefined();
      expect(sub2.ready).toBeDefined();

      await Promise.all([sub1.ready, sub2.ready]);

      sub1.unsubscribe();
      sub2.unsubscribe();
      transport.destroy();
      subscriber.disconnect();
    });
  });

  describeRedis('Sequence Reset Safety (Redis)', () => {
    test('should not receive stale pre-subscribe events via Redis after sequence reset', async () => {
      const manager = new GenerationJobManagerClass();
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      manager.configure(services);
      manager.initialize();

      const streamId = `seq-stale-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          delta: { content: { type: 'text', text: 'pre-sub-0' } },
          index: 0,
        },
      });
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: {
          delta: { content: { type: 'text', text: 'pre-sub-1' } },
          index: 1,
        },
      });

      const receivedEvents: unknown[] = [];
      const sub = await manager.subscribe(streamId, (event: unknown) => receivedEvents.push(event));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedEvents.length).toBe(2);
      expect(
        ((receivedEvents[0] as Record<string, unknown>).data as Record<string, unknown>).delta,
      ).toBeDefined();

      for (let i = 0; i < 5; i++) {
        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            delta: { content: { type: 'text', text: `post-sub-${i}` } },
            index: i + 2,
          },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(receivedEvents.length).toBe(7);

      const texts = receivedEvents.map(
        (e) =>
          (
            ((e as Record<string, unknown>).data as Record<string, unknown>).delta as Record<
              string,
              unknown
            >
          ).content as Record<string, unknown>,
      );
      expect((texts[0] as Record<string, unknown>).text).toBe('pre-sub-0');
      expect((texts[1] as Record<string, unknown>).text).toBe('pre-sub-1');
      for (let i = 0; i < 5; i++) {
        expect((texts[i + 2] as Record<string, unknown>).text).toBe(`post-sub-${i}`);
      }

      sub?.unsubscribe();
      await manager.destroy();
    });

    test('should not reset sequence when second subscriber joins mid-stream', async () => {
      const manager = new GenerationJobManagerClass();
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      manager.configure({ ...services, cleanupOnComplete: false });
      manager.initialize();

      const streamId = `seq-2nd-sub-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const eventsA: unknown[] = [];
      const subA = await manager.subscribe(streamId, (event: unknown) => eventsA.push(event));

      await new Promise((resolve) => setTimeout(resolve, 50));

      for (let i = 0; i < 3; i++) {
        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            delta: { content: { type: 'text', text: `chunk-${i}` } },
            index: i,
          },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(eventsA.length).toBe(3);

      const eventsB: unknown[] = [];
      const subB = await manager.subscribe(streamId, (event: unknown) => eventsB.push(event));

      for (let i = 3; i < 6; i++) {
        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            delta: { content: { type: 'text', text: `chunk-${i}` } },
            index: i,
          },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(eventsA.length).toBe(6);
      expect(eventsB.length).toBe(3);

      for (let i = 0; i < 6; i++) {
        const text = (
          (
            ((eventsA[i] as Record<string, unknown>).data as Record<string, unknown>)
              .delta as Record<string, unknown>
          ).content as Record<string, unknown>
        ).text;
        expect(text).toBe(`chunk-${i}`);
      }

      subA?.unsubscribe();
      subB?.unsubscribe();
      await manager.destroy();
    });
  });

  describeRedis('Subscribe Error Recovery (Redis)', () => {
    test('should allow resubscription after Redis subscribe failure', async () => {
      const subscriber = (
        ioredisClient as unknown as { duplicate: () => typeof ioredisClient }
      ).duplicate()!;

      const realSubscribe = subscriber.subscribe.bind(subscriber);
      let callCount = 0;
      subscriber.subscribe = ((...args: Parameters<typeof subscriber.subscribe>) => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Simulated Redis SUBSCRIBE failure'));
        }
        return realSubscribe(...args);
      }) as typeof subscriber.subscribe;

      const transport = new RedisEventTransport(ioredisClient as never, subscriber as never);

      const streamId = `err-retry-${Date.now()}`;

      const sub1 = transport.subscribe(streamId, {
        onChunk: () => {},
        onDone: () => {},
      });

      await expect(sub1.ready).rejects.toThrow('Simulated Redis SUBSCRIBE failure');

      const receivedEvents: unknown[] = [];
      sub1.unsubscribe();

      const sub2 = transport.subscribe(streamId, {
        onChunk: (event: unknown) => receivedEvents.push(event),
        onDone: () => {},
      });

      expect(sub2.ready).toBeDefined();
      await sub2.ready;
      expect(callCount).toBe(2);

      await transport.emitChunk(streamId, {
        event: 'test',
        data: { value: 'hello' },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedEvents.length).toBe(1);

      sub2.unsubscribe();
      transport.destroy();
      subscriber.disconnect();
    });
  });

  describe('createStreamServices Auto-Detection', () => {
    testRedis('should use Redis when useRedis is true and client is available', () => {
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      expect(services.isRedis).toBe(true);
      services.eventTransport.destroy();
    });

    test('should fall back to in-memory when useRedis is false', () => {
      const services = createStreamServices({ useRedis: false });

      expect(services.isRedis).toBe(false);
    });

    test('should allow forcing in-memory via config override', async () => {
      const services = createStreamServices({ useRedis: false });

      expect(services.isRedis).toBe(false);
    });
  });

  /**
   * The production topology for interrupt & steer: the steer POST is routed to
   * whichever replica the load balancer picks, which is usually NOT the replica
   * running the generation. Everything else in the preempt suite runs against a
   * single manager, so the hop that actually carries the request — non-owner
   * publishes, owner arms, owner's SDK poll flips — has no coverage.
   *
   * Two `GenerationJobManagerClass` instances are a faithful pair of replicas
   * here: `runtimeState` and `ownedJobs` are private instance fields, there is
   * no module-level mutable state between them, and `createStreamServices`
   * duplicates a dedicated subscriber connection per call. Separate OS
   * processes would exercise the same objects over the same Redis.
   */
  describeRedis('Cross-Replica Runtime Signals (Redis, multiple manager instances)', () => {
    const replicas: GenerationJobManagerClass[] = [];

    function createReplica(redisSubscriber?: Redis | Cluster): GenerationJobManagerClass {
      const manager = new GenerationJobManagerClass();
      manager.configure(
        createStreamServices({
          useRedis: true,
          redisClient: ioredisClient!,
          redisSubscriber,
        }),
      );
      manager.initialize();
      replicas.push(manager);
      return manager;
    }

    afterEach(async () => {
      /** `destroy()`, not `eventTransport.destroy()`: it also clears the
       *  manager's cleanup interval and disposes the job store and its timer.
       *  Dropping only the transport leaves each manager alive inside its own
       *  interval closure, still doing cleanup work against a dead transport. */
      for (const manager of replicas.splice(0)) {
        await manager.destroy().catch(() => {});
      }
    });

    /**
     * Redis pub/sub never replays and the owner's `SUBSCRIBE` is fired
     * detached, so a one-shot publish can be dropped simply for arriving
     * before anyone is listening — a fixed sleep only decides how often that
     * happens on a loaded worker. Republishing until the owner's state
     * converges is safe because both operations are idempotent set writes
     * keyed by steerId, and it removes the timing assumption entirely.
     */
    async function publishUntil(
      publish: () => Promise<unknown>,
      settled: () => boolean,
      what: string,
      timeoutMs = 15000,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await publish();
        for (let attempt = 0; attempt < 10; attempt++) {
          if (settled()) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      throw new Error(`Timed out waiting for ${what}`);
    }

    test('a replacement waits for the exact generation owner to acknowledge abort', async () => {
      const owner = createReplica();
      const router = createReplica();
      const streamId = `${testPrefix}-replacement-owner-ack-${Date.now()}`;

      const predecessor = await owner.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      const replacement = await router.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });

      expect(predecessor.abortController.signal.aborted).toBe(true);
      expect(replacement.abortController.signal.aborted).toBe(false);
      expect(await router.getJobStore().getJob(streamId)).toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
    }, 40000);

    test('a bystander subscriber cannot acknowledge for a disconnected generation owner', async () => {
      const ownerSubscriber = (ioredisClient as Redis).duplicate();
      const owner = createReplica(ownerSubscriber);
      const bystander = createReplica();
      const router = createReplica();
      const streamId = `${testPrefix}-replacement-bystander-ack-${Date.now()}`;

      const predecessor = await owner.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      const bystanderJob = await bystander.getJob(streamId);
      const bystanderSubscription = await bystander.subscribe(streamId, () => undefined);
      expect(bystanderJob?.createdAt).toBe(predecessor.createdAt);
      expect(bystanderSubscription).not.toBeNull();

      ownerSubscriber.disconnect();

      await expect(
        router.createJob(streamId, 'user-1', streamId, {
          initialMetadata: { generationProtocolVersion: 2 },
        }),
      ).rejects.toThrow('predecessor handoff could not be confirmed');

      expect(predecessor.abortController.signal.aborted).toBe(false);
      expect(bystanderJob?.abortController.signal.aborted).toBe(true);
      expect(await router.getJobStore().getJob(streamId)).toMatchObject({
        status: 'error',
        error: 'Generation predecessor handoff could not be confirmed',
        replacedJobs: [
          expect.objectContaining({
            createdAt: predecessor.createdAt,
            status: 'running',
          }),
        ],
      });
      bystanderSubscription?.unsubscribe();
    }, 40000);

    test('a steer routed to a non-owning replica arms the owner and flips its poll', async () => {
      const owner = createReplica();
      const router = createReplica();
      const streamId = `${testPrefix}-preempt-xreplica-${Date.now()}`;

      const job = await owner.createJob(streamId, 'user-1', undefined, {
        initialMetadata: { preemptCapable: true },
      });

      /**
       * The routing replica reads the job, which installs a FACADE runtime
       * entry on it. That facade must not make it look like an owner.
       */
      const seenByRouter = await router.getJob(streamId);
      expect(seenByRouter?.createdAt).toBe(job.createdAt);
      expect(router.isPreemptRequested(streamId)).toBe(false);

      /**
       * Guards the round-trip that shipped broken once: `preemptCapable` was
       * serialized but never deserialized, so every Redis deployment read it
       * back as undefined and the feature was a silent no-op. A same-replica
       * read cannot catch that — this one crosses Redis.
       */
      expect(seenByRouter?.metadata?.preemptCapable).toBe(true);

      const enqueued = await router.steering.enqueueVersioned(
        streamId,
        {
          steerId: 'steer-x',
          text: 'interrupt me',
          userId: 'user-1',
          createdAt: Date.now(),
        },
        true,
        job.createdAt,
      );
      if (typeof enqueued === 'number') {
        throw new Error(`Unexpected enqueue rejection: ${enqueued}`);
      }

      /** The whole point: the owner's level-triggered poll flips from a
       *  request that was accepted on a different replica. */
      await publishUntil(
        () =>
          router.requestPreempt(
            streamId,
            enqueued.item.steerId,
            job.createdAt,
            enqueued.item.preemptRevision ?? 0,
          ),
        () => owner.isPreemptRequested(streamId),
        'the owner to arm',
      );
      expect(owner.getArmedPreemptIds(streamId)).toContain('steer-x');

      expect(await router.steering.cancel(streamId, 'steer-x', job.createdAt)).toBe(true);
      await publishUntil(
        () => router.noteSteersRemoved(streamId, ['steer-x'], job.createdAt),
        () => !owner.isPreemptRequested(streamId),
        'the owner to disarm',
      );
      expect(owner.getArmedPreemptIds(streamId)).not.toContain('steer-x');
    }, 40000);

    /**
     * The in-memory store fences this in TypeScript; Redis fences it inside
     * STEER_ENQUEUE_LUA, which only a real server can execute. That Lua path
     * is where the `preemptCapable` P1 hid, so it gets its own coverage.
     */
    test('the enqueue Lua refuses an item fenced to a replaced generation', async () => {
      const owner = createReplica();
      const streamId = `${testPrefix}-enqueue-fenced-${Date.now()}`;

      const first = await owner.createJob(streamId, 'user-1');
      const replacement = await owner.createJob(streamId, 'user-1');
      expect(replacement.createdAt).not.toBe(first.createdAt);

      const stale = await owner.steering.enqueue(
        streamId,
        {
          steerId: 'steer-stale-epoch',
          text: 'belongs to the previous run',
          userId: 'user-1',
          createdAt: Date.now(),
        },
        first.createdAt,
      );
      expect(stale).toBe(STEER_ENQUEUE_NOT_RUNNING);
      expect(await owner.steering.peek(streamId)).toEqual([]);

      const live = await owner.steering.enqueue(
        streamId,
        {
          steerId: 'steer-live-epoch',
          text: 'belongs to the live run',
          userId: 'user-1',
          createdAt: Date.now(),
        },
        replacement.createdAt,
      );
      expect(live).toBe(1);
    }, 30000);

    /**
     * Redis parks leftover steers inside its terminal-transition Lua, which
     * projects each item field by field — so a field added to SteerQueueItem
     * is silently dropped there unless the projection is updated too. A steer
     * recovered from `/chat/status` would come back without its interrupting
     * label even though every non-Redis path preserves it.
     */
    test('the terminal-transition Lua keeps preempt on parked steers', async () => {
      const owner = createReplica();
      const streamId = `${testPrefix}-park-preempt-${Date.now()}`;

      const job = await owner.createJob(streamId, 'user-1');
      await owner.steering.enqueue(
        streamId,
        {
          steerId: 'steer-parked-preempt',
          text: 'interrupt me',
          userId: 'user-1',
          createdAt: Date.now(),
          preempt: true,
        },
        job.createdAt,
      );

      const store = new RedisJobStore(ioredisClient!);
      const moved = await store.transitionStatus(streamId, {
        from: 'running',
        to: 'complete',
      });
      expect(moved).toBe(true);

      const claimed = await store.claimParkedSteers(streamId, 'user-1');
      expect(claimed).toBeDefined();
      const parked = JSON.parse(claimed as string) as {
        steers: Array<{ steerId: string; preempt?: boolean }>;
      };
      expect(parked.steers).toHaveLength(1);
      expect(parked.steers[0].steerId).toBe('steer-parked-preempt');
      expect(parked.steers[0].preempt).toBe(true);
    }, 30000);

    test('a stale generation id from another replica cannot arm the live job', async () => {
      const owner = createReplica();
      const router = createReplica();
      const streamId = `${testPrefix}-preempt-xreplica-stale-${Date.now()}`;

      const job = await owner.createJob(streamId, 'user-1', undefined, {
        initialMetadata: { preemptCapable: true },
      });

      const enqueuePreempt = async (steerId: string) => {
        const enqueued = await router.steering.enqueueVersioned(
          streamId,
          {
            steerId,
            text: steerId,
            userId: 'user-1',
            createdAt: Date.now(),
          },
          true,
          job.createdAt,
        );
        if (typeof enqueued === 'number') {
          throw new Error(`Unexpected enqueue rejection for ${steerId}: ${enqueued}`);
        }
        return enqueued.item;
      };
      const controlBefore = await enqueuePreempt('control-before');
      const stale = await enqueuePreempt('steer-stale');
      const controlAfter = await enqueuePreempt('control-after');

      /**
       * A negative assertion cannot be established by waiting: an undelivered
       * stale arm and a fenced one look identical. So bracket it between two
       * control arms on the same channel. The first proves the owner is
       * listening BEFORE the stale one is published, and the second — sent
       * after it, over the same publisher connection, so Redis orders it
       * behind — proves the stale arm has already had its chance to land.
       */
      await publishUntil(
        () =>
          router.requestPreempt(
            streamId,
            controlBefore.steerId,
            job.createdAt,
            controlBefore.preemptRevision ?? 0,
          ),
        () => owner.getArmedPreemptIds(streamId).includes('control-before'),
        'the first control arm',
      );

      await router.requestPreempt(
        streamId,
        stale.steerId,
        job.createdAt - 1,
        stale.preemptRevision ?? 0,
      );

      await publishUntil(
        () =>
          router.requestPreempt(
            streamId,
            controlAfter.steerId,
            job.createdAt,
            controlAfter.preemptRevision ?? 0,
          ),
        () => owner.getArmedPreemptIds(streamId).includes('control-after'),
        'the second control arm',
      );

      expect(owner.getArmedPreemptIds(streamId)).not.toContain('steer-stale');
    }, 40000);
  });
});
