import { logger } from '@librechat/data-schemas';
import type { Redis, Cluster } from 'ioredis';
import { createMockPublisher } from './helpers/publisher';

logger.silent = true;

/**
 * Integration tests for RedisEventTransport.
 *
 * Tests Redis Pub/Sub functionality:
 * - Cross-instance event delivery
 * - Subscriber management
 * - Error handling
 *
 * Run with: USE_REDIS=true npx jest RedisEventTransport.stream_integration
 */
describe('RedisEventTransport Integration Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  const testPrefix = 'EventTransport-Integration-Test';

  beforeAll(async () => {
    originalEnv = { ...process.env };

    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.USE_REDIS_CLUSTER = process.env.USE_REDIS_CLUSTER ?? 'false';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = testPrefix;
    process.env.REDIS_PING_INTERVAL = '0';
    process.env.REDIS_RETRY_MAX_ATTEMPTS = '5';

    jest.resetModules();

    const { ioredisClient: client } = await import('../../cache/redisClients');
    ioredisClient = client;
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

  describe('Pub/Sub Event Delivery', () => {
    test('should deliver events to subscribers on same instance', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      // Create subscriber client (Redis pub/sub requires dedicated connection)
      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `pubsub-same-${Date.now()}`;
      const receivedChunks: unknown[] = [];
      let doneEvent: unknown = null;

      // Subscribe
      const { unsubscribe } = transport.subscribe(streamId, {
        onChunk: (event) => receivedChunks.push(event),
        onDone: (event) => {
          doneEvent = event;
        },
      });

      // Wait for subscription to be established (increased for CI)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Emit events (emitChunk/emitDone are async for ordered delivery)
      await transport.emitChunk(streamId, { type: 'text', text: 'Hello' });
      await transport.emitChunk(streamId, { type: 'text', text: ' World' });
      await transport.emitDone(streamId, { finished: true });

      // Wait for events to propagate (increased for CI)
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(receivedChunks.length).toBe(2);
      expect(doneEvent).toEqual({ finished: true });

      unsubscribe();
      transport.destroy();
      subscriber.disconnect();
    });

    test('should publish a zero-TTL terminal winner without leaking it into a replacement', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);
      const store = new RedisJobStore(ioredisClient, { completedTtl: 0 });
      await store.initialize();

      const streamId = `zero-ttl-terminal-${Date.now()}`;
      const received: unknown[] = [];
      const subscription = transport.subscribe(streamId, {
        onChunk: () => undefined,
        onDone: (event) => received.push(event),
      });
      await subscription.ready;

      let replacementCreatedAt: number | undefined;
      try {
        const terminalJob = await store.createJob(streamId, 'user-1', streamId);
        await expect(
          store.transitionStatus(streamId, {
            from: 'running',
            to: 'aborted',
            expectCreatedAt: terminalJob.createdAt,
            patch: { completedAt: Date.now() },
          }),
        ).resolves.toBe(true);
        await expect(store.getJob(streamId)).resolves.toBeNull();

        const finalEvent = { final: true, aborted: true };
        await transport.emitDone(streamId, finalEvent, terminalJob.createdAt);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(received).toEqual([finalEvent]);

        const regressedClock = jest
          .spyOn(Date, 'now')
          .mockReturnValue(terminalJob.createdAt - 1000);
        const replacement = await (async () => {
          try {
            return await store.createJob(streamId, 'user-1', streamId);
          } finally {
            regressedClock.mockRestore();
          }
        })();
        replacementCreatedAt = replacement.createdAt;
        expect(replacement.createdAt).toBe(terminalJob.createdAt + 1);

        // A live replacement must reject the predecessor's delayed terminal event.
        await expect(
          transport.emitDone(streamId, { final: true, stale: true }, terminalJob.createdAt),
        ).rejects.toThrow('fenced by a replacement');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(received).toEqual([finalEvent]);

        // The latest epoch marker survives zero-TTL finalization. It still rejects
        // the predecessor after the replacement hash itself has disappeared.
        await expect(
          store.transitionStatus(streamId, {
            from: 'running',
            to: 'aborted',
            expectCreatedAt: replacement.createdAt,
            patch: { completedAt: Date.now() },
          }),
        ).resolves.toBe(true);
        await expect(store.getJob(streamId)).resolves.toBeNull();
        await expect(
          transport.emitDone(
            streamId,
            { final: true, staleAfterReplacement: true },
            terminalJob.createdAt,
          ),
        ).rejects.toThrow('fenced by a replacement');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(received).toEqual([finalEvent]);

        const replacementFinalEvent = { final: true, replacement: true };
        await transport.emitDone(streamId, replacementFinalEvent, replacement.createdAt);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(received).toEqual([finalEvent, replacementFinalEvent]);
      } finally {
        if (replacementCreatedAt != null) {
          await store.deleteJob(streamId, replacementCreatedAt);
        }
        await ioredisClient.del(`stream:{${streamId}}:generation-epoch`);
        subscription.unsubscribe();
        await store.destroy();
        transport.destroy();
        subscriber.disconnect();
      }
    });

    test('should publish the latest generation error after stale-job reaping removes its hash', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `reaped-generation-${Date.now()}`;
      let resolveError!: (value: { error: string; generationId?: number }) => void;
      const receivedError = new Promise<{ error: string; generationId?: number }>((resolve) => {
        resolveError = resolve;
      });
      const subscription = transport.subscribe(streamId, {
        onChunk: () => undefined,
        onError: (error, generationId) => resolveError({ error, generationId }),
      });
      await subscription.ready;

      try {
        const job = await store.createJob(streamId, 'user-1', streamId);
        const generationEpochKey = `stream:{${streamId}}:generation-epoch`;
        await ioredisClient.del(generationEpochKey);
        await expect(ioredisClient.get(generationEpochKey)).resolves.toBeNull();
        await store.updateJob(streamId, { lastActiveAt: Date.now() - 61_000 }, job.createdAt);

        await expect(store.cleanup()).resolves.toBeGreaterThanOrEqual(1);
        await expect(store.getJob(streamId)).resolves.toBeNull();
        await expect(ioredisClient.get(generationEpochKey)).resolves.toBe(String(job.createdAt));

        await transport.emitError(streamId, 'Generation timed out', job.createdAt);
        await expect(receivedError).resolves.toEqual({
          error: 'Generation timed out',
          generationId: job.createdAt,
        });
      } finally {
        await ioredisClient.del(`stream:{${streamId}}:generation-epoch`);
        subscription.unsubscribe();
        await store.destroy();
        transport.destroy();
        subscriber.disconnect();
      }
    });

    test('should atomically contain legacy terminal claims when both job and epoch have expired', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const claimBeforeCreateId = `legacy-claim-first-${Date.now()}`;
      const createBeforeClaimId = `legacy-create-first-${Date.now()}`;
      const competingClaimsId = `legacy-competing-${Date.now()}`;
      const claimedEvents: string[] = [];
      const createFirstEvents: string[] = [];
      const competingEvents: string[] = [];
      const subscriptions = [
        transport.subscribe(claimBeforeCreateId, {
          onChunk: () => undefined,
          onError: (error) => claimedEvents.push(error),
        }),
        transport.subscribe(createBeforeClaimId, {
          onChunk: () => undefined,
          onError: (error) => createFirstEvents.push(error),
        }),
        transport.subscribe(competingClaimsId, {
          onChunk: () => undefined,
          onError: (error) => competingEvents.push(error),
        }),
      ];
      await Promise.all(subscriptions.map((subscription) => subscription.ready));

      try {
        // Natural expiry of a pre-deploy job leaves neither hash nor epoch. Its
        // terminal event claims the empty marker, then replacement creation must
        // allocate above the claimed epoch even if the local clock regresses.
        const claimFirstLegacy = await store.createJob(
          claimBeforeCreateId,
          'user-1',
          claimBeforeCreateId,
        );
        await ioredisClient.del(
          `stream:{${claimBeforeCreateId}}:job`,
          `stream:{${claimBeforeCreateId}}:generation-epoch`,
        );
        await transport.emitError(
          claimBeforeCreateId,
          'legacy claim won',
          claimFirstLegacy.createdAt,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(claimedEvents).toEqual(['legacy claim won']);
        await expect(
          ioredisClient.get(`stream:{${claimBeforeCreateId}}:generation-epoch`),
        ).resolves.toBe(String(claimFirstLegacy.createdAt));

        const regressedClock = jest
          .spyOn(Date, 'now')
          .mockReturnValue(claimFirstLegacy.createdAt - 1000);
        const claimedReplacement = await (async () => {
          try {
            return await store.createJob(claimBeforeCreateId, 'user-1', claimBeforeCreateId);
          } finally {
            regressedClock.mockRestore();
          }
        })();
        expect(claimedReplacement.createdAt).toBe(claimFirstLegacy.createdAt + 1);
        await expect(
          transport.emitError(
            claimBeforeCreateId,
            'stale after replacement',
            claimFirstLegacy.createdAt,
          ),
        ).rejects.toThrow('fenced by a replacement');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(claimedEvents).toEqual(['legacy claim won']);

        // If replacement creation wins the Redis serialization order, its live
        // hash rejects the legacy terminal before the fallback can claim.
        const createFirstLegacy = await store.createJob(
          createBeforeClaimId,
          'user-1',
          createBeforeClaimId,
        );
        await ioredisClient.del(
          `stream:{${createBeforeClaimId}}:job`,
          `stream:{${createBeforeClaimId}}:generation-epoch`,
        );
        const forwardClock = jest
          .spyOn(Date, 'now')
          .mockReturnValue(createFirstLegacy.createdAt + 1000);
        const createFirstReplacement = await (async () => {
          try {
            return await store.createJob(createBeforeClaimId, 'user-1', createBeforeClaimId);
          } finally {
            forwardClock.mockRestore();
          }
        })();
        expect(createFirstReplacement.createdAt).toBe(createFirstLegacy.createdAt + 1000);
        await expect(
          transport.emitError(
            createBeforeClaimId,
            'legacy claim lost',
            createFirstLegacy.createdAt,
          ),
        ).rejects.toThrow('fenced by a replacement');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(createFirstEvents).toEqual([]);

        // With two unknowable pre-marker epochs and no live hash, Redis ordering
        // gives the marker to the first claimant and rejects the differing second.
        await transport.emitError(competingClaimsId, 'first claimant', 100);
        await expect(
          transport.emitError(competingClaimsId, 'second claimant', 200),
        ).rejects.toThrow('fenced by a replacement');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(competingEvents).toEqual(['first claimant']);
        await expect(
          ioredisClient.get(`stream:{${competingClaimsId}}:generation-epoch`),
        ).resolves.toBe('100');
      } finally {
        for (const streamId of [claimBeforeCreateId, createBeforeClaimId, competingClaimsId]) {
          await store.deleteJob(streamId);
        }
        await store.cleanup();
        await Promise.all(
          [claimBeforeCreateId, createBeforeClaimId, competingClaimsId].map((streamId) =>
            ioredisClient!.del(`stream:{${streamId}}:generation-epoch`),
          ),
        );
        for (const subscription of subscriptions) {
          subscription.unsubscribe();
        }
        await store.destroy();
        transport.destroy();
        subscriber.disconnect();
      }
    });

    test('should deliver events across transport instances (simulating different servers)', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      // Create two separate transport instances (simulating two servers)
      const subscriber1 = (ioredisClient as Redis).duplicate();
      const subscriber2 = (ioredisClient as Redis).duplicate();

      const transport1 = new RedisEventTransport(ioredisClient, subscriber1);
      const transport2 = new RedisEventTransport(ioredisClient, subscriber2);

      const streamId = `pubsub-cross-${Date.now()}`;

      const instance2Chunks: unknown[] = [];

      // Subscribe on transport 2 (consumer)
      const sub2 = transport2.subscribe(streamId, {
        onChunk: (event) => instance2Chunks.push(event),
      });

      // Wait for subscription
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Emit from transport 1 (producer on different instance)
      await transport1.emitChunk(streamId, { data: 'from-instance-1' });

      // Wait for cross-instance delivery
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Transport 2 should receive the event
      expect(instance2Chunks.length).toBe(1);
      expect(instance2Chunks[0]).toEqual({ data: 'from-instance-1' });

      sub2.unsubscribe();
      transport1.destroy();
      transport2.destroy();
      subscriber1.disconnect();
      subscriber2.disconnect();
    });

    test('should handle multiple subscribers to same stream', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `pubsub-multi-${Date.now()}`;

      const subscriber1Chunks: unknown[] = [];
      const subscriber2Chunks: unknown[] = [];

      // Two subscribers
      const sub1 = transport.subscribe(streamId, {
        onChunk: (event) => subscriber1Chunks.push(event),
      });

      const sub2 = transport.subscribe(streamId, {
        onChunk: (event) => subscriber2Chunks.push(event),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      await transport.emitChunk(streamId, { data: 'broadcast' });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Both should receive
      expect(subscriber1Chunks.length).toBe(1);
      expect(subscriber2Chunks.length).toBe(1);

      sub1.unsubscribe();
      sub2.unsubscribe();
      transport.destroy();
      subscriber.disconnect();
    });
  });

  describe('Payload fidelity through server-side seq splicing', () => {
    /** The seq is spliced into the payload by Lua rather than encoded with it, so the
     *  fragments either side must reassemble to exactly what JSON.stringify would emit.
     *  Shapes here are the ones a naive cjson round-trip would corrupt. */
    test('should round-trip payload shapes that cjson would coerce', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `payload-fidelity-${Date.now()}`;
      const received: unknown[] = [];

      transport.subscribe(streamId, {
        onChunk: (event) => received.push(event),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const payloads: unknown[] = [
        { empty: [], nestedEmpty: { inner: [] } },
        { float: 0.1234567890123, negative: -273.15, zero: 0 },
        { unicode: 'héllo 🌍 "quoted" \\ backslash\n newline' },
        { nullish: null, emptyString: '', emptyObject: {} },
        { text: 'ordinary delta' },
      ];

      for (const payload of payloads) {
        await transport.emitChunk(streamId, payload);
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(received).toEqual(payloads);

      transport.destroy();
      subscriber.disconnect();
    });

    test('should assign 0-indexed sequences and refresh a shortened counter TTL', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `seq-alloc-${Date.now()}`;
      /** Bare key: the client applies REDIS_KEY_PREFIX itself, and ioredis prefixes EVAL keys
       *  the same way, so both sides land on the same prefixed key. */
      const seqKey = `stream:{${streamId}}:seq`;

      transport.subscribe(streamId, { onChunk: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 100));

      await transport.emitChunk(streamId, { index: 0 });
      /** First INCR arms the safety TTL. */
      const ttlAfterFirst = await (ioredisClient as Redis).ttl(seqKey);
      expect(ttlAfterFirst).toBeGreaterThan(0);

      // Simulate a nearly-expired counter. The next publish must restore the
      // safety window so a live generation cannot reset to sequence zero.
      await (ioredisClient as Redis).expire(seqKey, 2);
      await transport.emitChunk(streamId, { index: 1 });
      expect(await (ioredisClient as Redis).ttl(seqKey)).toBeGreaterThan(86_000);

      for (let i = 2; i < 5; i++) {
        await transport.emitChunk(streamId, { index: i });
      }

      /** Counter is 1-based in Redis; seq is 0-based, so 5 emits => counter 5, last seq 4. */
      expect(await (ioredisClient as Redis).get(seqKey)).toBe('5');
      expect(await (ioredisClient as Redis).ttl(seqKey)).toBeGreaterThanOrEqual(ttlAfterFirst - 1);

      transport.destroy();
      subscriber.disconnect();
    });

    test('mock atomic publish refreshes a shortened counter TTL', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };
      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );
      const streamId = 'mock-sequence-ttl-refresh';
      const sequenceKey = `stream:{${streamId}}:seq`;

      await transport.emitChunk(streamId, { index: 0 });
      expect(await mockPublisher.ttl(sequenceKey)).toBe(86_400);

      await mockPublisher.expire(sequenceKey, 2);
      await transport.emitChunk(streamId, { index: 1 });

      expect(await mockPublisher.ttl(sequenceKey)).toBe(86_400);
      transport.destroy();
    });
  });

  describe('Sequential Event Ordering', () => {
    test('should maintain strict order when emitChunk is awaited', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `order-test-${Date.now()}`;
      const receivedEvents: number[] = [];

      transport.subscribe(streamId, {
        onChunk: (event) => receivedEvents.push((event as { index: number }).index),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Emit 20 events rapidly with await - they should arrive in order
      for (let i = 0; i < 20; i++) {
        await transport.emitChunk(streamId, { index: i });
      }

      // Wait for all events to propagate
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify all events arrived in correct order
      expect(receivedEvents.length).toBe(20);
      for (let i = 0; i < 20; i++) {
        expect(receivedEvents[i]).toBe(i);
      }

      transport.destroy();
      subscriber.disconnect();
    });

    test('should maintain order for tool call delta chunks (simulates streaming args)', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `tool-delta-order-${Date.now()}`;
      const receivedArgs: string[] = [];

      transport.subscribe(streamId, {
        onChunk: (event) => {
          const data = event as {
            event: string;
            data: { delta: { tool_calls: { args: string }[] } };
          };
          if (data.event === 'on_run_step_delta') {
            receivedArgs.push(data.data.delta.tool_calls[0].args);
          }
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Simulate streaming tool call arguments like: {"code": "# First line\n..."
      const argChunks = ['{"code"', ': "', '# First', ' line', '\\n', '..."', '}'];

      for (const chunk of argChunks) {
        await transport.emitChunk(streamId, {
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

      // Verify chunks arrived in correct order - this was the bug we fixed
      expect(receivedArgs).toEqual(argChunks);
      expect(receivedArgs.join('')).toBe('{"code": "# First line\\n..."}');

      transport.destroy();
      subscriber.disconnect();
    });

    test('should maintain order across multiple concurrent streams (no cross-contamination)', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId1 = `concurrent-stream-1-${Date.now()}`;
      const streamId2 = `concurrent-stream-2-${Date.now()}`;

      const stream1Events: number[] = [];
      const stream2Events: number[] = [];

      transport.subscribe(streamId1, {
        onChunk: (event) => stream1Events.push((event as { index: number }).index),
      });
      transport.subscribe(streamId2, {
        onChunk: (event) => stream2Events.push((event as { index: number }).index),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Interleave events from both streams
      for (let i = 0; i < 10; i++) {
        await transport.emitChunk(streamId1, { index: i });
        await transport.emitChunk(streamId2, { index: i * 10 });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Each stream should have its own ordered events
      expect(stream1Events).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(stream2Events).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);

      transport.destroy();
      subscriber.disconnect();
    });
  });

  describe('Reorder Buffer (Redis Cluster Fix)', () => {
    test('should reorder out-of-sequence messages', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = 'reorder-test';
      const receivedEvents: number[] = [];

      transport.subscribe(streamId, {
        onChunk: (event) => receivedEvents.push((event as { index: number }).index),
      });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;

      const channel = `stream:{${streamId}}:events`;

      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 0, data: { index: 0 } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 2, data: { index: 2 } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 1, data: { index: 1 } }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedEvents).toEqual([0, 1, 2]);

      transport.destroy();
    });

    test('should buffer early messages and deliver when gaps are filled', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = 'buffer-test';
      const receivedEvents: number[] = [];

      transport.subscribe(streamId, {
        onChunk: (event) => receivedEvents.push((event as { index: number }).index),
      });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;

      const channel = `stream:{${streamId}}:events`;

      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 2, data: { index: 2 } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 4, data: { index: 4 } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 3, data: { index: 3 } }));

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receivedEvents).toEqual([]);

      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 0, data: { index: 0 } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 1, data: { index: 1 } }));

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receivedEvents).toEqual([0, 1, 2, 3, 4]);

      transport.destroy();
    });

    test('should force-flush on timeout when gaps are not filled', async () => {
      jest.useFakeTimers();

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = 'timeout-test';
      const receivedEvents: number[] = [];

      transport.subscribe(streamId, {
        onChunk: (event) => receivedEvents.push((event as { index: number }).index),
      });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;

      const channel = `stream:{${streamId}}:events`;

      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 2, data: { index: 2 } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 3, data: { index: 3 } }));

      expect(receivedEvents).toEqual([]);

      jest.advanceTimersByTime(600);

      expect(receivedEvents).toEqual([2, 3]);

      transport.destroy();
      jest.useRealTimers();
    });

    test('should handle messages without sequence numbers (backward compatibility)', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = 'compat-test';
      const receivedEvents: string[] = [];

      transport.subscribe(streamId, {
        onChunk: (event) => receivedEvents.push((event as { msg: string }).msg),
        onDone: (event) => receivedEvents.push(`done:${(event as { msg: string }).msg}`),
      });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;

      const channel = `stream:{${streamId}}:events`;

      messageHandler(channel, JSON.stringify({ type: 'chunk', data: { msg: 'no-seq-1' } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', data: { msg: 'no-seq-2' } }));
      messageHandler(channel, JSON.stringify({ type: 'done', data: { msg: 'finished' } }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedEvents).toEqual(['no-seq-1', 'no-seq-2', 'done:finished']);

      transport.destroy();
    });

    test('should deliver done event after all pending chunks (terminal event ordering)', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      const mockSubscriber = {
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      };

      const transport = new RedisEventTransport(mockPublisher as never, mockSubscriber as never);
      const streamId = `terminal-order-${Date.now()}`;

      const receivedEvents: string[] = [];
      let doneReceived = false;

      transport.subscribe(streamId, {
        onChunk: (event: unknown) => {
          const e = event as { msg?: string };
          receivedEvents.push(e.msg ?? 'unknown');
        },
        onDone: (event: unknown) => {
          const e = event as { msg?: string };
          receivedEvents.push(`done:${e.msg ?? 'finished'}`);
          doneReceived = true;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1];
      expect(messageHandler).toBeDefined();

      const channel = `stream:{${streamId}}:events`;

      // Simulate out-of-order delivery in Redis Cluster:
      // Done event (seq=3) arrives before chunk seq=2
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 0, data: { msg: 'chunk-0' } }));
      messageHandler(channel, JSON.stringify({ type: 'done', seq: 3, data: { msg: 'complete' } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 2, data: { msg: 'chunk-2' } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 1, data: { msg: 'chunk-1' } }));

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Done event should be delivered AFTER all chunks despite arriving early
      expect(doneReceived).toBe(true);
      expect(receivedEvents).toEqual(['chunk-0', 'chunk-1', 'chunk-2', 'done:complete']);

      transport.destroy();
    });

    test('should deliver error event after all pending chunks (terminal event ordering)', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      const mockSubscriber = {
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      };

      const transport = new RedisEventTransport(mockPublisher as never, mockSubscriber as never);
      const streamId = `terminal-error-${Date.now()}`;

      const receivedEvents: string[] = [];
      let errorReceived: string | undefined;

      transport.subscribe(streamId, {
        onChunk: (event: unknown) => {
          const e = event as { msg?: string };
          receivedEvents.push(e.msg ?? 'unknown');
        },
        onError: (error: string) => {
          receivedEvents.push(`error:${error}`);
          errorReceived = error;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1];
      expect(messageHandler).toBeDefined();

      const channel = `stream:{${streamId}}:events`;

      // Simulate out-of-order delivery: error arrives before final chunks
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 0, data: { msg: 'chunk-0' } }));
      messageHandler(channel, JSON.stringify({ type: 'error', seq: 2, error: 'Something failed' }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 1, data: { msg: 'chunk-1' } }));

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Error event should be delivered AFTER all preceding chunks
      expect(errorReceived).toBe('Something failed');
      expect(receivedEvents).toEqual(['chunk-0', 'chunk-1', 'error:Something failed']);

      transport.destroy();
    });
  });

  describe('Subscriber Management', () => {
    test('should track first subscriber correctly', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `first-sub-${Date.now()}`;

      // Before any subscribers - count is 0, not "first" since no one subscribed
      expect(transport.getSubscriberCount(streamId)).toBe(0);

      // First subscriber
      const sub1 = transport.subscribe(streamId, { onChunk: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now there's a subscriber - isFirstSubscriber returns true when count is 1
      expect(transport.getSubscriberCount(streamId)).toBe(1);
      expect(transport.isFirstSubscriber(streamId)).toBe(true);

      // Second subscriber - not first anymore
      const sub2temp = transport.subscribe(streamId, { onChunk: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(transport.isFirstSubscriber(streamId)).toBe(false);
      sub2temp.unsubscribe();

      const sub2 = transport.subscribe(streamId, { onChunk: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(transport.getSubscriberCount(streamId)).toBe(2);

      sub1.unsubscribe();
      sub2.unsubscribe();
      transport.destroy();
      subscriber.disconnect();
    });

    test('should fire onAllSubscribersLeft when last subscriber leaves', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `all-left-${Date.now()}`;
      let allLeftCalled = false;

      transport.onAllSubscribersLeft(streamId, () => {
        allLeftCalled = true;
      });

      const sub1 = transport.subscribe(streamId, { onChunk: () => {} });
      const sub2 = transport.subscribe(streamId, { onChunk: () => {} });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Unsubscribe first
      sub1.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Still have one subscriber
      expect(allLeftCalled).toBe(false);

      // Unsubscribe last
      sub2.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now all left
      expect(allLeftCalled).toBe(true);

      transport.destroy();
      subscriber.disconnect();
    });
  });

  describe('Error Handling', () => {
    test('should deliver error events to subscribers', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `error-${Date.now()}`;
      let receivedError: string | null = null;

      transport.subscribe(streamId, {
        onChunk: () => {},
        onError: (err) => {
          receivedError = err;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      await transport.emitError(streamId, 'Test error message');

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(receivedError).toBe('Test error message');

      transport.destroy();
      subscriber.disconnect();
    });
  });

  describe('Cross-Replica Abort', () => {
    test('should emit and receive abort signals on same instance', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `abort-same-${Date.now()}`;
      let abortReceived = false;

      // Register abort callback
      transport.onAbort(streamId, () => {
        abortReceived = true;
      });

      // Wait for subscription to be established
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Emit abort
      transport.emitAbort(streamId);

      // Wait for signal to propagate
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(abortReceived).toBe(true);

      transport.destroy();
      subscriber.disconnect();
    });

    test('should deliver abort signals across transport instances', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      // Two separate instances (simulating two servers)
      const subscriber1 = (ioredisClient as Redis).duplicate();
      const subscriber2 = (ioredisClient as Redis).duplicate();

      const transport1 = new RedisEventTransport(ioredisClient, subscriber1);
      const transport2 = new RedisEventTransport(ioredisClient, subscriber2);

      const streamId = `abort-cross-${Date.now()}`;
      let instance1AbortReceived = false;

      // Instance 1 registers abort callback (simulates server running generation)
      transport1.onAbort(streamId, () => {
        instance1AbortReceived = true;
      });

      // Wait for subscription
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Instance 2 emits abort (simulates server receiving abort request)
      transport2.emitAbort(streamId);

      // Wait for cross-instance delivery
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Instance 1 should receive abort signal
      expect(instance1AbortReceived).toBe(true);

      transport1.destroy();
      transport2.destroy();
      subscriber1.disconnect();
      subscriber2.disconnect();
    });

    test('should deliver a remote abort after the last SSE subscriber disconnects', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber1 = (ioredisClient as Redis).duplicate();
      const subscriber2 = (ioredisClient as Redis).duplicate();
      const transport1 = new RedisEventTransport(ioredisClient, subscriber1);
      const transport2 = new RedisEventTransport(ioredisClient, subscriber2);
      const streamId = `abort-after-disconnect-${Date.now()}`;
      let remoteAbortReceived = false;
      let signalAbortReceived: (() => void) | undefined;
      const abortReceived = new Promise<void>((resolve) => {
        signalAbortReceived = resolve;
      });
      let abortTimeout: ReturnType<typeof setTimeout> | undefined;

      try {
        await transport1.onAbort(streamId, () => {
          remoteAbortReceived = true;
          signalAbortReceived?.();
        });
        const sseSubscription = transport1.subscribe(streamId, { onChunk: () => undefined });
        await sseSubscription.ready;
        sseSubscription.unsubscribe();

        transport2.emitAbort(streamId);

        await Promise.race([
          abortReceived,
          new Promise<never>((_, reject) => {
            abortTimeout = setTimeout(
              () => reject(new Error('Timed out waiting for remote abort')),
              2000,
            );
          }),
        ]);
        expect(remoteAbortReceived).toBe(true);
      } finally {
        clearTimeout(abortTimeout);
        transport1.cleanup(streamId);
        transport1.destroy();
        transport2.destroy();
        subscriber1.disconnect();
        subscriber2.disconnect();
      }
    });

    test('should replace a disposed abort listener without stale cleanup detaching it', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber1 = (ioredisClient as Redis).duplicate();
      const subscriber2 = (ioredisClient as Redis).duplicate();
      const transport1 = new RedisEventTransport(ioredisClient, subscriber1);
      const transport2 = new RedisEventTransport(ioredisClient, subscriber2);
      const streamId = `abort-listener-reuse-${Date.now()}`;
      let predecessorCalled = false;
      let resolveReplacement!: () => void;
      const replacementCalled = new Promise<void>((resolve) => {
        resolveReplacement = resolve;
      });
      let abortTimeout: ReturnType<typeof setTimeout> | undefined;

      try {
        const disposePredecessor = await transport1.onAbort(streamId, () => {
          predecessorCalled = true;
        });
        disposePredecessor();

        const disposeReplacement = await transport1.onAbort(streamId, () => {
          resolveReplacement();
        });
        disposePredecessor();
        transport2.emitAbort(streamId);

        await Promise.race([
          replacementCalled,
          new Promise<never>((_, reject) => {
            abortTimeout = setTimeout(
              () => reject(new Error('Timed out waiting for replacement abort listener')),
              2000,
            );
          }),
        ]);

        expect(predecessorCalled).toBe(false);
        disposeReplacement();
      } finally {
        clearTimeout(abortTimeout);
        transport1.destroy();
        transport2.destroy();
        subscriber1.disconnect();
        subscriber2.disconnect();
      }
    });

    test('should call multiple abort callbacks', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `abort-multi-${Date.now()}`;
      let callback1Called = false;
      let callback2Called = false;

      // Multiple abort callbacks
      transport.onAbort(streamId, () => {
        callback1Called = true;
      });
      transport.onAbort(streamId, () => {
        callback2Called = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      transport.emitAbort(streamId);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(callback1Called).toBe(true);
      expect(callback2Called).toBe(true);

      transport.destroy();
      subscriber.disconnect();
    });

    test('should cleanup abort callbacks on stream cleanup', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `abort-cleanup-${Date.now()}`;
      let abortReceived = false;

      transport.onAbort(streamId, () => {
        abortReceived = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Cleanup the stream
      transport.cleanup(streamId);

      // Emit abort after cleanup
      transport.emitAbort(streamId);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should NOT receive abort since stream was cleaned up
      expect(abortReceived).toBe(false);

      transport.destroy();
      subscriber.disconnect();
    });
  });

  /**
   * Cross-Replica Sequence Synchronization (#12575)
   *
   * The core cross-replica sync logic (atomic sequence allocation, first-observed
   * attachment baseline, and same-replica replay frontier) is verified by:
   * - Unit tests with mock publishers (deterministic, no cluster timing)
   * - GenerationJobManager integration tests (end-to-end with earlyEventBuffer)
   * - The race-condition unit test (delayed subscriber dispatch after publish)
   *
   * Transport-level integration tests with two real Redis transports are
   * inherently flaky in Redis Cluster: cluster pub/sub fan-out is async
   * across nodes, so a PUBLISH acknowledged on node A can arrive at the
   * subscriber on node B after a subsequent SUBSCRIBE takes effect,
   * causing non-deterministic message counts.
   */
  describe('Cross-Replica Sequence Synchronization (#12575)', () => {
    test('shared counter survives local stream cleanup', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `cross-replica-cleanup-${Date.now()}`;

      // Publish chunks to create the Redis counter key
      for (let i = 0; i < 5; i++) {
        await transport.emitChunk(streamId, { index: i });
      }

      // Verify the key exists
      const key = `stream:{${streamId}}:seq`;
      const valBefore = await ioredisClient.get(key);
      expect(valBefore).toBe('5');

      // Cleanup only this transport's local subscriber state. The Redis counter is
      // shared by every replica and by later generations that reuse this stream ID.
      transport.cleanup(streamId);

      const valAfter = await ioredisClient.get(key);
      expect(valAfter).toBe('5');
      expect(await ioredisClient.ttl(key)).toBeGreaterThan(0);

      transport.destroy();
      subscriber.disconnect();
    });
  });

  describe('Cleanup', () => {
    test('should clean up stream resources', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `cleanup-${Date.now()}`;

      transport.subscribe(streamId, { onChunk: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(transport.getSubscriberCount(streamId)).toBe(1);

      // Cleanup the stream
      transport.cleanup(streamId);

      // Subscriber count should be 0
      expect(transport.getSubscriberCount(streamId)).toBe(0);

      transport.destroy();
      subscriber.disconnect();
    });
  });

  describe('Publish Error Propagation', () => {
    test('should swallow emitChunk publish errors (callers fire-and-forget)', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const { emitChunkWithReceipt } = await import('../internal/chunkPublication');

      const mockPublisher = createMockPublisher();
      mockPublisher.publish.mockRejectedValue(new Error('Redis connection lost'));
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = `error-prop-chunk-${Date.now()}`;

      // Public callers retain Promise<void>; the internal manager capability receives failure
      // without creating an unhandled rejection.
      await expect(transport.emitChunk(streamId, { data: 'test' })).resolves.toBeUndefined();
      await expect(
        emitChunkWithReceipt(transport, streamId, { data: 'test' }),
      ).resolves.toBeUndefined();

      transport.destroy();
    });

    test('should swallow emitChunk incr errors (sequence allocation failure)', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const { emitChunkWithReceipt } = await import('../internal/chunkPublication');

      const mockPublisher = createMockPublisher();
      mockPublisher.incr.mockRejectedValue(new Error('INCR failed'));
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = `error-prop-incr-${Date.now()}`;

      await expect(transport.emitChunk(streamId, { data: 'test' })).resolves.toBeUndefined();
      await expect(
        emitChunkWithReceipt(transport, streamId, { data: 'test' }),
      ).resolves.toBeUndefined();
      expect(mockPublisher.publish).not.toHaveBeenCalled();

      transport.destroy();
    });

    test('should throw when emitDone publish fails', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      mockPublisher.publish.mockRejectedValue(new Error('Redis connection lost'));
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = `error-prop-done-${Date.now()}`;

      await expect(transport.emitDone(streamId, { finished: true })).rejects.toThrow(
        'Redis connection lost',
      );

      transport.destroy();
    });

    test('should throw when emitError publish fails', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      mockPublisher.publish.mockRejectedValue(new Error('Redis connection lost'));
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = `error-prop-error-${Date.now()}`;

      await expect(transport.emitError(streamId, 'some error')).rejects.toThrow(
        'Redis connection lost',
      );

      transport.destroy();
    });

    test('should propagate when emitDone incr fails', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      mockPublisher.incr.mockRejectedValue(new Error('INCR failed'));
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = `error-prop-done-incr-${Date.now()}`;

      await expect(transport.emitDone(streamId, { finished: true })).rejects.toThrow('INCR failed');

      transport.destroy();
    });

    test('should propagate when emitError incr fails', async () => {
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const mockPublisher = createMockPublisher();
      mockPublisher.incr.mockRejectedValue(new Error('INCR failed'));
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };

      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );

      const streamId = `error-prop-error-incr-${Date.now()}`;

      await expect(transport.emitError(streamId, 'some error')).rejects.toThrow('INCR failed');

      transport.destroy();
    });

    test('should still deliver events successfully when publish succeeds', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber = (ioredisClient as Redis).duplicate();
      const transport = new RedisEventTransport(ioredisClient, subscriber);

      const streamId = `error-prop-success-${Date.now()}`;
      const receivedChunks: unknown[] = [];
      let doneEvent: unknown = null;

      transport.subscribe(streamId, {
        onChunk: (event) => receivedChunks.push(event),
        onDone: (event) => {
          doneEvent = event;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // These should NOT throw
      await transport.emitChunk(streamId, { text: 'hello' });
      await transport.emitDone(streamId, { finished: true });

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(receivedChunks.length).toBe(1);
      expect(doneEvent).toEqual({ finished: true });

      transport.destroy();
      subscriber.disconnect();
    });
  });

  describe('Cross-Replica Preempt Delivery', () => {
    test('delivers a fenced arm/clear payload across instances', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber1 = (ioredisClient as Redis).duplicate();
      const subscriber2 = (ioredisClient as Redis).duplicate();
      const transport1 = new RedisEventTransport(ioredisClient, subscriber1);
      const transport2 = new RedisEventTransport(ioredisClient, subscriber2);
      const streamId = `preempt-cross-${Date.now()}`;
      const received: Array<{ op: string; createdAt: number; steerIds: string[] }> = [];

      try {
        await transport1.onPreempt(streamId, (msg) => {
          received.push(msg);
        });

        transport2.emitPreempt(streamId, {
          op: 'arm',
          createdAt: 1234,
          steerIds: ['steer-a', 'steer-b'],
        });
        transport2.emitPreempt(streamId, { op: 'clear', createdAt: 1234, steerIds: ['steer-a'] });

        await new Promise((resolve) => setTimeout(resolve, 300));

        /**
         * Payload fidelity and delivery, NOT ordering: two publishes from the
         * same replica carry no cross-message ordering guarantee to a
         * subscriber, which is exactly why the receiving side tombstones
         * cleared ids rather than assuming arm-before-clear. Asserting order
         * here would test something stronger than the protocol promises.
         */
        expect(received).toHaveLength(2);
        expect(received).toContainEqual({
          op: 'arm',
          createdAt: 1234,
          steerIds: ['steer-a', 'steer-b'],
        });
        expect(received).toContainEqual({
          op: 'clear',
          createdAt: 1234,
          steerIds: ['steer-a'],
        });
      } finally {
        transport1.cleanup(streamId);
        transport1.destroy();
        transport2.destroy();
        subscriber1.disconnect();
        subscriber2.disconnect();
      }
    });

    test('unsubscribe removes only this registration and keeps the channel for a replacement', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');

      const subscriber1 = (ioredisClient as Redis).duplicate();
      const subscriber2 = (ioredisClient as Redis).duplicate();
      const transport1 = new RedisEventTransport(ioredisClient, subscriber1);
      const transport2 = new RedisEventTransport(ioredisClient, subscriber2);
      const streamId = `preempt-unsub-${Date.now()}`;
      const oldGeneration: string[] = [];
      const newGeneration: string[] = [];

      try {
        const unsubscribeOld = await transport1.onPreempt(streamId, (msg) => {
          oldGeneration.push(...msg.steerIds);
        });
        await transport1.onPreempt(streamId, (msg) => {
          newGeneration.push(...msg.steerIds);
        });

        unsubscribeOld();
        transport2.emitPreempt(streamId, { op: 'arm', createdAt: 99, steerIds: ['steer-live'] });

        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(oldGeneration).toEqual([]);
        expect(newGeneration).toEqual(['steer-live']);
      } finally {
        transport1.cleanup(streamId);
        transport1.destroy();
        transport2.destroy();
        subscriber1.disconnect();
        subscriber2.disconnect();
      }
    });
  });
});
