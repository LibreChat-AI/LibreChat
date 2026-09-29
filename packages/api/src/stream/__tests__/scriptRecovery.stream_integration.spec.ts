import { trace } from '@opentelemetry/api';
import type { Redis, Cluster } from 'ioredis';
import {
  createRedisRequestTelemetry,
  finishRedisRequestTelemetry,
  instrumentIORedisClient,
  RedisUseCases,
  runWithRedisRequestTelemetry,
} from '~/cache/redisTelemetry';
import { clearRedisTestPrefix, createRedisTestClient } from './helpers/redis';
import { RedisJobStore } from '../implementations/RedisJobStore';
import { evalScript } from '~/cache/redisScript';

const describeRedis = process.env.USE_REDIS === 'true' ? describe : describe.skip;

describeRedis('Redis script cache recovery', () => {
  const keyPrefix = 'ScriptRecovery-Integration-Test:';
  let redis: Redis | Cluster;
  let originalWindow: string | undefined;

  /** Invalidate only server state: the caller must recover without any test-only state reset. */
  async function invalidateServerScripts(): Promise<void> {
    const nodes = (redis as Cluster).isCluster
      ? (redis as Cluster).nodes('master')
      : [redis as Redis];
    await Promise.all(nodes.map((node) => node.script('FLUSH')));
  }

  beforeAll(async () => {
    originalWindow = process.env.STREAM_DELTA_COALESCE_MS;
    process.env.STREAM_DELTA_COALESCE_MS = '25';
    redis = createRedisTestClient(keyPrefix);
    await redis.connect();
  });

  afterEach(async () => {
    await clearRedisTestPrefix(redis, keyPrefix);
  });

  afterAll(async () => {
    redis.disconnect();
    if (originalWindow === undefined) {
      delete process.env.STREAM_DELTA_COALESCE_MS;
    } else {
      process.env.STREAM_DELTA_COALESCE_MS = originalWindow;
    }
  });

  test.each(['pending', 'already-flushing'])(
    'preserves durable order after partial warm-up (%s)',
    async (mode) => {
      const store = new RedisJobStore(redis);
      const streamId = `recovery-${mode}`;
      const event = (text: string) => ({ event: 'on_message_delta', data: { text } });
      try {
        await redis.hset(`stream:{${streamId}}:job`, 'createdAt', '100', 'status', 'running');
        const warmBatch = store.appendChunk(streamId, event('warm-batch'), 100, undefined, {
          coalesce: true,
        });
        await store.flushPendingAppends(streamId);
        expect(await warmBatch).toBe(true);
        expect(await store.appendChunk(streamId, event('warm-direct'), 100)).toBe(true);

        await invalidateServerScripts();
        expect(await store.appendChunk(streamId, event('reload-direct-only'), 100)).toBe(true);
        await redis.del(`stream:{${streamId}}:chunks`);

        const delta = store.appendChunk(streamId, event('earlier-delta'), 100, undefined, {
          coalesce: true,
        });
        const flushing =
          mode === 'already-flushing' ? store.flushPendingAppends(streamId) : Promise.resolve();
        const control = { event: 'on_pending_action', data: { text: 'later-control' } };
        const appended = store.appendChunk(streamId, control, 100);
        expect(await delta).toBe(true);
        expect(await appended).toBe(true);
        await flushing;

        const entries = await redis.xrange(`stream:{${streamId}}:chunks`, '-', '+');
        expect(entries.map(([, fields]) => fields[1])).toEqual([
          JSON.stringify(event('earlier-delta')),
          JSON.stringify(control),
        ]);
      } finally {
        await store.destroy();
      }
    },
  );

  test('recovers a previously successful SHA in one fallback without recording an error', async () => {
    const client = instrumentIORedisClient(redis, RedisUseCases.GENERATION_STREAM);
    const script = 'return ARGV[1]';
    const key = '{recovery-metrics}:key';
    await expect(evalScript(client, script, 1, key, 'warm')).resolves.toBe('warm');
    await invalidateServerScripts();
    const evalsha = jest.spyOn(redis, 'evalsha');
    const evalCommand = jest.spyOn(redis, 'eval');
    const span = trace.getTracer('script-recovery-test').startSpan('recovery');
    const telemetry = createRedisRequestTelemetry(span);

    await runWithRedisRequestTelemetry(telemetry, async () => {
      await expect(evalScript(client, script, 1, key, 'recovered')).resolves.toBe('recovered');
    });
    finishRedisRequestTelemetry(telemetry);
    span.end();

    expect(telemetry.errors).toBe(0);
    expect(evalsha).toHaveBeenCalledTimes(1);
    expect(evalCommand).toHaveBeenCalledTimes(1);
    await expect(evalScript(client, script, 1, key, 'warm-again')).resolves.toBe('warm-again');
    expect(evalsha).toHaveBeenCalledTimes(2);
    expect(evalCommand).toHaveBeenCalledTimes(1);
  });

  test('records a failed EVAL recovery and does not fail an independent concurrent call', async () => {
    const client = instrumentIORedisClient(redis, RedisUseCases.GENERATION_STREAM);
    const script =
      'if ARGV[1] == "fail" then return redis.error_reply("ERR recovery failed") end return ARGV[1]';
    const key = '{recovery-failure}:key';
    await expect(evalScript(client, script, 1, key, 'warm')).resolves.toBe('warm');
    await invalidateServerScripts();
    const span = trace.getTracer('script-recovery-test').startSpan('failed-recovery');
    const telemetry = createRedisRequestTelemetry(span);

    await runWithRedisRequestTelemetry(telemetry, async () => {
      const failed = evalScript(client, script, 1, key, 'fail');
      const successor = evalScript(client, script, 1, key, 'successor');
      await expect(failed).rejects.toThrow('ERR recovery failed');
      await expect(successor).resolves.toBe('successor');
    });
    finishRedisRequestTelemetry(telemetry);
    span.end();
    expect(telemetry.errors).toBe(1);
  });

  test.each([false, true])(
    'atomic claim races retain exactly one winner (cache flushed: %s)',
    async (flush) => {
      const store = new RedisJobStore(redis);
      const claim = (index: number) => ({
        streamId: `claim-${index}`,
        conversationId: 'conversation',
        claimedAt: 100,
        claimToken: `token-${index}`,
      });
      try {
        await store.claimIdempotencyKey('{claim-race}:warm', claim(0), 60);
        if (flush) {
          await invalidateServerScripts();
        }
        const key = `{claim-race}:contended-${flush}`;
        const results = await Promise.all(
          Array.from({ length: 32 }, (_, index) =>
            store.claimIdempotencyKey(key, claim(index), 60),
          ),
        );
        const winners = results.filter((result) => result.claimed);
        expect(winners).toHaveLength(1);
        expect(winners[0].existing).toEqual(
          expect.objectContaining({ claimToken: expect.any(String) }),
        );
        expect(
          results.every(
            (result) => result.existing?.claimToken === winners[0].existing?.claimToken,
          ),
        ).toBe(true);
        expect(await store.getIdempotencyClaim(key)).toEqual(winners[0].existing);
        await store.releaseIdempotencyKey(key, winners[0].existing);
        expect(await store.hasIdempotencyKey(key)).toBe(false);
      } finally {
        await store.destroy();
      }
    },
  );

  test('dispatches a same-stream burst without a response-dependent queue', async () => {
    const store = new RedisJobStore(redis);
    const streamId = 'pipelined-burst';
    try {
      await redis.hset(`stream:{${streamId}}:job`, 'createdAt', '100', 'status', 'running');
      const evalCommand = jest.spyOn(redis, 'eval');
      const evalsha = jest.spyOn(redis, 'evalsha');
      const events = Array.from({ length: 32 }, (_, index) => ({ event: 'delta', data: index }));
      const pending = events.map((event) => store.appendChunk(streamId, event, 100));
      expect(evalCommand).toHaveBeenCalledTimes(32);
      expect(evalsha).not.toHaveBeenCalled();
      expect(await Promise.all(pending)).toEqual(events.map(() => true));
      const entries = await redis.xrange(`stream:{${streamId}}:chunks`, '-', '+');
      expect(entries.map(([, fields]) => fields[1])).toEqual(
        events.map((event) => JSON.stringify(event)),
      );
    } finally {
      await store.destroy();
    }
  });
});
