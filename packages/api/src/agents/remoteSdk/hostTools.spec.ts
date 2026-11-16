import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createHostToolBindings, GraphEvents } from '@librechat/agents';
import type {
  HostToolRequest,
  HostToolSessionUpdate,
  ToolExecuteBatchRequest,
} from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import { createHostToolService, createWorkerToolService } from './hostTools';
import { createSdkPeer } from './peer';

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

it.each([true, false])(
  'propagates worker cancellation with a cooperative=%s handler and preserves sessions',
  async (cooperative) => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const connected = once(server, 'connection');
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await once(socket, 'open');
    const [hostSocket] = (await connected) as [WebSocket];
    const limits = {
      maxFrameBytes: 65536,
      maxBufferedBytes: 131072,
      timeoutMs: 2000,
      onClose: () => undefined,
      onFrame: async () => undefined,
    };
    const hostRun = new AbortController();
    const workerCall = new AbortController();
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hostSignal: AbortSignal | undefined;
    let effects = 0;
    let resolveFinished!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const host = createHostToolService({
      identity,
      tools,
      configurable: {},
      signal: hostRun.signal,
      peer: { call: (...args) => hostPeer.call(...args) },
      handler: {
        handle: async (_event, data) => {
          const batch = data as ToolExecuteBatchRequest;
          hostSignal = batch.signal;
          batch.toolCalls[0].codeSessionContext = { session_id: 'provisioned' };
          begin();
          if (cooperative) {
            await new Promise<void>((resolve) =>
              batch.signal!.addEventListener('abort', () => resolve(), { once: true }),
            );
            await held;
            batch.toolCalls[0].runtimeSessionHint = 'cancelled-session';
            batch.reject(new Error('cancelled'));
          } else {
            await held;
            if (!batch.signal?.aborted) effects++;
            batch.onResult?.({ toolCallId: 'call', status: 'success', content: 'late' });
            batch.resolve([{ toolCallId: 'call', status: 'success', content: 'late' }]);
          }
          resolveFinished();
        },
      },
    });
    const hostPeer = createSdkPeer(hostSocket, {
      ...limits,
      onCall: (method, data, _timeout, signal) =>
        method === 'tools' ? host(data, signal) : Promise.resolve('alive'),
    });
    const worker = createWorkerToolService({ call: (...args) => workerPeer.call(...args) });
    const workerPeer = createSdkPeer(socket, {
      ...limits,
      onCall: async (method, data) =>
        worker.accept(data, method === 'tool.session' ? 'session' : 'result'),
    });
    const bindings = createHostToolBindings({ identity, tools, service: worker.service });
    const resolve = jest.fn();
    const reject = jest.fn();
    const onResult = jest.fn();
    const call = { id: 'call', name: 'inspect', args: {} };
    try {
      const operation = bindings.customHandlers[GraphEvents.ON_TOOL_EXECUTE].handle(
        GraphEvents.ON_TOOL_EXECUTE,
        {
          toolCalls: [call],
          signal: workerCall.signal,
          agentId: identity.agentId,
          resolve,
          reject,
          onResult,
        },
      );
      await started;
      workerCall.abort();
      let settled = false;
      void Promise.resolve(operation).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      expect(hostSignal?.aborted).toBe(true);
      release();
      await operation;
      expect(hostSignal?.aborted).toBe(true);
      expect(hostRun.signal.aborted).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledTimes(1);
      expect(call).toMatchObject({ codeSessionContext: { session_id: 'provisioned' } });
      if (cooperative) expect(call).toMatchObject({ runtimeSessionHint: 'cancelled-session' });
      release();
      await handlerFinished;
      expect(effects).toBe(0);
      expect(onResult).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(WebSocket.OPEN);
      await expect(workerPeer.call('probe', null)).resolves.toBe('alive');
    } finally {
      release();
      hostSocket.terminate();
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
