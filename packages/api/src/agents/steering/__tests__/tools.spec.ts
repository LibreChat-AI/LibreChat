import { z } from 'zod';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { EventHandler, StreamPreemption, ToolExecuteBatchRequest } from '@librechat/agents';
import { createToolExecuteHandler } from '~/agents/handlers';
import { interruptToolHandler } from '../tools';

function control() {
  let requested = false;
  const listeners = new Set<() => void>();
  const preemption: StreamPreemption = {
    shouldPreempt: () => requested,
    subscribe: (wake) => {
      listeners.add(wake);
      if (requested) wake();
      return () => listeners.delete(wake);
    },
  };
  return {
    preemption,
    listeners,
    wake: () => {
      for (const wake of listeners) wake();
    },
    interrupt: () => {
      requested = true;
      for (const wake of listeners) wake();
    },
  };
}

function batch(overrides: Partial<ToolExecuteBatchRequest> = {}): ToolExecuteBatchRequest {
  return {
    toolCalls: [
      { id: 'one', name: 'search', args: {} },
      { id: 'two', name: 'search', args: {} },
    ],
    resolve: jest.fn(),
    reject: jest.fn(),
    ...overrides,
  };
}

function pendingHandler() {
  let request: ToolExecuteBatchRequest | undefined;
  const handler: EventHandler = {
    handle: jest.fn(async (_event, data) => {
      request = data as ToolExecuteBatchRequest;
    }),
  };
  return {
    handler,
    request: () => {
      if (request == null) throw new Error('Tool handler was not called');
      return request;
    },
  };
}

describe('interruptToolHandler', () => {
  it('waits for tools during ordinary steering and ignores spurious wakes', async () => {
    const { handler, request } = pendingHandler();
    const state = control();
    const input = batch();
    const pending = interruptToolHandler(handler, state.preemption).handle(
      'on_tool_execute',
      input,
    );
    state.wake();
    expect(input.resolve).not.toHaveBeenCalled();
    expect(request().signal?.aborted).toBe(false);
    request().resolve([]);
    await pending;
    expect(state.listeners.size).toBe(0);
  });

  it('keeps completed results and cancels only the unfinished work without stopping the run', async () => {
    const { handler, request } = pendingHandler();
    const state = control();
    const run = new AbortController();
    const input = batch({ signal: run.signal });
    const pending = interruptToolHandler(handler, state.preemption).handle(
      'on_tool_execute',
      input,
    );
    const completed = { toolCallId: 'one', status: 'success' as const, content: 'found it' };
    request().onResult?.(completed);
    state.interrupt();
    await pending;
    expect(request().signal?.aborted).toBe(true);
    expect(run.signal.aborted).toBe(false);
    expect(input.resolve).toHaveBeenCalledWith([
      completed,
      expect.objectContaining({
        toolCallId: 'two',
        status: 'error',
        errorMessage: expect.stringContaining('Do not repeat'),
      }),
    ]);
    expect(state.listeners.size).toBe(0);
  });

  it('does not start a side effect when interruption is already armed', async () => {
    const { handler } = pendingHandler();
    const state = control();
    state.interrupt();
    const input = batch();
    await interruptToolHandler(handler, state.preemption).handle('on_tool_execute', input);
    expect(handler.handle).not.toHaveBeenCalled();
    expect(input.resolve).toHaveBeenCalledTimes(1);
    expect(state.listeners.size).toBe(0);
  });

  it('ignores late results and rejects after interruption', async () => {
    const { handler, request } = pendingHandler();
    const state = control();
    const input = batch({ onResult: jest.fn() });
    const pending = interruptToolHandler(handler, state.preemption).handle(
      'on_tool_execute',
      input,
    );
    state.interrupt();
    await pending;
    const late = { toolCallId: 'two', status: 'success' as const, content: 'late' };
    request().onResult?.(late);
    request().resolve([late]);
    request().reject(new Error('late error'));
    expect(input.resolve).toHaveBeenCalledTimes(1);
    expect(input.onResult).not.toHaveBeenCalled();
    expect(input.reject).not.toHaveBeenCalled();
  });

  it('forwards normal failures and releases the subscription', async () => {
    const { handler, request } = pendingHandler();
    const state = control();
    const input = batch();
    const pending = interruptToolHandler(handler, state.preemption).handle(
      'on_tool_execute',
      input,
    );
    const failure = new Error('failed');
    request().reject(failure);
    await expect(pending).rejects.toBe(failure);
    expect(input.reject).toHaveBeenCalledWith(failure);
    expect(state.listeners.size).toBe(0);
  });

  it('releases the subscription when Stop aborts the run', async () => {
    const { handler } = pendingHandler();
    const state = control();
    const controller = new AbortController();
    const input = batch({ signal: controller.signal });
    const pending = interruptToolHandler(handler, state.preemption).handle(
      'on_tool_execute',
      input,
    );
    const failure = new Error('Run stopped');
    controller.abort(failure);
    await expect(pending).rejects.toBe(failure);
    expect(input.reject).toHaveBeenCalledWith(failure);
    expect(state.listeners.size).toBe(0);
  });

  it('leaves independently controlled child executions alone', async () => {
    const { handler } = pendingHandler();
    const state = control();
    const input = batch({
      executionContext: {
        rootRunId: 'root',
        depth: 1,
        ancestry: [],
        hookSessionId: 'child',
      },
    });
    await interruptToolHandler(handler, state.preemption).handle('on_tool_execute', input);
    expect(handler.handle).toHaveBeenCalledWith('on_tool_execute', input, undefined, undefined);
    expect(state.listeners.size).toBe(0);
  });

  it('cancels a real tool invocation and suppresses artifacts from a tool that ignores cancellation', async () => {
    const state = control();
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const tool = new DynamicStructuredTool({
      name: 'search',
      description: 'Search',
      schema: z.object({}),
      responseFormat: 'content_and_artifact',
      func: async (_input, _manager, config) => {
        signal = config?.signal;
        started?.();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return ['late result', { files: [] }];
      },
    });
    const callback = jest.fn();
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      toolEndCallback: callback,
    });
    const input = batch({ toolCalls: [{ id: 'one', name: 'search', args: {} }] });
    const pending = interruptToolHandler(handler, state.preemption).handle(
      'on_tool_execute',
      input,
    );
    await ready;
    state.interrupt();
    await pending;
    expect(signal?.aborted).toBe(true);
    finish?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(callback).not.toHaveBeenCalled();
    expect(input.resolve).toHaveBeenCalledTimes(1);
    expect(input.reject).not.toHaveBeenCalled();
  });
});
