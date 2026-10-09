import type { Redis, Cluster } from 'ioredis';

jest.spyOn(console, 'log').mockImplementation();

/**
 * Regression coverage for #14247 / #14253 (Bug 3): resuming an `ask_user_question`
 * pause with Redis Streams enabled must not crash on a graph disposed at pause time.
 *
 * Run with real Redis:
 *   USE_REDIS=true REDIS_URI=redis://127.0.0.1:6379 \
 *     npx jest hitlResumeRedis.stream_integration
 */
describe('HITL ask_user_question resume (Redis Streams)', () => {
  let ioredisClient: Redis | Cluster | null = null;
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.USE_REDIS_CLUSTER = process.env.USE_REDIS_CLUSTER ?? 'false';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = 'HitlResumeRedisTest';
    process.env.REDIS_PING_INTERVAL = '0';
    jest.resetModules();
    const { ioredisClient: client } = await import('../../cache/redisClients');
    ioredisClient = client;
  });

  afterAll(async () => {
    if (ioredisClient) {
      const keys = await ioredisClient.keys(`HitlResumeRedisTest*`);
      const streamKeys = await ioredisClient.keys(`stream:*`);
      await Promise.all([...keys, ...streamKeys].map((k) => ioredisClient!.del(k)));
      await ioredisClient.quit();
    }
    process.env = originalEnv;
  });

  /**
   * A `StandardGraph` disposed after a HITL pause: `disposeClient`
   * (api/server/cleanup.js `graphPropsToClean`) nulls `messages`/`contentData`, so the
   * SDK getters throw exactly as they would on the real object. This is the #14247 crash.
   */
  function disposedGraph() {
    return {
      messages: null,
      contentData: null,
      startIndex: null,
      getContentParts() {
        return (this.messages as unknown as unknown[]).slice(0);
      },
      getRunSteps() {
        return [...(this.contentData as unknown as unknown[])];
      },
    };
  }

  test('getContentParts / getRunSteps tolerate a disposed cached graph (no null.slice crash)', async () => {
    if (!ioredisClient) {
      console.warn('no redis');
      return;
    }
    const { RedisJobStore } = await import('../implementations/RedisJobStore');
    const store = new RedisJobStore(ioredisClient);
    await store.initialize();

    const streamId = `disposed-${Date.now()}`;
    await store.createJob(streamId, 'user-1', streamId);
    // Persist a chunk so reconstruction has durable content to fall back to.
    await store.appendChunk(streamId, {
      event: 'on_run_step',
      data: {
        id: 'step-ask',
        runId: 'resp-1',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-ask', name: 'ask_user_question', args: '' }],
        },
      },
    });

    // Cache the graph, then dispose it (mirrors AgentClient pause + disposeClient).
    store.setGraph(streamId, disposedGraph() as never);

    // Before the fix these threw "Cannot read properties of null (reading 'slice')"
    // and "this.contentData is not iterable" respectively — the awaits would reject.
    const content = await store.getContentParts(streamId);
    expect(content?.content?.[0]).toMatchObject({ tool_call: { name: 'ask_user_question' } });
    const runSteps = await store.getRunSteps(streamId);
    expect(Array.isArray(runSteps)).toBe(true);

    await store.destroy();
  });
});
