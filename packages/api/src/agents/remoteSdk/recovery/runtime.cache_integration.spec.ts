import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { tool } from '@librechat/agents/langchain/tools';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeChatModel as TestModel } from '@langchain/core/utils/testing';
import { HumanMessage, AIMessageChunk } from '@librechat/agents/langchain/messages';
import {
  Run,
  Providers,
  FakeChatModel,
  GraphEvents,
  MemorySaver,
  HookRegistry,
} from '@librechat/agents';
import type { AddressInfo, Socket } from 'node:net';
import type { RunConfig } from '@librechat/agents';
import type { RedisTestClient } from '../../../stream/__tests__/helpers/redis';
import type { RemoteSdkFactoryInput } from '../types';
import {
  createRedisTestClient,
  clearRedisTestPrefix,
} from '../../../stream/__tests__/helpers/redis';
import { createRedisRuntimeJournal } from './redis';
import { createRemoteSdkServer } from '../server';
import { createRuntimeRecovery } from './server';
import { createRemoteSdkRun } from '../client';

const secret = 'runtime-recovery-test-credential-not-a-production-key';
const identity = {
  runtimeId: 'recovery',
  agentId: 'agent_recovery',
  runId: 'run_recovery',
  userId: 'user',
  tenantId: 'tenant',
  conversationId: 'conversation',
};
const prefix = `Runtime-Recovery-Test-${randomUUID()}`;
const text = 'first second third fourth fifth sixth seventh eighth ninth tenth';
let redis: RedisTestClient;
beforeAll(async () => {
  redis = createRedisTestClient(prefix);
  await redis.ping();
});
afterAll(async () => {
  try {
    await clearRedisTestPrefix(redis, prefix);
    await redis.quit();
  } finally {
    redis.disconnect();
  }
});
async function factory(input: RemoteSdkFactoryInput) {
  const run = await Run.create({
    ...input.config,
    tokenCounter: () => 1,
    returnContent: true,
    graphConfig: {
      type: 'standard',
      signal: input.signal,
      compileOptions: input.compileOptions,
      agents: [
        {
          agentId: input.identity.agentId,
          provider: Providers.OPENAI,
          tools: [],
          clientOptions: { model: 'gpt-4.1' },
        },
      ],
    },
  });
  run.Graph!.overrideModel = new FakeChatModel({ responses: [text], sleep: 20 });
  return run;
}
function hostConfig(handle: () => Promise<void>) {
  return {
    runId: identity.runId,
    tokenCounter: () => 1,
    returnContent: true,
    customHandlers: { [GraphEvents.ON_MESSAGE_DELTA]: { handle } },
    graphConfig: {
      type: 'standard' as const,
      agents: [
        {
          agentId: identity.agentId,
          provider: Providers.OPENAI,
          tools: [],
          clientOptions: { model: 'gpt-4.1' },
        },
      ],
    },
  };
}
async function fixture(makeRun = factory) {
  const createRun = jest.fn(makeRun);
  const errors: unknown[] = [];
  const journalPrefix = `${prefix}:${randomUUID()}`;
  const journal = createRedisRuntimeJournal(redis, {
    prefix: journalPrefix,
    retentionMs: 60000,
    leaseMs: 3000,
    maxFrames: 10000,
    maxBytes: 16777216,
    maxBatchFrames: 64,
    maxBatchBytes: 1048576,
  });
  const sessionScopes = new Map<string, string>();
  const read = journal.read.bind(journal);
  journal.read = (session, after, count) => {
    sessionScopes.set(session.sessionId, session.scope);
    return read(session, after, count);
  };
  const makeRuntime = () =>
    createRemoteSdkServer({
      runtimeId: identity.runtimeId,
      secret,
      createRun,
      authorize: () => true,
      recovery: { journal, maxDisconnectMs: 5000 },
      onError: (error) => errors.push(error),
    });
  let runtime = makeRuntime();
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const port = (runtime.server.address() as AddressInfo).port;
  const sockets = new Set<Socket>();
  let connections = 0;
  let offline = false;
  const proxy = createServer((client) => {
    connections++;
    if (offline) {
      client.destroy();
      return;
    }
    const upstream = connect(port, '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    }
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return {
    get runtime() {
      return runtime;
    },
    offline: (value: boolean) => {
      offline = value;
    },
    restart: async () => {
      await runtime.close();
      runtime = makeRuntime();
      await new Promise<void>((resolve) => runtime.server.listen(port, '127.0.0.1', resolve));
    },
    completed: async () => {
      for (const [sessionId, scope] of sessionScopes) {
        const page = await journal.read({ sessionId, scope }, 0, 1);
        if (page.ok && page.value.state === 'completed') return true;
      }
      return false;
    },
    createRun,
    errors,
    connections: () => connections,
    drop: () => {
      for (const socket of sockets) socket.destroy();
    },
    remote: {
      url: `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/sdk`,
      secret,
      recovery: { maxDisconnectMs: 5000, retryDelayMs: 20, maxJournalBytes: 16777216 },
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await runtime.close();
    },
  };
}
describe('live SDK recovery', () => {
  it('runs a real SDK graph through the negotiated durable channel', async () => {
    const runtime = await fixture();
    try {
      let events = 0;
      const run = await createRemoteSdkRun({
        config: hostConfig(async () => {
          events++;
        }),
        identity,
        remote: runtime.remote,
      });
      const result = await run.processStream(
        { messages: [new HumanMessage('hello')] },
        { version: 'v2', configurable: { thread_id: identity.conversationId } },
      );
      expect(JSON.stringify(result)).toContain(text);
      expect(events).toBeGreaterThan(3);
      expect(runtime.createRun).toHaveBeenCalledTimes(1);
      expect(runtime.errors).toEqual([]);
    } finally {
      await runtime.close();
    }
  });
  it('reconnects after repeated wire failures without repeating the agent factory or text events', async () => {
    const runtime = await fixture();
    try {
      let events = 0;
      const run = await createRemoteSdkRun({
        config: hostConfig(async () => {
          events++;
          if (events === 2 || events === 7) runtime.drop();
        }),
        identity,
        remote: runtime.remote,
      });
      const result = await run.processStream(
        { messages: [new HumanMessage('hello')] },
        { version: 'v2', configurable: { thread_id: identity.conversationId } },
      );
      expect(JSON.stringify(result)).toContain(text);
      expect(runtime.connections()).toBeGreaterThanOrEqual(3);
      expect(runtime.createRun).toHaveBeenCalledTimes(1);
      expect(events).toBe(text.split(/(?<=\s+)|(?=\s+)/).length);
      expect(runtime.errors).toEqual([]);
    } finally {
      await runtime.close();
    }
  });
  it('delivers cancellation after the wire is lost and reconnects before acknowledging it', async () => {
    let remoteSignal: AbortSignal | undefined;
    const runtime = await fixture(async (input) => {
      remoteSignal = input.signal;
      return factory(input);
    });
    try {
      const controller = new AbortController();
      let lost!: () => void;
      const first = new Promise<void>((resolve) => {
        lost = resolve;
      });
      const run = await createRemoteSdkRun({
        config: hostConfig(async () => {
          lost();
        }),
        identity,
        remote: runtime.remote,
      });
      const result = run.processStream(
        { messages: [new HumanMessage('hello')] },
        {
          version: 'v2',
          signal: controller.signal,
          configurable: { thread_id: identity.conversationId },
        },
      );
      const rejected = result.catch((error: Error) => error);
      await first;
      runtime.offline(true);
      runtime.drop();
      controller.abort();
      await delay(100);
      runtime.offline(false);
      expect(await rejected).toMatchObject({ name: 'AbortError' });
      expect(remoteSignal?.aborted).toBe(true);
      expect(runtime.createRun).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });
  it('preserves a pending policy reply and approved tool result across wire failures', async () => {
    let executions = 0;
    const runtime = await fixture(async (input) => {
      const inspected = tool(
        async () => {
          executions++;
          runtime.drop();
          return 'approved result';
        },
        {
          name: 'inspect',
          description: 'Inspect after approval',
          schema: z.object({}),
        },
      );
      const run = await Run.create({
        ...input.config,
        tokenCounter: () => 1,
        returnContent: true,
        graphConfig: {
          type: 'standard',
          compileOptions: input.compileOptions,
          agents: [
            {
              agentId: input.identity.agentId,
              provider: Providers.OPENAI,
              tools: [inspected],
              clientOptions: { streaming: false },
            },
          ],
        },
      });
      const model = new TestModel({});
      model._generate = async (messages) => ({
        generations: [
          {
            text: '',
            message: new AIMessageChunk(
              messages.some((m) => m.getType() === 'tool')
                ? { content: 'approved recovery complete' }
                : { content: '', tool_calls: [{ id: 'inspect-1', name: 'inspect', args: {} }] },
            ),
          },
        ],
      });
      run.Graph!.overrideModel = model;
      return run;
    });
    try {
      let policyCalls = 0;
      const config: RunConfig = {
        ...hostConfig(async () => undefined),
        hooks: new HookRegistry(),
        humanInTheLoop: { enabled: true },
      };
      config.hooks!.register('PreToolUse', {
        hooks: [
          async () => {
            policyCalls++;
            runtime.drop();
            await delay(100);
            return { decision: 'ask' };
          },
        ],
      });
      config.graphConfig = {
        ...config.graphConfig,
        compileOptions: { checkpointer: new MemorySaver() },
      };
      const run = await createRemoteSdkRun({ config, identity, remote: runtime.remote });
      const invocation = {
        version: 'v2' as const,
        configurable: { thread_id: identity.conversationId },
      };
      await run.processStream({ messages: [new HumanMessage('inspect')] }, invocation);
      expect(run.getInterrupt()?.payload.type).toBe('tool_approval');
      expect(policyCalls).toBe(1);
      expect(executions).toBe(0);
      const restored = await createRemoteSdkRun({
        config,
        identity,
        remote: runtime.remote,
        resumeState: {
          content: run.Graph!.getContentParts() ?? [],
          steps: run.Graph!.createRunStepResumeState().steps.map((e) => e.step),
        },
      });
      const result = await restored.resume({ 'inspect-1': { type: 'approve' } }, invocation);
      expect(JSON.stringify(result)).toContain('approved recovery complete');
      expect(executions).toBe(1);
      expect(runtime.createRun).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
    }
  });
  it('replays a committed terminal result after restarting the worker without rerunning it', async () => {
    const runtime = await fixture();
    try {
      let dropped = false;
      const run = await createRemoteSdkRun({
        config: hostConfig(async () => {
          if (!dropped) {
            dropped = true;
            runtime.offline(true);
            runtime.drop();
          }
        }),
        identity,
        remote: runtime.remote,
      });
      const result = run.processStream(
        { messages: [new HumanMessage('hello')] },
        { version: 'v2', configurable: { thread_id: identity.conversationId } },
      );
      for (let i = 0; i < 100 && !(await runtime.completed()); i++) await delay(20);
      expect(await runtime.completed()).toBe(true);
      await runtime.restart();
      runtime.offline(false);
      expect(JSON.stringify(await result)).toContain(text);
      expect(runtime.createRun).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });
  it('binds reattachment to caller, agent, thread and generation and never recreates an expired session', async () => {
    const journal = createRedisRuntimeJournal(redis, {
      prefix: `${prefix}:scope`,
      retentionMs: 300,
      leaseMs: 100,
      maxFrames: 100,
      maxBytes: 10000,
      maxBatchFrames: 10,
      maxBatchBytes: 1000,
    });
    const recovery = createRuntimeRecovery({
      journal,
      maxDisconnectMs: 1000,
      maxFrameBytes: 1000,
      maxBufferedBytes: 10000,
    });
    const claim = { sessionId: randomUUID(), after: 0, resume: false, generation: 'generation' };
    try {
      const session = await recovery.prepare(identity, 'thread', claim);
      for (const other of [
        { ...identity, userId: 'other' },
        { ...identity, agentId: 'other' },
        { ...identity, tenantId: 'other' },
      ])
        await expect(recovery.prepare(other, 'thread', { ...claim, resume: true })).rejects.toThrow(
          'identity mismatch',
        );
      await expect(recovery.prepare(identity, 'other', claim)).rejects.toThrow('identity mismatch');
      await expect(
        recovery.prepare(identity, 'thread', { ...claim, generation: 'other' }),
      ).rejects.toThrow('identity mismatch');
      session.dispose();
      await delay(350);
      await expect(
        recovery.prepare(identity, 'thread', { ...claim, resume: true }),
      ).rejects.toThrow('unavailable');
    } finally {
      recovery.close();
    }
  });
  it('fails a started execution after owner loss instead of invoking its factory again', async () => {
    const journal = createRedisRuntimeJournal(redis, {
      prefix: `${prefix}:restart`,
      retentionMs: 10000,
      leaseMs: 100,
      maxFrames: 100,
      maxBytes: 10000,
      maxBatchFrames: 10,
      maxBatchBytes: 1000,
    });
    const opts = { journal, maxDisconnectMs: 1000, maxFrameBytes: 1000, maxBufferedBytes: 10000 };
    const claim = { sessionId: randomUUID(), after: 0, resume: false };
    const previous = createRuntimeRecovery(opts);
    const session = await previous.prepare(identity, 'thread', claim);
    await session.begin();
    previous.close();
    await delay(150);
    const next = createRuntimeRecovery(opts);
    try {
      const restored = await next.prepare(identity, 'thread', { ...claim, resume: true });
      expect(restored.needsEngine).toBe(false);
      await expect(restored.begin()).rejects.toThrow('already started');
    } finally {
      next.close();
    }
  });
});
