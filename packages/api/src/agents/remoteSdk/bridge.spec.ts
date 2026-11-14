import { z } from 'zod';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { tool } from '@librechat/agents/langchain/tools';
import { FakeChatModel as TestModel } from '@langchain/core/utils/testing';
import { HumanMessage, AIMessageChunk } from '@librechat/agents/langchain/messages';
import {
  Run,
  Providers,
  GraphEvents,
  FakeChatModel,
  MemorySaver,
  HookRegistry,
} from '@librechat/agents';
import type { RunConfig } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import type { RemoteSdkServerOptions } from './server';
import type { RemoteSdkFactoryInput } from './types';
import { createRemoteSdkServer } from './server';
import { createRemoteSdkRun } from './client';

const secret = 'sdk-runtime-test-secret-at-least-32-characters';
const identity = {
  runtimeId: 'custom',
  agentId: 'agent_saved',
  userId: 'user',
  tenantId: 'tenant',
  conversationId: 'conversation',
  runId: 'response',
};
function hostConfig(): RunConfig {
  return {
    runId: identity.runId,
    tokenCounter: () => 1,
    returnContent: true,
    graphConfig: {
      type: 'standard',
      llmConfig: { provider: Providers.OPENAI },
      agents: [
        {
          agentId: identity.agentId,
          provider: Providers.OPENAI,
          clientOptions: { model: 'gpt-4.1' },
          tools: [],
        },
      ],
    },
  };
}
const invocation = () => ({
  version: 'v2' as const,
  configurable: { thread_id: identity.conversationId },
});
async function factory(input: RemoteSdkFactoryInput) {
  const run = await Run.create({
    ...input.config,
    returnContent: true,
    tokenCounter: () => 1,
    graphConfig: {
      type: 'standard',
      compileOptions: input.compileOptions,
      llmConfig: { provider: Providers.OPENAI },
      agents: [
        {
          agentId: input.identity.agentId,
          provider: Providers.OPENAI,
          clientOptions: { model: 'gpt-4.1' },
          tools: [],
        },
      ],
    },
  });
  if (!run.Graph) throw new Error('Missing graph');
  run.Graph.overrideModel = new FakeChatModel({
    responses: ['A separately hosted SDK reply'],
    sleep: 1,
  });
  return run;
}
async function fixture(createRun = factory, overrides: Partial<RemoteSdkServerOptions> = {}) {
  const runtime = createRemoteSdkServer({
    runtimeId: identity.runtimeId,
    secret,
    authorize: (principal) => principal.agentId === identity.agentId,
    createRun,
    ...overrides,
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(runtime.server.address() as AddressInfo).port}/sdk`;
  return { ...runtime, remote: { url, secret } };
}

function signedToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    {
      protocolVersion: 1,
      identity,
      threadId: identity.conversationId,
      invocationId: randomUUID(),
      ...overrides,
    },
    secret,
    { algorithm: 'HS256', audience: identity.runtimeId, issuer: 'librechat-sdk', expiresIn: '60s' },
  );
}
async function connect(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}
describe('remote SDK runtime bridge', () => {
  it('bounds pending authorization and releases a disconnected admission without executing it', async () => {
    let release!: (allowed: boolean) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const createRun = jest.fn(factory);
    const authorize = jest
      .fn()
      .mockImplementationOnce(() => {
        entered();
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      })
      .mockReturnValue(true);
    const runtime = await fixture(createRun, { maxConcurrentRuns: 1, authorize });
    try {
      const first = new WebSocket(runtime.remote.url, {
        headers: { Authorization: `Bearer ${signedToken()}` },
      });
      first.on('error', () => undefined);
      await ready;
      await expect(connect(runtime.remote.url, signedToken())).rejects.toThrow();
      expect(authorize).toHaveBeenCalledTimes(1);
      const closed = new Promise<void>((resolve) => first.once('close', () => resolve()));
      first.terminate();
      await closed;
      release(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = await connect(runtime.remote.url, signedToken());
      next.close();
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      release(true);
      await runtime.close();
    }
  });
  it('aborts and closes pending authorization during server shutdown', async () => {
    let release!: (allowed: boolean) => void;
    let entered!: () => void;
    let signal: AbortSignal | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime = await fixture(factory, {
      authorize: (_identity, admissionSignal) => {
        signal = admissionSignal;
        entered();
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
    });
    const socket = new WebSocket(runtime.remote.url, {
      headers: { Authorization: `Bearer ${signedToken()}` },
    });
    socket.on('error', () => undefined);
    await ready;
    await runtime.close();
    expect(signal?.aborted).toBe(true);
    release(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  it.each(['short', '${UNRESOLVED_REMOTE_SDK_RUNTIME_SECRET_VARIABLE}'])(
    'rejects missing or unresolved signing credentials',
    async (secret) => {
      await expect(
        createRemoteSdkRun({
          config: hostConfig(),
          identity,
          remote: { url: 'ws://127.0.0.1:1/sdk', secret },
        }),
      ).rejects.toThrow();
      expect(() =>
        createRemoteSdkServer({
          runtimeId: identity.runtimeId,
          secret,
          authorize: () => true,
          createRun: factory,
        }),
      ).toThrow();
    },
  );
  it('preserves checkpoint history filters, pagination, and limits inside the signed scope', async () => {
    const saver = new MemorySaver();
    const list = jest.spyOn(saver, 'list').mockImplementation(async function* () {
      yield* [];
    });
    const runtime = await fixture(async (input) => {
      const checkpointer = input.compileOptions.checkpointer as MemorySaver;
      for await (const _tuple of checkpointer.list(
        { configurable: { thread_id: identity.conversationId } },
        {
          limit: 1,
          filter: { source: 'input' },
          before: { configurable: { checkpoint_id: 'cursor' } },
        },
      )) {
        /* Consume the scoped cursor. */
      }
      return factory(input);
    });
    try {
      const config = hostConfig();
      config.graphConfig.compileOptions = { checkpointer: saver };
      const run = await createRemoteSdkRun({ config, identity, remote: runtime.remote });
      await run.processStream({ messages: [new HumanMessage('hello')] }, invocation());
      expect(list).toHaveBeenCalledWith(
        { configurable: { thread_id: identity.conversationId, checkpoint_ns: '' } },
        {
          limit: 1,
          filter: { source: 'input' },
          before: {
            configurable: {
              thread_id: identity.conversationId,
              checkpoint_ns: '',
              checkpoint_id: 'cursor',
            },
          },
        },
      );
    } finally {
      await runtime.close();
    }
  });
  it('rejects replayed invocation credentials before execution', async () => {
    const createRun = jest.fn(factory);
    const runtime = await fixture(createRun);
    try {
      const token = signedToken();
      const socket = await connect(runtime.remote.url, token);
      socket.close();
      await expect(connect(runtime.remote.url, token)).rejects.toThrow();
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });
  it('rejects expired invocation credentials', async () => {
    const runtime = await fixture();
    try {
      await expect(
        connect(runtime.remote.url, signedToken({ iat: Math.floor(Date.now() / 1000) - 120 })),
      ).rejects.toThrow();
    } finally {
      await runtime.close();
    }
  });
  it('refuses checkpoints in another conversation without calling the saver', async () => {
    const saver = new MemorySaver();
    const getTuple = jest.spyOn(saver, 'getTuple');
    const runtime = await fixture(async (input) => {
      const remoteSaver = input.compileOptions.checkpointer as MemorySaver;
      await remoteSaver.getTuple({ configurable: { thread_id: 'foreign-conversation' } });
      return factory(input);
    });
    try {
      const config = hostConfig();
      config.graphConfig.compileOptions = { checkpointer: saver };
      const run = await createRemoteSdkRun({ config, identity, remote: runtime.remote });
      await expect(run.processStream({ messages: [] }, invocation())).rejects.toThrow(
        'SDK runtime execution failed',
      );
      expect(getTuple).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });
  it('does not run a tool when host policy fails', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let executions = 0;
    const runtime = await fixture(async (input) => {
      const guarded = tool(
        async () => {
          executions++;
          return 'forbidden';
        },
        {
          name: 'guarded',
          description: 'Policy guarded operation',
          schema: z.object({}),
        },
      );
      const run = await Run.create({
        ...input.config,
        tokenCounter: () => 1,
        graphConfig: {
          type: 'standard',
          agents: [
            {
              agentId: input.identity.agentId,
              provider: Providers.OPENAI,
              tools: [guarded],
              clientOptions: { streaming: false },
            },
          ],
        },
      });
      const model = new TestModel({});
      model._generate = async () => ({
        generations: [
          {
            text: '',
            message: new AIMessageChunk({
              content: '',
              tool_calls: [{ id: 'guarded-1', name: 'guarded', args: {} }],
            }),
          },
        ],
      });
      run.Graph!.overrideModel = model;
      return run;
    });
    try {
      const config = hostConfig();
      config.hooks = new HookRegistry();
      config.hooks.register('PreToolUse', {
        hooks: [
          async () => {
            throw new Error('private policy failure');
          },
        ],
      });
      const run = await createRemoteSdkRun({ config, identity, remote: runtime.remote });
      await run
        .processStream({ messages: [new HumanMessage('Run guarded')] }, invocation())
        .catch(() => undefined);
      expect(executions).toBe(0);
    } finally {
      warning.mockRestore();
      await runtime.close();
    }
  });
  it('rejects approval configuration without a host checkpointer', async () => {
    const config = hostConfig();
    config.humanInTheLoop = { enabled: true };
    await expect(
      createRemoteSdkRun({ config, identity, remote: { url: 'ws://127.0.0.1:1/sdk', secret } }),
    ).rejects.toThrow('host checkpointer');
  });

  it('rebuilds a paused remote SDK run from host checkpoints and approves the tool exactly once', async () => {
    let executions = 0;
    let factories = 0;
    const runtime = await fixture(async (input) => {
      factories++;
      const reviewed = tool(
        async () => {
          executions++;
          return 'approved result';
        },
        {
          name: 'reviewed',
          description: 'A reviewed operation',
          schema: z.object({}),
        },
      );
      const run = await Run.create({
        ...input.config,
        returnContent: true,
        tokenCounter: () => 1,
        graphConfig: {
          type: 'standard',
          compileOptions: input.compileOptions,
          agents: [
            {
              agentId: input.identity.agentId,
              provider: Providers.OPENAI,
              tools: [reviewed],
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
              messages.some((message) => message.getType() === 'tool')
                ? { content: 'Reviewed operation completed' }
                : { content: '', tool_calls: [{ id: 'review-1', name: 'reviewed', args: {} }] },
            ),
          },
        ],
      });
      if (!run.Graph) throw new Error('Missing SDK graph');
      run.Graph.overrideModel = model;
      return run;
    });
    try {
      const hooks = new HookRegistry();
      hooks.register('PreToolUse', { hooks: [async () => ({ decision: 'ask' })] });
      const config = hostConfig();
      config.hooks = hooks;
      config.humanInTheLoop = { enabled: true };
      config.graphConfig.compileOptions = { checkpointer: new MemorySaver() };
      const run = await createRemoteSdkRun({ config, identity, remote: runtime.remote });
      await run.processStream(
        { messages: [new HumanMessage('Review this operation')] },
        invocation(),
      );
      expect(run.getInterrupt()?.payload.type).toBe('tool_approval');
      expect(executions).toBe(0);
      const restored = await createRemoteSdkRun({
        config,
        identity,
        remote: runtime.remote,
        resumeState: {
          content: run.Graph!.getContentParts() ?? [],
          steps: run.Graph!.createRunStepResumeState().steps.map((entry) => entry.step),
        },
      });
      const result = await restored.resume({ 'review-1': { type: 'approve' } }, invocation());
      expect(restored.getInterrupt()).toBeUndefined();
      expect(executions).toBe(1);
      expect(factories).toBe(2);
      expect(JSON.stringify(result)).toContain('Reviewed operation completed');
    } finally {
      await runtime.close();
    }
  });
  it('runs the real SDK over a socket through existing handlers and projects final content', async () => {
    const createRun = jest.fn(factory);
    const runtime = await fixture(createRun);
    try {
      const config = hostConfig();
      const seen: string[] = [];
      config.streamLimits = {
        maxToolCallArgBytes: 512,
        maxToolCallArgBytesByTool: { inspected: 2048 },
        maxDeltaEventsPerTurn: 1000,
      };
      config.customHandlers = Object.fromEntries(
        [GraphEvents.ON_RUN_STEP, GraphEvents.ON_MESSAGE_DELTA, GraphEvents.ON_RUN_STEP_CLOSED].map(
          (event) => [
            event,
            {
              handle: async () => {
                seen.push(event);
              },
            },
          ],
        ),
      );
      const run = await createRemoteSdkRun({ config, identity, remote: runtime.remote });
      const parts = await run.processStream(
        { messages: [new HumanMessage('hello')] },
        invocation(),
      );
      expect(run).toBeInstanceOf(Run);
      expect(seen).toContain(GraphEvents.ON_MESSAGE_DELTA);
      expect(JSON.stringify(parts)).toContain('separately hosted');
      expect(run.Graph?.getContentParts()).toEqual(parts);
      expect(createRun).toHaveBeenCalledTimes(1);
      expect(createRun.mock.calls[0][0].identity).toEqual(identity);
      expect(createRun.mock.calls[0][0].config.streamLimits).toEqual(config.streamLimits);
      expect(Object.isFrozen(createRun.mock.calls[0][0].identity)).toBe(true);
    } finally {
      await runtime.close();
    }
  });
  it('fails closed on an oversized request before executing the worker factory', async () => {
    const createRun = jest.fn(factory);
    const runtime = await fixture(createRun);
    try {
      const run = await createRemoteSdkRun({
        config: hostConfig(),
        identity,
        remote: { ...runtime.remote, maxFrameBytes: 1024 },
      });
      await expect(
        run.processStream({ messages: [new HumanMessage('x'.repeat(4096))] }, invocation()),
      ).rejects.toThrow();
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });
  it('does not retry execution after losing the worker connection', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const createRun = jest.fn(async (input: RemoteSdkFactoryInput) => {
      const run = await factory(input);
      run.processStream = async () => {
        started();
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return [];
      };
      return run;
    });
    const runtime = await fixture(createRun);
    const run = await createRemoteSdkRun({
      config: hostConfig(),
      identity,
      remote: runtime.remote,
    });
    const result = run.processStream({ messages: [] }, invocation()).catch((error: Error) => error);
    await ready;
    await runtime.close();
    expect(await result).toMatchObject({ message: 'SDK runtime execution failed' });
    expect(createRun).toHaveBeenCalledTimes(1);
  });
  it('does not send arbitrary host configurable fields to the runtime', async () => {
    const runtime = await fixture();
    try {
      const run = await createRemoteSdkRun({
        config: hostConfig(),
        identity,
        remote: runtime.remote,
      });
      await expect(
        run.processStream(
          { messages: [new HumanMessage('hello')] },
          {
            ...invocation(),
            configurable: {
              ...invocation().configurable,
              req: { secret: 'do not send', cycle: () => undefined },
            },
          },
        ),
      ).resolves.toBeDefined();
    } finally {
      await runtime.close();
    }
  });
  it('rejects a foreign runtime credential before invoking the factory', async () => {
    const createRun = jest.fn(factory);
    const runtime = await fixture(createRun);
    try {
      const run = await createRemoteSdkRun({
        config: hostConfig(),
        identity,
        remote: { ...runtime.remote, secret: `${secret}-wrong` },
      });
      await expect(run.processStream({ messages: [] }, invocation())).rejects.toThrow(
        'SDK runtime connection failed',
      );
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });
  it('rejects an agent outside the runtime deployment policy', async () => {
    const runtime = await fixture();
    try {
      const run = await createRemoteSdkRun({
        config: hostConfig(),
        identity: { ...identity, agentId: 'other' },
        remote: runtime.remote,
      });
      await expect(run.processStream({ messages: [] }, invocation())).rejects.toThrow();
    } finally {
      await runtime.close();
    }
  });
  it('cancels an active remote graph when the host aborts', async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = await fixture(async (input) => {
      signal = input.signal;
      const run = await factory(input);
      run.processStream = async () => {
        started();
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return [];
      };
      return run;
    });
    try {
      const controller = new AbortController();
      const run = await createRemoteSdkRun({
        config: hostConfig(),
        identity,
        remote: runtime.remote,
      });
      const result = run.processStream(
        { messages: [] },
        { ...invocation(), signal: controller.signal },
      );
      const rejected = result.catch((error: Error) => error);
      await ready;
      controller.abort();
      expect(await rejected).toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(signal?.aborted).toBe(true);
    } finally {
      await runtime.close();
    }
  });
  it('sanitizes remote execution failures', async () => {
    const runtime = await fixture(async () => {
      throw new Error('PRIVATE provider credential and SQL');
    });
    try {
      const run = await createRemoteSdkRun({
        config: hostConfig(),
        identity,
        remote: runtime.remote,
      });
      await expect(run.processStream({ messages: [] }, invocation())).rejects.toThrow(
        'SDK runtime execution failed',
      );
    } finally {
      await runtime.close();
    }
  });
  it.each(['ws://example.com/sdk', 'https://example.com/sdk', 'ws://user:password@localhost/sdk'])(
    'rejects unsafe transport configuration %s',
    async (url) => {
      await expect(
        createRemoteSdkRun({ config: hostConfig(), identity, remote: { url, secret } }),
      ).rejects.toThrow();
    },
  );
});
