import { clearRedisTestPrefix, createRedisTestClient, type RedisTestClient } from './helpers/redis';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { JobPredecessorMismatchError } from '../interfaces/IJobStore';
import { emitChunkWithReceipt } from '../internal/chunkPublication';
import { RedisJobStore } from '../implementations/RedisJobStore';

function createConditionalJob(
  store: RedisJobStore,
  streamId: string,
  expectedPredecessorCreatedAt: number,
  attempt: string,
) {
  return store.createJob(
    streamId,
    'owner-1',
    streamId,
    undefined,
    { generationProtocolVersion: 2 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    attempt,
    expectedPredecessorCreatedAt,
  );
}

/** An automatic continuation must never replace a parent turn that is still live. */
function createWakeupJob(store: RedisJobStore, streamId: string, attempt: string) {
  return store.createJob(
    streamId,
    'owner-1',
    streamId,
    undefined,
    { generationProtocolVersion: 2 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    attempt,
    undefined,
    true,
  );
}

describe('Redis generation predecessor create fence', () => {
  const keyPrefix = `Predecessor-Fence-${process.pid}-${Date.now()}:`;
  let redis: RedisTestClient;
  let store: RedisJobStore;

  beforeAll(async () => {
    redis = createRedisTestClient(keyPrefix);
    await redis.connect();
    store = new RedisJobStore(redis, {
      chunksAfterCompleteTtl: 300,
      runStepsAfterCompleteTtl: 300,
    });
    await store.initialize();
  });

  afterEach(async () => {
    await clearRedisTestPrefix(redis, keyPrefix);
  });

  afterAll(async () => {
    await store.destroy();
    await redis.quit();
  });

  test('admission refuses an active predecessor without mutating it, and admits a settled one', async () => {
    const streamId = 'redis-active-predecessor-fence';
    const parent = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    await expect(
      store.appendChunk(
        streamId,
        { event: 'on_message_delta', data: { delta: 'parent still writing' } },
        parent.createdAt,
      ),
    ).resolves.toBe(true);
    const chunksKey = `stream:{${streamId}}:chunks`;
    const chunksBefore = await redis.xrange(chunksKey, '-', '+');

    await expect(createWakeupJob(store, streamId, 'redis-wakeup-running')).rejects.toMatchObject({
      code: 'GENERATION_PREDECESSOR_MISMATCH',
      currentJob: { createdAt: parent.createdAt, active: true, verified: true, status: 'running' },
    });
    /** The refused continuation must leave the live parent turn exactly as it was. */
    await expect(store.getJob(streamId)).resolves.toMatchObject({
      createdAt: parent.createdAt,
      status: 'running',
    });
    await expect(redis.xrange(chunksKey, '-', '+')).resolves.toEqual(chunksBefore);

    await expect(
      store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        expectCreatedAt: parent.createdAt,
      }),
    ).resolves.toBe(true);
    await expect(
      createWakeupJob(store, streamId, 'redis-wakeup-requires-action'),
    ).rejects.toMatchObject({
      code: 'GENERATION_PREDECESSOR_MISMATCH',
      currentJob: { active: true, status: 'requires_action' },
    });

    await expect(
      store.transitionStatus(streamId, {
        from: 'requires_action',
        to: 'aborted',
        expectCreatedAt: parent.createdAt,
      }),
    ).resolves.toBe(true);
    await store.updateJob(streamId, { terminalPersistencePending: true }, parent.createdAt);
    await expect(
      createWakeupJob(store, streamId, 'redis-wakeup-terminal-persistence'),
    ).rejects.toMatchObject({
      currentJob: { active: true, status: 'aborted' },
    });
    await store.updateJob(streamId, { terminalPersistencePending: false }, parent.createdAt);
    await store.updateJob(streamId, { terminalHostActionPending: true }, parent.createdAt);
    await expect(
      createWakeupJob(store, streamId, 'redis-wakeup-terminal-host-action'),
    ).rejects.toMatchObject({
      currentJob: { active: true, status: 'aborted' },
    });
    await expect(
      store.createJob(streamId, 'owner-1', streamId, undefined, {
        generationProtocolVersion: 2,
      }),
    ).rejects.toMatchObject({
      currentJob: { active: true, status: 'aborted' },
    });
    await store.updateJob(streamId, { terminalHostActionPending: false }, parent.createdAt);
    const wakeup = await createWakeupJob(store, streamId, 'redis-wakeup-settled');
    expect(wakeup.createdAt).toBeGreaterThanOrEqual(parent.createdAt);
  });

  test('admission accepts an absent predecessor', async () => {
    const streamId = 'redis-absent-predecessor-fence';
    const wakeup = await createWakeupJob(store, streamId, 'redis-wakeup-absent');
    expect(wakeup.createdAt).toEqual(expect.any(Number));
  });

  test('ordinary turns still replace an active predecessor', async () => {
    const streamId = 'redis-ordinary-replacement-unchanged';
    const first = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    /** Without the policy a user turn keeps replacing a running generation. */
    const second = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    expect(second.createdAt).toBeGreaterThanOrEqual(first.createdAt);
    await expect(store.getJob(streamId)).resolves.toMatchObject({ createdAt: second.createdAt });
  });

  test('mismatch returns the exact current generation without mutating durable state', async () => {
    const streamId = 'redis-predecessor-fence-no-mutation';
    const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    const queued = {
      steerId: 'redis-predecessor-queued',
      text: 'keep queued work',
      userId: 'owner-1',
      createdAt: Date.now(),
    };
    await expect(store.enqueueSteer(streamId, queued, predecessor.createdAt)).resolves.toBe(1);
    await expect(
      store.appendChunk(
        streamId,
        { event: 'on_message_delta', data: { delta: 'keep persisted content' } },
        predecessor.createdAt,
      ),
    ).resolves.toBe(true);
    const chunksKey = `stream:{${streamId}}:chunks`;
    const chunksBefore = await redis.xrange(chunksKey, '-', '+');
    const epochBefore = await redis.get(`stream:{${streamId}}:generation-epoch`);

    await expect(
      createConditionalJob(store, streamId, predecessor.createdAt + 1, 'redis-mismatch-attempt'),
    ).rejects.toMatchObject({
      code: 'GENERATION_PREDECESSOR_MISMATCH',
      currentJob: {
        createdAt: predecessor.createdAt,
        active: true,
        verified: true,
        status: 'running',
        conversationId: streamId,
      },
    });

    await expect(store.getJob(streamId)).resolves.toMatchObject({
      createdAt: predecessor.createdAt,
      status: 'running',
    });
    await expect(store.peekSteers(streamId, predecessor.createdAt)).resolves.toEqual([queued]);
    await expect(redis.xrange(chunksKey, '-', '+')).resolves.toEqual(chunksBefore);
    await expect(redis.get(`stream:{${streamId}}:generation-epoch`)).resolves.toBe(epochBefore);
    const durable = await store.getJob(streamId);
    expect(Object.getOwnPropertyDescriptor(durable!, 'replacedJobs')).toBeUndefined();
  });

  test('matching expected predecessor atomically installs its replacement receipt', async () => {
    const streamId = 'redis-predecessor-fence-match';
    const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });

    const replacement = await createConditionalJob(
      store,
      streamId,
      predecessor.createdAt,
      'redis-matching-attempt',
    );

    expect(replacement.createdAt).toBeGreaterThan(predecessor.createdAt);
    expect(replacement.replacedJob).toEqual({
      createdAt: predecessor.createdAt,
      status: 'running',
      conversationId: streamId,
    });
    await expect(store.getJob(streamId)).resolves.toMatchObject({
      createdAt: replacement.createdAt,
      status: 'running',
    });
  });

  test('a retained epoch matching the disappeared predecessor permits a monotonic new generation', async () => {
    const streamId = 'redis-predecessor-fence-absent';
    const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    await expect(store.deleteJob(streamId, predecessor.createdAt)).resolves.toBe(true);

    const replacement = await createConditionalJob(
      store,
      streamId,
      predecessor.createdAt,
      'redis-absent-attempt',
    );

    expect(replacement.createdAt).toBeGreaterThan(predecessor.createdAt);
    expect(replacement.replacedJob).toBeUndefined();
  });

  test('missing predecessor evidence rejects conditionally without recreating state', async () => {
    const streamId = 'redis-predecessor-fence-expired-evidence';
    const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    await expect(store.deleteJob(streamId, predecessor.createdAt)).resolves.toBe(true);
    const retainedEpochKey = `stream:{${streamId}}:generation-epoch`;
    await expect(redis.del(retainedEpochKey)).resolves.toBe(1);

    await expect(
      createConditionalJob(store, streamId, predecessor.createdAt, 'redis-expired-attempt'),
    ).rejects.toMatchObject({
      code: 'GENERATION_PREDECESSOR_MISMATCH',
      currentJob: {
        createdAt: predecessor.createdAt,
        active: false,
        verified: false,
      },
    });
    await expect(store.getJob(streamId)).resolves.toBeNull();
    await expect(redis.get(retainedEpochKey)).resolves.toBeNull();
  });

  test('a retained intervening epoch rejects a delayed create after its job disappeared', async () => {
    const streamId = 'redis-predecessor-fence-retained-intervening';
    const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    await expect(store.deleteJob(streamId, predecessor.createdAt)).resolves.toBe(true);

    const intervening = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    await expect(store.deleteJob(streamId, intervening.createdAt)).resolves.toBe(true);
    const retainedEpochKey = `stream:{${streamId}}:generation-epoch`;
    await expect(redis.get(retainedEpochKey)).resolves.toBe(String(intervening.createdAt));

    await expect(
      createConditionalJob(
        store,
        streamId,
        predecessor.createdAt,
        'redis-retained-intervening-attempt',
      ),
    ).rejects.toMatchObject({
      code: 'GENERATION_PREDECESSOR_MISMATCH',
      currentJob: {
        createdAt: intervening.createdAt,
        active: false,
        verified: true,
      },
    });
    await expect(store.getJob(streamId)).resolves.toBeNull();
    await expect(redis.get(retainedEpochKey)).resolves.toBe(String(intervening.createdAt));
  });

  test('exposes a typed mismatch error for callers that need a definitive 409', async () => {
    const streamId = 'redis-predecessor-fence-error-type';
    const predecessor = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });

    await expect(
      createConditionalJob(store, streamId, predecessor.createdAt + 1, 'redis-typed-attempt'),
    ).rejects.toBeInstanceOf(JobPredecessorMismatchError);
  });

  test('same-epoch append is fenced after terminal transition without changing retained chunks', async () => {
    const streamId = 'redis-terminal-append-fence';
    const job = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    await expect(
      store.appendChunk(
        streamId,
        { event: 'on_message_delta', data: { delta: 'committed before terminal' } },
        job.createdAt,
      ),
    ).resolves.toBe(true);
    await expect(
      store.transitionStatus(streamId, {
        from: 'running',
        to: 'complete',
        expectCreatedAt: job.createdAt,
      }),
    ).resolves.toBe(true);

    const chunksKey = `stream:{${streamId}}:chunks`;
    const chunksAtTerminal = await redis.xrange(chunksKey, '-', '+');
    expect(chunksAtTerminal).toHaveLength(1);

    await expect(
      store.appendChunk(
        streamId,
        { event: 'on_message_delta', data: { delta: 'must be rejected' } },
        job.createdAt,
      ),
    ).resolves.toBe(false);
    await expect(redis.xrange(chunksKey, '-', '+')).resolves.toEqual(chunksAtTerminal);
  });

  test('same-epoch run-step save is fenced after terminal transition without changing retained steps', async () => {
    const streamId = 'redis-terminal-runsteps-fence';
    const job = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    const committedSteps = [{ id: 'step-before-terminal', type: 'tool_call' }];
    await store.saveRunSteps(streamId, committedSteps as never, job.createdAt);
    await expect(
      store.transitionStatus(streamId, {
        from: 'running',
        to: 'complete',
        expectCreatedAt: job.createdAt,
      }),
    ).resolves.toBe(true);

    const runStepsKey = `stream:{${streamId}}:runsteps`;
    const stepsAtTerminal = await redis.get(runStepsKey);
    expect(stepsAtTerminal).toBe(JSON.stringify(committedSteps));

    await store.saveRunSteps(
      streamId,
      [{ id: 'step-after-terminal', type: 'tool_call' }] as never,
      job.createdAt,
    );
    await expect(redis.get(runStepsKey)).resolves.toBe(stepsAtTerminal);
  });

  test('terminal hash fences CHUNK before sequence allocation while permitting same-epoch DONE', async () => {
    const streamId = 'redis-terminal-publication-fence';
    const job = await store.createJob(streamId, 'owner-1', streamId, undefined, {
      generationProtocolVersion: 2,
    });
    await expect(
      store.transitionStatus(streamId, {
        from: 'running',
        to: 'complete',
        expectCreatedAt: job.createdAt,
      }),
    ).resolves.toBe(true);

    const subscriber = redis.duplicate();
    const transport = new RedisEventTransport(redis, subscriber);
    const sequenceKey = `stream:{${streamId}}:seq`;
    try {
      await expect(redis.get(sequenceKey)).resolves.toBeNull();
      await expect(
        emitChunkWithReceipt(
          transport,
          streamId,
          { event: 'on_message_delta', data: { delta: 'must not publish' } },
          job.createdAt,
        ),
      ).resolves.toBe(false);
      await expect(redis.get(sequenceKey)).resolves.toBeNull();

      await expect(
        transport.emitDone(streamId, { final: true }, job.createdAt),
      ).resolves.toBeUndefined();
      await expect(redis.get(sequenceKey)).resolves.toBe('1');
    } finally {
      transport.destroy();
      subscriber.disconnect();
    }
  });
});
