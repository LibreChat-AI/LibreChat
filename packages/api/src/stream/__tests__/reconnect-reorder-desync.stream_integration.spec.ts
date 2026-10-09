import { logger } from '@librechat/data-schemas';
import type { Redis, Cluster } from 'ioredis';
import {
  ioredisClient as staticRedisClient,
  keyvRedisClient as staticKeyvClient,
  keyvRedisClientReady,
} from '~/cache/redisClients';
import { RedisEventTransport } from '~/stream/implementations/RedisEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createStreamServices } from '~/stream/createStreamServices';
import { createMockPublisher } from './helpers/publisher';

logger.silent = true;

/**
 * Regression tests for the reconnect reorder buffer desync bug.
 *
 * Bug: When a user disconnects and reconnects to a stream multiple times,
 * the second+ reconnect lost chunks because the transport deleted stream state
 * on last unsubscribe, destroying the allSubscribersLeftCallbacks registered
 * by createJob(). This prevented hasSubscriber from being reset, which in turn
 * prevented syncReorderBuffer from being called on reconnect.
 *
 * Fix: Preserve stream state (callbacks, abort handlers) across reconnect cycles
 * instead of deleting it. The state is fully cleaned up by cleanup() when the
 * job completes.
 *
 * A second failure mode reused the conversation-scoped stream after one replica
 * deleted its shared sequence counter. A subscriber still attached elsewhere kept
 * the old nextSeq and rejected the new turn's restarted sequence as duplicates.
 * Local cleanup now preserves the shared counter until its bounded Redis TTL expires.
 *
 * Run with: USE_REDIS=true npx jest reconnect-reorder-desync
 */
describe('Reconnect Reorder Buffer Desync (Regression)', () => {
  describe('Callback preservation across reconnect cycles (Unit)', () => {
    test('allSubscribersLeft callback fires on every disconnect, not just the first', () => {
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

      const streamId = 'callback-persist-test';
      let callbackFireCount = 0;

      // Register callback (simulates what createJob does)
      transport.onAllSubscribersLeft(streamId, () => {
        callbackFireCount++;
      });

      // First subscribe/unsubscribe cycle
      const sub1 = transport.subscribe(streamId, { onChunk: () => {} });
      sub1.unsubscribe();

      expect(callbackFireCount).toBe(1);

      // Second subscribe/unsubscribe cycle — callback must still fire
      const sub2 = transport.subscribe(streamId, { onChunk: () => {} });
      sub2.unsubscribe();

      expect(callbackFireCount).toBe(2);

      // Third cycle — continues to work
      const sub3 = transport.subscribe(streamId, { onChunk: () => {} });
      sub3.unsubscribe();

      expect(callbackFireCount).toBe(3);

      transport.destroy();
    });

    test('abort callback survives across reconnect cycles', () => {
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

      const streamId = 'abort-callback-persist-test';
      let abortCallbackFired = false;

      // Register abort callback (simulates what createJob does)
      transport.onAbort(streamId, () => {
        abortCallbackFired = true;
      });

      // Subscribe/unsubscribe cycle
      const sub1 = transport.subscribe(streamId, { onChunk: () => {} });
      sub1.unsubscribe();

      // Re-subscribe and receive an abort signal
      const sub2 = transport.subscribe(streamId, { onChunk: () => {} });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;

      const channel = `stream:{${streamId}}:events`;
      messageHandler(channel, JSON.stringify({ type: 'abort' }));

      // Abort callback should fire — it was preserved across the reconnect
      expect(abortCallbackFired).toBe(true);

      sub2.unsubscribe();
      transport.destroy();
    });

    test('stale unsubscribe cannot detach a replacement stream state', () => {
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
      const streamId = 'stale-unsubscribe-test';

      const staleSubscription = transport.subscribe(streamId, { onChunk: () => {} });
      transport.cleanup(streamId);
      mockSubscriber.unsubscribe.mockClear();

      const currentSubscription = transport.subscribe(streamId, { onChunk: () => {} });
      staleSubscription.unsubscribe();

      expect(transport.getSubscriberCount(streamId)).toBe(1);
      expect(mockSubscriber.unsubscribe).not.toHaveBeenCalled();

      currentSubscription.unsubscribe();
      transport.destroy();
    });
  });

  describe('First-subscriber replay ordering (Unit)', () => {
    test('does not deliver a buffered event twice while its Redis sequence assignment settles', async () => {
      const mockPublisher = createMockPublisher();
      let resolveSequence!: (sequence: number) => void;
      let markEvalStarted!: () => void;
      const evalStarted = new Promise<void>((resolve) => {
        markEvalStarted = resolve;
      });
      mockPublisher.eval.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            resolveSequence = resolve;
            markEvalStarted();
          }),
      );
      // Redis has already executed INCR + PUBLISH while the command response is in flight.
      mockPublisher.get.mockResolvedValueOnce('1');

      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };
      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: new InMemoryJobStore(),
        eventTransport: transport,
        isRedis: true,
        cleanupOnComplete: false,
      });

      const streamId = 'first-subscriber-publish-race';
      const event = {
        event: 'on_message_delta',
        data: { index: 0 },
      };
      await manager.createJob(streamId, 'user-1');

      const emitPromise = manager.emitChunk(streamId, event);
      await evalStarted;

      const received: unknown[] = [];
      const subscribePromise = manager.subscribe(streamId, (chunk) => received.push(chunk));
      for (
        let attempt = 0;
        attempt < 10 && transport.getSubscriberCount(streamId) === 0;
        attempt++
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(transport.getSubscriberCount(streamId)).toBe(1);

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;
      messageHandler(
        `stream:{${streamId}}:events`,
        JSON.stringify({ type: 'chunk', seq: 0, data: event }),
      );
      const deliveredBeforeReplay = received.length;

      resolveSequence(0);
      await Promise.all([emitPromise, subscribePromise]);

      expect(deliveredBeforeReplay).toBe(0);
      expect(received).toEqual([event]);

      await manager.destroy();
    });

    test('a failed Redis sync still releases only events beyond the replay frontier', async () => {
      const mockPublisher = createMockPublisher();
      mockPublisher.get.mockRejectedValueOnce(new Error('GET failed'));
      const mockSubscriber = {
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
      };
      const transport = new RedisEventTransport(
        mockPublisher as unknown as Redis,
        mockSubscriber as unknown as Redis,
      );
      const streamId = 'first-subscriber-sync-failure';
      const chunks: unknown[] = [];
      transport.subscribe(
        streamId,
        {
          onChunk: (event) => chunks.push(event),
        },
        { deferSequenceDelivery: true },
      );

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;
      const channel = `stream:{${streamId}}:events`;
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 0, data: { index: 0 } }));
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 1, data: { index: 1 } }));
      expect(chunks).toEqual([]);

      await expect(transport.syncReorderBuffer(streamId, 1)).rejects.toThrow('GET failed');

      expect(chunks).toEqual([{ index: 1 }]);
      transport.destroy();
    });
  });

  describe('Reorder buffer sync on reconnect (Unit)', () => {
    /**
     * After the fix, the allSubscribersLeft callback fires on every disconnect,
     * which resets hasSubscriber. GenerationJobManager.subscribe() then enters
     * the if (!runtime.hasSubscriber) block and calls syncReorderBuffer.
     *
     * This test verifies at the transport level that when syncReorderBuffer IS
     * called (as it now will be on every reconnect), messages are delivered
     * immediately regardless of how many reconnect cycles have occurred.
     */
    test('syncReorderBuffer works correctly on third+ reconnect', async () => {
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

      const streamId = 'reorder-multi-reconnect-test';

      transport.onAllSubscribersLeft(streamId, () => {
        // Simulates the callback from createJob
      });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;

      const channel = `stream:{${streamId}}:events`;

      // Run 3 full subscribe/emit/unsubscribe cycles
      for (let cycle = 0; cycle < 3; cycle++) {
        const chunks: unknown[] = [];
        const sub = transport.subscribe(streamId, {
          onChunk: (event) => chunks.push(event),
        });

        // Sync reorder buffer (as GenerationJobManager.subscribe does)
        await transport.syncReorderBuffer(streamId);

        const baseSeq = cycle * 10;

        // Emit 10 chunks (advances publisher sequence)
        for (let i = 0; i < 10; i++) {
          await transport.emitChunk(streamId, { index: baseSeq + i });
        }

        // Deliver messages via pub/sub handler
        for (let i = 0; i < 10; i++) {
          messageHandler(
            channel,
            JSON.stringify({ type: 'chunk', seq: baseSeq + i, data: { index: baseSeq + i } }),
          );
        }

        // Messages should be delivered immediately on every cycle
        expect(chunks.length).toBe(10);
        expect(chunks.map((c) => (c as { index: number }).index)).toEqual(
          Array.from({ length: 10 }, (_, i) => baseSeq + i),
        );

        sub.unsubscribe();
      }

      transport.destroy();
    });

    test('reorder buffer works correctly when syncReorderBuffer IS called', async () => {
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

      const streamId = 'reorder-sync-test';

      // Emit 20 chunks to advance publisher sequence
      for (let i = 0; i < 20; i++) {
        await transport.emitChunk(streamId, { index: i });
      }

      // Subscribe and sync the reorder buffer
      const chunks: unknown[] = [];
      const sub = transport.subscribe(streamId, {
        onChunk: (event) => chunks.push(event),
      });

      // This is the critical call - sync nextSeq to match publisher (reads from Redis)
      await transport.syncReorderBuffer(streamId);

      // Deliver messages starting at seq 20
      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;

      const channel = `stream:{${streamId}}:events`;

      for (let i = 20; i < 25; i++) {
        messageHandler(channel, JSON.stringify({ type: 'chunk', seq: i, data: { index: i } }));
      }

      // Messages should be delivered IMMEDIATELY (no 500ms wait)
      // because nextSeq was synced to 20
      expect(chunks.length).toBe(5);
      expect(chunks.map((c) => (c as { index: number }).index)).toEqual([20, 21, 22, 23, 24]);

      sub.unsubscribe();
      transport.destroy();
    });

    test('should not carry nextSeq into a new generation after last unsubscribe', async () => {
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

      const streamId = 'reorder-generation-reuse-test';
      const firstRunChunks: unknown[] = [];

      const firstSub = transport.subscribe(streamId, {
        onChunk: (event) => firstRunChunks.push(event),
      });

      await transport.syncReorderBuffer(streamId);

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;
      const channel = `stream:{${streamId}}:events`;

      for (let i = 0; i < 5; i++) {
        await transport.emitChunk(streamId, { index: i });
        messageHandler(channel, JSON.stringify({ type: 'chunk', seq: i, data: { index: i } }));
      }

      expect(firstRunChunks.map((c) => (c as { index: number }).index)).toEqual([0, 1, 2, 3, 4]);

      firstSub.unsubscribe();

      // Simulate another replica cleaning up the shared Redis sequence key
      // before this replica's local preserved stream state is garbage-collected.
      await mockPublisher.del(`stream:{${streamId}}:seq`);

      const secondRunChunks: unknown[] = [];
      transport.subscribe(streamId, {
        onChunk: (event) => secondRunChunks.push(event),
      });

      await transport.syncReorderBuffer(streamId);

      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 0, data: { index: 0 } }));

      expect(secondRunChunks.map((c) => (c as { index: number }).index)).toEqual([0]);

      transport.destroy();
    });
  });

  describe('syncReorderBuffer race: message arrives during async GET window (Unit)', () => {
    test('stale sync cannot overwrite a replacement stream state', async () => {
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
      const streamId = 'stale-sync-replacement-test';
      transport.subscribe(streamId, { onChunk: () => {} });

      let resolveOldSync!: (value: string | null) => void;
      mockPublisher.get.mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveOldSync = resolve;
          }),
      );
      const oldSync = transport.syncReorderBuffer(streamId);

      transport.cleanup(streamId);
      const replacementChunks: unknown[] = [];
      transport.subscribe(streamId, {
        onChunk: (event) => replacementChunks.push(event),
      });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;
      const channel = `stream:{${streamId}}:events`;
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 0, data: { index: 0 } }));

      // The old GET completes after cleanup with an obsolete high frontier.
      // It must not advance the replacement state from nextSeq=1 to nextSeq=50.
      resolveOldSync('50');
      await oldSync;
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 1, data: { index: 1 } }));

      expect(replacementChunks).toEqual([{ index: 0 }, { index: 1 }]);
      transport.destroy();
    });

    test('should not drop a chunk that lands in pending while GET is in-flight', async () => {
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

      const streamId = 'race-get-window-test';
      const chunks: unknown[] = [];

      // Emit seq 0 so the Redis counter is 1
      await transport.emitChunk(streamId, { index: 0 });

      // Subscribe (nextSeq starts at 0)
      transport.subscribe(streamId, {
        onChunk: (event) => chunks.push(event),
      });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;
      const channel = `stream:{${streamId}}:events`;

      // Pause the GET: intercept with a deferred promise
      let resolveGet!: (val: string | null) => void;
      mockPublisher.get.mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveGet = resolve;
          }),
      );

      const syncPromise = transport.syncReorderBuffer(streamId);

      // While GET is in-flight, the publisher emits seq 1 (INCR → counter=2)
      // and the subscriber receives it via pub/sub → pending[1]
      await transport.emitChunk(streamId, { index: 1 });
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 1, data: { index: 1 } }));

      // Resolve GET with counter=2 (reflects the INCR for seq 1)
      resolveGet('2');
      await syncPromise;

      // seq 1 MUST be delivered — it arrived during the GET window and must not be pruned
      expect(chunks.map((c) => (c as { index: number }).index)).toContain(1);

      // Subsequent chunks must also deliver immediately
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 2, data: { index: 2 } }));
      expect(chunks.map((c) => (c as { index: number }).index)).toContain(2);

      transport.destroy();
    });

    test('same-replica: should not drop a live chunk when INCR advances past the replay frontier during GET', async () => {
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

      const streamId = 'race-same-replica-test';
      const chunks: unknown[] = [];

      // Emit seqs 0–4 (earlyEventBuffer would have held these; counter = 5)
      for (let i = 0; i < 5; i++) {
        await transport.emitChunk(streamId, { index: i });
      }

      // Subscribe (nextSeq starts at 0)
      transport.subscribe(streamId, {
        onChunk: (event) => chunks.push(event),
      });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;
      const channel = `stream:{${streamId}}:events`;

      // Pause the GET
      let resolveGet!: (val: string | null) => void;
      mockPublisher.get.mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveGet = resolve;
          }),
      );

      // Absolute replay frontier is 5 (seqs 0–4 were replayed).
      const syncPromise = transport.syncReorderBuffer(streamId, 5);

      // During GET window: LLM emits seq 5 (INCR → counter=6), subscriber receives it
      await transport.emitChunk(streamId, { index: 5 });
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 5, data: { index: 5 } }));

      // GET returns 6 (counter advanced past seq 5)
      resolveGet('6');
      await syncPromise;

      // seq 5 MUST be delivered — it is at the replay frontier, not below it.
      // With the old boolean pruneStaleEntries, 5 < currentSeq(6) would have pruned it.
      expect(chunks.map((c) => (c as { index: number }).index)).toContain(5);

      // Subsequent chunks deliver normally
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 6, data: { index: 6 } }));
      expect(chunks.map((c) => (c as { index: number }).index)).toContain(6);

      transport.destroy();
    });

    test('same-replica: should not drop chunk whose pub/sub arrives AFTER GET resolves', async () => {
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

      const streamId = 'race-post-get-test';
      const chunks: unknown[] = [];

      // Emit seqs 0–4 (earlyEventBuffer would have held these; counter = 5)
      for (let i = 0; i < 5; i++) {
        await transport.emitChunk(streamId, { index: i });
      }

      transport.subscribe(streamId, {
        onChunk: (event) => chunks.push(event),
      });

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (call) => call[0] === 'message',
      )?.[1] as (channel: string, message: string) => void;
      const channel = `stream:{${streamId}}:events`;

      let resolveGet!: (val: string | null) => void;
      mockPublisher.get.mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveGet = resolve;
          }),
      );

      const syncPromise = transport.syncReorderBuffer(streamId, 5);

      // LLM emits seq 5 during the GET window (INCR → counter=6)
      // but do NOT deliver via messageHandler yet — simulates pub/sub arriving late
      await transport.emitChunk(streamId, { index: 5 });

      // GET resolves with counter=6 while pending is EMPTY (pub/sub hasn't arrived)
      resolveGet('6');
      await syncPromise;

      // Now pub/sub for seq 5 arrives AFTER sync completed
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 5, data: { index: 5 } }));

      // seq 5 must be delivered — nextSeq should have been capped at the replay frontier (5),
      // not advanced to currentSeq (6) which would have dropped it.
      expect(chunks.map((c) => (c as { index: number }).index)).toContain(5);

      transport.destroy();
    });
  });

  describe('End-to-end reconnect with GenerationJobManager (Integration)', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let ioredisClient: Redis | Cluster | null = null;
    let dynamicKeyvClient: unknown = null;
    let dynamicKeyvReady: Promise<unknown> | null = null;
    const testPrefix = 'ReconnectDesync-Test';

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
      jest.resetModules();

      if (ioredisClient) {
        try {
          const keys = await ioredisClient.keys(`${testPrefix}*`);
          const streamKeys = await ioredisClient.keys('stream:*');
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

    /**
     * Verifies that all reconnect cycles deliver chunks immediately —
     * not just the first reconnect.
     */
    test('chunks are delivered immediately on every reconnect cycle', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const manager = new GenerationJobManagerClass();
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      manager.configure(services);
      manager.initialize();

      const streamId = `reconnect-fixed-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      // Run 3 subscribe/emit/unsubscribe cycles
      for (let cycle = 0; cycle < 3; cycle++) {
        const chunks: unknown[] = [];
        const sub = await manager.subscribe(streamId, (event) => chunks.push(event));

        await new Promise((resolve) => setTimeout(resolve, 100));

        // Emit 10 chunks
        for (let i = 0; i < 10; i++) {
          await manager.emitChunk(streamId, {
            event: 'on_message_delta',
            data: {
              delta: { content: { type: 'text', text: `c${cycle}-${i}` } },
              index: cycle * 10 + i,
            },
          });
        }

        // Chunks should arrive within 200ms (well under the 500ms force-flush timeout)
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(chunks.length).toBe(10);

        sub!.unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await manager.destroy();
    });

    /**
     * Verifies that syncSent is correctly reset on every disconnect,
     * proving the onAllSubscribersLeft callback survives reconnect cycles.
     */
    test('onAllSubscribersLeft callback resets state on every disconnect', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const manager = new GenerationJobManagerClass();
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      manager.configure(services);
      manager.initialize();

      const streamId = `callback-persist-integ-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      for (let cycle = 0; cycle < 3; cycle++) {
        const sub = await manager.subscribe(streamId, () => {});
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Mark sync as sent
        manager.markSyncSent(streamId);
        await new Promise((resolve) => setTimeout(resolve, 50));

        let syncSent = await manager.wasSyncSent(streamId);
        expect(syncSent).toBe(true);

        // Disconnect
        sub!.unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Callback should reset syncSent on every disconnect
        syncSent = await manager.wasSyncSent(streamId);
        expect(syncSent).toBe(false);
      }

      await manager.destroy();
    });

    /**
     * Verifies all reconnect cycles deliver chunks immediately with no
     * increasing gap pattern.
     */
    test('no increasing gap pattern across reconnect cycles', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const manager = new GenerationJobManagerClass();
      const services = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });

      manager.configure(services);
      manager.initialize();

      const streamId = `no-gaps-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      const chunksPerCycle = 15;

      for (let cycle = 0; cycle < 4; cycle++) {
        const chunks: unknown[] = [];
        const sub = await manager.subscribe(streamId, (event) => chunks.push(event));
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Emit chunks
        for (let i = 0; i < chunksPerCycle; i++) {
          await manager.emitChunk(streamId, {
            event: 'on_message_delta',
            data: {
              delta: { content: { type: 'text', text: `c${cycle}-${i}` } },
              index: cycle * chunksPerCycle + i,
            },
          });
        }

        // All chunks should arrive within 200ms on every cycle
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(chunks.length).toBe(chunksPerCycle);

        sub!.unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await manager.destroy();
    });

    test('early buffer replay advances to its absolute Redis sequence', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const manager = new GenerationJobManagerClass();
      manager.configure(
        createStreamServices({
          useRedis: true,
          redisClient: ioredisClient,
        }),
      );
      manager.initialize();

      const streamId = `absolute-replay-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      // Redis sequences are conversation-scoped and survive across turns, so a
      // fresh generation's early buffer can hold events whose sequences start
      // well above zero. Seed the shared counter to model that later turn.
      await ioredisClient.set(`stream:{${streamId}}:seq`, '5');

      // These buffered events receive seqs 5 and 6. Replaying two events must
      // therefore advance to seq=7, not to the relative count of 2.
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { index: 0 },
      });
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { index: 1 },
      });

      const resumedEvents: unknown[] = [];
      const resumedSubscription = await manager.subscribe(streamId, (event) => {
        resumedEvents.push(event);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { index: 2 },
      });
      // Must arrive before the 500 ms reorder timeout.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(
        resumedEvents.map((event) => (event as { data: { index: number } }).data.index),
      ).toEqual([0, 1, 2]);

      resumedSubscription?.unsubscribe();
      await manager.destroy();
    });

    /**
     * A producer replica can tear down its local transport after generation 1 while a
     * subscriber on another replica is still attached with nextSeq=10. Since stream IDs
     * are conversation IDs, generation 2 reuses the same Redis ordering namespace. The
     * shared counter must continue at 10 for the new attachment, while generation tags
     * keep the abandoned generation-1 subscriber from receiving generation-2 content.
     */
    test('regenerated turn preserves sequence without leaking to a lingering predecessor subscriber', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }

      const producer = new GenerationJobManagerClass();
      const producerServices = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      producer.configure(producerServices);
      producer.initialize();

      const consumer = new GenerationJobManagerClass();
      const consumerServices = createStreamServices({
        useRedis: true,
        redisClient: ioredisClient,
      });
      consumer.configure(consumerServices);
      consumer.initialize();

      const streamId = `xrep-regen-${Date.now()}`;
      const sequenceKey = `stream:{${streamId}}:seq`;
      await producer.createJob(streamId, 'user-1');

      const firstGeneration: unknown[] = [];
      const lingering = await consumer.subscribe(streamId, (event) => {
        firstGeneration.push(event);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      for (let index = 0; index < 10; index++) {
        await producer.emitChunk(streamId, {
          event: 'on_message_delta',
          data: { generation: 1, index },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        firstGeneration.filter((event) => JSON.stringify(event).includes('"generation":1')),
      ).toHaveLength(10);
      expect(await ioredisClient.get(sequenceKey)).toBe('10');

      await producer.completeJob(streamId);
      producerServices.eventTransport.cleanup(streamId);

      // Local cleanup must not reset a counter that another replica's subscriber
      // still uses as its ordering frontier.
      expect(await ioredisClient.get(sequenceKey)).toBe('10');

      await producer.createJob(streamId, 'user-1');

      // Exercise the normal POST-then-SSE path: generation can emit before its
      // local subscriber attaches, so this event is replayed from earlyEventBuffer.
      // Its Redis sequence is 10, not 0, because the conversation counter survived.
      await producer.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { generation: 2, index: 0 },
      });

      const regenerated: unknown[] = [];
      const secondSubscription = await producer.subscribe(streamId, (event) => {
        regenerated.push(event);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      for (let index = 1; index < 5; index++) {
        await producer.emitChunk(streamId, {
          event: 'on_message_delta',
          data: { generation: 2, index },
        });
      }
      // Live chunks must not wait for the 500 ms reorder-buffer force flush.
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(
        regenerated
          .filter((event) => JSON.stringify(event).includes('"generation":2'))
          .map((event) => (event as { data: { index: number } }).data.index),
      ).toEqual([0, 1, 2, 3, 4]);
      expect(
        firstGeneration
          .filter((event) => JSON.stringify(event).includes('"generation":2'))
          .map((event) => (event as { data: { index: number } }).data.index),
      ).toEqual([]);
      expect(await ioredisClient.get(sequenceKey)).toBe('15');

      lingering?.unsubscribe();
      secondSubscription?.unsubscribe();
      await producer.destroy();
      await consumer.destroy();
    });
  });
});
