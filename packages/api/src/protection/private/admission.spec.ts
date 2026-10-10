import { Run, Providers, FakeChatModel } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Request } from 'express';
import {
  createPrivateTextIngress,
  stampPrivateTextMessage,
  requirePrivateTextAdmission,
  savePrivateTextErrorTurn,
  bindPrivateTextPersistenceAbort,
} from './submission';
import {
  createPrivateTextInitialAdmissionCallback,
  getPrivateTextModelHooks,
  withPrivateTextAdmissionConfig,
} from './admission';
import { createModelBoundChatModelCallback } from '../../middleware/modelBoundContent';

function turn() {
  const filters = {
    messages: {
      pii: {
        action: 'redact' as const,
        fields: ['text' as const, 'content_part' as const],
        starterPatterns: [],
        customPatterns: [
          { id: 'email', label: 'Email', regex: 'alice@example\\.com', category: 'email' as const },
          { id: 'history', label: 'History', regex: 'RESTRICTED-HISTORY' },
        ],
      },
    },
  };
  const req = {
    path: '/',
    user: { id: 'owner' },
    body: {
      text: 'alice@example.com',
      clientRequestId: 'parallel-private',
    },
  } as unknown as Request;
  createPrivateTextIngress({
    getFilters: () => filters,
    getLegacyPii: () => undefined,
    getKey: () => 'ab'.repeat(32),
  })(req, {} as never, jest.fn());
  const message = stampPrivateTextMessage(req, {
    messageId: 'user',
    conversationId: 'conversation',
    text: req.body.text,
    isCreatedByUser: true,
  });
  return { filters, req, message };
}
function setup(roots = ['a', 'b']) {
  const { req, message, filters } = turn();
  const controller = new AbortController();
  const start = jest.fn(async () => ({ message }));
  const cancel = jest.fn();
  const created = jest.fn();
  const initial = createPrivateTextInitialAdmissionCallback(req, {
    agentIds: roots,
    start,
    cancel,
    onPersisted: created,
    signal: controller.signal,
  })!;
  const content = createModelBoundChatModelCallback(
    { filters },
    getPrivateTextModelHooks(req, initial, start, cancel, created),
  );
  const manager = new CallbackManager();
  manager.addHandler(
    Object.assign(
      BaseCallbackHandler.fromMethods({
        handleChainStart: initial.handleChainStart,
        handleChainEnd: initial.handleChainEnd,
        handleChainError: initial.handleChainError,
        handleLLMError: initial.handleLLMError,
      }),
      {
        raiseError: true,
        awaitHandlers: true,
      },
    ),
    true,
  );
  const graph = manager.handleChainStart(
    { lc: 1, type: 'not_implemented', id: ['graph'] },
    {},
    'graph',
  );
  const model = async (agent: string, text = 'Safe native input') => {
    const graphRun = await graph;
    const nodeManager = graphRun.getChild();
    const metadata = { agentId: agent, langgraph_node: `agent=${agent}` };
    nodeManager.addMetadata(metadata, true);
    const node = await nodeManager.handleChainStart(
      { lc: 1, type: 'not_implemented', id: ['agent'] },
      {},
      `node-${agent}`,
      undefined,
      undefined,
      metadata,
      `agent=${agent}`,
    );
    const modelManager = node.getChild();
    modelManager.addHandler(
      Object.assign(
        BaseCallbackHandler.fromMethods({
          handleChatModelStart: (llm, batches, runId, parentRunId, extra, tags, metadata) =>
            content.handleChatModelStart(
              llm,
              batches.map((batch) =>
                batch.map((message) => ({
                  role: message.getType(),
                  content: message.content,
                })),
              ),
              runId,
              parentRunId,
              extra,
              tags,
              metadata,
            ),
        }),
        {
          raiseError: true,
          awaitHandlers: true,
        },
      ),
      true,
    );
    // Actual LangChain dispatch supplies ancestry and metadata to intrinsic callbacks.
    return modelManager.handleChatModelStart(
      { lc: 1, type: 'not_implemented', id: ['model'] },
      [[new HumanMessage(text)]],
      `model-${agent}`,
      undefined,
      undefined,
      undefined,
      metadata,
    );
  };
  return { req, message, start, cancel, created, initial, content, controller, model };
}

it('holds a safe root until a sibling input passes, then commits once before either model', async () => {
  const state = setup();
  const invoke = jest.fn();
  const first = state.model('a').then(invoke);
  await new Promise((resolve) => setImmediate(resolve));
  expect(state.start).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  await state.model('b').then(invoke);
  await first;
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(state.created).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(state.created.mock.invocationCallOrder[0]).toBeLessThan(
    invoke.mock.invocationCallOrder[0],
  );
});

it('a sibling rejection releases every waiting root without saving, invoking, or recovery', async () => {
  const state = setup();
  const invoke = jest.fn();
  const first = state.model('a').then(invoke);
  const observed = first.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  await expect(state.model('b', 'RESTRICTED-HISTORY')).rejects.toThrow();
  expect(await observed).toBeInstanceOf(Error);
  expect(state.start).not.toHaveBeenCalled();
  expect(state.created).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  const recover = jest.fn(async () => {});
  await savePrivateTextErrorTurn(state.req, new Error('rejected'), recover);
  expect(recover).not.toHaveBeenCalled();
  await expect(requirePrivateTextAdmission(state.req)).rejects.toThrow();
});

it('cancels a waiting parallel root on Stop, without beginning protected persistence', async () => {
  const state = setup();
  const invoke = jest.fn();
  const first = state.model('a').then(invoke);
  const observed = first.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  state.controller.abort();
  expect(await observed).toBeInstanceOf(Error);
  expect(state.start).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it('does not accept a summary or unidentified model as initial-root admission', async () => {
  const state = setup();
  await expect(
    state.content.handleChatModelStart(
      undefined,
      [[{ role: 'user', content: 'Safe' }]],
      'summary',
      'graph',
      undefined,
      undefined,
      { summarization: true },
    ),
  ).rejects.toThrow();
  expect(state.start).not.toHaveBeenCalled();
});

it('releases waiting roots when a peer needs a later summarization superstep', async () => {
  const state = setup();
  const waiting = state.model('a').catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  state.initial.handleChainStart(
    undefined,
    {},
    'b-detour',
    'graph',
    undefined,
    { langgraph_node: 'agent=b' },
    undefined,
    'agent=b',
  );
  state.initial.handleChainEnd({ summarizationRequest: {} }, 'b-detour');
  expect(await waiting).toBeInstanceOf(Error);
  expect(state.start).not.toHaveBeenCalled();
});

it('raises concurrency to the root-wave size without changing ordinary run configuration', () => {
  const state = setup(['a', 'b', 'c']);
  expect(withPrivateTextAdmissionConfig({ maxConcurrency: 1 }, state.initial).maxConcurrency).toBe(
    3,
  );
  expect(withPrivateTextAdmissionConfig({}, state.initial).maxConcurrency).toBeUndefined();
  expect(withPrivateTextAdmissionConfig({ maxConcurrency: 8 }, state.initial).maxConcurrency).toBe(
    8,
  );
  const ordinary = { maxConcurrency: 1 };
  expect(withPrivateTextAdmissionConfig(ordinary)).toBe(ordinary);
});

it.each([false, true])(
  'cancels an unadmitted protected write on Stop, pre-aborted: %s',
  (aborted) => {
    const { req } = turn();
    const controller = new AbortController();
    const start = jest.fn();
    const cancel = jest.fn();
    if (aborted) {
      controller.abort();
    }
    bindPrivateTextPersistenceAbort(req, controller.signal, start, cancel);
    if (!aborted) {
      controller.abort();
    }
    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

it('retains ordinary Stop durability', () => {
  const controller = new AbortController();
  const start = jest.fn();
  const cancel = jest.fn();
  bindPrivateTextPersistenceAbort({}, controller.signal, start, cancel);
  controller.abort();
  expect(start).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
});

it.each([false, true])(
  'coordinates the actual SDK parallel graph, rejected sibling: %s',
  async (rejectSibling) => {
    const { req, message, filters } = turn();
    const start = jest.fn(async () => ({ message }));
    const created = jest.fn();
    const cancel = jest.fn();
    const initial = createPrivateTextInitialAdmissionCallback(req, {
      agentIds: ['a', 'b'],
      start,
      cancel,
      onPersisted: created,
    })!;
    const inspect = createModelBoundChatModelCallback(
      {
        filters: {
          ...filters,
          agentInstructions: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'history', label: 'Restricted', regex: 'RESTRICTED-HISTORY' }],
            },
          },
        },
      },
      getPrivateTextModelHooks(req, initial, start, cancel, created),
    );
    const invoke = jest.fn();
    const model = new FakeChatModel({ responses: ['Safe reply'], sleep: 0 });
    const stream = model._streamResponseChunks.bind(model);
    jest.spyOn(model, '_streamResponseChunks').mockImplementation(async function* (...args) {
      expect(created).toHaveBeenCalledTimes(1);
      invoke();
      yield* stream(...args);
    });
    // Same registration adapter used by the production model-client boundary.
    model.callbacks = [
      Object.assign(
        BaseCallbackHandler.fromMethods({
          handleChatModelStart: (llm, batches, runId, parentRunId, extra, tags, metadata) =>
            inspect.handleChatModelStart(
              llm,
              batches.map((batch) =>
                batch.map((entry) => ({
                  role: entry.getType(),
                  content:
                    rejectSibling && metadata?.agentId === 'b'
                      ? 'RESTRICTED-HISTORY'
                      : entry.content,
                })),
              ),
              runId,
              parentRunId,
              extra,
              tags,
              metadata,
            ),
        }),
        { raiseError: true, awaitHandlers: true },
      ),
    ];
    const run = await Run.create({
      runId: `private-parallel-${rejectSibling}`,
      skipCleanup: true,
      tokenCounter: () => 1,
      graphConfig: {
        type: 'multi-agent',
        edges: [],
        agents: ['a', 'b'].map((agentId) => ({
          agentId,
          provider: Providers.OPENAI,
          tools: [],
          instructions:
            rejectSibling && agentId === 'b' ? 'RESTRICTED-HISTORY' : 'Safe instructions',
          maxContextTokens: 100_000,
          clientOptions: { apiKey: 'fixture-key', streaming: false },
        })),
      },
    });
    if (run.Graph == null) {
      throw new Error('SDK graph was not initialized');
    }
    run.Graph.overrideModel = model;
    const config = withPrivateTextAdmissionConfig(
      { configurable: { thread_id: 'private-parallel' }, version: 'v2' as const },
      initial,
    );
    const execution = run.processStream(
      { messages: [new HumanMessage('Safe turn')] },
      {
        ...config,
        callbacks: [
          Object.assign(
            BaseCallbackHandler.fromMethods({
              handleChainStart: initial.handleChainStart,
              handleChainEnd: initial.handleChainEnd,
              handleChainError: initial.handleChainError,
              handleLLMError: initial.handleLLMError,
            }),
            { raiseError: true, awaitHandlers: true },
          ),
        ],
      },
    );
    if (rejectSibling) {
      await execution.catch(() => undefined);
      expect(start).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    } else {
      await execution;
      expect(start).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledTimes(2);
    }
  },
);
