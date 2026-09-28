import type { SteerQueueItem } from '../interfaces/IJobStore';
import { clearRedisTestPrefix, createRedisTestClient, type RedisTestClient } from './helpers/redis';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { RedisJobStore } from '../implementations/RedisJobStore';

describe('Redis generation protocol rollout bridge', () => {
  const keyPrefix = `Protocol-Rollout-${process.pid}-${Date.now()}:`;
  let redis: RedisTestClient;
  let store: RedisJobStore;

  beforeAll(async () => {
    redis = createRedisTestClient(keyPrefix);
    await redis.connect();
    store = new RedisJobStore(redis);
    await store.initialize();
  });

  afterEach(async () => {
    await clearRedisTestPrefix(redis, keyPrefix);
  });

  afterAll(async () => {
    await store.destroy();
    await redis.quit();
  });

  test('Redis defaults new jobs to v2 while explicit v1 remains compatible', async () => {
    const current = await store.createJob('redis-protocol-v2', 'user-1');
    const legacy = await store.createJob('redis-protocol-v1', 'user-1', undefined, undefined, {
      generationProtocolVersion: 1,
    });

    expect(legacy.generationProtocolVersion).toBe(1);
    expect(legacy.checkpointNamespace).toBeUndefined();
    expect(current.generationProtocolVersion).toBe(2);
    expect(current.checkpointNamespace).toEqual(expect.any(String));
    expect(current.checkpointNamespace).not.toBe(String(current.createdAt));
    expect((await store.getJob(current.streamId))?.generationProtocolVersion).toBe(2);
  });

  test('same-millisecond cross-owner jobs receive distinct checkpoint scopes', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const first = await store.createJob(
        'redis-same-ms-a',
        'owner-a',
        'shared-conversation',
        'tenant-a',
        { providerExecutionId: 'shared-execution' },
      );
      const second = await store.createJob(
        'redis-same-ms-b',
        'owner-b',
        'shared-conversation',
        'tenant-b',
        { providerExecutionId: 'shared-execution' },
      );

      expect(first.createdAt).toBe(second.createdAt);
      expect(first.checkpointNamespace).not.toBe(second.checkpointNamespace);
      expect(first.checkpointNamespace).toMatch(/^lcg:v2:[0-9a-f]{64}:[0-9a-f-]{36}$/);
      expect(second.checkpointNamespace).toMatch(/^lcg:v2:[0-9a-f]{64}:[0-9a-f-]{36}$/);
    } finally {
      now.mockRestore();
    }
  });

  test('v1 receipt API falls back to a receiptless legacy queue and drain', async () => {
    const job = await store.createJob('redis-protocol-v1-steer', 'user-1', undefined, undefined, {
      generationProtocolVersion: 1,
      preemptCapable: true,
    });
    const item: SteerQueueItem = {
      steerId: 'legacy-steer',
      clientSteerId: 'legacy-client-steer',
      text: 'legacy words',
      userId: 'user-1',
      createdAt: Date.now(),
    };

    const enqueued = await store.enqueueSteerWithReceipt(
      job.streamId,
      item,
      {
        clientSteerId: item.clientSteerId!,
        fingerprint: 'fingerprint',
        userId: 'user-1',
        generationCreatedAt: job.createdAt,
      },
      true,
      job.createdAt,
    );
    expect(enqueued).toMatchObject({ position: 1, item: { steerId: item.steerId } });
    expect(enqueued).not.toHaveProperty('state');
    expect(await store.getSteerReceipt(job.streamId, item.clientSteerId!)).toBeNull();

    const drained = await store.drainSteers(job.streamId, job.createdAt);
    expect(drained).toHaveLength(1);
    expect(await store.peekClaimedSteers(job.streamId, job.createdAt)).toEqual([]);
    expect(
      await store.appendChunk(job.streamId, { event: 'chunk' }, job.createdAt, drained[0]),
    ).toBe(true);
  });

  test('requested v1 destructively downgrades a v2 parked payload', async () => {
    const job = await store.createJob('redis-protocol-park', 'user-1', undefined, undefined, {
      generationProtocolVersion: 2,
    });
    await store.parkSteers(
      job.streamId,
      JSON.stringify({
        userId: 'user-1',
        steers: [{ steerId: 'parked', text: 'parked words', createdAt: Date.now() }],
      }),
      job.createdAt,
    );

    expect(
      (await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 2))
        ?.generationProtocolVersion,
    ).toBe(2);
    expect(
      (await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 2))
        ?.generationProtocolVersion,
    ).toBe(2);

    const legacy = await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 1);
    expect(legacy?.generationProtocolVersion).toBe(1);
    expect(JSON.parse(legacy!.payload)).toMatchObject({ generationProtocolVersion: 1 });
    expect(
      await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 2),
    ).toBeUndefined();
  });

  test('requested v1 preserves a source leased to an active v2 recovery', async () => {
    const streamId = 'redis-protocol-park-active-v2-lease';
    const job = await store.createJob(streamId, 'user-1', undefined, undefined, {
      generationProtocolVersion: 2,
    });
    const leased = { steerId: 'redis-leased-v2', text: 'leased words', createdAt: 1 };
    const legacy = { steerId: 'redis-visible-v1', text: 'legacy words', createdAt: 2 };
    await store.parkSteers(
      streamId,
      JSON.stringify({ userId: 'user-1', steers: [leased, legacy] }),
      job.createdAt,
    );
    const recovery = await store.createJob(
      streamId,
      'user-1',
      undefined,
      undefined,
      { generationProtocolVersion: 2 },
      leased.steerId,
      undefined,
      undefined,
      undefined,
      { text: leased.text, fileIds: [], quotes: [] },
    );

    const downgraded = await store.claimParkedSteersDetailed(streamId, 'user-1', undefined, 1);
    expect(downgraded?.generationProtocolVersion).toBe(1);
    expect(JSON.parse(downgraded!.payload)).toEqual({
      userId: 'user-1',
      generationProtocolVersion: 1,
      steers: [legacy],
    });
    await expect(
      store.claimParkedSteersDetailed(streamId, 'user-1', undefined, 2),
    ).resolves.toBeUndefined();
    await expect(redis.exists(`stream:{${streamId}}:parked`)).resolves.toBe(1);

    await expect(
      store.transitionStatus(streamId, {
        from: 'running',
        to: 'error',
        expectCreatedAt: recovery.createdAt,
        patch: { error: 'recovery failed', completedAt: Date.now() },
      }),
    ).resolves.toBe(true);
    const exposed = await store.claimParkedSteersDetailed(streamId, 'user-1', undefined, 2);
    expect(JSON.parse(exposed!.payload)).toEqual({
      userId: 'user-1',
      generationProtocolVersion: 2,
      steers: [leased],
    });
  });

  test('cannot lease a legacy parked item into a v2 generation', async () => {
    const streamId = 'redis-protocol-v1-source';
    const job = await store.createJob(streamId, 'user-1', undefined, undefined, {
      generationProtocolVersion: 1,
    });
    await store.parkSteers(
      streamId,
      JSON.stringify({
        userId: 'user-1',
        steers: [{ steerId: 'legacy', text: 'legacy words', createdAt: Date.now() }],
      }),
      job.createdAt,
    );

    await expect(
      store.createJob(
        streamId,
        'user-1',
        undefined,
        undefined,
        { generationProtocolVersion: 2 },
        'legacy',
        undefined,
        undefined,
        undefined,
        { text: 'legacy words', fileIds: [], quotes: [] },
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_PAYLOAD_MISMATCH' });
  });

  test('marks the legacy bridge claim started only for its owner token', async () => {
    await store.claimIdempotencyKey(
      'legacy:user:req',
      { streamId: 'stream-1', conversationId: 'stream-1', claimToken: 'token-1' },
      60,
    );
    expect(await store.markIdempotencyKeyStarted('legacy:user:req', 'wrong', 1234, 60)).toBe(false);
    expect(await store.markIdempotencyKeyStarted('legacy:user:req', 'token-1', 1234, 60)).toBe(
      true,
    );
    expect(
      (
        await store.claimIdempotencyKey(
          'legacy:user:req',
          { streamId: 'other', conversationId: 'other' },
          60,
        )
      ).existing,
    ).toMatchObject({ startedAt: 1234 });
  });

  test('manager bridges the exact old physical key to the same-slot primary with one winner', async () => {
    const managerStores = [new RedisJobStore(redis), new RedisJobStore(redis)];
    const managers = managerStores.map((jobStore) => {
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: true,
      });
      manager.initialize();
      return manager;
    });
    try {
      const userId = 'rollout-user';
      const clientRequestId = `rollout-request-${Date.now()}`;
      const streamId = `rollout-stream-${Date.now()}`;
      const [first, second] = await Promise.all(
        managers.map((manager) =>
          manager.claimGeneration(userId, clientRequestId, streamId, streamId, 2),
        ),
      );

      expect([first, second].filter((result) => result.claimed)).toHaveLength(1);
      expect(first.existing?.claimToken).toBe(second.existing?.claimToken);
      const legacyPhysicalKey = `stream:idem:{${userId}:${clientRequestId}}`;
      const primaryPhysicalKey = `stream:idem:{${streamId}}:${userId}:${clientRequestId}`;
      const legacy = JSON.parse((await redis.get(legacyPhysicalKey))!);
      const primary = JSON.parse((await redis.get(primaryPhysicalKey))!);
      expect(legacy).toEqual(primary);
      expect(primary).toMatchObject({
        streamId,
        conversationId: streamId,
        claimToken: first.existing?.claimToken,
        generationProtocolVersion: 2,
      });
      expect(await redis.ttl(primaryPhysicalKey)).toBeGreaterThan(24 * 60 * 60);
      expect(await redis.ttl(primaryPhysicalKey)).toBeLessThanOrEqual(25 * 60 * 60);
      expect(await redis.ttl(legacyPhysicalKey)).toBeGreaterThan(25 * 60 * 60);
      expect(await redis.ttl(legacyPhysicalKey)).toBeLessThanOrEqual(26 * 60 * 60);

      const winner = first.claimed ? managers[0] : managers[1];
      const claim = first.claimed ? first.existing! : second.existing!;
      const job = await winner.createJob(streamId, userId, streamId, {
        idempotencyClientRequestId: clientRequestId,
        idempotencyClaimToken: claim.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      });
      expect(JSON.parse((await redis.get(primaryPhysicalKey))!)).toMatchObject({
        startedAt: job.createdAt,
        generationProtocolVersion: 2,
      });
      expect(JSON.parse((await redis.get(legacyPhysicalKey))!)).toMatchObject({
        startedAt: job.createdAt,
        generationProtocolVersion: 2,
      });
    } finally {
      await Promise.all(managers.map((manager) => manager.destroy()));
    }
  });

  test('recovers a lost create reply, repairs membership, and stops the exact raced predecessor', async () => {
    const abortHandlers = new Map<string, Set<(generationId?: number) => void | boolean>>();
    const acknowledgedAborts = new Map<string, Set<number>>();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      emitAbort(streamId: string, generationId?: number) {
        for (const handler of abortHandlers.get(streamId) ?? []) {
          handler(generationId);
        }
      },
      async onAbort(streamId: string, handler: (generationId?: number) => void) {
        let handlers = abortHandlers.get(streamId);
        if (handlers == null) {
          handlers = new Set();
          abortHandlers.set(streamId, handlers);
        }
        handlers.add(handler);
        return () => handlers?.delete(handler);
      },
      async emitAbortConfirmed(streamId: string, generationId: number) {
        let acknowledged = acknowledgedAborts.get(streamId)?.has(generationId) === true;
        for (const handler of abortHandlers.get(streamId) ?? []) {
          acknowledged = handler(generationId) === true || acknowledged;
        }
        if (acknowledged) {
          let generations = acknowledgedAborts.get(streamId);
          if (generations == null) {
            generations = new Set();
            acknowledgedAborts.set(streamId, generations);
          }
          generations.add(generationId);
        }
        return acknowledged;
      },
    });
    const ownerStore = new RedisJobStore(redis);
    const recoveringStore = new RedisJobStore(redis);
    const owner = new GenerationJobManagerClass();
    const recovering = new GenerationJobManagerClass();
    owner.configure({ jobStore: ownerStore, eventTransport, isRedis: true });
    recovering.configure({ jobStore: recoveringStore, eventTransport, isRedis: true });
    owner.initialize();
    recovering.initialize();

    const streamId = `redis-lost-create-${Date.now()}`;
    const userId = 'redis-lost-create-user';
    const clientRequestId = `redis-lost-create-request-${Date.now()}`;
    const doneEvents: Array<{ event: unknown; generationId?: number }> = [];
    const subscription = eventTransport.subscribe(streamId, {
      onChunk: () => undefined,
      onDone: (event, generationId) => doneEvents.push({ event, generationId }),
    });
    const actualEval = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
    const evalSpy = jest.spyOn(redis, 'eval');
    let injectLostCreateReply = false;
    evalSpy.mockImplementation((async (...args: unknown[]) => {
      const result = await actualEval(...args);
      const script = args[0];
      if (
        injectLostCreateReply &&
        typeof script === 'string' &&
        script.includes('previousJobExists') &&
        script.includes('claim_lost')
      ) {
        injectLostCreateReply = false;
        throw new Error('simulated lost JOB_CREATE_LUA reply');
      }
      return result;
    }) as typeof redis.eval);

    let racedPredecessor: Awaited<ReturnType<GenerationJobManagerClass['createJob']>> | undefined;
    const actualGetJob = recoveringStore.getJob.bind(recoveringStore);
    let injectRacedPredecessor = true;
    const getJobSpy = jest.spyOn(recoveringStore, 'getJob').mockImplementation(async (id) => {
      const observed = await actualGetJob(id);
      if (id === streamId && injectRacedPredecessor) {
        injectRacedPredecessor = false;
        racedPredecessor = await owner.createJob(streamId, userId, streamId, {
          initialMetadata: { generationProtocolVersion: 2 },
        });
        injectLostCreateReply = true;
      }
      return observed;
    });

    try {
      // A is what the recovering manager pre-reads. B is installed by the
      // getJob hook immediately afterward, so only Redis's persisted
      // transaction-time receipt can identify B when C's eval reply is lost.
      const stalePredecessor = await owner.createJob(streamId, userId, streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      const claim = await recovering.claimGeneration(
        userId,
        clientRequestId,
        streamId,
        streamId,
        2,
      );
      const replacement = await recovering.createJob(streamId, userId, streamId, {
        idempotencyClientRequestId: clientRequestId,
        idempotencyClaimToken: claim.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      });

      expect(racedPredecessor).toBeDefined();
      expect(racedPredecessor!.createdAt).toBeGreaterThan(stalePredecessor.createdAt);
      expect(replacement.createdAt).toBeGreaterThan(racedPredecessor!.createdAt);
      expect(racedPredecessor!.abortController.signal.aborted).toBe(true);
      expect(doneEvents).toContainEqual({
        event: expect.objectContaining({
          final: true,
          reconcileReason: 'generation_replaced',
          generationCreatedAt: racedPredecessor!.createdAt,
        }),
        generationId: racedPredecessor!.createdAt,
      });
      expect(await redis.sismember('stream:running', streamId)).toBe(1);
      expect(await redis.sismember(`stream:user:{${userId}}:jobs`, streamId)).toBe(1);
      expect(await recoveringStore.getJob(streamId)).toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
        idempotencyClientRequestId: clientRequestId,
      });
    } finally {
      getJobSpy.mockRestore();
      evalSpy.mockRestore();
      subscription.unsubscribe();
      await Promise.all([recovering.destroy(), owner.destroy()]);
    }
  });

  test('a superseded lost-reply helper delivers but does not acknowledge the crashed successor chain', async () => {
    const abortHandlers = new Map<string, Set<(generationId?: number) => void | boolean>>();
    const acknowledgedAborts = new Map<string, Set<number>>();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      emitAbort(streamId: string, generationId?: number) {
        for (const handler of abortHandlers.get(streamId) ?? []) {
          handler(generationId);
        }
      },
      async onAbort(streamId: string, handler: (generationId?: number) => void) {
        let handlers = abortHandlers.get(streamId);
        if (handlers == null) {
          handlers = new Set();
          abortHandlers.set(streamId, handlers);
        }
        handlers.add(handler);
        return () => handlers?.delete(handler);
      },
      async emitAbortConfirmed(streamId: string, generationId: number) {
        let acknowledged = acknowledgedAborts.get(streamId)?.has(generationId) === true;
        for (const handler of abortHandlers.get(streamId) ?? []) {
          acknowledged = handler(generationId) === true || acknowledged;
        }
        if (acknowledged) {
          let generations = acknowledgedAborts.get(streamId);
          if (generations == null) {
            generations = new Set();
            acknowledgedAborts.set(streamId, generations);
          }
          generations.add(generationId);
        }
        return acknowledged;
      },
    });
    const ownerStore = new RedisJobStore(redis);
    const recoveringStore = new RedisJobStore(redis);
    const crashedStore = new RedisJobStore(redis);
    const successorStore = new RedisJobStore(redis);
    const owner = new GenerationJobManagerClass();
    const recovering = new GenerationJobManagerClass();
    const successor = new GenerationJobManagerClass();
    owner.configure({ jobStore: ownerStore, eventTransport, isRedis: true });
    recovering.configure({ jobStore: recoveringStore, eventTransport, isRedis: true });
    successor.configure({ jobStore: successorStore, eventTransport, isRedis: true });
    owner.initialize();
    recovering.initialize();
    successor.initialize();

    const streamId = `redis-superseded-lost-create-${Date.now()}`;
    const userId = 'redis-superseded-lost-create-user';
    const doneEvents: Array<{ event: unknown; generationId?: number }> = [];
    const subscription = eventTransport.subscribe(streamId, {
      onChunk: () => undefined,
      onDone: (event, generationId) => doneEvents.push({ event, generationId }),
    });
    const actualEval = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
    const evalSpy = jest.spyOn(redis, 'eval');
    let injectLostCreateReply = false;
    evalSpy.mockImplementation((async (...args: unknown[]) => {
      const result = await actualEval(...args);
      const script = args[0];
      if (
        injectLostCreateReply &&
        typeof script === 'string' &&
        script.includes('previousJobExists') &&
        script.includes('claim_lost')
      ) {
        injectLostCreateReply = false;
        throw new Error('simulated lost C create reply');
      }
      return result;
    }) as typeof redis.eval);

    let getJobCalls = 0;
    let crashedSuccessor: Awaited<ReturnType<RedisJobStore['createJob']>> | undefined;
    const actualGetJob = recoveringStore.getJob.bind(recoveringStore);
    const getJobSpy = jest.spyOn(recoveringStore, 'getJob').mockImplementation(async (id) => {
      getJobCalls += 1;
      if (id === streamId && getJobCalls === 2) {
        crashedSuccessor = await crashedStore.createJob(
          streamId,
          userId,
          streamId,
          undefined,
          { generationProtocolVersion: 2 },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'crashed-successor-attempt',
        );
      }
      return actualGetJob(id);
    });

    try {
      const activePredecessor = await owner.createJob(streamId, userId, streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      expect(await ownerStore.getJob(streamId)).toMatchObject({ providerAbortReady: true });
      injectLostCreateReply = true;

      await expect(
        recovering.createJob(streamId, userId, streamId, {
          initialMetadata: { generationProtocolVersion: 2 },
        }),
      ).rejects.toThrow('simulated lost C create reply');

      expect(crashedSuccessor).toBeDefined();
      expect(crashedSuccessor).toMatchObject({ providerAbortReady: false });
      expect(activePredecessor.abortController.signal.aborted).toBe(true);
      expect(doneEvents).toContainEqual({
        event: expect.objectContaining({
          final: true,
          reconcileReason: 'generation_replaced',
          generationCreatedAt: activePredecessor.createdAt,
        }),
        generationId: activePredecessor.createdAt,
      });
      const jobKey = `stream:{${streamId}}:job`;
      const retainedChain = JSON.parse((await redis.hget(jobKey, '__replacedGenerations'))!);
      expect(retainedChain).toEqual([
        expect.objectContaining({ createdAt: activePredecessor.createdAt, status: 'running' }),
        expect.objectContaining({ status: 'running', providerAbortReady: false }),
      ]);
      expect(await crashedStore.getJob(streamId)).toMatchObject({
        createdAt: crashedSuccessor!.createdAt,
        status: 'running',
      });

      // The helper deliberately could not ACK another attempt's receipts. A
      // later real successor inherits the chain, delivers it idempotently,
      // and may then clear it under its own creation-attempt fence.
      getJobSpy.mockRestore();
      evalSpy.mockRestore();
      const eventualSuccessor = await successor.createJob(streamId, userId, streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      expect(eventualSuccessor.createdAt).toBeGreaterThan(crashedSuccessor!.createdAt);
      expect(await redis.hget(jobKey, '__replacedGenerations')).toBeNull();
    } finally {
      getJobSpy.mockRestore();
      evalSpy.mockRestore();
      subscription.unsubscribe();
      await Promise.all([owner.destroy(), recovering.destroy(), successor.destroy()]);
      await crashedStore.destroy();
    }
  });

  test('rejects malformed replacement receipts before mutating the current job', async () => {
    const corruptions: Array<{
      name: string;
      fields: (createdAt: number) => Record<string, string>;
    }> = [
      {
        name: 'unsafe JSON epoch',
        fields: () => ({
          __replacedGenerations: JSON.stringify([
            { createdAt: Number.MAX_SAFE_INTEGER + 1, status: 'running' },
          ]),
          __replacedCreatedAt: String(Number.MAX_SAFE_INTEGER + 1),
          __replacedStatus: 'running',
        }),
      },
      {
        name: 'fractional JSON epoch',
        fields: () => ({
          __replacedGenerations: JSON.stringify([{ createdAt: 1.5, status: 'running' }]),
          __replacedCreatedAt: '1.5',
          __replacedStatus: 'running',
        }),
      },
      {
        name: 'unordered JSON epochs',
        fields: () => ({
          __replacedGenerations: JSON.stringify([
            { createdAt: 2, status: 'running' },
            { createdAt: 1, status: 'complete' },
          ]),
          __replacedCreatedAt: '1',
          __replacedStatus: 'complete',
        }),
      },
      {
        name: 'receipt equal to current predecessor',
        fields: (createdAt) => ({
          __replacedGenerations: JSON.stringify([{ createdAt, status: 'complete' }]),
          __replacedCreatedAt: String(createdAt),
          __replacedStatus: 'complete',
        }),
      },
      {
        name: 'invalid provider abort readiness',
        fields: () => ({
          __replacedGenerations: JSON.stringify([
            { createdAt: 1, status: 'running', providerAbortReady: 'yes' },
          ]),
          __replacedCreatedAt: '1',
          __replacedStatus: 'running',
        }),
      },
      {
        name: 'invalid legacy scalar status',
        fields: () => ({
          __replacedCreatedAt: '1',
          __replacedStatus: 'not-a-status',
        }),
      },
    ];

    for (const corruption of corruptions) {
      const streamId = `redis-corrupt-receipt-${corruption.name.replaceAll(' ', '-')}-${Date.now()}`;
      const current = await store.createJob(
        streamId,
        'receipt-user',
        undefined,
        undefined,
        { generationProtocolVersion: 2 },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'current-attempt',
      );
      const jobKey = `stream:{${streamId}}:job`;
      const fields = corruption.fields(current.createdAt);
      await redis.hset(jobKey, ...Object.entries(fields).flat());
      const before = await redis.hgetall(jobKey);

      await expect(
        store.createJob(
          streamId,
          'receipt-user',
          undefined,
          undefined,
          { generationProtocolVersion: 2 },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          `replacement-attempt-${corruption.name}`,
        ),
      ).rejects.toThrow('replacement receipt is corrupt');
      expect(await redis.hgetall(jobKey)).toEqual(before);
    }
  });

  test('inherits a no-conversation replacement chain without corrupting its scalar mirror', async () => {
    const streamId = `redis-no-conversation-chain-${Date.now()}`;
    const first = await store.createJob(
      streamId,
      'receipt-user',
      undefined,
      undefined,
      { generationProtocolVersion: 2 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'no-conversation-attempt-a',
    );
    const second = await store.createJob(
      streamId,
      'receipt-user',
      undefined,
      undefined,
      { generationProtocolVersion: 2 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'no-conversation-attempt-b',
    );
    const third = await store.createJob(
      streamId,
      'receipt-user',
      undefined,
      undefined,
      { generationProtocolVersion: 2 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'no-conversation-attempt-c',
    );

    expect((third as typeof third & { replacedJobs?: unknown }).replacedJobs).toEqual([
      { createdAt: first.createdAt, status: 'running' },
      { createdAt: second.createdAt, status: 'running' },
    ]);
  });

  test('replacement transport authorizes only the current receipt and tolerates zero DONE listeners', async () => {
    const streamId = `redis-replacement-transport-${Date.now()}`;
    const first = await store.createJob(
      streamId,
      'transport-user',
      streamId,
      undefined,
      { generationProtocolVersion: 2 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'transport-attempt-a',
    );
    expect(
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'complete',
        expectCreatedAt: first.createdAt,
        patch: { completedAt: Date.now() },
      }),
    ).toBe(true);
    await store.createJob(
      streamId,
      'transport-user',
      streamId,
      undefined,
      { generationProtocolVersion: 2 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'transport-attempt-b',
    );
    const subscriber = redis.duplicate();
    const transport = new RedisEventTransport(redis, subscriber);
    try {
      await expect(
        transport.emitReplacedDoneConfirmed(
          streamId,
          { final: true, reconcile: true },
          first.createdAt,
          'transport-attempt-b',
        ),
      ).resolves.toBeUndefined();
      await expect(
        transport.emitReplacedDoneConfirmed(
          streamId,
          { final: true },
          first.createdAt,
          'wrong-attempt',
        ),
      ).rejects.toThrow('no longer current');
      await expect(
        transport.emitReplacedDoneConfirmed(
          streamId,
          { final: true },
          first.createdAt - 1,
          'transport-attempt-b',
        ),
      ).rejects.toThrow('no longer current');
      await expect(transport.emitDone(streamId, { final: true }, first.createdAt)).rejects.toThrow(
        'fenced by a replacement',
      );
      await expect(transport.emitError(streamId, 'stale', first.createdAt)).rejects.toThrow(
        'fenced by a replacement',
      );
    } finally {
      transport.destroy();
    }
  });

  test('rejects partial low-level idempotency arguments without creating a Redis job', async () => {
    const streamId = `redis-partial-create-idempotency-${Date.now()}`;
    await expect(
      store.createJob(
        streamId,
        'user-1',
        undefined,
        undefined,
        {},
        undefined,
        `{${streamId}}:user-1:req`,
        'claim-token',
      ),
    ).rejects.toThrow('Invalid generation job idempotency arguments');
    expect(await redis.exists(`stream:{${streamId}}:job`)).toBe(0);
  });

  test('live Redis tombstones legacy/protocol-mismatch adoptions through job deletion', async () => {
    const managerStore = new RedisJobStore(redis);
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: managerStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: true,
    });
    manager.initialize();
    try {
      const userId = 'redis-adopt-user';

      // Old v1 job: no durable clientRequestId, fresh upgraded request asks for
      // v2. It cannot attach, but both mirrors must become v1 started
      // tombstones before the controller returns 503.
      const legacyStream = `redis-legacy-adopt-${Date.now()}`;
      const legacyRequest = `redis-legacy-request-${Date.now()}`;
      const legacyJob = await manager.createJob(legacyStream, userId, legacyStream, {
        initialMetadata: { generationProtocolVersion: 1 },
      });
      const legacyFresh = await manager.claimGeneration(
        userId,
        legacyRequest,
        legacyStream,
        legacyStream,
        2,
      );
      await expect(
        manager.resumeClaimedGeneration(userId, legacyRequest, legacyStream, legacyFresh.existing!),
      ).rejects.toThrow('conservatively fenced');

      const legacyKey = `stream:idem:{${userId}:${legacyRequest}}`;
      const legacyPrimaryKey = `stream:idem:{${legacyStream}}:${userId}:${legacyRequest}`;
      for (const key of [legacyKey, legacyPrimaryKey]) {
        expect(JSON.parse((await redis.get(key))!)).toMatchObject({
          startedAt: legacyJob.createdAt,
          generationProtocolVersion: 1,
        });
      }
      expect(await managerStore.deleteJob(legacyStream, legacyJob.createdAt)).toBe(true);
      const legacyRetry = await manager.claimGeneration(
        userId,
        legacyRequest,
        legacyStream,
        legacyStream,
        2,
      );
      expect(legacyRetry).toMatchObject({
        claimed: false,
        existing: { startedAt: legacyJob.createdAt, generationProtocolVersion: 1 },
      });
      await expect(
        manager.takeoverGeneration(userId, legacyRequest, legacyStream, legacyRetry.existing!),
      ).resolves.toMatchObject({ claimed: false });
      await expect(
        manager.createJob(legacyStream, userId, legacyStream, {
          idempotencyClientRequestId: legacyRequest,
          idempotencyClaimToken: legacyFresh.existing!.claimToken,
          initialMetadata: { generationProtocolVersion: 2 },
        }),
      ).rejects.toThrow('claim was taken over');

      // Correlated v2 job with expired mirrors and a fresh v1 request remains
      // attachable, but the new tombstone is capped to immutable job protocol.
      const currentStream = `redis-current-adopt-${Date.now()}`;
      const currentRequest = `redis-current-request-${Date.now()}`;
      const original = await manager.claimGeneration(
        userId,
        currentRequest,
        currentStream,
        currentStream,
        2,
      );
      const currentJob = await manager.createJob(currentStream, userId, currentStream, {
        idempotencyClientRequestId: currentRequest,
        idempotencyClaimToken: original.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      });
      const currentLegacyKey = `stream:idem:{${userId}:${currentRequest}}`;
      const currentPrimaryKey = `stream:idem:{${currentStream}}:${userId}:${currentRequest}`;
      await redis.del(currentLegacyKey);
      await redis.del(currentPrimaryKey);
      const currentFresh = await manager.claimGeneration(
        userId,
        currentRequest,
        currentStream,
        currentStream,
        1,
      );
      await expect(
        manager.resumeClaimedGeneration(
          userId,
          currentRequest,
          currentStream,
          currentFresh.existing!,
        ),
      ).resolves.toMatchObject({
        startedAt: currentJob.createdAt,
        generationProtocolVersion: 2,
      });
      expect(await managerStore.deleteJob(currentStream, currentJob.createdAt)).toBe(true);
      const currentRetry = await manager.claimGeneration(
        userId,
        currentRequest,
        currentStream,
        currentStream,
        1,
      );
      expect(currentRetry).toMatchObject({
        claimed: false,
        existing: { startedAt: currentJob.createdAt, generationProtocolVersion: 2 },
      });
      await expect(
        manager.takeoverGeneration(userId, currentRequest, currentStream, currentRetry.existing!),
      ).resolves.toMatchObject({ claimed: false });
    } finally {
      await manager.destroy();
    }
  });
});
