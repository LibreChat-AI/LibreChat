import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { InMemoryEventTransport } from './implementations/InMemoryEventTransport';
import { parseChannelExecution, sanitizeJobMetadata } from './metadata';
import { GenerationJobManagerClass } from './GenerationJobManager';
import { RedisJobStore } from './implementations/RedisJobStore';

// Isolate unrelated module-level cache clients; the store below uses real Redis.
jest.mock('~/cache/redisClients', () => ({
  ioredisClient: null,
  keyvRedisClient: null,
  keyvRedisClientReady: Promise.resolve(),
}));

const marker = { channelId: 'channel-test', runId: 'run-test' };

describe('trusted channel execution metadata', () => {
  test('preserves only the explicit server-owned marker', () => {
    expect(sanitizeJobMetadata({ channelExecution: marker }).channelExecution).toEqual(marker);
    expect(parseChannelExecution(undefined)).toBeUndefined();
    expect(parseChannelExecution(marker)).not.toBe(marker);
  });

  test.each(['channel:team', 'channel.with.dots', 'channel/team', '频道', 'x'.repeat(512)])(
    'preserves an opaque admitted identifier: %s',
    (id) => {
      expect(parseChannelExecution({ channelId: id, runId: id })).toEqual({
        channelId: id,
        runId: id,
      });
    },
  );

  test.each([
    null,
    [],
    {},
    'run',
    { ...marker, userId: 'other' },
    { channelId: '', runId: 'run' },
    { channelId: 'channel', runId: '' },
    { channelId: 'channel', runId: 1 },
  ])('rejects a malformed stored marker: %#', (value) => {
    expect(() => parseChannelExecution(value)).toThrow('channel_execution_invalid');
  });
});

// Run the storage round-trip with USE_REDIS=true and the normal REDIS_URI.
const describeRedis = process.env.USE_REDIS === 'true' ? describe : describe.skip;

describeRedis('channel metadata through actual Redis and reconstructed managers', () => {
  const prefix = `ChannelMetadata-${randomUUID()}:`;
  let redis: Redis;
  let raw: Redis;
  const managers: GenerationJobManagerClass[] = [];

  function manager(): GenerationJobManagerClass {
    const result = new GenerationJobManagerClass();
    result.configure({
      jobStore: new RedisJobStore(redis),
      eventTransport: new InMemoryEventTransport(),
      isRedis: true,
      cleanupOnComplete: false,
    });
    managers.push(result);
    return result;
  }

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URI ?? 'redis://127.0.0.1:6379', {
      keyPrefix: prefix,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    raw = redis.duplicate({ keyPrefix: '' });
    if ((await redis.ping()) !== 'PONG') throw new Error('Redis test connection unavailable');
  });

  afterAll(async () => {
    await Promise.allSettled(managers.map((item) => item.destroy()));
    if (raw) {
      // Only this random test namespace; never flush a shared local database.
      const keys = await raw.keys(`${prefix}*`);
      if (keys.length) await raw.del(...keys);
      await raw.quit();
    }
    if (redis) await redis.quit();
  });

  test('survives serialization and another manager, with stale writes fenced', async () => {
    const writer = manager();
    const reader = manager();
    const id = randomUUID();
    const job = await writer.createJob(id, 'owner', id);
    await writer.updateMetadata(id, { channelExecution: marker }, job.createdAt);
    expect(JSON.parse((await redis.hget(`stream:{${id}}:job`, 'channelExecution'))!)).toEqual(
      marker,
    );
    expect((await reader.getJob(id))?.metadata.channelExecution).toEqual(marker);
    await writer.updateMetadata(
      id,
      {
        channelExecution: { channelId: 'wrong-channel', runId: 'wrong-run' },
      },
      job.createdAt - 1,
    );
    expect((await reader.getJob(id))?.metadata.channelExecution).toEqual(marker);
  });

  test.each(['complete', 'error', 'abort'] as const)(
    'recovers channel %s obligations through a reconstructed Redis manager',
    async (outcome) => {
      const writer = manager();
      const reader = manager();
      writer.setTerminalHostActionHandler(async () => {
        throw new Error('source temporarily unavailable');
      });
      const recovered = jest.fn().mockResolvedValue(undefined);
      reader.setTerminalHostActionHandler(recovered);
      const id = randomUUID();
      const opaque = { channelId: 'channel:team/频道', runId: 'event.run:1' };
      const job = await writer.createJob(id, 'owner', id, {
        initialMetadata: { channelExecution: opaque },
      });
      if (outcome === 'abort') await writer.abortJob(id, { expectedCreatedAt: job.createdAt });
      else
        await writer.completeJob(
          id,
          outcome === 'error' ? 'execution_failed' : undefined,
          job.createdAt,
        );
      expect((await reader.getJob(id))?.metadata.terminalHostActionPending).toBe(true);
      await expect(reader.retryTerminalHostAction(id, job.createdAt + 1)).resolves.toBe(false);
      await expect(reader.retryTerminalHostAction(id, job.createdAt)).resolves.toBe(true);
      expect(recovered).toHaveBeenCalledTimes(1);
      expect(recovered.mock.calls[0][1].channelExecution).toEqual(opaque);
      await reader.retryTerminalHostAction(id, job.createdAt);
      expect(recovered).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['{invalid', JSON.stringify({ ...marker, userId: 'injected' })])(
    'fails closed on a malformed Redis marker: %#',
    async (value) => {
      const writer = manager();
      const reader = manager();
      const id = randomUUID();
      await writer.createJob(id, 'owner', id);
      await redis.hset(`stream:{${id}}:job`, 'channelExecution', value);
      try {
        await expect(reader.getJob(id)).rejects.toThrow();
      } finally {
        await redis.hdel(`stream:{${id}}:job`, 'channelExecution');
      }
    },
  );
});
