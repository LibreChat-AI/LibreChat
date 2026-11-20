import { z } from 'zod';
import { Providers } from '@librechat/agents';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@librechat/agents/langchain/tools';
import { FakeChatModel } from '@langchain/core/utils/testing';
import { agentsEndpointSchema } from 'librechat-data-provider';
import type { RunConfig } from '@librechat/agents';
import { createSdkModelHost } from './builder';

const identity = { runtimeId: 'runtime', runId: 'run', agentId: 'agent', userId: 'user' };
const limits = agentsEndpointSchema.parse({ sdkHostModels: {} }).sdkHostModels!;
const config = (): RunConfig => ({
  runId: identity.runId,
  graphConfig: {
    type: 'standard',
    agents: [
      {
        agentId: identity.agentId,
        provider: Providers.OPENAI,
        clientOptions: {
          model: 'builder-model',
          apiKey: 'host-secret',
          temperature: 0.25,
          streaming: true,
        },
        tools: [],
        toolDefinitions: [
          {
            name: 'lookup',
            description: 'Authorized lookup',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    ],
  },
});
const request = () => ({
  version: 1 as const,
  identity,
  reference: 'primary',
  messages: [new HumanMessage('hello')],
  toolNames: [],
});

it('is disabled until the host owner is configured', () => {
  expect(createSdkModelHost(undefined)).toBeUndefined();
});

it('keeps native builder parameters and callbacks on the host, exposing only the public profile and schemas', async () => {
  const callback = { name: 'host-policy', handleChatModelStart: jest.fn() };
  const cfg = config();
  if (!('agents' in cfg.graphConfig)) throw new Error('Missing agent config');
  Object.assign(cfg.graphConfig.agents[0].clientOptions!, { callbacks: [callback] });
  const native = new FakeChatModel({ callbacks: [callback] });
  native.bindTools = () => native;
  const initialize = jest.fn(() => native);
  const host = createSdkModelHost(limits, initialize)!;
  const binding = host.bind(cfg, identity);
  expect(initialize).toHaveBeenCalledWith({
    provider: Providers.OPENAI,
    clientOptions: cfg.graphConfig.agents[0].clientOptions,
  });
  expect(binding.modelProfile).toEqual({
    provider: Providers.OPENAI,
    name: 'builder-model',
    streaming: true,
  });
  expect(JSON.stringify(binding)).not.toContain('host-secret');
  expect(binding.model!.descriptor.tools[0].function.name).toBe('lookup');
  await binding.model!.service.invoke(request());
  expect(callback.handleChatModelStart).toHaveBeenCalledTimes(1);
  expect(host.snapshot().calls).toBe(0);
});

it('shares admission across users and rebuilt turns, retaining capacity until abandoned provider work settles', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = new FakeChatModel({});
  native.bindTools = () => native;
  const generate = native._generate.bind(native);
  native._generate = async (...args) => {
    entered();
    await pending;
    return generate(...args);
  };
  const host = createSdkModelHost({ ...limits, maxConcurrentCalls: 1 }, () => native)!;
  const abort = new AbortController();
  const first = host.bind(config(), identity, abort.signal).model!;
  const call = first.service.invoke(request());
  await started;
  abort.abort();
  await expect(call).rejects.toMatchObject({ code: 'cancelled' });
  expect(host.snapshot()).toMatchObject({ calls: 1, retainedCalls: 1 });
  const secondIdentity = { ...identity, runId: 'second-run', userId: 'second-user' };
  const second = host.bind(config(), secondIdentity).model!;
  await expect(
    second.service.invoke({ ...request(), identity: secondIdentity }),
  ).rejects.toMatchObject({ code: 'overflow' });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  expect(host.snapshot().calls).toBe(0);
  await expect(
    second.service.invoke({ ...request(), identity: secondIdentity }),
  ).resolves.toBeDefined();
});

it('keeps callback rejection authoritative and sanitizes the provider-facing error', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const native = new FakeChatModel({
    callbacks: [
      {
        name: 'host-policy',
        raiseError: true,
        awaitHandlers: true,
        handleChatModelStart: () => {
          throw new Error('private rejection details');
        },
      },
    ],
  });
  native.bindTools = () => native;
  const host = createSdkModelHost(limits, () => native)!;
  const binding = host.bind(config(), identity);
  try {
    await expect(binding.model!.service.invoke(request())).rejects.not.toThrow(
      'private rejection details',
    );
    expect(host.snapshot().calls).toBe(0);
  } finally {
    log.mockRestore();
  }
});

it.each(['fallback', 'tools', 'graphTools', 'identity', 'missingModel'] as const)(
  'rejects unsupported %s before initializing a provider',
  (feature) => {
    const cfg = config();
    if (!('agents' in cfg.graphConfig)) throw new Error('Missing agent config');
    const agent = cfg.graphConfig.agents[0];
    if (feature === 'fallback')
      Object.assign(agent.clientOptions!, {
        fallbacks: [{ provider: Providers.OPENAI, clientOptions: { model: 'fallback' } }],
      });
    if (feature === 'tools')
      agent.tools = [
        tool(async () => 'ok', { name: 'local', description: 'Local tool', schema: z.object({}) }),
      ];
    if (feature === 'graphTools')
      agent.graphTools = [
        tool(async () => 'ok', { name: 'local', description: 'Local tool', schema: z.object({}) }),
      ];
    if (feature === 'identity') agent.agentId = 'another-agent';
    if (feature === 'missingModel') delete agent.clientOptions!.model;
    const initialize = jest.fn(() => new FakeChatModel({}));
    expect(() => createSdkModelHost(limits, initialize)!.bind(cfg, identity)).toThrow('cannot use');
    expect(initialize).not.toHaveBeenCalled();
  },
);
