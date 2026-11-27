import Redis from 'ioredis';
import { DEFAULT_REDIS_FINALIZATION_RECOVERY_TIMEOUT_MS } from 'librechat-data-provider';
import { startRedis, sleep, waitUntil } from '~/cache/__tests__/outage.helper';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { RedisJobStore } from '../implementations/RedisJobStore';
import { isRedisStreamInterrupted } from '../redisOutage';

const lostReply = new Error('Connection is closed.');

let server: Awaited<ReturnType<typeof startRedis>>;
let redis: Redis;
let store: RedisJobStore;
let transport: RedisEventTransport;
let manager: GenerationJobManagerClass;
let subscriber: Redis;

beforeAll(async () => {
  server = await startRedis(false);
  redis = new Redis(server.url, {
    maxRetriesPerRequest: 0,
    autoResendUnfulfilledCommands: false,
    enableOfflineQueue: false,
    retryStrategy: () => 25,
  });
  subscriber = redis.duplicate();
  for (const client of [redis, subscriber]) client.on('error', () => undefined);
  await waitUntil(() => redis.status === 'ready' && subscriber.status === 'ready');
  store = new RedisJobStore(redis);
  transport = new RedisEventTransport(redis, subscriber);
  manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: store,
    eventTransport: transport,
    isRedis: true,
    cleanupOnComplete: false,
  });
  manager.initialize();
});

afterEach(async () => {
  server?.restore();
  if (redis) await waitUntil(() => redis.status === 'ready');
});

afterAll(async () => {
  try {
    await manager?.destroy();
  } finally {
    redis?.disconnect();
    subscriber?.disconnect();
    await server?.close();
  }
});

async function start(streamId: string, timeout = DEFAULT_REDIS_FINALIZATION_RECOVERY_TIMEOUT_MS) {
  const job = await manager.createJob(streamId, 'user', streamId);
  const provider = job.metadata.providerExecutionId!;
  expect(
    await manager.beginProviderExecution(streamId, job.createdAt, provider, undefined, timeout),
  ).toBe(true);
  const options = {
    expectedProviderExecutionId: provider,
    persistencePending: true as const,
  };
  return { job, provider, options };
}

test('settles an interrupted chat with received content and exact provider proof after Redis returns', async () => {
  const id = 'stream-outage';
  const { job, provider, options } = await start(id);
  const content = [{ type: 'text' as const, text: 'Received before the outage' }];
  manager.setContentParts(id, content, job.createdAt);
  server.block();
  await waitUntil(() => redis.status !== 'ready');
  await expect(
    manager.emitChunk(
      id,
      { event: 'on_message_delta', data: {} },
      { durable: true, expectedCreatedAt: job.createdAt },
    ),
  ).rejects.toThrow();
  expect(isRedisStreamInterrupted(job.abortController.signal)).toBe(true);
  const claiming = manager.claimTerminalJob(id, 'aborted', undefined, job.createdAt, options);
  await sleep(200);
  expect(await server.admin.hget(`stream:{${id}}:job`, 'status')).toBe('running');
  expect(await server.admin.hget(`stream:{${id}}:job`, 'providerDrained')).toBe('0');
  server.restore();
  const claim = await claiming;
  expect(claim?.status).toBe('aborted');
  const final = {
    final: true as const,
    responseMessage: { content, unfinished: true },
    conversation: { conversationId: id },
  };
  server.block();
  await waitUntil(() => redis.status !== 'ready');
  const publishing = manager.publishTerminalClaim(claim!, final);
  await sleep(200);
  expect(await server.admin.hget(`stream:{${id}}:job`, 'terminalPersistencePending')).toBe('1');
  server.restore();
  await expect(publishing).resolves.toMatchObject({ persistenceFailed: false });
  await manager.finishTerminalJob(claim!);

  server.block();
  await waitUntil(() => redis.status !== 'ready');
  const draining = manager.markProviderExecutionDrained(id, job.createdAt, provider);
  await sleep(200);
  expect(await server.admin.hget(`stream:{${id}}:job`, 'providerDrained')).toBe('0');
  server.restore();
  await expect(draining).resolves.toBe(true);
  const retained = await store.getJob(id);
  expect(retained).toMatchObject({
    status: 'aborted',
    providerDrained: true,
    terminalPersistencePending: false,
  });
  expect(JSON.parse(retained!.finalEvent!)).toMatchObject(final);
  await expect(transport.hasProviderDrain(id, job.createdAt, provider)).resolves.toBe(true);
  await expect(
    manager.abortJob(id, { expectedCreatedAt: job.createdAt, awaitProviderDrain: true }),
  ).resolves.toMatchObject({ failureReason: 'already_settled' });
});

test('recovers a lost terminal CAS acknowledgement without stealing another claim', async () => {
  const id = 'lost-terminal-reply';
  const { job, provider, options } = await start(id);
  await store.enqueueSteer(
    id,
    { steerId: 'steer-1', userId: 'user', text: 'keep this steer', createdAt: Date.now() },
    job.createdAt,
  );
  const script = redis.eval.bind(redis);
  let dropped = false;
  jest.spyOn(redis, 'eval').mockImplementation(async (...args) => {
    const result = await script(...args);
    if (
      !dropped &&
      typeof args[0] === 'string' &&
      args[0].includes('__terminalAttemptSteers') &&
      args[1] === 10 &&
      typeof result === 'string'
    ) {
      dropped = true;
      throw lostReply;
    }
    return result;
  });
  const claim = await manager.claimTerminalJob(id, 'complete', undefined, job.createdAt, options);
  expect(dropped).toBe(true);
  expect(claim).toMatchObject({ status: 'complete', drainedSteers: [{ text: 'keep this steer' }] });
  await expect(
    manager.claimTerminalJob(id, 'complete', undefined, job.createdAt, options),
  ).resolves.toBeNull();
  await manager.publishTerminalClaim(claim!, { final: true });
  await manager.finishTerminalJob(claim!);
  await manager.markProviderExecutionDrained(id, job.createdAt, provider);
});

test('a terminal generation still blocks cleanup until its exact provider drains', async () => {
  const id = 'drain-fence';
  const { job, provider, options } = await start(id);
  const claim = await manager.claimTerminalJob(id, 'complete', undefined, job.createdAt, options);
  await manager.publishTerminalClaim(claim!, { final: true });
  await manager.finishTerminalJob(claim!);
  const read = jest.spyOn(transport, 'hasProviderDrain');
  const aborting = manager.abortJob(id, {
    expectedCreatedAt: job.createdAt,
    awaitProviderDrain: true,
  });
  await waitUntil(() => read.mock.calls.length > 0);
  await expect(
    manager.markProviderExecutionDrained(id, job.createdAt, 'different-segment'),
  ).resolves.toBe(false);
  await expect(transport.hasProviderDrain(id, job.createdAt, provider)).resolves.toBe(false);
  const pending = Symbol('pending');
  await expect(Promise.race([aborting, sleep(100).then(() => pending)])).resolves.toBe(pending);
  await expect(manager.markProviderExecutionDrained(id, job.createdAt, provider)).resolves.toBe(
    true,
  );
  await expect(aborting).resolves.toMatchObject({ failureReason: 'already_settled' });
});

test.each([false, true])(
  'resolves a lost error finalize reply without issuing a second terminal frame (stale recovery wins: %s)',
  async (staleWins) => {
    const id = `lost-error-reply-${staleWins}`;
    const message = 'Generation interrupted';
    const { job, provider, options } = await start(id);
    const onDone = jest.fn();
    const onError = jest.fn();
    const sub = await manager.subscribe(id, () => undefined, onDone, onError);
    const emitError = jest.spyOn(transport, 'emitError');
    const emitDone = jest.spyOn(transport, 'emitDone');
    const key = `stream:{${id}}:job`;
    const finalize = store.finalizeTerminalPersistence.bind(store);
    let dropped = false;
    let payload: string | undefined;
    const writes = jest
      .spyOn(store, 'finalizeTerminalPersistence')
      .mockImplementation(async (...args) => {
        if (args[3] == null || dropped) return finalize(...args);
        payload = args[2];
        dropped = true;
        if (staleWins) {
          // The real stale-owner path writes the exact same bytes, without the writer's attempt token.
          await redis.hset(key, 'terminalPersistenceStartedAt', String(Date.now() - 31_000));
          await manager.getCleanupJob(id);
          expect(await redis.hget(key, 'finalEvent')).toBe(payload);
        } else {
          expect(await finalize(...args)).toBe(true);
        }
        throw lostReply;
      });
    const beforeErrorPublication = jest.fn().mockResolvedValue(undefined);
    try {
      await expect(
        manager.completeJob(id, message, job.createdAt, {
          ...options,
          beforeErrorPublication,
        }),
      ).resolves.toBe(true);
      await waitUntil(() => onDone.mock.calls.length + onError.mock.calls.length > 0);
      expect(beforeErrorPublication).toHaveBeenCalledTimes(1);
      expect(writes.mock.calls.filter((args) => args[3] != null).map((args) => args[3])).toEqual([
        expect.any(String),
        writes.mock.calls[0][3],
      ]);
      await expect(store.getJob(id)).resolves.toMatchObject({
        status: 'error',
        error: message,
        terminalPersistencePending: false,
        finalEvent: payload,
      });
      expect(JSON.parse(payload!)).toMatchObject({
        final: true,
        reconcile: true,
        terminalStatus: 'error',
        generationCreatedAt: job.createdAt,
      });
      await expect(finalize(id, job.createdAt, payload!, 'wrong-writer')).resolves.toBe(false);
      await expect(finalize(id, job.createdAt + 1, payload!, 'wrong-writer')).resolves.toBe(false);
      await expect(
        manager.completeJob(id, message, job.createdAt, { ...options, beforeErrorPublication }),
      ).resolves.toBe(false);
      expect(beforeErrorPublication).toHaveBeenCalledTimes(1);
      if (staleWins) {
        expect(emitDone).toHaveBeenCalledTimes(1);
        expect(emitError).not.toHaveBeenCalled();
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ reconcile: true }));
        expect(onError).not.toHaveBeenCalled();
      } else {
        expect(emitError).toHaveBeenCalledTimes(1);
        expect(emitDone).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(message);
        expect(onDone).not.toHaveBeenCalled();
      }
    } finally {
      sub?.unsubscribe();
      await manager.markProviderExecutionDrained(id, job.createdAt, provider);
    }
  },
);

test('a later provider drain does not get a fresh retry window', async () => {
  const id = 'shared-retry-window';
  const { job, provider, options } = await start(id, 350);
  const read = store.getJob.bind(store);
  const reads = jest.spyOn(store, 'getJob').mockRejectedValueOnce(lostReply);
  const claim = await manager.claimTerminalJob(id, 'complete', undefined, job.createdAt, options);
  await manager.publishTerminalClaim(claim!, { final: true });
  await manager.finishTerminalJob(claim!);
  await sleep(350);
  reads.mockClear().mockRejectedValueOnce(lostReply).mockImplementation(read);
  await expect(manager.markProviderExecutionDrained(id, job.createdAt, provider)).rejects.toBe(
    lostReply,
  );
  expect(reads).toHaveBeenCalledTimes(1);
  expect(await transport.hasProviderDrain(id, job.createdAt, provider)).toBe(false);
});
