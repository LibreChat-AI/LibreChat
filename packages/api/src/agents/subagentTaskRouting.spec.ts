import { EventEmitter } from 'node:events';
import type {
  SubagentTaskControlCommand,
  SubagentTaskControlResult,
  SubagentTaskSnapshot,
} from '@librechat/agents';
import type { Cluster, Redis } from 'ioredis';
import type { SubagentTaskControlHandler } from './subagentTaskRouting';
import {
  controlFingerprint,
  RedisSubagentTaskControlTransport,
  SubagentTaskOwnerUnavailableError,
} from './subagentTaskRouting';

type MessageListener = (channel: string, message: string) => void;

class FakeRedisBus {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly clients = new Set<FakeRedisClient>();
  dropResponses = 0;
  /** Acknowledgements that reach nobody, as Redis reports during a resubscribe. */
  ackFailures = 0;
  registrationFailures = 0;
  registrationHook?: (taskId: string) => Promise<void>;

  createClient(): FakeRedisClient {
    const client = new FakeRedisClient(this);
    this.clients.add(client);
    return client;
  }

  publish(channel: string, message: string): number {
    if (this.dropResponses > 0 && channel.endsWith(':requester')) {
      this.dropResponses -= 1;
      return 1;
    }
    if (this.ackFailures > 0 && message.includes('"kind":"ack"')) {
      this.ackFailures -= 1;
      return 0;
    }
    let delivered = 0;
    for (const client of this.clients) {
      if (!client.disconnected && client.channels.has(channel)) {
        delivered += 1;
        for (const listener of client.listeners) {
          queueMicrotask(() => listener(channel, message));
        }
      }
    }
    return delivered;
  }
}

class FakeRedisClient {
  readonly channels = new Set<string>();
  readonly listeners = new Set<MessageListener>();
  disconnected = false;

  constructor(private readonly bus: FakeRedisBus) {}

  on(event: string, listener: MessageListener): this {
    if (event === 'message') {
      this.listeners.add(listener);
    }
    return this;
  }

  off(event: string, listener: MessageListener): this {
    if (event === 'message') {
      this.listeners.delete(listener);
    }
    return this;
  }

  async subscribe(channel: string): Promise<number> {
    this.channels.add(channel);
    return this.channels.size;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.channels.delete(channel);
    return this.channels.size;
  }

  disconnect(): void {
    this.disconnected = true;
    this.channels.clear();
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.bus.publish(channel, message);
  }

  async eval(
    _script: string,
    _keyCount: number,
    key: string,
    ...args: string[]
  ): Promise<number | string | string[] | null> {
    const hash = this.bus.hashes.get(key) ?? new Map<string, string>();
    if (args.length === 3) {
      if (this.bus.registrationFailures > 0) {
        this.bus.registrationFailures -= 1;
        throw new Error('temporary registration failure');
      }
      const [taskId, ownerId, ttlMs] = args;
      if (this.bus.registrationHook != null) {
        await this.bus.registrationHook(taskId);
      }
      hash.set(taskId, `${Date.now() + Number(ttlMs)}|${ownerId}`);
      this.bus.hashes.set(key, hash);
      return 1;
    }
    const readOwner = (taskId: string): string | null => {
      const value = hash.get(taskId);
      const separator = value?.indexOf('|') ?? -1;
      const expiresAt = separator < 0 ? Number.NaN : Number(value?.slice(0, separator));
      if (value == null || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        hash.delete(taskId);
        return null;
      }
      return value.slice(separator + 1);
    };
    if (args.length === 1) {
      return readOwner(args[0]);
    }
    return [...hash.keys()].flatMap((taskId) => {
      const ownerId = readOwner(taskId);
      return ownerId == null ? [] : [taskId, ownerId];
    });
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.bus.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.bus.hashes.get(key) ?? []);
  }

  async hlen(key: string): Promise<number> {
    return this.bus.hashes.get(key)?.size ?? 0;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    let deleted = 0;
    for (const field of fields) {
      deleted += this.bus.hashes.get(key)?.delete(field) ? 1 : 0;
    }
    return deleted;
  }
}

function asRedis(client: FakeRedisClient): Redis | Cluster {
  return client as unknown as Redis;
}

function snapshot(overrides: Partial<SubagentTaskSnapshot> = {}): SubagentTaskSnapshot {
  return {
    taskId: 'task-1',
    threadId: 'thread-1',
    subagentType: 'researcher',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    resultAvailable: false,
    resultClaimed: false,
    pendingControls: 0,
    ...overrides,
  };
}

function taskHandler(
  overrides: Partial<SubagentTaskControlHandler> = {},
): SubagentTaskControlHandler {
  return {
    claim: () => ({ status: 'not_found' }),
    control: () => ({ status: 'not_found' }),
    list: () => [],
    retainsTaskOwnership: () => false,
    cancelScope: () => 0,
    ...overrides,
  };
}

describe('RedisSubagentTaskControlTransport', () => {
  it('waits for the fail-fast publisher before reporting itself bound', async () => {
    const bus = new FakeRedisBus();
    const publisher = new EventEmitter() as EventEmitter & { status: string };
    publisher.status = 'connecting';
    const transport = new RedisSubagentTaskControlTransport(
      publisher as unknown as Redis,
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'waiting-owner' },
    );

    let bound = false;
    const binding = transport.bind(taskHandler()).then(() => {
      bound = true;
    });
    await Promise.resolve();
    expect(bound).toBe(false);

    publisher.status = 'ready';
    publisher.emit('ready');
    await binding;
    expect(bound).toBe(true);
    await transport.destroy();
  });

  it('routes list, claim, and controls to the owner and deduplicates a retried command', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const control = jest.fn(
      (_scopeId: string, _taskId: string, _command: SubagentTaskControlCommand) =>
        ({
          status: 'accepted',
          task: snapshot(),
          controlId: 'control-1',
        }) satisfies SubagentTaskControlResult,
    );
    const claim = jest.fn(() => ({ status: 'running', task: snapshot() }) as const);
    await owner.bind(taskHandler({ claim, control, list: () => [snapshot()] }));
    await requester.bind(taskHandler({ claim, control }));
    await owner.registerTask('scope-1', 'task-1', 60_000);

    await expect(requester.hasTasks('scope-1')).resolves.toBe(true);
    await expect(requester.list('scope-1')).resolves.toEqual([snapshot()]);
    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'running',
    });

    bus.dropResponses = 1;
    await expect(
      requester.control(
        'scope-1',
        'task-1',
        { action: 'queue', message: 'Check one more source.' },
        'invocation-1',
      ),
    ).resolves.toMatchObject({ status: 'accepted', controlId: 'control-1' });
    expect(control).toHaveBeenCalledTimes(1);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('recomputes an idempotent list when its first response is lost', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const list = jest.fn(() => [snapshot()]);
    const handler = taskHandler({
      claim: () => ({ status: 'running', task: snapshot() }) as const,
      list,
    });
    await owner.bind(handler);
    await requester.bind({ ...handler, list: () => [] });
    await owner.registerTask('scope-1', 'task-1', 60_000);
    bus.dropResponses = 1;

    await expect(requester.list('scope-1')).resolves.toEqual([snapshot()]);
    expect(list).toHaveBeenCalledTimes(2);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('reports a registered but unreachable task owner as unavailable', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    const handler = taskHandler();
    await owner.bind(handler);
    await requester.bind(handler);
    await owner.registerTask('scope-1', 'task-1', 60_000);
    await owner.destroy();

    await expect(
      requester.control('scope-1', 'task-1', { action: 'cancel' }, 'invocation-dead-owner'),
    ).rejects.toBeInstanceOf(SubagentTaskOwnerUnavailableError);
    await requester.destroy();
  });

  it('delivers the largest default task result without consuming it on the owner', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const result = '\u0000'.repeat(100_000);
    const claim = jest.fn(() => ({
      status: 'completed' as const,
      task: snapshot({ status: 'completed', resultAvailable: true }),
      result,
    }));
    const handler = taskHandler({
      claim,
      list: () => [snapshot({ status: 'completed', resultAvailable: true })],
    });
    await owner.bind(handler);
    await requester.bind({ ...handler, list: () => [] });
    await owner.registerTask('scope-1', 'task-1', 60_000);

    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'completed',
      result,
    });
    expect(claim).toHaveBeenCalledTimes(1);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('keeps consuming claims when earlier results were never acknowledged', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    const result = '\u0000'.repeat(100_000);
    const claim = jest.fn((_scopeId: string, taskId: string) => ({
      status: 'completed' as const,
      task: snapshot({ taskId, status: 'completed', resultAvailable: true }),
      result,
    }));
    await owner.bind(taskHandler({ claim }));
    await requester.bind(taskHandler());
    const taskIds = Array.from({ length: 40 }, (_, index) => `task-${index + 1}`);
    await Promise.all(taskIds.map((taskId) => owner.registerTask('scope-1', taskId, 60_000)));

    /** Every response is lost, so nothing is ever acknowledged or released. */
    bus.dropResponses = taskIds.length * 2;
    for (const taskId of taskIds) {
      await expect(requester.claim('scope-1', taskId)).rejects.toBeInstanceOf(
        SubagentTaskOwnerUnavailableError,
      );
    }

    /** Retention is a fast path over a durable result, so abandoned copies bound
     * themselves instead of refusing later callers until the process restarts. */
    const { claimReplays } = owner as unknown as {
      claimReplays: { entries: Map<string, unknown>; bytes: number };
    };
    expect(claim).toHaveBeenCalledTimes(taskIds.length);
    expect(claimReplays.entries.size).toBeLessThanOrEqual(2_000);
    expect(claimReplays.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);

    bus.dropResponses = 0;
    await owner.registerTask('scope-1', 'task-late', 60_000);
    await expect(requester.claim('scope-1', 'task-late')).resolves.toMatchObject({
      status: 'completed',
    });

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('replays one invocation and applies two identical invocations separately', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    const control = jest.fn((_scopeId: string, taskId: string) => ({
      status: 'accepted' as const,
      task: snapshot({ taskId }),
      controlId: 'control-1',
    }));
    await owner.bind(taskHandler({ control }));
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);
    const steer = { action: 'queue' as const, message: 'Check one more source.' };

    /** The command is applied, but both responses for that invocation are lost. */
    bus.dropResponses = 2;
    await expect(
      requester.control('scope-1', 'task-1', steer, 'invocation-a'),
    ).rejects.toBeInstanceOf(SubagentTaskOwnerUnavailableError);
    expect(control).toHaveBeenCalledTimes(1);

    /** Retransmitting that invocation replays the owner's result. */
    await expect(
      requester.control('scope-1', 'task-1', steer, 'invocation-a'),
    ).resolves.toMatchObject({ status: 'accepted', controlId: 'control-1' });
    expect(control).toHaveBeenCalledTimes(1);

    /** A separate invocation of the identical command is a second command. */
    await expect(
      requester.control('scope-1', 'task-1', steer, 'invocation-b'),
    ).resolves.toMatchObject({ status: 'accepted' });
    expect(control).toHaveBeenCalledTimes(2);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('retries and refreshes owner registration while the local task is retained', async () => {
    const bus = new FakeRedisBus();
    bus.registrationFailures = 1;
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', registrationHeartbeatMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester' },
    );
    const handler = taskHandler({
      claim: () => ({ status: 'running', task: snapshot() }) as const,
      list: () => [snapshot()],
    });
    await owner.bind(handler);
    await requester.bind({ ...handler, list: () => [] });
    await expect(owner.registerTask('scope-1', 'task-1', 60_000)).rejects.toThrow(
      'temporary registration failure',
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await requester.hasTasks('scope-1')) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await expect(requester.hasTasks('scope-1')).resolves.toBe(true);

    bus.hashes.clear();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await requester.hasTasks('scope-1')) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await expect(requester.hasTasks('scope-1')).resolves.toBe(true);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('keeps a receipt-only owner registered until deletion cleanup can reach it', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', registrationHeartbeatMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 100, retryDelayMs: 5 },
    );
    let receiptPending = true;
    const cancelScope = jest.fn(() => 0);
    await owner.bind(
      taskHandler({
        retainsTaskOwnership: (_scopeId, taskId) => receiptPending && taskId === 'task-1',
        cancelScope,
      }),
    );
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);

    /** Model the SDK task/result buckets dropping the task and Redis losing the
     * directory entry before the next owner heartbeat. Pending receipt work is
     * the only remaining reason this process can still handle deletion cleanup. */
    bus.hashes.clear();
    for (let attempt = 0; attempt < 100 && !(await requester.hasTasks('scope-1')); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await expect(requester.hasTasks('scope-1')).resolves.toBe(true);
    await expect(requester.cancelScope('scope-1', null, ['deleted-child-thread'])).resolves.toBe(0);
    expect(cancelScope).toHaveBeenCalledWith('scope-1', null, ['deleted-child-thread']);

    receiptPending = false;
    bus.hashes.clear();
    for (let attempt = 0; attempt < 100 && (await requester.hasTasks('scope-1')); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await expect(requester.hasTasks('scope-1')).resolves.toBe(false);
    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('expires a dead owner independently while another owner keeps the scope active', async () => {
    const bus = new FakeRedisBus();
    const deadOwner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'dead-owner', registrationHeartbeatMs: 5 },
    );
    const liveOwner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'live-owner', registrationHeartbeatMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    const deadTask = snapshot({ taskId: 'dead-task' });
    const liveTask = snapshot({ taskId: 'live-task' });
    await deadOwner.bind(
      taskHandler({ claim: () => ({ status: 'running', task: deadTask }), list: () => [deadTask] }),
    );
    await liveOwner.bind(
      taskHandler({ claim: () => ({ status: 'running', task: liveTask }), list: () => [liveTask] }),
    );
    await requester.bind(taskHandler());
    await deadOwner.registerTask('scope-1', deadTask.taskId, 20);
    await liveOwner.registerTask('scope-1', liveTask.taskId, 20);
    await deadOwner.destroy();

    /** The dead owner's entry lapses on its own TTL while the live owner's heartbeat
     * re-registers its entry against that same TTL, so a runner that stalls past 20ms
     * can find both gone for one beat. Poll until the directory settles rather than
     * asserting on a single sleep. */
    let listed: SubagentTaskSnapshot[] = [];
    for (let attempt = 0; attempt < 100 && listed.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      try {
        listed = await requester.list('scope-1');
      } catch (error) {
        /** The dead owner is still registered, so the request routes to a process that
         * answers nothing. Anything else is a real failure. */
        if (!(error instanceof SubagentTaskOwnerUnavailableError)) {
          throw error;
        }
      }
    }
    expect(listed).toEqual([liveTask]);
    await Promise.all([liveOwner.destroy(), requester.destroy()]);
  });

  it('does not prune registered tasks omitted from a capped owner response', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const tasks = Array.from({ length: 201 }, (_, index) =>
      snapshot({ taskId: `task-${index + 1}` }),
    );
    const handler = taskHandler({
      claim: (_scopeId: string, taskId: string) => ({
        status: 'running' as const,
        task: snapshot({ taskId }),
      }),
      list: () => tasks,
    });
    await owner.bind(handler);
    await requester.bind({ ...handler, list: () => [] });
    await Promise.all(tasks.map((task) => owner.registerTask('scope-1', task.taskId, 60_000)));

    await expect(requester.list('scope-1')).resolves.toHaveLength(200);
    await expect(requester.claim('scope-1', 'task-201')).resolves.toMatchObject({
      status: 'running',
      task: { taskId: 'task-201' },
    });

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('refreshes owner registrations in bounded parallel batches', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', registrationHeartbeatMs: 5 },
    );
    const taskIds = Array.from({ length: 80 }, (_, index) => `task-${index + 1}`);
    const [staleTaskId, ...retainedTaskIds] = taskIds;
    await owner.bind(
      taskHandler({ list: () => retainedTaskIds.map((taskId) => snapshot({ taskId })) }),
    );
    await Promise.all(taskIds.map((taskId) => owner.registerTask('scope-1', taskId, 60_000)));

    const started: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bus.registrationHook = async (taskId) => {
      started.push(taskId);
      await gate;
    };

    for (let attempt = 0; attempt < 100 && started.length < 32; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    /** A serialized pass would hold exactly one refresh open; the batch bound, not
     * the pass, is what limits concurrency. */
    expect(started).toHaveLength(32);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(started).toHaveLength(32);

    release();
    for (
      let attempt = 0;
      attempt < 200 && new Set(started).size < retainedTaskIds.length;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(new Set(started)).toEqual(new Set(retainedTaskIds));
    const [registry] = [...bus.hashes.values()];
    expect(registry.has(staleTaskId)).toBe(false);
    expect(registry.size).toBe(retainedTaskIds.length);

    bus.registrationHook = undefined;
    await owner.destroy();
  });

  it('keeps refreshing other registrations when one registration fails', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', registrationHeartbeatMs: 5 },
    );
    const taskIds = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'];
    await owner.bind(taskHandler({ list: () => taskIds.map((taskId) => snapshot({ taskId })) }));
    await Promise.all(taskIds.map((taskId) => owner.registerTask('scope-1', taskId, 60_000)));

    bus.hashes.clear();
    bus.registrationHook = async (taskId) => {
      if (taskId === 'task-1') {
        throw new Error('registration failed');
      }
    };

    const healthyTaskIds = taskIds.slice(1);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [registry] = [...bus.hashes.values()];
      if (registry != null && registry.size >= healthyTaskIds.length) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const [registry] = [...bus.hashes.values()];
    expect([...registry.keys()].sort()).toEqual(healthyTaskIds);

    bus.registrationHook = undefined;
    await owner.destroy();
  });

  it('cancels every task in a scope beyond the model-facing list cap', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const tasks = Array.from({ length: 201 }, (_, index) =>
      snapshot({ taskId: `task-${index + 1}`, threadId: `thread-${index + 1}` }),
    );
    const requests: Array<string[] | null> = [];
    await owner.bind(
      taskHandler({
        list: () => tasks,
        cancelScope: (_scopeId, threadIds) => {
          requests.push(threadIds);
          return threadIds == null ? tasks.length : threadIds.length;
        },
      }),
    );
    await requester.bind(taskHandler());
    await Promise.all(tasks.map((task) => owner.registerTask('scope-1', task.taskId, 60_000)));

    /** The model-facing list stays capped, but cancellation still reaches every task. */
    await expect(requester.list('scope-1')).resolves.toHaveLength(200);
    await expect(requester.cancelScope('scope-1', null)).resolves.toBe(201);
    expect(requests).toEqual([null]);

    const threadIds = tasks.map((_task, index) => `thread-${index + 1}`);
    await expect(requester.cancelScope('scope-1', threadIds)).resolves.toBe(201);
    expect(requests.slice(1).map((batch) => batch?.length)).toEqual([200, 1]);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('caps the aggregated list across owners rather than per owner', async () => {
    const bus = new FakeRedisBus();
    const owners = ['owner-a', 'owner-b'].map(
      (instanceId) =>
        new RedisSubagentTaskControlTransport(
          asRedis(bus.createClient()),
          asRedis(bus.createClient()),
          { namespace: 'test', instanceId, requestTimeoutMs: 200, retryDelayMs: 10 },
        ),
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    await Promise.all(
      owners.map(async (owner, ownerIndex) => {
        const tasks = Array.from({ length: 150 }, (_unused, index) =>
          snapshot({
            taskId: `owner-${ownerIndex}-task-${index + 1}`,
            threadId: `owner-${ownerIndex}-thread-${index + 1}`,
          }),
        );
        await owner.bind(taskHandler({ list: () => tasks }));
        await Promise.all(tasks.map((task) => owner.registerTask('scope-1', task.taskId, 60_000)));
      }),
    );
    await requester.bind(taskHandler());

    /** Each owner bounds its own reply, so an unbounded merge would hand the model
     * every replica's batch and grow the poll response with the deployment. */
    await expect(requester.list('scope-1')).resolves.toHaveLength(200);

    await Promise.all([...owners.map((owner) => owner.destroy()), requester.destroy()]);
  });

  it('keeps running tasks when one owner caps its own reply', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    /** One owner holding more than the cap, oldest settled first: a positional slice in
     * the reply drops the running children before the requester can bound anything. */
    const tasks = [
      ...Array.from({ length: 190 }, (_unused, index) =>
        snapshot({
          taskId: `settled-${index + 1}`,
          threadId: `settled-thread-${index + 1}`,
          status: 'completed',
          createdAt: index + 1,
          resultAvailable: true,
        }),
      ),
      ...Array.from({ length: 30 }, (_unused, index) =>
        snapshot({
          taskId: `running-${index + 1}`,
          threadId: `running-thread-${index + 1}`,
          status: 'running',
          createdAt: 1_000 + index,
        }),
      ),
    ];
    await owner.bind(taskHandler({ list: () => tasks }));
    await Promise.all(tasks.map((task) => owner.registerTask('scope-1', task.taskId, 60_000)));
    await requester.bind(taskHandler());

    const listed = await requester.list('scope-1');
    expect(listed).toHaveLength(200);
    expect(listed.filter((task) => task.status === 'running')).toHaveLength(30);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('keeps running tasks when the aggregate cap drops the rest', async () => {
    const bus = new FakeRedisBus();
    const owners = ['owner-old', 'owner-new'].map(
      (instanceId) =>
        new RedisSubagentTaskControlTransport(
          asRedis(bus.createClient()),
          asRedis(bus.createClient()),
          { namespace: 'test', instanceId, requestTimeoutMs: 200, retryDelayMs: 10 },
        ),
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    /** The settled tasks are the oldest, and the running ones the newest, so an
     * oldest-first slice would drop exactly the children still worth polling. */
    const settled = Array.from({ length: 150 }, (_unused, index) =>
      snapshot({
        taskId: `settled-${index + 1}`,
        threadId: `settled-thread-${index + 1}`,
        status: 'completed',
        createdAt: index + 1,
        resultAvailable: true,
      }),
    );
    const running = Array.from({ length: 150 }, (_unused, index) =>
      snapshot({
        taskId: `running-${index + 1}`,
        threadId: `running-thread-${index + 1}`,
        status: 'running',
        createdAt: 1_000 + index,
      }),
    );
    await Promise.all(
      [settled, running].map(async (tasks, ownerIndex) => {
        const owner = owners[ownerIndex];
        await owner.bind(taskHandler({ list: () => tasks }));
        await Promise.all(tasks.map((task) => owner.registerTask('scope-1', task.taskId, 60_000)));
      }),
    );
    await requester.bind(taskHandler());

    const listed = await requester.list('scope-1');
    expect(listed).toHaveLength(200);
    expect(listed.filter((task) => task.status === 'running')).toHaveLength(150);

    await Promise.all([...owners.map((owner) => owner.destroy()), requester.destroy()]);
  });

  it('releases a claim replay once the requester acknowledges it, and keeps it otherwise', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    await owner.bind(
      taskHandler({
        claim: (_scopeId: string, taskId: string) => ({
          status: 'completed' as const,
          task: snapshot({ taskId, status: 'completed', resultAvailable: true }),
          result: 'child result',
        }),
        control: (_scopeId: string, taskId: string) => ({
          status: 'accepted' as const,
          task: snapshot({ taskId }),
          controlId: 'control-1',
        }),
      }),
    );
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);
    await owner.registerTask('scope-1', 'task-2', 60_000);
    const { claimReplays, controlReplays } = owner as unknown as {
      claimReplays: { entries: Map<string, unknown> };
      controlReplays: { entries: Map<string, unknown> };
    };

    /** A delivered result needs no replay copy. */
    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'completed',
    });
    for (let attempt = 0; attempt < 50 && claimReplays.entries.size > 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(claimReplays.entries.size).toBe(0);

    /** An undelivered one is retained, and control traffic cannot displace it. */
    bus.dropResponses = 2;
    await expect(requester.claim('scope-1', 'task-2')).rejects.toBeInstanceOf(
      SubagentTaskOwnerUnavailableError,
    );
    expect(claimReplays.entries.size).toBe(1);
    for (let index = 0; index < 50; index += 1) {
      await requester.control(
        'scope-1',
        'task-1',
        { action: 'queue', message: `m-${index}` },
        `invocation-churn-${index}`,
      );
    }
    expect(controlReplays.entries.size).toBe(50);
    expect(claimReplays.entries.size).toBe(1);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('lets an abandoned result expire out of retention', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 30, retryDelayMs: 5 },
    );
    let consumed = false;
    const claim = jest.fn((_scopeId: string, taskId: string) => {
      if (consumed) {
        return { status: 'claimed' as const, task: snapshot({ taskId, status: 'completed' }) };
      }
      consumed = true;
      return {
        status: 'completed' as const,
        task: snapshot({ taskId, status: 'completed', resultAvailable: true }),
        result: 'child result',
      };
    });
    await owner.bind(taskHandler({ claim }));
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 4 * 60 * 60_000);

    bus.dropResponses = 2;
    await expect(requester.claim('scope-1', 'task-1')).rejects.toBeInstanceOf(
      SubagentTaskOwnerUnavailableError,
    );

    /** A requester that never comes back cannot hold owner memory forever: the copy
     * carries an expiry, and the result stays recoverable from its durable thread. */
    const { claimReplays } = owner as unknown as {
      claimReplays: { entries: Map<string, { expiresAt: number }> };
    };
    expect([...claimReplays.entries.values()][0]?.expiresAt).toBeGreaterThan(Date.now());

    const realNow = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow + 6 * 60_000);
    try {
      await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
        status: 'claimed',
      });
    } finally {
      clock.mockRestore();
    }

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('delivers a result whose acknowledgement could not be confirmed', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 40, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 40, retryDelayMs: 5 },
    );
    const claim = jest.fn((_scopeId: string, taskId: string) => ({
      status: 'completed' as const,
      task: snapshot({ taskId, status: 'completed', resultAvailable: true }),
      result: 'child result',
    }));
    await owner.bind(taskHandler({ claim }));
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);
    const { claimReplays } = owner as unknown as {
      claimReplays: { entries: Map<string, unknown> };
    };

    /** Every acknowledgement reaches nobody, so the owner is never told it landed. */
    bus.ackFailures = 1_000;
    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'completed',
      result: 'child result',
    });
    /** The caller keeps the result it is holding; only the owner's copy lingers. */
    expect(claimReplays.entries.size).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);

    bus.ackFailures = 0;
    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'completed',
      result: 'child result',
    });
    for (let attempt = 0; attempt < 50 && claimReplays.entries.size > 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(claimReplays.entries.size).toBe(0);
    expect(claim).toHaveBeenCalledTimes(1);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('retries an acknowledgement that briefly reaches no subscriber', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 200, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 5 },
    );
    const claim = jest.fn((_scopeId: string, taskId: string) => ({
      status: 'completed' as const,
      task: snapshot({ taskId, status: 'completed', resultAvailable: true }),
      result: 'child result',
    }));
    await owner.bind(taskHandler({ claim }));
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);

    /** The first two acknowledgements land during a resubscribe; the third succeeds. */
    bus.ackFailures = 2;
    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'completed',
    });
    expect(bus.ackFailures).toBe(0);
    const { claimReplays } = owner as unknown as {
      claimReplays: { entries: Map<string, unknown> };
    };
    for (let attempt = 0; attempt < 50 && claimReplays.entries.size > 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(claimReplays.entries.size).toBe(0);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('keeps a retained result addressable after its task leaves the store', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      {
        namespace: 'test',
        instanceId: 'owner',
        requestTimeoutMs: 40,
        retryDelayMs: 5,
        registrationHeartbeatMs: 5,
      },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 40, retryDelayMs: 5 },
    );
    let retained = true;
    const claim = jest.fn((_scopeId: string, taskId: string) => ({
      status: 'completed' as const,
      task: snapshot({ taskId, status: 'completed', resultAvailable: true }),
      result: 'child result',
    }));
    await owner.bind(
      taskHandler({
        claim,
        /** The task ages out of the store while its result is still retained. */
        list: () => (retained ? [snapshot({ taskId: 'task-1' })] : []),
      }),
    );
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);

    bus.dropResponses = 2;
    await expect(requester.claim('scope-1', 'task-1')).rejects.toBeInstanceOf(
      SubagentTaskOwnerUnavailableError,
    );

    retained = false;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'completed',
      result: 'child result',
    });
    expect(claim).toHaveBeenCalledTimes(1);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('keeps a control fingerprint small no matter how large its message is', () => {
    const large = controlFingerprint({ action: 'queue', message: 'x'.repeat(64 * 1024) });
    const other = controlFingerprint({ action: 'queue', message: 'y'.repeat(64 * 1024) });

    /** Fingerprints are retained per invocation, so they must not carry the message. */
    expect(large).toHaveLength(43);
    expect(other).toHaveLength(43);
    expect(large).not.toBe(other);
    expect(controlFingerprint({ action: 'queue', message: 'same' })).toBe(
      controlFingerprint({ action: 'queue', message: 'same' }),
    );
  });

  it('drops a routed command whose caller already stopped waiting', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 40, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 40, retryDelayMs: 5 },
    );
    const control = jest.fn((_scopeId: string, taskId: string) => ({
      status: 'accepted' as const,
      task: snapshot({ taskId }),
      controlId: 'control-1',
    }));
    await owner.bind(taskHandler({ control }));
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);
    const ownerChannel = [...bus.clients]
      .flatMap((client) => [...client.channels])
      .find((channel) => channel.endsWith(':owner'));
    expect(ownerChannel).toBeDefined();

    /** A disconnected publisher queues an envelope offline and delivers it after the
     * caller has already been told the owner was unavailable. */
    bus.publish(
      ownerChannel as string,
      JSON.stringify({
        version: 1,
        kind: 'request',
        requestId: 'stale-request',
        requesterId: 'requester',
        expiresAt: Date.now() - 10 * 60_000,
        operation: 'control',
        scopeId: 'scope-1',
        taskId: 'task-1',
        command: { action: 'queue', message: 'a steer the caller gave up on' },
        invocationId: 'invocation-stale',
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(control).not.toHaveBeenCalled();

    /** A command still inside its deadline applies normally. */
    await expect(
      requester.control(
        'scope-1',
        'task-1',
        { action: 'queue', message: 'Check one more source.' },
        'invocation-fresh',
      ),
    ).resolves.toMatchObject({ status: 'accepted' });
    expect(control).toHaveBeenCalledTimes(1);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('never answers one invocation id from a different command it already ran', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 40, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 40, retryDelayMs: 5 },
    );
    const control = jest.fn(
      (_scopeId: string, taskId: string, command: SubagentTaskControlCommand) => ({
        status: 'accepted' as const,
        task: snapshot({ taskId }),
        controlId: `control-${'message' in command ? command.message : command.action}`,
      }),
    );
    await owner.bind(taskHandler({ control }));
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);

    await expect(
      requester.control('scope-1', 'task-1', { action: 'queue', message: 'first' }, 'invocation-1'),
    ).resolves.toMatchObject({ controlId: 'control-first' });

    /** A retransmission of that invocation replays without applying again. */
    await expect(
      requester.control('scope-1', 'task-1', { action: 'queue', message: 'first' }, 'invocation-1'),
    ).resolves.toMatchObject({ controlId: 'control-first' });
    expect(control).toHaveBeenCalledTimes(1);

    /** Reusing the id for different content is a caller error, so it reaches the
     * owner to be refused rather than collecting the earlier command's success. */
    await expect(
      requester.control(
        'scope-1',
        'task-1',
        { action: 'queue', message: 'second' },
        'invocation-1',
      ),
    ).resolves.toMatchObject({ controlId: 'control-second' });
    expect(control).toHaveBeenCalledTimes(2);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('keeps one repeated provider invocation id from bleeding across tasks', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 40, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 40, retryDelayMs: 5 },
    );
    const control = jest.fn((_scopeId: string, taskId: string) => ({
      status: 'accepted' as const,
      task: snapshot({ taskId }),
      controlId: `control-${taskId}`,
    }));
    await owner.bind(taskHandler({ control }));
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);
    await owner.registerTask('scope-2', 'task-2', 60_000);
    const steer = { action: 'queue' as const, message: 'Check one more source.' };

    /** `call_0` repeats across runs and agents, so it must not answer one task from
     * another task's retained response. */
    await expect(requester.control('scope-1', 'task-1', steer, 'call_0')).resolves.toMatchObject({
      controlId: 'control-task-1',
    });
    await expect(requester.control('scope-2', 'task-2', steer, 'call_0')).resolves.toMatchObject({
      controlId: 'control-task-2',
    });
    expect(control).toHaveBeenCalledTimes(2);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('never retains a live claim status behind a later poll', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 200, retryDelayMs: 10 },
    );
    let settled = false;
    await owner.bind(
      taskHandler({
        claim: (_scopeId: string, taskId: string) => {
          if (!settled) {
            return { status: 'running' as const, task: snapshot({ taskId }) };
          }
          return {
            status: 'completed' as const,
            task: snapshot({ taskId, status: 'completed', resultAvailable: true }),
            result: 'child result',
          };
        },
      }),
    );
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);

    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'running',
    });
    settled = true;
    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'completed',
      result: 'child result',
    });

    await Promise.all([owner.destroy(), requester.destroy()]);
  });

  it('returns a consumed result to a later claim after both responses are lost', async () => {
    const bus = new FakeRedisBus();
    const owner = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'owner', requestTimeoutMs: 60, retryDelayMs: 5 },
    );
    const requester = new RedisSubagentTaskControlTransport(
      asRedis(bus.createClient()),
      asRedis(bus.createClient()),
      { namespace: 'test', instanceId: 'requester', requestTimeoutMs: 60, retryDelayMs: 5 },
    );
    let claims = 0;
    await owner.bind(
      taskHandler({
        claim: (_scopeId: string, taskId: string) => {
          claims += 1;
          return claims === 1
            ? {
                status: 'completed' as const,
                task: snapshot({ taskId, status: 'completed', resultAvailable: true }),
                result: 'child result',
              }
            : {
                status: 'claimed' as const,
                task: snapshot({ taskId, status: 'completed', resultClaimed: true }),
              };
        },
      }),
    );
    await requester.bind(taskHandler());
    await owner.registerTask('scope-1', 'task-1', 60_000);

    /** Both the first response and its retry are lost after the owner consumed the result. */
    bus.dropResponses = 2;
    await expect(requester.claim('scope-1', 'task-1')).rejects.toBeInstanceOf(
      SubagentTaskOwnerUnavailableError,
    );
    expect(claims).toBe(1);

    await expect(requester.claim('scope-1', 'task-1')).resolves.toMatchObject({
      status: 'completed',
      result: 'child result',
    });
    expect(claims).toBe(1);

    await Promise.all([owner.destroy(), requester.destroy()]);
  });
});
