import { randomUUID } from 'node:crypto';
import IoRedis, { Cluster } from 'ioredis';
import type { Redis } from 'ioredis';
import type { SubagentActivityEnvelope } from '~/agents/subagentActivity';
import {
  SubagentActivityStream,
  subagentActivityStreamId,
  boundSubagentActivityUpdate,
} from '~/agents/subagentActivity';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { SUBAGENT_ACTIVITY_LIMITS } from '~/agents/activity';
import { READ_REPLAY_LUA } from '../internal/replay';

const clients: Array<Redis | Cluster> = [];
const transports: RedisEventTransport[] = [];
const subscriptions: Array<{ unsubscribe: () => void }> = [];
const prefix = `activity-replay-${randomUUID()}:`;

async function client(): Promise<Redis | Cluster> {
  const urls = (process.env.REDIS_URI ?? 'redis://127.0.0.1:6379').split(',');
  const options = { keyPrefix: prefix, maxRetriesPerRequest: 1, enableOfflineQueue: false };
  const connection =
    process.env.USE_REDIS_CLUSTER === 'true'
      ? new Cluster(
          urls.map((uri) => {
            const url = new URL(uri);
            return { host: url.hostname, port: Number(url.port) };
          }),
          { redisOptions: options, lazyConnect: true },
        )
      : new IoRedis(urls[0], { ...options, lazyConnect: true });
  clients.push(connection);
  await connection.connect();
  return connection;
}

async function replica() {
  const [publisher, subscriber] = await Promise.all([client(), client()]);
  const transport = new RedisEventTransport(publisher, subscriber);
  transports.push(transport);
  return { publisher, transport, stream: new SubagentActivityStream(transport) };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for activity');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const update = (
  sequence: number,
  phase: 'message_delta' | 'reasoning_delta' | 'run_step' = 'message_delta',
) => ({
  runId: 'parent',
  parentRunId: 'parent',
  subagentRunId: 'child',
  subagentType: 'reviewer',
  subagentKind: 'agent' as const,
  subagentAgentId: 'agent-1',
  depth: 1,
  ancestry: [],
  activityEventId: `task:${sequence}`,
  activitySequence: sequence,
  phase,
  timestamp: '2026-09-29T00:00:00.000Z',
  data:
    phase === 'run_step'
      ? {
          id: `step-${sequence}`,
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [
              { id: `call-${sequence}`, name: 'execute_code', args: { code: 'print(1)' } },
            ],
          },
        }
      : {
          delta: {
            content: [
              {
                type: phase === 'message_delta' ? 'text' : 'think',
                ...(phase === 'message_delta'
                  ? { text: `text-${sequence}` }
                  : { think: `reason-${sequence}` }),
              },
            ],
          },
        },
});

function collect(stream: SubagentActivityStream, thread: string, task: string) {
  const events: SubagentActivityEnvelope[] = [];
  const onDone = jest.fn();
  const subscription = stream.subscribe(thread, task, {
    onEvent: (envelope) => {
      if (envelope.event === 'subagent_activity_replay') events.push(...envelope.data);
      else events.push(envelope);
    },
    onDone,
  });
  subscriptions.push(subscription);
  return { events, onDone, subscription };
}

afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
  for (const transport of transports.splice(0)) transport.destroy();
  await Promise.all(
    clients.splice(0).map(async (connection) => {
      connection.disconnect();
    }),
  );
});

describe('bounded cross-replica subagent replay (real Redis)', () => {
  it('replays tool calls, reasoning and text produced without demand, then streams and reconnects', async () => {
    const owner = await replica();
    const viewer = await replica();
    const thread = randomUUID();
    const task = randomUUID();
    for (let index = 0; index < 18; index++)
      await owner.stream.publish(thread, task, update(index, 'run_step'));
    await owner.stream.publish(thread, task, update(18, 'reasoning_delta'));
    await owner.stream.publish(thread, task, update(19));
    const first = collect(viewer.stream, thread, task);
    await first.subscription.ready;
    expect(first.events.map((event) => event.data.activitySequence)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
    expect(first.events[0].data.data).toEqual(update(0, 'run_step').data);
    await owner.stream.publish(thread, task, update(20));
    await waitUntil(() => first.events.length === 21);
    first.subscription.unsubscribe();
    const replacement = collect((await replica()).stream, thread, task);
    await replacement.subscription.ready;
    expect(replacement.events.map((event) => event.data.activitySequence)).toEqual(
      Array.from({ length: 21 }, (_, i) => i),
    );
    await owner.stream.complete(thread, task, 'completed');
    await waitUntil(() => replacement.onDone.mock.calls.length === 1);
    expect(replacement.events).toHaveLength(21);
  });

  it('buffers snapshot-time live events without gaps or duplicates and does not rewind another viewer', async () => {
    const owner = await replica();
    const viewer = await replica();
    const thread = randomUUID();
    const task = randomUUID();
    await owner.stream.publish(thread, task, update(0));
    const first = collect(viewer.stream, thread, task);
    await first.subscription.ready;
    let release!: () => void;
    let captured!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshotCaptured = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const evalOriginal = viewer.publisher.eval.bind(viewer.publisher);
    jest
      .spyOn(viewer.publisher, 'eval')
      .mockImplementation(async (...args: Parameters<Redis['eval']>) => {
        const result = await evalOriginal(...args);
        if (args[0] === READ_REPLAY_LUA) {
          captured();
          await held;
        }
        return result;
      });
    const second = collect(viewer.stream, thread, task);
    await snapshotCaptured;
    await owner.stream.publish(thread, task, update(1));
    await waitUntil(() => first.events.length === 2);
    expect(second.events).toHaveLength(0);
    release();
    await second.subscription.ready;
    await waitUntil(() => second.events.length === 2);
    expect(first.events.map((event) => event.data.activitySequence)).toEqual([0, 1]);
    expect(second.events.map((event) => event.data.activitySequence)).toEqual([0, 1]);
  });

  it('recovers from a failed Redis publish without losing later activity', async () => {
    const owner = await replica();
    const viewer = await replica();
    const thread = randomUUID();
    const task = randomUUID();
    await owner.stream.publish(thread, task, update(0));
    jest
      .spyOn(owner.publisher, 'eval')
      .mockRejectedValueOnce(new Error('simulated transient Redis failure'));
    await expect(owner.stream.publish(thread, task, update(1))).rejects.toThrow('transient');
    await owner.stream.publish(thread, task, update(1));
    const attached = collect(viewer.stream, thread, task);
    await attached.subscription.ready;
    await owner.stream.publish(thread, task, update(2));
    await waitUntil(() => attached.events.length === 3);
    expect(attached.events.map((event) => event.data.activitySequence)).toEqual([0, 1, 2]);
  });

  it('deduplicates commit-before-response-loss retries without retaining duplicate chunks or DONE', async () => {
    const owner = await replica();
    const viewer = await replica();
    const thread = randomUUID();
    const task = randomUUID();
    const streamId = subagentActivityStreamId(thread, task);
    const attached = collect(viewer.stream, thread, task);
    await attached.subscription.ready;
    const originalEval = owner.publisher.eval.bind(owner.publisher);
    jest
      .spyOn(owner.publisher, 'eval')
      .mockImplementationOnce(async (...args: Parameters<Redis['eval']>) => {
        await originalEval(...args);
        throw new Error('response lost after commit');
      });
    await expect(owner.stream.publish(thread, task, update(0))).rejects.toThrow('response lost');
    await owner.stream.publish(thread, task, update(0));
    await owner.stream.publish(thread, task, update(1));
    await owner.stream.publish(thread, task, update(0));
    expect(await owner.publisher.get(`stream:{${streamId}}:seq`)).toBe('2');
    expect(await owner.publisher.llen(`stream:{${streamId}}:activity-backlog`)).toBe(2);
    jest
      .spyOn(owner.publisher, 'eval')
      .mockImplementationOnce(async (...args: Parameters<Redis['eval']>) => {
        await originalEval(...args);
        throw new Error('terminal response lost after commit');
      });
    await expect(owner.stream.complete(thread, task, 'completed')).rejects.toThrow('response lost');
    await owner.stream.complete(thread, task, 'completed');
    await owner.stream.publish(thread, task, update(2));
    await waitUntil(() => attached.onDone.mock.calls.length === 1);
    expect(attached.events.map((event) => event.data.activitySequence)).toEqual([0, 1]);
    expect(await owner.publisher.get(`stream:{${streamId}}:seq`)).toBe('3');
    expect(await owner.publisher.llen(`stream:{${streamId}}:activity-backlog`)).toBe(3);
  });

  it('retains the largest permitted payload including wire and omission-marker overhead', async () => {
    const owner = await replica();
    const thread = randomUUID();
    const task = randomUUID();
    let low = 0;
    let high = 65_536;
    const candidate = (length: number) => ({ ...update(0), data: { text: 'x'.repeat(length) } });
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (boundSubagentActivityUpdate(candidate(middle)).data != null) low = middle;
      else high = middle - 1;
    }
    const event = candidate(low);
    expect(low).toBeGreaterThan(63 * 1024);
    await owner.stream.publish(thread, task, event, Number.MAX_SAFE_INTEGER);
    const retained = await owner.publisher.lrange(
      `stream:{${subagentActivityStreamId(thread, task)}}:activity-backlog`,
      0,
      -1,
    );
    expect(retained).toHaveLength(1);
    expect(Buffer.byteLength(retained[0])).toBeLessThanOrEqual(SUBAGENT_ACTIVITY_LIMITS.bytes);
    expect(JSON.parse(retained[0]).data.data.data).toEqual(event.data);
  });

  it('injects retention long enough to cover a silent tool interval', async () => {
    const owner = await replica();
    const thread = randomUUID();
    const task = randomUUID();
    const stream = new SubagentActivityStream(owner.transport, { replayTtlMs: 3_600_000 });
    await stream.publish(thread, task, update(0));
    const ttl = await owner.publisher.pttl(
      `stream:{${subagentActivityStreamId(thread, task)}}:activity-backlog`,
    );
    expect(ttl).toBeGreaterThan(3_590_000);
    expect(ttl).toBeLessThanOrEqual(3_600_000);
  });

  it('renews demand for an older publisher during a rolling deployment', async () => {
    const owner = await replica();
    const viewer = await replica();
    const thread = randomUUID();
    const task = randomUUID();
    const attached = collect(viewer.stream, thread, task);
    await attached.subscription.ready;
    const streamId = subagentActivityStreamId(thread, task);
    const publishLegacy = async (sequence: number) => {
      if (!(await owner.transport.hasDemand(streamId))) return;
      await owner.transport.emitChunk(streamId, {
        event: 'on_subagent_update',
        data: update(sequence),
      });
    };
    expect(await owner.transport.hasDemand(streamId)).toBe(true);
    await publishLegacy(0);
    await waitUntil(() => attached.events.length === 1);
    expect(await owner.publisher.pttl(`stream:{${streamId}}:demand`)).toBeGreaterThan(0);
    if (await owner.transport.hasDemand(streamId)) {
      await owner.transport.emitDone(streamId, {
        final: true,
        subagentActivity: true,
        status: 'completed',
      });
    }
    await waitUntil(() => attached.onDone.mock.calls.length === 1);
    expect(attached.events[0].data.activitySequence).toBe(0);
  });

  it('preserves an older owner frame published between SUBSCRIBE and snapshot capture', async () => {
    const owner = await replica();
    const viewer = await replica();
    const thread = randomUUID();
    const task = randomUUID();
    const streamId = subagentActivityStreamId(thread, task);
    const originalEval = viewer.publisher.eval.bind(viewer.publisher);
    jest
      .spyOn(viewer.publisher, 'eval')
      .mockImplementationOnce(async (...args: Parameters<Redis['eval']>) => {
        expect(args[0]).toBe(READ_REPLAY_LUA);
        await owner.transport.emitChunk(streamId, { event: 'on_subagent_update', data: update(0) });
        return originalEval(...args);
      });
    const attached = collect(viewer.stream, thread, task);
    await attached.subscription.ready;
    expect(attached.events.map((event) => event.data.activitySequence)).toEqual([0]);
    await owner.transport.emitChunk(streamId, { event: 'on_subagent_update', data: update(1) });
    await waitUntil(() => attached.events.length === 2);
    expect(attached.events.map((event) => event.data.activitySequence)).toEqual([0, 1]);
  });

  it('caps retained items and encoded bytes, expires them, and preserves the shared sequence', async () => {
    const owner = await replica();
    const streamId = subagentActivityStreamId(randomUUID(), randomUUID());
    const limits = { items: 3, bytes: 250, ttlMs: 100 };
    for (let index = 0; index < 8; index++)
      await owner.transport.emitReplayableChunk(streamId, { text: `payload-${index}` }, limits);
    const key = `stream:{${streamId}}:activity-backlog`;
    const backlog = await owner.publisher.lrange(key, 0, -1);
    expect(backlog.length).toBeLessThanOrEqual(3);
    expect(
      backlog.reduce((bytes, event) => bytes + Buffer.byteLength(event), 0),
    ).toBeLessThanOrEqual(250);
    const pttl = await owner.publisher.pttl(key);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(100);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(await owner.publisher.exists(key)).toBe(0);
    expect(await owner.publisher.get(`stream:{${streamId}}:seq`)).toBe('8');
    expect(SUBAGENT_ACTIVITY_LIMITS).toMatchObject({ items: 100, bytes: 65536 });
  });

  it('retains terminal frames and rejects a stalled attachment with bounded live buffering', async () => {
    const owner = await replica();
    const viewer = await replica();
    const streamId = subagentActivityStreamId(randomUUID(), randomUUID());
    const limits = { items: 3, bytes: 4096, ttlMs: 1000 };
    await owner.transport.emitReplayableChunk(streamId, { text: 'before' }, limits);
    await owner.transport.emitReplayableDone(streamId, { final: true }, limits);
    const onReplay = jest.fn();
    const onDone = jest.fn();
    const subscription = viewer.transport.subscribe(
      streamId,
      { onChunk: jest.fn(), onReplay, onDone },
      { replay: limits },
    );
    subscriptions.push(subscription);
    await subscription.ready;
    expect(onReplay).toHaveBeenCalledWith([{ text: 'before' }]);
    expect(onDone).toHaveBeenCalledWith({ final: true });
    const stalledStreamId = subagentActivityStreamId(randomUUID(), randomUUID());
    const held = new Promise<never>(() => undefined);
    jest.spyOn(viewer.publisher, 'eval').mockImplementationOnce(() => held);
    const onError = jest.fn();
    const stalled = viewer.transport.subscribe(
      stalledStreamId,
      { onChunk: jest.fn(), onError },
      { replay: limits },
    );
    subscriptions.push(stalled);
    const readyFailure = stalled.ready?.catch((error: Error) => error.message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    for (let i = 0; i < 4; i++)
      await owner.transport.emitReplayableChunk(stalledStreamId, { text: i }, limits);
    await waitUntil(() => onError.mock.calls.length === 1);
    expect(onError.mock.calls[0][0]).toContain('overflow');
    expect(await readyFailure).toContain('Timed out synchronizing');
  });
});
