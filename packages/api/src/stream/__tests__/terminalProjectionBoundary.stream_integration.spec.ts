/* eslint jest/no-standalone-expect: ["error", { "additionalTestBlockFunctions": ["testRedis"] }] */
/* eslint jest/expect-expect: ["error", { "assertFunctionNames": ["expect", "expectSafeTerminalEvent"] }] */
import type { Redis, Cluster } from 'ioredis';
import type { FinalEvent, ServerSentEvent } from '~/types';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { RedisEventTransport } from '~/stream/implementations/RedisEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { RedisJobStore } from '~/stream/implementations/RedisJobStore';
import { createIoRedisSubscriber } from '~/cache/redisUtils';
import { clearRedisTestPrefix } from './helpers/redis';

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

const TRANSIENT_BODY = 'D'.repeat(64 * 1024);
const ANSWER = 'The report concludes that latency improved.';
/** Generated attachment body: authoritative output, must survive projection. */
const GENERATED_OUTPUT = 'row,value\n1,42\n';

/**
 * A terminal event as a controller would hand it over WITHOUT caller-level
 * sanitization. Passing the unsanitized shape is the negative control for
 * "caller allowlists are enough": every assertion below then proves the
 * manager boundary itself excludes the transient data.
 */
function buildUnsanitizedFinal(): FinalEvent {
  return {
    final: true,
    terminalStatus: 'complete',
    conversation: { conversationId: 'conv-1', title: 'Report' },
    title: 'Report',
    requestMessage: {
      messageId: 'um-1',
      conversationId: 'conv-1',
      text: 'Summarize the attachment',
      isCreatedByUser: true,
      fileContext: TRANSIENT_BODY,
      image_urls: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TRANSIENT_BODY}` } },
      ],
      files: [
        {
          file_id: 'f-1',
          filename: 'report.pdf',
          filepath: '/uploads/report.pdf',
          text: TRANSIENT_BODY,
        },
      ],
    },
    responseMessage: {
      messageId: 'rm-1',
      parentMessageId: 'um-1',
      conversationId: 'conv-1',
      content: [{ type: 'text', text: ANSWER }],
      attachments: [
        { file_id: 'a-1', filename: 'out.csv', text: GENERATED_OUTPUT, status: 'ready' },
      ],
    },
  };
}

/** `FinalMessageFields` carries an index signature, so nested collections read
 * back as `unknown`; these keep the assertions readable without `any`. */
const entries = (value: unknown): Array<Record<string, unknown>> =>
  (value ?? []) as Array<Record<string, unknown>>;
const filesOf = (message: unknown): Array<Record<string, unknown>> =>
  entries((message as { files?: unknown } | null | undefined)?.files);
const attachmentsOf = (message: unknown): Array<Record<string, unknown>> =>
  entries((message as { attachments?: unknown } | null | undefined)?.attachments);

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Every assertion a safe terminal representation must satisfy. */
function expectSafeTerminalEvent(event: unknown): void {
  const final = event as FinalEvent;
  expect(final.requestMessage).not.toHaveProperty('fileContext');
  expect(final.requestMessage).not.toHaveProperty('image_urls');
  expect(filesOf(final.requestMessage)[0]).not.toHaveProperty('text');

  // authoritative final state and attachment references survive
  expect(final.requestMessage?.text).toBe('Summarize the attachment');
  expect(filesOf(final.requestMessage)[0]).toMatchObject({
    file_id: 'f-1',
    filename: 'report.pdf',
    filepath: '/uploads/report.pdf',
  });
  /** Generated output survives: excluding it would blank the inline preview with
   * no recovery path, since preview polling only runs while status is pending. */
  expect(attachmentsOf(final.responseMessage)[0]).toMatchObject({
    file_id: 'a-1',
    filename: 'out.csv',
    text: GENERATED_OUTPUT,
    status: 'ready',
  });
  expect((final.responseMessage?.content as Array<{ text: string }>)[0]?.text).toBe(ANSWER);

  // the excluded bodies are nowhere in the serialized representation
  expect(JSON.stringify(final)).not.toContain(TRANSIENT_BODY);
}

describe('terminal projection boundary', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  const testPrefix = 'Terminal-Projection-Test';
  const redisConfigured = process.env.USE_REDIS === 'true';
  const describeRedis = redisConfigured ? describe : describe.skip;

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = testPrefix;
    process.env.REDIS_PING_INTERVAL = '0';
    jest.resetModules();
    const redisModule = await import('~/cache/redisClients');
    ioredisClient = redisModule.ioredisClient;
  });

  afterAll(async () => {
    process.env = originalEnv;
  });

  afterEach(async () => {
    if (ioredisClient) {
      await clearRedisTestPrefix(ioredisClient, testPrefix).catch(() => undefined);
    }
  });

  describe('in-memory mode preserves the same external contract', () => {
    let manager: GenerationJobManagerClass;
    let jobStore: InMemoryJobStore;

    beforeEach(() => {
      jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
      manager = new GenerationJobManagerClass();
      manager.configure({ jobStore, eventTransport: new InMemoryEventTransport(), isRedis: false });
      manager.initialize();
    });

    afterEach(async () => {
      await manager.destroy();
    });

    it('excludes transient data from publishTerminalClaim storage, publication and cache', async () => {
      const streamId = `inmem-claim-${Date.now()}`;
      const job = await manager.createJob(streamId, 'user-1');
      const claim = await manager.claimTerminalJob(streamId, 'complete', undefined, job.createdAt, {
        persistencePending: true,
      });

      const input = buildUnsanitizedFinal();
      const result = await manager.publishTerminalClaim(claim!, input);

      expectSafeTerminalEvent(result.finalEvent);
      expect(result.persistenceFailed).toBe(false);

      const stored = await jobStore.getJob(streamId);
      expect(stored?.finalEvent).toBeDefined();
      expectSafeTerminalEvent(JSON.parse(stored!.finalEvent!));

      // the caller's own object is untouched
      expect(input.requestMessage).toHaveProperty('fileContext');
      expect(input.requestMessage).toHaveProperty('image_urls');
    });

    it('excludes transient data from emitDone storage and publication', async () => {
      const streamId = `inmem-emitdone-${Date.now()}`;
      await manager.createJob(streamId, 'user-1');

      await manager.emitDone(streamId, buildUnsanitizedFinal());

      const stored = await jobStore.getJob(streamId);
      expectSafeTerminalEvent(JSON.parse(stored!.finalEvent!));
    });
  });

  describeRedis('Redis mode', () => {
    let manager: GenerationJobManagerClass;
    let jobStore: RedisJobStore;
    let eventTransport: RedisEventTransport;
    let subscriber: Redis | Cluster;

    beforeEach(async () => {
      jobStore = new RedisJobStore(ioredisClient!, { runningTtl: 60 });
      await jobStore.initialize();
      subscriber = createIoRedisSubscriber(ioredisClient!, 'terminal-projection-sub');
      eventTransport = new RedisEventTransport(ioredisClient!, subscriber);
      manager = new GenerationJobManagerClass();
      manager.configure({ jobStore, eventTransport, isRedis: true });
      manager.initialize();
    });

    afterEach(async () => {
      await manager.destroy();
      await subscriber.quit().catch(() => undefined);
    });

    it('excludes transient data from the Redis job hash and the published frame', async () => {
      const streamId = `redis-claim-${Date.now()}`;
      const job = await manager.createJob(streamId, 'user-1');
      const claim = await manager.claimTerminalJob(streamId, 'complete', undefined, job.createdAt, {
        persistencePending: true,
      });

      const published: ServerSentEvent[] = [];
      const originalEmitDone = eventTransport.emitDone.bind(eventTransport);
      jest
        .spyOn(eventTransport, 'emitDone')
        .mockImplementation(async (id: string, event: unknown, generationId?: number) => {
          published.push(event as ServerSentEvent);
          return originalEmitDone(id, event as ServerSentEvent, generationId);
        });

      const result = await manager.publishTerminalClaim(claim!, buildUnsanitizedFinal());

      expect(result.persistenceFailed).toBe(false);
      expectSafeTerminalEvent(result.finalEvent);

      // durable record actually written to Redis
      const stored = await jobStore.getJob(streamId);
      expectSafeTerminalEvent(JSON.parse(stored!.finalEvent!));

      // the frame handed to the transport for Pub/Sub publication
      expect(published).toHaveLength(1);
      expectSafeTerminalEvent(published[0]);
    });

    it('does not scale the durable terminal record with excluded bodies', async () => {
      const sizes: number[] = [];
      for (const bodyChars of [1_000, 256 * 1024]) {
        const streamId = `redis-scale-${bodyChars}-${Date.now()}`;
        const job = await manager.createJob(streamId, 'user-1');
        const claim = await manager.claimTerminalJob(
          streamId,
          'complete',
          undefined,
          job.createdAt,
          { persistencePending: true },
        );
        const body = 'D'.repeat(bodyChars);
        await manager.publishTerminalClaim(claim!, {
          final: true,
          requestMessage: {
            messageId: 'um-1',
            text: 'q',
            fileContext: body,
            files: [{ file_id: 'f-1', filename: 'a.pdf', text: body }],
          },
          responseMessage: { messageId: 'rm-1', content: [{ type: 'text', text: ANSWER }] },
        } as FinalEvent);
        const stored = await jobStore.getJob(streamId);
        sizes.push(Buffer.byteLength(stored!.finalEvent!, 'utf8'));
      }

      expect(sizes[1]).toBe(sizes[0]);
    });

    /**
     * Mixed deployment, live path: an old generation owner publishes an
     * unprojected FINAL over Pub/Sub while a NEW replica is already subscribed.
     * Nothing is read from the job store here, so only the subscriber's own
     * delivery choke point can exclude the prompt inputs before they are cached
     * on its runtime and forwarded to the browser.
     */
    it('projects a live terminal frame published by an older replica', async () => {
      const streamId = `redis-live-legacy-${Date.now()}`;
      const job = await manager.createJob(streamId, 'user-1');

      const delivered: ServerSentEvent[] = [];
      const subscription = await manager.subscribe(
        streamId,
        () => undefined,
        (event: ServerSentEvent) => {
          delivered.push(event);
        },
      );
      expect(subscription).not.toBeNull();

      /** An old replica's transport emit: straight to Pub/Sub, unprojected, with
       * no durable finalEvent written for the subscriber to read instead. */
      const legacyTransport = new RedisEventTransport(ioredisClient!, subscriber);
      await legacyTransport.emitDone(streamId, buildUnsanitizedFinal(), job.createdAt);

      await waitFor(() => delivered.length > 0, 'live terminal delivery');

      expect(delivered).toHaveLength(1);
      expectSafeTerminalEvent(delivered[0]);

      /** It must not be cached unprojected either: a later late-subscriber read
       * of this runtime would otherwise re-deliver the oversized frame. */
      const runtime = (
        manager as unknown as { runtimeState: Map<string, { finalEvent?: unknown }> }
      ).runtimeState.get(streamId);
      expect(runtime?.finalEvent).toBeDefined();
      expectSafeTerminalEvent(runtime!.finalEvent);

      subscription!.unsubscribe();
    });

    /**
     * Mixed deployment: the durable record was written by a replica that
     * predates projection, and a different replica replays it. The reader has
     * no local runtime, so it must project what it parses out of Redis instead
     * of re-delivering the stored payload unchanged.
     */
    it('projects a legacy unprojected record when another replica replays it', async () => {
      const streamId = `redis-legacy-${Date.now()}`;
      const job = await manager.createJob(streamId, 'user-1');
      const claim = await manager.claimTerminalJob(streamId, 'complete', undefined, job.createdAt, {
        persistencePending: true,
      });
      await manager.publishTerminalClaim(claim!, { final: true } as FinalEvent);

      /** Overwrite with the shape an older producer stored. */
      await jobStore.updateJob(
        streamId,
        { finalEvent: JSON.stringify(buildUnsanitizedFinal()) },
        job.createdAt,
      );
      const rawStored = await jobStore.getJob(streamId);
      expect(rawStored!.finalEvent).toContain(TRANSIENT_BODY);

      const replicaStore = new RedisJobStore(ioredisClient!, { runningTtl: 60 });
      await replicaStore.initialize();
      const replicaSubscriber = createIoRedisSubscriber(ioredisClient!, 'terminal-projection-b');
      const replicaTransport = new RedisEventTransport(ioredisClient!, replicaSubscriber);
      const replica = new GenerationJobManagerClass();
      replica.configure({
        jobStore: replicaStore,
        eventTransport: replicaTransport,
        isRedis: true,
      });
      replica.initialize();

      try {
        const delivered: ServerSentEvent[] = [];
        const subscription = await replica.subscribe(
          streamId,
          () => undefined,
          (event: ServerSentEvent) => {
            delivered.push(event);
          },
        );
        expect(subscription).not.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 250));

        expect(delivered).toHaveLength(1);
        expectSafeTerminalEvent(delivered[0]);
        subscription!.unsubscribe();
      } finally {
        await replica.destroy();
        await replicaSubscriber.quit().catch(() => undefined);
      }
    });

    describe('persistence-success bookkeeping', () => {
      it('reports success for a normally projected and persisted FINAL', async () => {
        const streamId = `redis-ok-${Date.now()}`;
        const job = await manager.createJob(streamId, 'user-1');
        const claim = await manager.claimTerminalJob(
          streamId,
          'complete',
          undefined,
          job.createdAt,
          { persistencePending: true },
        );

        const result = await manager.publishTerminalClaim(claim!, buildUnsanitizedFinal());

        expect(result.persistenceFailed).toBe(false);
        expect((result.finalEvent as FinalEvent).reconcile).toBeUndefined();
      });

      it('reports failure when the caller publishes conservative reconciliation', async () => {
        const streamId = `redis-null-${Date.now()}`;
        const job = await manager.createJob(streamId, 'user-1');
        const claim = await manager.claimTerminalJob(
          streamId,
          'complete',
          undefined,
          job.createdAt,
          { persistencePending: true },
        );

        const result = await manager.publishTerminalClaim(claim!, null);

        expect(result.persistenceFailed).toBe(true);
        expect((result.finalEvent as FinalEvent).reconcile).toBe(true);
      });

      it('reports failure when durable finalization fails', async () => {
        const streamId = `redis-nodurable-${Date.now()}`;
        const job = await manager.createJob(streamId, 'user-1');
        const claim = await manager.claimTerminalJob(
          streamId,
          'complete',
          undefined,
          job.createdAt,
          { persistencePending: true },
        );
        jest
          .spyOn(jobStore, 'finalizeTerminalPersistence')
          .mockRejectedValue(new Error('redis unavailable'));

        const result = await manager.publishTerminalClaim(claim!, buildUnsanitizedFinal());

        expect(result.persistenceFailed).toBe(true);
        expect((result.finalEvent as FinalEvent).reconcile).toBe(true);
      });
    });
  });
});
