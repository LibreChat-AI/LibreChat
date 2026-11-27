import { z } from 'zod';
import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';
import type { BackgroundTaskRegistryClass } from './background';
import type * as Handlers from './handlers';
import { BACKGROUND_TASK_SHUTDOWN_MESSAGE } from './backgroundCompletion';

type CreateToolExecuteHandler = typeof Handlers.createToolExecuteHandler;

interface BatchResult {
  content: string;
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/** Each test drains the registry, which closes admission for the rest of the process,
 *  so every test loads its own handler and registry instances. */
function loadModules(): {
  createToolExecuteHandler: CreateToolExecuteHandler;
  registry: BackgroundTaskRegistryClass;
} {
  let loaded:
    | { createToolExecuteHandler: CreateToolExecuteHandler; registry: BackgroundTaskRegistryClass }
    | undefined;
  jest.isolateModules(() => {
    const handlers = jest.requireActual<typeof Handlers>('./handlers');
    const background = jest.requireActual<typeof import('./background')>('./background');
    loaded = {
      createToolExecuteHandler: handlers.createToolExecuteHandler,
      registry: background.backgroundTaskRegistry,
    };
  });
  if (loaded == null) {
    throw new Error('modules failed to load');
  }
  return loaded;
}

const buildConfig = (backgroundToolNames: string[]) => ({
  req: { user: { id: 'shutdown_user' }, body: { conversationId: 'shutdown_convo' } },
  backgroundToolNames,
});

async function runBatch(
  handler: ReturnType<CreateToolExecuteHandler>,
  input: {
    toolCalls: Array<Record<string, unknown>>;
    configurable: Record<string, unknown>;
    metadata: Record<string, unknown>;
  },
): Promise<BatchResult[]> {
  let out: BatchResult[] = [];
  await handler.handle('on_tool_execute', {
    ...input,
    agentId: 'agent_shutdown',
    resolve: (results: BatchResult[]) => {
      out = results;
    },
    reject: (error: Error) => {
      throw error;
    },
  } as unknown as Parameters<typeof handler.handle>[1]);
  return out;
}

function completionAdapter() {
  const persistResult = jest.fn(async () => true);
  const retire = jest.fn(async () => true);
  const renew = jest.fn(async () => true);
  const persist = jest.fn(async () => true);
  return {
    persistResult,
    retire,
    renew,
    persist,
    backgroundToolCompletion: {
      preregister: jest.fn(async () => ({ renew, persistResult, retire })),
      persist,
      claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
    },
  };
}

/** A search tool whose invocation the test controls; it may honor or ignore the abort. */
function controlledTool(options: { honorAbort: boolean }) {
  let resolveInvocation: (value: { content: string }) => void = () => undefined;
  const tool = {
    name: 'search_mcp_docs',
    description: 'search docs',
    schema: z.object({ q: z.string() }),
    invoke: jest.fn(
      (_input: unknown, config?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          resolveInvocation = resolve;
          if (!options.honorAbort) {
            return;
          }
          config?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('This operation was aborted', 'AbortError')),
            { once: true },
          );
        }),
    ),
  } as unknown as StructuredToolInterface;
  return { tool, resolve: (content: string) => resolveInvocation({ content }) };
}

const drainOptions = () => ({
  deadlineAt: Date.now() + 800,
  interruptGraceMs: 300,
  flushReserveMs: 100,
  reason: BACKGROUND_TASK_SHUTDOWN_MESSAGE,
});

const interruptedOutput = `Error: [search_mcp_docs] tool call failed: ${BACKGROUND_TASK_SHUTDOWN_MESSAGE}`;

describe('createToolExecuteHandler — background tasks at shutdown', () => {
  it('interrupts a running tool and delivers the shutdown reason as its result', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    const adapter = completionAdapter();
    const { tool } = controlledTool({ honorAbort: true });
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: adapter.backgroundToolCompletion,
    });

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-interrupt',
          name: tool.name,
          args: { q: 'slow', run_in_background: true },
          stepId: 'step-interrupt',
        },
      ],
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-interrupt' },
    });
    const taskId = JSON.parse(dispatch.content).background_task_id;

    const summary = await registry.drainForShutdown(drainOptions());

    expect(summary).toEqual({ tracked: 1, interrupted: 1, flushed: 0, unsettled: 0 });
    expect(adapter.persistResult).toHaveBeenCalledTimes(1);
    expect(adapter.persistResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', output: interruptedOutput }),
    );
    expect(adapter.retire).not.toHaveBeenCalled();
    expect(registry.get('shutdown_user', 'shutdown_convo', taskId)).toMatchObject({
      status: 'error',
      error: BACKGROUND_TASK_SHUTDOWN_MESSAGE,
    });
  });

  it('records an interrupted result for a tool that ignores the abort, and a late result keeps it', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    const adapter = completionAdapter();
    const controlled = controlledTool({ honorAbort: false });
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [controlled.tool] }),
      backgroundToolCompletion: adapter.backgroundToolCompletion,
    });

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-stubborn',
          name: controlled.tool.name,
          args: { q: 'stubborn', run_in_background: true },
          stepId: 'step-stubborn',
        },
      ],
      configurable: buildConfig([controlled.tool.name]),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-stubborn' },
    });
    const taskId = JSON.parse(dispatch.content).background_task_id;

    const summary = await registry.drainForShutdown(drainOptions());

    expect(summary).toEqual({ tracked: 1, interrupted: 1, flushed: 1, unsettled: 0 });
    expect(adapter.persistResult).toHaveBeenCalledTimes(1);
    expect(adapter.persistResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', output: interruptedOutput }),
    );
    expect(registry.get('shutdown_user', 'shutdown_convo', taskId)?.status).toBe('error');

    adapter.persist.mockResolvedValueOnce(false);
    controlled.resolve('late result');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(adapter.persistResult).toHaveBeenCalledTimes(1);
    expect(adapter.retire).not.toHaveBeenCalled();
  });

  it('stores a finished code result durably when its harvest is still waiting', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    const adapter = completionAdapter();
    const codeTool = {
      name: 'execute_code',
      description: 'run code',
      schema: z.object({ lang: z.string(), code: z.string() }),
      invoke: jest.fn(async () => ({ content: 'stdout:\nhello' })),
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [codeTool] }),
      backgroundToolCompletion: adapter.backgroundToolCompletion,
      persistBackgroundCodeResult: () => new Promise(() => undefined),
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-code-harvest',
          name: 'execute_code',
          args: { lang: 'py', code: 'print(1)', run_in_background: true },
          stepId: 'step-code-harvest',
          turn: 1,
        },
      ],
      configurable: buildConfig(['execute_code']),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-code-harvest' },
    });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(adapter.persistResult).not.toHaveBeenCalled();

    const summary = await registry.drainForShutdown(drainOptions());

    expect(summary).toEqual({ tracked: 1, interrupted: 0, flushed: 1, unsettled: 0 });
    expect(adapter.persistResult).toHaveBeenCalledTimes(1);
    expect(adapter.persistResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', output: expect.stringContaining('hello') }),
    );
  });

  it('waits for a legacy pre-admitted completion projection before declaring shutdown durable', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    let notifyFlush: () => void = () => undefined;
    const flushStarted = new Promise<void>((resolve) => {
      notifyFlush = resolve;
    });
    const trackShutdown = registry.trackShutdown.bind(registry);
    jest.spyOn(registry, 'trackShutdown').mockImplementation((task, handle) =>
      trackShutdown(task, {
        ...handle,
        flush: (reason) => {
          notifyFlush();
          return handle.flush(reason);
        },
      }),
    );
    let resolveProjection: (persisted: boolean) => void = () => undefined;
    const persist = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProjection = resolve;
        }),
    );
    const retire = jest.fn(async () => true);
    const tool = {
      name: 'search_mcp_docs',
      description: 'search docs',
      schema: z.object({ q: z.string() }),
      invoke: jest.fn(async () => ({ content: 'legacy projection result' })),
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({ renew: async () => true, retire })),
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-legacy-projection',
          name: tool.name,
          args: { q: 'legacy', run_in_background: true },
          stepId: 'step-legacy',
        },
      ],
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-legacy-projection' },
    });
    await flushMicrotasks();
    expect(persist).toHaveBeenCalledTimes(1);

    const draining = registry.drainForShutdown({
      ...drainOptions(),
      deadlineAt: Date.now() + 1_750,
      flushReserveMs: 1_400,
    });
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await flushStarted;
    await flushMicrotasks();
    expect(drained).toBe(false);
    resolveProjection(true);
    expect(await draining).toEqual({ tracked: 1, interrupted: 0, flushed: 1, unsettled: 0 });
    expect(retire).not.toHaveBeenCalled();
  });

  it('reports a pre-admitted legacy completion with no durable projection as unsettled', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    const persist = jest.fn(async () => false);
    const tool = {
      name: 'search_mcp_docs',
      description: 'search docs',
      schema: z.object({ q: z.string() }),
      invoke: jest.fn(async () => ({ content: 'missing legacy result' })),
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({ renew: async () => true, retire: async () => true })),
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-legacy-failed',
          name: tool.name,
          args: { q: 'failed', run_in_background: true },
          stepId: 'step-legacy-failed',
        },
      ],
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-legacy-failed' },
    });
    await flushMicrotasks();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(
      await registry.drainForShutdown({
        ...drainOptions(),
        deadlineAt: Date.now() + 190,
        interruptGraceMs: 75,
        flushReserveMs: 40,
      }),
    ).toEqual({
      tracked: 1,
      interrupted: 0,
      flushed: 1,
      unsettled: 1,
    });
  });

  it('projects an interrupted result for an uncooperative legacy completion without a receipt', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    const persist = jest.fn(async () => true);
    const controlled = controlledTool({ honorAbort: false });
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [controlled.tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({ renew: async () => true, retire: async () => true })),
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-legacy-stubborn',
          name: controlled.tool.name,
          args: { q: 'stubborn', run_in_background: true },
          stepId: 'step-legacy-stubborn',
        },
      ],
      configurable: buildConfig([controlled.tool.name]),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-legacy-stubborn' },
    });

    expect(
      await registry.drainForShutdown({
        ...drainOptions(),
        deadlineAt: Date.now() + 280,
        interruptGraceMs: 90,
        flushReserveMs: 70,
      }),
    ).toEqual({
      tracked: 1,
      interrupted: 1,
      flushed: 1,
      unsettled: 0,
    });
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        output: interruptedOutput,
        backgroundTask: expect.objectContaining({ status: 'error' }),
      }),
    );

    controlled.resolve('late success');
    await flushMicrotasks();
    await flushMicrotasks();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('reports a failed legacy interruption projection as unconfirmed', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    const persist = jest.fn(async () => false);
    const controlled = controlledTool({ honorAbort: false });
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [controlled.tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({ renew: async () => true, retire: async () => true })),
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-legacy-interruption-failed',
          name: controlled.tool.name,
          args: { q: 'stubborn', run_in_background: true },
          stepId: 'step-legacy-interruption-failed',
        },
      ],
      configurable: buildConfig([controlled.tool.name]),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-legacy-interruption-failed' },
    });

    expect(
      await registry.drainForShutdown({
        ...drainOptions(),
        deadlineAt: Date.now() + 280,
        interruptGraceMs: 90,
        flushReserveMs: 70,
      }),
    ).toEqual({
      tracked: 1,
      interrupted: 1,
      flushed: 1,
      unsettled: 1,
    });
    expect(persist).toHaveBeenCalledTimes(1);
    controlled.resolve('late success');
    await flushMicrotasks();
    await flushMicrotasks();
  });

  it('waits for the projected result when an independent receipt write returns false', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    const adapter = completionAdapter();
    adapter.persistResult.mockResolvedValue(false);
    let resolveProjection: (ready: boolean) => void = () => undefined;
    adapter.persist.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProjection = resolve;
        }),
    );
    const tool = {
      name: 'search_mcp_docs',
      description: 'search docs',
      schema: z.object({ q: z.string() }),
      invoke: jest.fn(async () => ({ content: 'projected output' })),
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: adapter.backgroundToolCompletion,
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-projected',
          name: tool.name,
          args: { q: 'projected', run_in_background: true },
          stepId: 'step-projected',
        },
      ],
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-projected' },
    });
    await flushMicrotasks();
    expect(adapter.persistResult).toHaveReturnedTimes(1);
    expect(adapter.persist).toHaveBeenCalledTimes(1);

    const draining = registry.drainForShutdown(drainOptions());
    resolveProjection(true);
    expect(await draining).toEqual({ tracked: 1, interrupted: 0, flushed: 0, unsettled: 0 });
    expect(adapter.retire).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed result when neither receipt nor projection becomes durable', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    const adapter = completionAdapter();
    adapter.persistResult.mockResolvedValue(false);
    adapter.persist.mockResolvedValue(false);
    const tool = {
      name: 'search_mcp_docs',
      description: 'search docs',
      schema: z.object({ q: z.string() }),
      invoke: jest.fn(async () => ({ content: 'not durable' })),
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: adapter.backgroundToolCompletion,
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-undurable',
          name: tool.name,
          args: { q: 'undurable', run_in_background: true },
          stepId: 'step-undurable',
        },
      ],
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-undurable' },
    });
    await flushMicrotasks();
    expect(adapter.retire).toHaveBeenCalledTimes(1);

    expect(await registry.drainForShutdown(drainOptions())).toEqual({
      tracked: 1,
      interrupted: 0,
      flushed: 1,
      unsettled: 1,
    });
  });

  it('refuses a new background dispatch once shutdown closes admission', async () => {
    const { createToolExecuteHandler, registry } = loadModules();
    const adapter = completionAdapter();
    const { tool } = controlledTool({ honorAbort: true });
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: adapter.backgroundToolCompletion,
    });
    registry.closeAdmission();

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-after-shutdown',
          name: tool.name,
          args: { q: 'late', run_in_background: true },
          stepId: 'step-after-shutdown',
        },
      ],
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'shutdown_convo', run_id: 'response-after-shutdown' },
    });

    expect(JSON.parse(dispatch.content)).toMatchObject({
      status: 'rejected',
      scope: 'shutting_down',
    });
    expect(tool.invoke).not.toHaveBeenCalled();
    expect(adapter.backgroundToolCompletion.preregister).not.toHaveBeenCalled();
  });
});
