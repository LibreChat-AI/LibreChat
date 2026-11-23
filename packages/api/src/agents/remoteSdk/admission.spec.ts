import { randomUUID } from 'node:crypto';
import { CallbackManager, ensureHandler } from '@langchain/core/callbacks/manager';
import {
  createInitialModelBoundAdmissionCallback,
  createModelBoundChatModelCallback,
} from '../../middleware/modelBoundContent';
import {
  createHostModelLifecycle,
  createWorkerModelLifecycle,
  supportsModelInvocationContext,
} from './admission';

it('installs an SDK that exercises combined admission and output protection', () => {
  expect(supportsModelInvocationContext).toBe(true);
});

function fixture() {
  const persist = jest.fn();
  const initial = createInitialModelBoundAdmissionCallback({
    agentIds: ['root'],
    isActive: () => true,
    onAllowed: persist,
  });
  const host = createHostModelLifecycle('root', 16);
  host.attach([initial]);
  const callback = host.wrapCallbacks([]);
  if (!Array.isArray(callback)) throw new Error('Expected callbacks');
  return { persist, host, observer: callback[0] };
}
const attempt = () => ({ nodeId: randomUUID(), modelId: randomUUID() });

it('requires both an observed native success and graph-node completion before persistence', async () => {
  const { host, persist, observer } = fixture();
  const scope = attempt();
  await host.invoke(scope, async () => {
    await observer.handleChatModelStart?.(
      { id: [], lc: 1, type: 'not_implemented' },
      [],
      randomUUID(),
    );
    expect(persist).not.toHaveBeenCalled();
  });
  expect(persist).not.toHaveBeenCalled();
  host.end({ nodeId: scope.nodeId, completed: true });
  expect(persist).toHaveBeenCalledTimes(1);
  await expect(host.invoke(undefined, async () => 'subsequent call')).resolves.toBe(
    'subsequent call',
  );
  expect(() => host.end({ nodeId: scope.nodeId, completed: true })).toThrow();
});

it.each(['unobserved', 'failed', 'cancelled', 'incomplete'] as const)(
  'never admits an %s attempt',
  async (outcome) => {
    const { host, persist, observer } = fixture();
    const scope = attempt();
    try {
      await host.invoke(scope, async () => {
        if (outcome !== 'unobserved')
          await observer.handleChatModelStart?.(
            { id: [], lc: 1, type: 'not_implemented' },
            [],
            randomUUID(),
          );
        if (outcome === 'failed') throw new Error('provider failure');
        if (outcome === 'cancelled') host.dispose();
      });
    } catch {
      /* expected provider failure */
    }
    if (outcome !== 'cancelled')
      host.end({ nodeId: scope.nodeId, completed: outcome !== 'incomplete' });
    expect(persist).not.toHaveBeenCalled();
  },
);

it('rejects completion while provider work is pending, missing lineage and replayed attempts', async () => {
  const { host, persist } = fixture();
  const scope = attempt();
  await host.invoke(scope, async () => {
    expect(() => host.end({ nodeId: scope.nodeId, completed: true })).toThrow();
  });
  await expect(host.invoke(scope, async () => {})).rejects.toThrow();
  await expect(host.invoke(undefined, async () => {})).rejects.toThrow();
  expect(persist).not.toHaveBeenCalled();
});

it('preserves exact messages while supplying only host-derived admission metadata to policy hooks', async () => {
  const { host } = fixture();
  const allowed = jest.fn();
  const filter = createModelBoundChatModelCallback({}, { onContentAllowed: allowed });
  const manager = new CallbackManager();
  const original = ensureHandler({
    name: filter.name,
    raiseError: true,
    awaitHandlers: true,
    handleChatModelStart: (...args) =>
      filter.handleChatModelStart(undefined, [], args[2], args[3], args[4], args[5], args[6]),
  });
  manager.addHandler(original, true);
  const wrapped = host.wrapCallbacks(manager);
  if (Array.isArray(wrapped)) throw new Error('Expected callback manager');
  const policy = wrapped.handlers.find((callback) => callback.name === filter.name)!;
  const scope = attempt();
  const modelId = randomUUID();
  await host.invoke(scope, async () => {
    await policy.handleChatModelStart?.(
      { id: [], lc: 1, type: 'not_implemented' },
      [],
      modelId,
      'untrusted-parent',
      undefined,
      undefined,
      { agentId: 'untrusted' },
    );
  });
  expect(allowed).toHaveBeenCalledWith({
    runId: modelId,
    parentRunId: scope.nodeId,
    metadata: { agentId: 'root', langgraph_node: 'agent=root' },
  });
  expect(manager.handlers[0]).toBe(original);
});

it('bounds admission state across many completed graph nodes', async () => {
  const { host } = fixture();
  for (let index = 0; index < 16; index++) {
    const scope = attempt();
    await host.invoke(scope, async () => {});
    host.end({ nodeId: scope.nodeId, completed: false });
  }
  await expect(host.invoke(attempt(), async () => {})).rejects.toThrow();
});

it('latches policy rejection even if the worker retries with safe input', async () => {
  const { host, persist } = fixture();
  const filter = createModelBoundChatModelCallback({
    filters: {
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'Private', regex: 'PRIVATE-VALUE' }],
        },
      },
    },
  });
  const policy = ensureHandler({
    name: filter.name,
    handleChatModelStart: (_model, _messages, runId, parent, extra, tags, metadata) =>
      filter.handleChatModelStart(
        undefined,
        [[{ role: 'human', content: 'PRIVATE-VALUE' }]],
        runId,
        parent,
        extra,
        tags,
        metadata,
      ),
  });
  const callbacks = host.wrapCallbacks([policy]);
  if (!Array.isArray(callbacks)) throw new Error('Expected callbacks');
  const first = attempt();
  await expect(
    host.invoke(first, async () =>
      callbacks[0].handleChatModelStart?.(
        { id: [], lc: 1, type: 'not_implemented' },
        [],
        randomUUID(),
      ),
    ),
  ).rejects.toMatchObject({ code: 'content_filter_block' });
  const invoke = jest.fn(async () => {});
  await expect(host.invoke(attempt(), invoke)).rejects.toMatchObject({
    code: 'content_filter_block',
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(() => host.end({ nodeId: first.nodeId, completed: true })).toThrow();
  expect(host.failure()).toMatchObject({ code: 'content_filter_block' });
  expect(persist).not.toHaveBeenCalled();
});

it('rejects concurrent root attempts instead of treating a sibling as the starting root', async () => {
  const { host } = fixture();
  await host.invoke(attempt(), async () => {
    await expect(host.invoke(attempt(), async () => {})).rejects.toThrow();
  });
});

it('does not enroll summary or unrelated models into the starting graph admission', async () => {
  const call = jest.fn();
  const worker = createWorkerModelLifecycle('root', 16, { call });
  const nodeId = randomUUID();
  const callback = worker.callback;
  await callback.handleChainStart?.(
    { id: [], lc: 1, type: 'not_implemented' },
    {},
    nodeId,
    undefined,
    undefined,
    { langgraph_node: 'agent=root' },
    undefined,
    'agent=root',
  );
  for (const metadata of [
    { agentId: 'other', langgraph_node: 'agent=root' },
    { agentId: 'root', langgraph_node: 'agent=root', summarization: true },
  ]) {
    await callback.handleChatModelStart?.(
      { id: [], lc: 1, type: 'not_implemented' },
      [],
      randomUUID(),
      nodeId,
      undefined,
      undefined,
      metadata,
    );
  }
  await callback.handleChainEnd?.({ messages: [{}] }, nodeId);
  expect(call).not.toHaveBeenCalled();
  expect(() => worker.current()).toThrow();
});
