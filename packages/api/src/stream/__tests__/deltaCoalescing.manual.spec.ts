/* eslint jest/no-standalone-expect: ["error", { "additionalTestBlockFunctions": ["testRedis"] }] */
import type { Redis, Cluster } from 'ioredis';
import type { ServerSentEvent } from '~/types';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createStreamServices } from '~/stream/createStreamServices';

/**
 * MANUAL benchmark for streaming-delta coalescing. Not part of any CI suite.
 *
 * Measures, per (window x event-rate) scenario against a real Redis:
 *   - Redis EVAL invocations and script time (INFO commandstats)
 *   - Redis engine CPU (INFO cpu)
 *   - Node process CPU
 *   - producer await stall (the round trips production callbacks wait on)
 *   - subscriber delivery latency percentiles
 *   - published frame mix (single vs batch, mean batch size)
 *
 * Run:
 *   USE_REDIS=true REDIS_URI=redis://127.0.0.1:6379 npx jest \
 *     src/stream/__tests__/deltaCoalescing.manual.spec.ts --coverage=false --runInBand --forceExit
 */
describe('delta coalescing benchmark (manual)', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  const testPrefix = 'DeltaCoalescing-Bench';
  const redisConfigured = process.env.USE_REDIS === 'true';
  const testRedis = redisConfigured ? test : test.skip;

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = testPrefix;
    jest.resetModules();
    const redisModule = await import('~/cache/redisClients');
    ioredisClient = redisModule.ioredisClient;
  });

  afterAll(async () => {
    if (ioredisClient) {
      try {
        const keys = await ioredisClient.keys(`${testPrefix}*`);
        const streamKeys = await ioredisClient.keys(`stream:*`);
        await Promise.all([...keys, ...streamKeys].map((key) => ioredisClient!.del(key)));
        await ioredisClient.quit();
      } catch {
        /* ignore */
      }
    }
    process.env = originalEnv;
  });

  interface CommandStat {
    calls: number;
    usec: number;
  }

  function parseCommandStats(info: string): Map<string, CommandStat> {
    const stats = new Map<string, CommandStat>();
    for (const line of info.split('\n')) {
      const match = line.match(/^cmdstat_([a-z|]+):calls=(\d+),usec=(\d+)/);
      if (match) {
        stats.set(match[1], { calls: Number(match[2]), usec: Number(match[3]) });
      }
    }
    return stats;
  }

  function parseCpu(info: string): number {
    let total = 0;
    for (const line of info.split('\n')) {
      const match = line.match(/^used_cpu_(?:sys|user):([\d.]+)/);
      if (match) {
        total += Number(match[1]);
      }
    }
    return total;
  }

  function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
      return 0;
    }
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
  }

  interface ScenarioResult {
    scenario: string;
    windowMs: number;
    targetRate: number | 'serial';
    events: number;
    achievedRate: number;
    wallMs: number;
    awaitStallMs: number;
    evalCalls: number;
    evalUsec: number;
    publishCalls: number;
    xaddCalls: number;
    redisCpuSec: number;
    nodeCpuMs: number;
    deliveryP50: number;
    deliveryP95: number;
    deliveryMax: number;
    singleFrames: number;
    batchFrames: number;
    meanBatchSize: number;
    delivered: number;
  }

  const DELTA_TEXT = 'lorem ipsum token piece that approximates a realistic streamed delta ';

  async function runScenario(options: {
    windowMs: number;
    rate: number | 'serial';
    events: number;
  }): Promise<ScenarioResult> {
    const { windowMs, rate, events } = options;
    process.env.STREAM_DELTA_COALESCE_MS = String(windowMs);

    const manager = new GenerationJobManagerClass();
    manager.configure(createStreamServices({ useRedis: true, redisClient: ioredisClient! }));
    manager.initialize();

    const streamId = `bench-${windowMs}ms-${rate}-${Date.now()}`;
    await manager.createJob(streamId, 'bench-user', streamId);

    const latencies: number[] = [];
    let delivered = 0;
    const subscription = await manager.subscribe(streamId, (event) => {
      delivered++;
      const emittedAt = (event as { data?: { t?: number } }).data?.t;
      if (typeof emittedAt === 'number') {
        latencies.push(Date.now() - emittedAt);
      }
    });

    const rawSubscriber = (ioredisClient as Redis).duplicate();
    let singleFrames = 0;
    let batchFrames = 0;
    let batchedEvents = 0;
    rawSubscriber.on('message', (_channel: string, message: string) => {
      const parsed = JSON.parse(message) as { type: string; events?: unknown[] };
      if (parsed.type === 'chunk') {
        singleFrames++;
      } else if (parsed.type === 'chunk_batch') {
        batchFrames++;
        batchedEvents += parsed.events?.length ?? 0;
      }
    });
    await rawSubscriber.subscribe(`stream:{${streamId}}:events`);

    await (ioredisClient as Redis).config('RESETSTAT');
    const cpuBefore = parseCpu(await ioredisClient!.info('cpu'));
    const nodeCpuBefore = process.cpuUsage();
    const started = Date.now();
    let awaitStallMs = 0;

    if (rate === 'serial') {
      for (let i = 0; i < events; i++) {
        const before = Date.now();
        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            id: 'step-1',
            t: before,
            delta: { content: [{ type: 'text', text: `${DELTA_TEXT}${i}` }] },
          },
        });
        awaitStallMs += Date.now() - before;
      }
    } else {
      const intervalMs = 1000 / rate;
      for (let i = 0; i < events; i++) {
        const deadline = started + i * intervalMs;
        const wait = deadline - Date.now();
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        const before = Date.now();
        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: {
            id: 'step-1',
            t: before,
            delta: { content: [{ type: 'text', text: `${DELTA_TEXT}${i}` }] },
          },
        });
        awaitStallMs += Date.now() - before;
      }
    }
    const wallMs = Date.now() - started;

    await new Promise((resolve) => setTimeout(resolve, Math.max(200, windowMs * 3)));

    const stats = parseCommandStats(await ioredisClient!.info('commandstats'));
    const cpuAfter = parseCpu(await ioredisClient!.info('cpu'));
    const nodeCpuAfter = process.cpuUsage(nodeCpuBefore);

    /** Terminal-first teardown: a pre-terminal unsubscribe fires the
     * disconnected-subscriber persistence chain (XRANGE over the whole chunk
     * log + content writes), which would bleed into the NEXT scenario's
     * RESETSTAT window. After the final event it is skipped entirely. */
    await manager.emitDone(streamId, { final: true, streamId } as unknown as ServerSentEvent);
    await manager.completeJob(streamId);
    subscription?.unsubscribe();
    await manager.destroy();
    rawSubscriber.disconnect();

    await new Promise((resolve) => setTimeout(resolve, 500));
    const staleKeys = [
      ...(await ioredisClient!.keys(`${testPrefix}*`)),
      ...(await ioredisClient!.keys(`stream:*`)),
    ];
    await Promise.all(staleKeys.map((key) => ioredisClient!.del(key)));
    await new Promise((resolve) => setTimeout(resolve, 250));

    latencies.sort((a, b) => a - b);
    return {
      scenario: `${windowMs}ms @ ${rate}`,
      windowMs,
      targetRate: rate,
      events,
      achievedRate: Math.round((events / wallMs) * 1000),
      wallMs,
      awaitStallMs,
      evalCalls: stats.get('eval')?.calls ?? 0,
      evalUsec: stats.get('eval')?.usec ?? 0,
      publishCalls: stats.get('publish')?.calls ?? 0,
      xaddCalls: stats.get('xadd')?.calls ?? 0,
      redisCpuSec: Number((cpuAfter - cpuBefore).toFixed(3)),
      nodeCpuMs: Math.round((nodeCpuAfter.user + nodeCpuAfter.system) / 1000),
      deliveryP50: percentile(latencies, 50),
      deliveryP95: percentile(latencies, 95),
      deliveryMax: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
      singleFrames,
      batchFrames,
      meanBatchSize: batchFrames > 0 ? Number((batchedEvents / batchFrames).toFixed(1)) : 0,
      delivered,
    };
  }

  testRedis(
    'matrix: window x rate',
    async () => {
      const results: ScenarioResult[] = [];

      /** JIT/connection warmup; discarded so the first recorded rows are not inflated. */
      await runScenario({ windowMs: 0, rate: 200, events: 400 });
      await runScenario({ windowMs: 25, rate: 200, events: 400 });

      for (const rate of [40, 100, 200] as const) {
        for (const windowMs of [0, 20, 25, 50]) {
          results.push(await runScenario({ windowMs, rate, events: rate * 8 }));
        }
      }
      for (const windowMs of [0, 25]) {
        results.push(await runScenario({ windowMs, rate: 'serial', events: 3000 }));
      }

      console.table(
        results.map((r) => ({
          scenario: r.scenario,
          events: r.events,
          'rate ev/s': r.achievedRate,
          'eval calls': r.evalCalls,
          'eval ms': Math.round(r.evalUsec / 1000),
          'redis cpu s': r.redisCpuSec,
          'node cpu ms': r.nodeCpuMs,
          'stall ms': r.awaitStallMs,
          'p50 ms': r.deliveryP50,
          'p95 ms': r.deliveryP95,
          frames: `${r.singleFrames}s/${r.batchFrames}b`,
          'batch avg': r.meanBatchSize,
          delivered: r.delivered,
        })),
      );
      console.log(JSON.stringify(results, null, 2));

      for (const result of results) {
        expect(result.delivered).toBeGreaterThanOrEqual(result.events);
      }
    },
    15 * 60_000,
  );
});
