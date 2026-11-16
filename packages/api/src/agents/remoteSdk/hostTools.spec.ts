import type { HostToolRequest, HostToolSessionUpdate } from '@librechat/agents';
import { createHostToolService, createWorkerToolService } from './hostTools';

const identity = {
  runtimeId: 'runtime',
  agentId: 'agent',
  runId: 'run',
  userId: 'user',
  tenantId: 'tenant',
};
const tools = [{ reference: 'bound', definition: { name: 'inspect' } }];
function setup() {
  const handle = jest.fn(async (_event, data) => {
    data.resolve([{ toolCallId: 'call', status: 'success', content: 'ok' }]);
  });
  const controller = new AbortController();
  const invoke = createHostToolService({
    identity,
    tools,
    handler: { handle },
    configurable: { privateCredential: 'host-secret' },
    peer: { call: async () => null },
    signal: controller.signal,
  });
  const input = {
    id: 'c420977d-63df-4dd8-bb75-344d00334818',
    incremental: false,
    request: {
      version: 1,
      identity,
      calls: [{ reference: 'bound', call: { id: 'call', name: 'inspect', args: {} } }],
    },
  };
  return { handle, controller, invoke, input };
}
it.each(['userId', 'tenantId', 'runId', 'agentId'] as const)(
  'rejects foreign %s before dispatch',
  async (key) => {
    const { handle, invoke, input } = setup();
    await expect(
      invoke({
        ...input,
        request: { ...input.request, identity: { ...identity, [key]: 'other' } },
      }),
    ).rejects.toThrow('identity');
    expect(handle).not.toHaveBeenCalled();
  },
);
it('rejects unbound references and unsupported child attribution', async () => {
  const { handle, invoke, input } = setup();
  await expect(
    invoke({ ...input, request: { ...input.request, executingAgentId: 'child' } }),
  ).rejects.toThrow('subject');
  await expect(
    invoke({
      ...input,
      request: {
        ...input.request,
        calls: [{ reference: 'other', call: { id: 'call', name: 'inspect', args: {} } }],
      },
    }),
  ).rejects.toThrow('capability');
  expect(handle).not.toHaveBeenCalled();
});
it('uses only host-owned invocation configuration and honors cancellation', async () => {
  const { handle, controller, invoke, input } = setup();
  await invoke({
    ...input,
    request: { ...input.request, configurable: { privateCredential: 'forged' } },
  });
  expect(handle.mock.calls[0][1].configurable).toEqual({ privateCredential: 'host-secret' });
  controller.abort();
  await expect(invoke(input)).rejects.toThrow();
  expect(handle).toHaveBeenCalledTimes(1);
});

it('delivers refreshed host session state before propagating an execution failure', async () => {
  const updates: HostToolSessionUpdate[] = [];
  const worker = createWorkerToolService({ call: async (_method, data) => host(data) });
  const host = createHostToolService({
    identity,
    tools,
    configurable: {},
    signal: new AbortController().signal,
    peer: {
      call: async (method, data) =>
        worker.accept(data, method === 'tool.session' ? 'session' : 'result'),
    },
    handler: {
      handle: async (_event, data) => {
        const batch = data as import('@librechat/agents').ToolExecuteBatchRequest;
        batch.toolCalls[0].codeSessionContext = { session_id: 'refreshed' };
        throw new Error('execution failed after provisioning');
      },
    },
  });
  const request: HostToolRequest = {
    version: 1,
    identity,
    executingAgentId: identity.agentId,
    calls: [{ reference: 'bound', call: { id: 'call', name: 'inspect', args: {} } }],
  };
  await expect(
    worker.service.invoke(request, undefined, {
      onSessionUpdate: (update) => {
        updates.push(update);
      },
    }),
  ).rejects.toThrow('execution failed');
  expect(updates[0].context.codeSessionContext?.session_id).toBe('refreshed');
});
