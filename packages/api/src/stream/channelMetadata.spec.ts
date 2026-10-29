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

  test.each([
    null,
    [],
    {},
    'run',
    { ...marker, userId: 'other' },
    { channelId: '', runId: 'run' },
    { channelId: 'channel', runId: 1 },
    { channelId: 'channel', runId: 'x'.repeat(257) },
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
