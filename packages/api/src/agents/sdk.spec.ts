import { HumanMessage } from '@librechat/agents/langchain/messages';
import { Run, Providers, GraphEvents, FakeChatModel } from '@librechat/agents';
import type { RunConfig } from '@librechat/agents';
import { agentManagementCreateSchema, projectAgentManagementResponse } from './management';
import { createSdkAgentRun, resolveSdkAgentBinding } from './sdk';

const binding = { id: 'schema-advisor', protocolVersion: 1 as const };
const identity = {
  agentId: 'agent_saved',
  userId: 'authenticated',
  tenantId: 'authorized',
  conversationId: 'conversation',
};
const endpoint = {
  sdkRuntimes: { 'schema-advisor': { module: './approved.cjs', roles: ['ADMIN'] } },
};
function config(): RunConfig {
  return {
    runId: 'run_server',
    skipCleanup: true,
    tokenCounter: () => 1,
    graphConfig: {
      type: 'standard',
      maxContextTokens: 100_000,
      llmConfig: { provider: Providers.OPENAI, streaming: true, apiKey: 'test' },
      tools: [],
    },
  };
}
function args() {
  return { registration: { binding, module: './approved.cjs' }, config: config(), identity };
}

describe('SDK agent registration and native execution', () => {
  it('round-trips the binding through management without executable fields', () => {
    const data = agentManagementCreateSchema.parse({
      name: 'Advisor',
      provider: 'openAI',
      model: 'gpt-4.1',
      sdk_runtime: binding,
    });
    expect(
      projectAgentManagementResponse({
        ...data,
        id: identity.agentId,
        version: 1,
        createdAt: '2026-11-13T00:00:00Z',
        updatedAt: '2026-11-13T00:00:00Z',
      }).sdk_runtime,
    ).toEqual(binding);
    expect(
      agentManagementCreateSchema.safeParse({
        provider: 'openAI',
        model: 'gpt-4.1',
        sdk_runtime: { ...binding, module: './untrusted.cjs' },
      }).success,
    ).toBe(false);
  });
  it('leaves native agents on the existing path', () => {
    expect(resolveSdkAgentBinding([{ id: 'native' }], undefined, 'USER')).toBeUndefined();
  });
  it('requires configured runtime and role', () => {
    const agents = [{ id: identity.agentId, sdk_runtime: binding }];
    expect(resolveSdkAgentBinding(agents, endpoint, 'ADMIN')).toEqual({
      binding,
      module: './approved.cjs',
    });
    expect(() => resolveSdkAgentBinding(agents, endpoint, 'USER')).toThrow(
      expect.objectContaining({ code: 'sdk_runtime_forbidden' }),
    );
    expect(() => resolveSdkAgentBinding(agents, undefined, 'ADMIN')).toThrow(
      expect.objectContaining({ code: 'sdk_runtime_unavailable' }),
    );
    expect(() =>
      resolveSdkAgentBinding(
        [{ id: 'saved', sdk_runtime: { ...binding, id: 'constructor' } }],
        endpoint,
        'ADMIN',
      ),
    ).toThrow(expect.objectContaining({ code: 'sdk_runtime_unavailable' }));
  });
  it('does not silently drop native chain members', () => {
    expect(() =>
      resolveSdkAgentBinding(
        [{ id: 'native' }, { id: 'sdk', sdk_runtime: binding }],
        endpoint,
        'ADMIN',
      ),
    ).toThrow(expect.objectContaining({ code: 'sdk_runtime_composition_unsupported' }));
  });
  it('runs a real SDK graph through native event handlers with immutable host identity', async () => {
    const events: string[] = [];
    const cfg = config();
    cfg.customHandlers = {
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: async () => {
          events.push('delta');
        },
      },
    };
    const factory = jest.fn(async (input: { config: RunConfig; identity: typeof identity }) => {
      expect(Object.isFrozen(input.identity)).toBe(true);
      const run = await Run.create(input.config);
      if (!run.Graph) throw new Error('Missing graph');
      run.Graph.overrideModel = new FakeChatModel({ responses: ['Shared native events'] });
      return run;
    });
    const run = await createSdkAgentRun({
      ...args(),
      config: cfg,
      loadModule: () => ({ protocolVersion: 1, createRun: factory }),
    });
    expect(factory.mock.calls[0][0]).toEqual({
      config: cfg,
      identity: { ...identity, runtimeId: binding.id, runId: cfg.runId },
    });
    await run.processStream(
      { messages: [new HumanMessage('hello')] },
      { configurable: { thread_id: identity.conversationId }, version: 'v2' },
    );
    expect(events).toContain('delta');
    expect(run.getInterrupt()).toBeUndefined();
  });
  it('sanitizes module errors and rejects unsupported versions', async () => {
    await expect(
      createSdkAgentRun({
        ...args(),
        loadModule: () => {
          throw new Error('secret');
        },
      }),
    ).rejects.toMatchObject({
      code: 'sdk_runtime_invalid',
      message: 'The SDK agent runtime is unavailable for this request.',
    });
    await expect(
      createSdkAgentRun({ ...args(), loadModule: () => ({ protocolVersion: 2 }) }),
    ).rejects.toMatchObject({ code: 'sdk_runtime_invalid' });
  });
  it('rejects replacement run identities', async () => {
    await expect(
      createSdkAgentRun({
        ...args(),
        loadModule: () => ({
          protocolVersion: 1,
          createRun: () => Run.create({ ...config(), runId: 'other' }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'sdk_runtime_identity_mismatch' });
  });
  it('does not load modules for aborted requests or missing principals', async () => {
    const controller = new AbortController();
    controller.abort();
    const loadModule = jest.fn();
    await expect(
      createSdkAgentRun({ ...args(), loadModule, signal: controller.signal }),
    ).rejects.toThrow();
    await expect(
      createSdkAgentRun({ ...args(), loadModule, identity: { ...identity, userId: '' } }),
    ).rejects.toMatchObject({ code: 'sdk_runtime_identity_mismatch' });
    expect(loadModule).not.toHaveBeenCalled();
  });
});
