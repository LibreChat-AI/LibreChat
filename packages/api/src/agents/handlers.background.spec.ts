import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import { tool as structuredTool } from '@librechat/agents/langchain/tools';
import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';
import type { FiltersConfig } from 'librechat-data-provider';
import type { BackgroundToolWakeupAdmission } from './backgroundCompletion';
import type { ToolExecuteOptions } from './handlers';
import {
  BACKGROUND_TASK_ABORT_GRACE_MS,
  BACKGROUND_TASK_TIMEOUT_MS,
  BACKGROUND_TOOL_PRODUCER_HEARTBEAT_MS,
} from './backgroundCompletion';
import {
  backgroundTaskRegistry,
  runCheckBackgroundTask,
  CHECK_BACKGROUND_TASK_NAME,
} from './background';
import { BACKGROUND_TOOL_INVOCATION_CONFIG_KEY } from './invocation';
import { ContentFilterError } from '../middleware/contentFilter';
import { createToolExecuteHandler } from './handlers';

interface BatchInput {
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    stepId?: string;
    turn?: number;
    codeSessionContext?: { session_id: string; files?: Array<Record<string, unknown>> };
    runtimeSessionHint?: string;
  }>;
  agentId: string;
  configurable: Record<string, unknown>;
  metadata: Record<string, unknown>;
  resolve: (results: Array<{ content: string }>) => void;
  reject: (error: Error) => void;
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

const MODEL_BOUND_FILE_CONTENT_BLOCK = JSON.stringify({
  error: 'content_filter_block',
  message: 'Submitted content was blocked by content policy.',
  source: 'file',
  field: 'content',
});

const MODEL_BOUND_TOOL_OUTPUT_BLOCK = JSON.stringify({
  error: 'content_filter_block',
  message: 'Submitted content was blocked by content policy.',
  source: 'tool_argument',
  field: 'output',
});

const CODE_TOOL_OUTPUT_BLOCK = `Error: [execute_code] tool call failed: ${MODEL_BOUND_TOOL_OUTPUT_BLOCK}`;
const CODE_FILE_CONTENT_BLOCK = `Error: [execute_code] tool call failed: ${MODEL_BOUND_FILE_CONTENT_BLOCK}`;

const makeSearchTool = (state: { calls: number; lastInput?: Record<string, unknown> }) =>
  ({
    name: 'search_mcp_docs',
    description: 'search docs',
    schema: z.object({ q: z.string() }),
    invoke: async (input: Record<string, unknown>) => {
      state.calls += 1;
      state.lastInput = input;
      return { content: `RESULT for ${String(input.q)}` };
    },
  }) as unknown as StructuredToolInterface;

const buildConfig = (
  backgroundToolNames: string[] = ['search_mcp_docs'],
  filters?: FiltersConfig,
) => ({
  req: {
    user: { id: 'exec_user' },
    body: { conversationId: 'exec_convo' },
    ...(filters != null ? { config: { filters } } : {}),
  },
  backgroundToolNames,
});

const runBatch = async (
  handler: ReturnType<typeof createToolExecuteHandler>,
  input: Omit<BatchInput, 'resolve' | 'reject'>,
): Promise<Array<{ content: string }>> => {
  let out: Array<{ content: string }> = [];
  await handler.handle('on_tool_execute', {
    ...input,
    resolve: (results: Array<{ content: string }>) => {
      out = results;
    },
    reject: (error: Error) => {
      throw error;
    },
  } as unknown as Parameters<typeof handler.handle>[1]);
  return out;
};

describe('createToolExecuteHandler — background tool calls', () => {
  it('hands off an explicit polling call and preserves validation feedback in its result', async () => {
    const execute = jest.fn(async () => 'executed');
    const bash = structuredTool(execute, {
      name: 'build_project',
      description: 'Starts commands',
      schema: {
        type: 'object',
        required: ['command'],
        properties: { command: { type: 'string' } },
      },
    });
    const handler = createToolExecuteHandler({ loadTools: async () => ({ loadedTools: [bash] }) });
    const configurable = buildConfig(['build_project']);
    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'invalid-background-bash',
          name: 'build_project',
          args: { background_task_id: 'secret-task', run_in_background: true },
        },
      ],
      agentId: 'agent_parent_1',
      configurable,
      metadata: { thread_id: 'exec_convo', run_id: 'invalid-background-run' },
    });
    const handle = JSON.parse(dispatch.content);
    const statusCheck = JSON.parse(handle.message.split('Status request: ')[1]);
    expect(statusCheck).toEqual({
      name: CHECK_BACKGROUND_TASK_NAME,
      arguments: { background_task_id: handle.background_task_id },
    });
    await flushMicrotasks();
    const [poll] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'poll-invalid-background-bash',
          name: statusCheck.name,
          args: statusCheck.arguments,
        },
      ],
      agentId: 'agent_parent_1',
      configurable,
      metadata: { thread_id: 'exec_convo', run_id: 'invalid-background-run' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(poll.content).toContain('Missing required fields: command');
    expect(poll.content).not.toContain('secret-task');
  });
  it('pre-registers an ordinary completion before invoke and persists its terminal receipt', async () => {
    const events: string[] = [];
    const retire = jest.fn(async () => true);
    const persistResult = jest.fn(async () => {
      events.push('receipt');
      return true;
    });
    const preregister = jest.fn(async () => {
      events.push('preregister');
      return { renew: jest.fn(async () => true), persistResult, retire };
    });
    const persist = jest.fn(async () => {
      events.push('persist');
      return true;
    });
    const tool = {
      name: 'search_mcp_docs',
      description: 'search docs',
      schema: z.object({ q: z.string() }),
      invoke: jest.fn(async () => {
        events.push('invoke');
        return { content: 'durable result' };
      }),
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister,
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-wakeup',
          name: tool.name,
          args: { q: 'continuations', run_in_background: true },
          stepId: 'step-wakeup',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-1' },
    });

    expect(events.slice(0, 2)).toEqual(['preregister', 'invoke']);
    expect(tool.invoke).toHaveBeenCalledWith(
      { q: 'continuations' },
      expect.objectContaining({
        configurable: expect.objectContaining({
          [BACKGROUND_TOOL_INVOCATION_CONFIG_KEY]: true,
        }),
      }),
    );
    expect(JSON.parse(dispatch.content).message).toContain('host will resume you');
    await flushMicrotasks();
    expect(events).toEqual(['preregister', 'invoke', 'receipt', 'persist']);
    expect(preregister).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call-wakeup',
        conversationId: 'exec_convo',
        parentMessageId: 'response-1',
        parentAgentId: 'agent_parent_1',
      }),
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        output: 'durable result',
        stepId: 'step-wakeup',
        backgroundTask: expect.objectContaining({
          taskId: expect.any(String),
          status: 'completed',
        }),
      }),
    );
    expect(persistResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', output: 'durable result' }),
    );
    expect(retire).not.toHaveBeenCalled();
  });

  it('persists structured background content using the registry serialization', async () => {
    const structuredContent = [
      { type: 'text', text: 'structured result' },
      { type: 'resource', uri: 'memory://result' },
    ];
    const tool = {
      name: 'search_mcp_docs',
      description: 'search docs',
      schema: z.object({ q: z.string() }),
      invoke: jest.fn(async () => ({ content: structuredContent })),
    } as unknown as StructuredToolInterface;
    const persist = jest.fn(async () => true);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({
          renew: jest.fn(async () => true),
          retire: jest.fn(async () => true),
        })),
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-structured-wakeup',
          name: tool.name,
          args: { q: 'structured', run_in_background: true },
          stepId: 'step-structured-wakeup',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-structured' },
    });
    await flushMicrotasks();

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ output: JSON.stringify(structuredContent) }),
    );
  });

  it.each(['acknowledged', 'ambiguous'])(
    'keeps delivery live for an %s receipt without a projection',
    async (ack) => {
      const retire = jest.fn(async () => true);
      const persistResult = jest.fn(async () => {
        if (ack === 'ambiguous') throw new Error('receipt committed but acknowledgement lost');
        return true;
      });
      const tool = {
        name: 'search_mcp_docs',
        description: 'search docs',
        schema: z.object({ q: z.string() }),
        invoke: jest.fn(async () => ({ content: 'available before parent row' })),
      } as unknown as StructuredToolInterface;
      const handler = createToolExecuteHandler({
        loadTools: async () => ({ loadedTools: [tool] }),
        backgroundToolCompletion: {
          preregister: jest.fn(async () => ({
            renew: jest.fn(async () => true),
            persistResult,
            retire,
          })),
          persist: jest.fn(async () => false),
          claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
        },
      });

      await runBatch(handler, {
        toolCalls: [
          {
            id: `call-independent-receipt-${ack}`,
            name: tool.name,
            args: { q: 'receipt', run_in_background: true },
            stepId: 'step-independent-receipt',
          },
        ],
        agentId: 'agent_parent_1',
        configurable: buildConfig([tool.name]),
        metadata: { thread_id: 'exec_convo', run_id: `response-independent-receipt-${ack}` },
      });
      await flushMicrotasks();

      expect(persistResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', output: 'available before parent row' }),
      );
      expect(retire).not.toHaveBeenCalled();
    },
  );

  it('keeps polling guidance when the completion adapter skips registration', async () => {
    const tool = makeSearchTool({ calls: 0 });
    const preregister = jest.fn(async () => false as const);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister,
        persist: jest.fn(async () => true),
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-skipped-wakeup',
          name: tool.name,
          args: { q: 'ephemeral', run_in_background: true },
          stepId: 'step-skipped-wakeup',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-1' },
    });

    expect(preregister).toHaveBeenCalledTimes(1);
    expect(JSON.parse(dispatch.content).message).toContain('Call check_background_task');
    expect(JSON.parse(dispatch.content).message).not.toContain('host will resume you');
  });

  it('keeps repeated provider ids poll-only when the host step identity is absent', async () => {
    const tool = makeSearchTool({ calls: 0 });
    const preregister = jest.fn(async () => ({
      renew: jest.fn(async () => true),
      retire: jest.fn(async () => true),
    }));
    const persist = jest.fn(async () => true);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister,
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-without-step',
          name: tool.name,
          args: { q: 'legacy', run_in_background: true },
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-1' },
    });
    await flushMicrotasks();

    expect(preregister).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(JSON.parse(dispatch.content).message).toContain('Call check_background_task');
    expect(JSON.parse(dispatch.content).message).not.toContain('host will resume you');
  });

  it('expedites the delivery when only the parent-message projection was persisted', async () => {
    const tool = makeSearchTool({ calls: 0 });
    const expedite = jest.fn();
    const retire = jest.fn(async () => true);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({
          renew: jest.fn(async () => true),
          persistResult: jest.fn(async () => false),
          retire,
          expedite,
        })),
        persist: jest.fn(async () => true),
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-projection-only',
          name: tool.name,
          args: { q: 'projection', run_in_background: true },
          stepId: 'step-projection-only',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-1' },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(expedite).toHaveBeenCalledTimes(1);
    expect(retire).not.toHaveBeenCalled();
  });

  it('retires a preregistered delivery when terminal persistence fails', async () => {
    const tool = makeSearchTool({ calls: 0 });
    const retire = jest.fn(async () => true);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({ renew: jest.fn(async () => true), retire })),
        persist: jest.fn(async () => false),
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-persistence-failure',
          name: tool.name,
          args: { q: 'retire', run_in_background: true },
          stepId: 'step-persistence-failure',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-1' },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(retire).toHaveBeenCalledWith('background tool result was not persisted', undefined);
  });

  it('falls back to the settled local result when a poll retired delivery before persistence failed', async () => {
    let finishPersistence: ((persisted: boolean) => void) | undefined;
    const persist = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishPersistence = resolve;
        }),
    );
    const retire = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const tool = makeSearchTool({ calls: 0 });
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({ renew: jest.fn(async () => true), retire })),
        persist,
        claim: jest.fn(async () => ({ status: 'not_ready' as const })),
      },
    });

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-poll-before-failure',
          name: tool.name,
          args: { q: 'settle', run_in_background: true },
          stepId: 'step-poll-before-failure',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-poll-before-failure' },
    });
    await flushMicrotasks();
    const taskId = JSON.parse(dispatch.content).background_task_id as string;

    const waiting = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'exec_user',
        conversationId: 'exec_convo',
        args: { background_task_id: taskId },
        toolCallId: 'manual-poll-1',
        runId: 'response-poll-before-failure',
        claimBackgroundToolResult: async () => ({ status: 'not_ready' }),
      }),
    );
    expect(waiting.status).toBe('result_persisting');
    expect(
      backgroundTaskRegistry.get('exec_user', 'exec_convo', taskId)?.resultClaim,
    ).toBeUndefined();

    finishPersistence?.(false);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(
      backgroundTaskRegistry.get('exec_user', 'exec_convo', taskId)?.completionPersistenceFailed,
    ).toBe(true);

    const recovered = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'exec_user',
        conversationId: 'exec_convo',
        args: { background_task_id: taskId },
        toolCallId: 'manual-poll-2',
        runId: 'response-poll-before-failure',
        claimBackgroundToolResult: async () => ({ status: 'not_ready' }),
      }),
    );
    expect(recovered).toMatchObject({
      status: 'completed',
      result: 'RESULT for settle',
    });
  });

  it('keeps durable ownership active when an ambiguous persistence failure cannot retire a lease', async () => {
    const tool = makeSearchTool({ calls: 0 });
    const retire = jest.fn(async () => false);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({ renew: jest.fn(async () => true), retire })),
        persist: jest.fn(async () => {
          throw new Error('write receipt lost');
        }),
        claim: jest.fn(async () => ({ status: 'claimed' as const })),
      },
    });

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-ambiguous-persistence',
          name: tool.name,
          args: { q: 'ambiguous', run_in_background: true },
          stepId: 'step-ambiguous-persistence',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-ambiguous' },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const taskId = JSON.parse(dispatch.content).background_task_id as string;
    expect(retire).toHaveBeenCalledWith('background tool result persistence failed', {
      onlyIfUnclaimed: true,
    });
    const task = backgroundTaskRegistry.get('exec_user', 'exec_convo', taskId);
    expect(task?.completionWakeup).toBe(true);
    expect(task?.completionPersistenceFailed).toBeUndefined();
  });

  it('elects live polling only when the settled result actually contains an artifact', async () => {
    const retire = jest.fn(async () => true);
    const preregister = jest.fn(async () => ({
      renew: jest.fn(async () => true),
      retire,
    }));
    const persist = jest.fn(async () => true);
    const tool = {
      name: 'artifact_tool',
      description: 'returns a live artifact',
      schema: z.object({ q: z.string() }),
      responseFormat: 'content_and_artifact',
      invoke: jest.fn(async () => ({
        content: 'artifact result',
        artifact: { files: ['report.pdf'] },
      })),
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister,
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-artifact-poll',
          name: tool.name,
          args: { q: 'artifact', run_in_background: true },
          stepId: 'step-artifact-poll',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-artifact' },
    });
    await flushMicrotasks();

    expect(preregister).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith('background tool artifact requires live polling');
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundTask: expect.not.objectContaining({ completionWakeup: true }),
      }),
    );
    expect(JSON.parse(dispatch.content).message).toContain('must call check_background_task');
    expect(JSON.parse(dispatch.content).message).toContain('do not end the turn');
  });

  it('keeps automatic completion for a declared artifact tool that returns content only', async () => {
    const retire = jest.fn(async () => true);
    const persist = jest.fn(async () => true);
    const tool = {
      name: 'optional_artifact_tool',
      description: 'may return an artifact',
      schema: z.object({ q: z.string() }),
      responseFormat: 'content_and_artifact',
      invoke: jest.fn(async () => ({ content: 'content-only result' })),
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({
          renew: jest.fn(async () => true),
          retire,
        })),
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-optional-artifact',
          name: tool.name,
          args: { q: 'content', run_in_background: true },
          stepId: 'step-optional-artifact',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-optional-artifact' },
    });
    await flushMicrotasks();

    expect(retire).not.toHaveBeenCalled();
    expect(JSON.parse(dispatch.content).message).toContain('must call check_background_task');
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundTask: expect.objectContaining({ completionWakeup: true }),
      }),
    );
  });

  it('persists ordinary background failures in the renderer-recognized error shape', async () => {
    const tool = {
      name: 'search_mcp_docs',
      description: 'search docs',
      schema: z.object({ q: z.string() }),
      invoke: jest.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as StructuredToolInterface;
    const persist = jest.fn(async () => true);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({
          renew: jest.fn(async () => true),
          retire: jest.fn(async () => true),
        })),
        persist,
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-ordinary-failure',
          name: tool.name,
          args: { q: 'fail', run_in_background: true },
          stepId: 'step-ordinary-failure',
        },
      ],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-1' },
    });
    await flushMicrotasks();

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        output: 'Error: [search_mcp_docs] tool call failed: boom',
        backgroundTask: expect.objectContaining({ status: 'error' }),
      }),
    );
  });

  it('persists a terminal receipt when an admitted background task times out', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const tool = {
        name: 'search_mcp_docs',
        description: 'search docs',
        schema: z.object({ q: z.string() }),
        invoke: jest.fn(
          (_input: unknown, config?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              const signal = config?.signal;
              if (signal?.aborted === true) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        ),
      } as unknown as StructuredToolInterface;
      const persist = jest.fn(async () => true);
      const handler = createToolExecuteHandler({
        loadTools: async () => ({ loadedTools: [tool] }),
        backgroundToolCompletion: {
          preregister: jest.fn(async () => ({
            renew: jest.fn(async () => true),
            retire: jest.fn(async () => true),
          })),
          persist,
          claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
        },
      });

      const [dispatch] = await runBatch(handler, {
        toolCalls: [
          {
            id: 'call-timeout-wakeup',
            name: tool.name,
            args: { q: 'hang', run_in_background: true },
            stepId: 'step-timeout-wakeup',
          },
        ],
        agentId: 'agent_parent_1',
        configurable: buildConfig([tool.name]),
        metadata: { thread_id: 'exec_convo', run_id: 'response-timeout' },
      });

      jest.advanceTimersByTime(31 * 60 * 1000);
      await flushMicrotasks();
      await flushMicrotasks();

      expect(persist).toHaveBeenCalledWith(
        expect.objectContaining({
          output: 'Error: [search_mcp_docs] tool call failed: Background task timed out',
          backgroundTask: expect.objectContaining({
            taskId: JSON.parse(dispatch.content).background_task_id,
            status: 'error',
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves timeout provenance when cancellation is requested after the deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      let rejectInvocation: ((error: unknown) => void) | undefined;
      let invocationSignal: AbortSignal | undefined;
      const tool = {
        name: 'execute_code',
        description: 'settles after acknowledging an abort',
        schema: z.object({ lang: z.string(), code: z.string() }),
        invoke: jest.fn(
          (_input: unknown, config?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              invocationSignal = config?.signal;
              rejectInvocation = reject;
            }),
        ),
      } as unknown as StructuredToolInterface;
      const persistBackgroundCodeResult = jest.fn(
        async (
          _params: Parameters<NonNullable<ToolExecuteOptions['persistBackgroundCodeResult']>>[0],
        ) => ({ attachments: [] }),
      );
      const handler = createToolExecuteHandler({
        loadTools: async () => ({ loadedTools: [tool] }),
        ordinaryToolCancellation: true,
        persistBackgroundCodeResult,
        backgroundToolCompletion: {
          preregister: async () => ({
            renew: jest.fn(async () => true),
            retire: jest.fn(async () => true),
          }),
          persist: jest.fn(async () => true),
          claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
        },
      });
      const configurable = buildConfig([tool.name]);
      const metadata = { thread_id: 'late_cancel_conversation', run_id: 'late-cancel-run' };
      const [dispatch] = await runBatch(handler, {
        toolCalls: [
          {
            id: 'call_late_cancel',
            name: 'execute_code',
            args: { lang: 'python', code: 'while True: pass', run_in_background: true },
          },
        ],
        agentId: 'agent_late_cancel',
        configurable,
        metadata,
      });
      const taskId = JSON.parse(dispatch.content).background_task_id as string;

      jest.advanceTimersByTime(31 * 60 * 1000);
      await flushMicrotasks();
      const [cancellation] = await runBatch(handler, {
        toolCalls: [
          {
            id: 'call_late_cancel_control',
            name: CHECK_BACKGROUND_TASK_NAME,
            args: { background_task_id: taskId, action: 'cancel' },
          },
        ],
        agentId: 'agent_late_cancel',
        configurable,
        metadata,
      });
      expect(JSON.parse(cancellation.content)).toMatchObject({
        status: 'unavailable',
        background_task_id: taskId,
      });

      rejectInvocation?.(
        invocationSignal?.reason ?? new DOMException('Background task timed out', 'AbortError'),
      );
      await flushMicrotasks();
      await flushMicrotasks();

      const persisted =
        persistBackgroundCodeResult.mock.calls[
          persistBackgroundCodeResult.mock.calls.length - 1
        ]?.[0];
      expect(persisted).toEqual(
        expect.objectContaining({ output: expect.stringContaining('Background task timed out') }),
      );
      expect(persisted?.backgroundTask?.cancelled).not.toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retires the automatic wakeup after an abort-resistant invocation exceeds its grace period', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const tool = {
        name: 'search_mcp_docs',
        description: 'search docs',
        schema: z.object({ q: z.string() }),
        invoke: jest.fn(() => new Promise(() => undefined)),
      } as unknown as StructuredToolInterface;
      const persist = jest.fn(async () => true);
      const renew = jest.fn(async () => true);
      const retire = jest.fn(async () => true);
      const handler = createToolExecuteHandler({
        loadTools: async () => ({ loadedTools: [tool] }),
        backgroundToolCompletion: {
          preregister: jest.fn(async () => ({
            renew,
            retire,
          })),
          persist,
          claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
        },
      });

      const [dispatch] = await runBatch(handler, {
        toolCalls: [
          {
            id: 'call-timeout-resistant',
            name: tool.name,
            args: { q: 'hang', run_in_background: true },
            stepId: 'step-timeout-resistant',
          },
        ],
        agentId: 'agent_parent_1',
        configurable: buildConfig([tool.name]),
        metadata: { thread_id: 'exec_convo', run_id: 'response-timeout-resistant' },
      });

      jest.advanceTimersByTime(BACKGROUND_TASK_TIMEOUT_MS + BACKGROUND_TASK_ABORT_GRACE_MS);
      await flushMicrotasks();
      await flushMicrotasks();

      const taskId = JSON.parse(dispatch.content).background_task_id as string;
      expect(backgroundTaskRegistry.get('exec_user', 'exec_convo', taskId)?.status).toBe('running');
      expect(persist).not.toHaveBeenCalled();
      expect(renew).toHaveBeenCalled();
      expect(retire).toHaveBeenCalledWith(
        'background task did not settle after its abort grace period',
        { onlyIfUnclaimed: true },
      );

      const renewalsBefore = renew.mock.calls.length;
      jest.advanceTimersByTime(3 * 60 * 1000);
      await flushMicrotasks();
      expect(renew).toHaveBeenCalledTimes(renewalsBefore);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops producer heartbeats after the completion lease is lost', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      let finishTool: ((value: { content: string }) => void) | undefined;
      const tool = {
        name: 'search_mcp_docs',
        description: 'search docs',
        schema: z.object({ q: z.string() }),
        invoke: jest.fn(
          () =>
            new Promise<{ content: string }>((resolve) => {
              finishTool = resolve;
            }),
        ),
      } as unknown as StructuredToolInterface;
      const renew = jest.fn(async () => false);
      const handler = createToolExecuteHandler({
        loadTools: async () => ({ loadedTools: [tool] }),
        backgroundToolCompletion: {
          preregister: jest.fn(async () => ({
            renew,
            retire: jest.fn(async () => true),
          })),
          persist: jest.fn(async () => true),
          claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
        },
      });

      await runBatch(handler, {
        toolCalls: [
          {
            id: 'call-lost-producer-lease',
            name: tool.name,
            args: { q: 'lease', run_in_background: true },
            stepId: 'step-lost-producer-lease',
          },
        ],
        agentId: 'agent_parent_1',
        configurable: buildConfig([tool.name]),
        metadata: { thread_id: 'exec_convo', run_id: 'response-lost-producer-lease' },
      });

      jest.advanceTimersByTime(BACKGROUND_TOOL_PRODUCER_HEARTBEAT_MS);
      await flushMicrotasks();
      expect(renew).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(BACKGROUND_TOOL_PRODUCER_HEARTBEAT_MS * 6);
      await flushMicrotasks();
      expect(renew).toHaveBeenCalledTimes(1);

      finishTool?.({ content: 'settled after lease loss' });
      await flushMicrotasks();
      await flushMicrotasks();
    } finally {
      jest.useRealTimers();
    }
  });

  it('persists an Event Actor launch before invoking and terminal evidence before wakeup', async () => {
    const events: string[] = [];
    let finishTool: ((value: { content: string }) => void) | undefined;
    const tool = {
      name: 'submit_move_mcp_chess',
      description: 'submits a move',
      schema: z.object({ move: z.string() }),
      invoke: () => {
        events.push('invoke');
        return new Promise<{ content: string }>((resolve) => {
          finishTool = resolve;
        });
      },
    } as unknown as StructuredToolInterface;
    let reservations = 0;
    const eventActorDetachedAction = {
      reserve: jest.fn(async () => {
        events.push('reserve');
        reservations += 1;
        return {
          status: reservations === 1 ? ('reserved' as const) : ('replay' as const),
          taskId: 'event-task-stable-1',
          idempotencyKey: 'a'.repeat(64),
        };
      }),
      markRunning: jest.fn(async () => {
        events.push('running');
        return true;
      }),
      settle: jest.fn(async () => {
        events.push('terminal');
        return true;
      }),
      wake: jest.fn(async () => {
        events.push('wake');
      }),
    };
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      eventActorDetachedAction,
    });
    const request = {
      toolCalls: [
        {
          id: 'call-event-detached',
          name: tool.name,
          args: { move: 'e4', run_in_background: true },
        },
      ],
      agentId: 'agent-player',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'event-conversation', run_id: 'event-response' },
    };

    const first = await runBatch(handler, request);

    expect(JSON.parse(first[0].content)).toMatchObject({
      status: 'running',
      background_task_id: 'event-task-stable-1',
    });
    expect(events).toEqual(['reserve', 'invoke', 'running']);
    finishTool?.({ content: 'move accepted' });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(events).toEqual(['reserve', 'invoke', 'running', 'terminal', 'wake']);
    expect(eventActorDetachedAction.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'event-response:' }),
    );

    const replay = await runBatch(handler, request);

    expect(JSON.parse(replay[0].content).background_task_id).toBe('event-task-stable-1');
    expect(events).toEqual(['reserve', 'invoke', 'running', 'terminal', 'wake', 'reserve']);
    expect(eventActorDetachedAction.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'event-task-stable-1',
        status: 'succeeded',
        result: 'move accepted',
      }),
    );
  });

  it('records filtered detached output as successful side-effect evidence', async () => {
    const protectedValue = 'Authorization: Bearer detached-secret';
    const tool = {
      name: 'submit_move_mcp_chess',
      description: 'submits a move',
      schema: z.object({ move: z.string() }),
      invoke: jest.fn(async () => ({ content: protectedValue })),
    } as unknown as StructuredToolInterface;
    const eventActorDetachedAction = {
      reserve: jest.fn(async () => ({
        status: 'reserved' as const,
        taskId: 'event-task-filtered',
        idempotencyKey: 'e'.repeat(64),
      })),
      markRunning: jest.fn(async () => true),
      settle: jest.fn(async () => true),
      wake: jest.fn(async () => undefined),
    };
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      eventActorDetachedAction,
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-event-filtered',
          name: tool.name,
          args: { move: 'e4', run_in_background: true },
        },
      ],
      agentId: 'agent-player',
      configurable: buildConfig([tool.name], {
        toolArguments: {
          pii: { fields: ['output'], starterPatterns: ['bearer_header'] },
        },
      }),
      metadata: { thread_id: 'event-filtered-conversation', run_id: 'event-filtered-turn' },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(eventActorDetachedAction.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'event-task-filtered',
        status: 'succeeded',
        result: expect.stringContaining('content_filter_block'),
      }),
    );
    expect(JSON.stringify(eventActorDetachedAction.settle.mock.calls)).not.toContain(
      protectedValue,
    );
    expect(eventActorDetachedAction.settle).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(eventActorDetachedAction.wake).toHaveBeenCalledTimes(1);
  });

  it('rejects capacity before creating durable Event Actor launch authority', async () => {
    let invocations = 0;
    const tool = {
      name: 'submit_move_mcp_chess',
      description: 'submits a move',
      schema: z.object({ move: z.string() }),
      invoke: () => {
        invocations += 1;
        return new Promise(() => undefined);
      },
    } as unknown as StructuredToolInterface;
    const configurable = {
      req: {
        user: { id: 'capacity-user' },
        body: { conversationId: 'capacity-conversation' },
      },
      backgroundToolNames: [tool.name],
    };
    const metadata = { thread_id: 'capacity-conversation', run_id: 'capacity-run' };
    const ordinaryHandler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
    });
    await runBatch(ordinaryHandler, {
      toolCalls: Array.from({ length: 10 }, (_, index) => ({
        id: `capacity-${index}`,
        name: tool.name,
        args: { move: 'e4', run_in_background: true },
      })),
      agentId: 'agent-player',
      configurable,
      metadata,
    });

    const reserve = jest.fn(async () => ({
      status: 'reserved' as const,
      taskId: 'event-task-capacity',
      idempotencyKey: 'f'.repeat(64),
    }));
    const detachedHandler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      eventActorDetachedAction: {
        reserve,
        markRunning: jest.fn(async () => true),
        settle: jest.fn(async () => true),
        wake: jest.fn(async () => undefined),
      },
    });

    const [rejected] = await runBatch(detachedHandler, {
      toolCalls: [
        {
          id: 'capacity-detached',
          name: tool.name,
          args: { move: 'e5', run_in_background: true },
        },
      ],
      agentId: 'agent-player',
      configurable,
      metadata,
    });

    expect(rejected.content).toContain('Too many background tasks');
    expect(invocations).toBe(10);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('does not launch an expected action when staged production is disabled', async () => {
    const invoke = jest.fn(async () => ({ content: 'move accepted' }));
    const tool = {
      name: 'submit_move_mcp_chess',
      description: 'submits a move',
      schema: z.object({ move: z.string() }),
      invoke,
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      eventActorDetachedAction: {
        reserve: jest.fn(async () => ({
          status: 'conflict' as const,
          error: 'Detached Event Actor production is not activated',
        })),
        markRunning: jest.fn(async () => true),
        settle: jest.fn(async () => true),
        wake: jest.fn(async () => undefined),
      },
    });

    await expect(
      runBatch(handler, {
        toolCalls: [
          {
            id: 'call-disabled',
            name: tool.name,
            args: { move: 'e4', run_in_background: true },
          },
        ],
        agentId: 'agent-player',
        configurable: buildConfig([tool.name]),
        metadata: { thread_id: 'event-conversation', run_id: 'event-response' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ content: '', errorMessage: expect.stringContaining('activated') }),
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('persists a synchronous detached-tool rejection as terminal evidence', async () => {
    const tool = {
      name: 'submit_move_mcp_chess',
      description: 'submits a move',
      schema: z.object({ move: z.string() }),
      invoke: () => {
        throw new Error('launch rejected synchronously');
      },
    } as unknown as StructuredToolInterface;
    const eventActorDetachedAction = {
      reserve: jest.fn(async () => ({
        status: 'reserved' as const,
        taskId: 'event-task-sync-error',
        idempotencyKey: 'b'.repeat(64),
      })),
      markRunning: jest.fn(async () => true),
      settle: jest.fn(async () => true),
      wake: jest.fn(async () => undefined),
    };
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      eventActorDetachedAction,
    });

    await expect(
      runBatch(handler, {
        toolCalls: [
          {
            id: 'call-sync-error',
            name: tool.name,
            args: { move: 'e4', run_in_background: true },
          },
        ],
        agentId: 'agent-player',
        configurable: buildConfig([tool.name]),
        metadata: { thread_id: 'event-conversation', run_id: 'event-response' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ content: expect.stringContaining('event-task-sync-error') }),
    ]);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(eventActorDetachedAction.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'event-task-sync-error',
        status: 'failed',
        error: expect.stringContaining('launch rejected synchronously'),
      }),
    );
    expect(eventActorDetachedAction.wake).toHaveBeenCalledTimes(1);
  });

  it('does not claim an unrequested provider abort was owner cancellation', async () => {
    const abortError = Object.assign(new Error('operation aborted'), { name: 'AbortError' });
    const tool = {
      name: 'submit_move_mcp_chess',
      description: 'submits a move',
      schema: z.object({ move: z.string() }),
      invoke: async () => {
        throw abortError;
      },
    } as unknown as StructuredToolInterface;
    const eventActorDetachedAction = {
      reserve: jest.fn(async () => ({
        status: 'reserved' as const,
        taskId: 'event-task-cancelled',
        idempotencyKey: 'c'.repeat(64),
      })),
      markRunning: jest.fn(async () => true),
      settle: jest.fn(async () => true),
      wake: jest.fn(async () => undefined),
    };
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      eventActorDetachedAction,
    });

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call-cancelled',
          name: tool.name,
          args: { move: 'e4', run_in_background: true },
        },
      ],
      agentId: 'agent-player',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'event-conversation', run_id: 'event-response' },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(eventActorDetachedAction.settle).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'operation aborted' }),
    );
  });

  it('returns a handle immediately, runs the tool once detached, and yields the result via check_background_task', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const searchTool = makeSearchTool(state);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [searchTool] }),
    });
    const configurable = buildConfig();
    const metadata = { thread_id: 'exec_convo' };

    const dispatchResults = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_bg',
          name: 'search_mcp_docs',
          args: { q: 'librechat', run_in_background: true },
        },
      ],
      agentId: 'agent_1',
      configurable,
      metadata,
    });

    expect(dispatchResults).toHaveLength(1);
    const handle = JSON.parse(dispatchResults[0].content);
    expect(handle.status).toBe('running');
    expect(typeof handle.background_task_id).toBe('string');

    await flushMicrotasks();
    await flushMicrotasks();

    // real tool ran exactly once, without the injected flag
    expect(state.calls).toBe(1);
    expect(state.lastInput).toEqual({ q: 'librechat' });

    const pollResults = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: handle.background_task_id },
        },
      ],
      agentId: 'agent_1',
      configurable,
      metadata,
    });

    const polled = JSON.parse(pollResults[0].content);
    expect(polled.status).toBe('completed');
    expect(polled.result).toContain('RESULT for librechat');
  });

  it('cancels a running background Bash mutation, reports settlement truthfully, and reuses the workspace', async () => {
    let delayedWrites = 0;
    let invocations = 0;
    const bashTool = {
      name: 'bash_tool',
      description: 'runs a workspace command',
      schema: z.object({ command: z.string() }),
      invoke: jest.fn(
        async (
          input: { command: string },
          config?: { signal?: AbortSignal },
        ): Promise<{ content: string }> => {
          invocations += 1;
          if (input.command === 'pwd') {
            return { content: '/workspace' };
          }
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              delayedWrites += 1;
              resolve({ content: 'late mutation completed' });
            }, 50);
            config?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(
                  config.signal?.reason ??
                    new DOMException('Background task cancellation requested', 'AbortError'),
                );
              },
              { once: true },
            );
          });
        },
      ),
    } as unknown as StructuredToolInterface;
    const persistBackgroundCodeResult = jest.fn(async () => ({ attachments: [] }));
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [bashTool] }),
      ordinaryToolCancellation: true,
      persistBackgroundCodeResult,
    });
    const configurable = buildConfig(['bash_tool']);
    const metadata = { thread_id: 'cancel_bash_conversation', run_id: 'cancel-bash-run' };

    const dispatch = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_cancel_bash',
          name: 'bash_tool',
          stepId: 'step_cancel_bash',
          args: { command: 'sleep-then-write', run_in_background: true },
        },
      ],
      agentId: 'agent_cancel_bash',
      configurable,
      metadata,
    });
    const taskId = JSON.parse(dispatch[0].content).background_task_id as string;

    const cancellation = JSON.parse(
      (
        await runBatch(handler, {
          toolCalls: [
            {
              id: 'call_cancel_control',
              name: CHECK_BACKGROUND_TASK_NAME,
              args: { background_task_id: taskId, action: 'cancel' },
            },
          ],
          agentId: 'agent_cancel_bash',
          configurable,
          metadata,
        })
      )[0].content,
    );
    expect(cancellation).toMatchObject({
      status: 'cancellation_requested',
      cancellation_requested: true,
    });

    await flushMicrotasks();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 75));
    const terminal = JSON.parse(
      (
        await runBatch(handler, {
          toolCalls: [
            {
              id: 'call_poll_cancelled_bash',
              name: CHECK_BACKGROUND_TASK_NAME,
              args: { background_task_id: taskId },
            },
          ],
          agentId: 'agent_cancel_bash',
          configurable,
          metadata,
        })
      )[0].content,
    );
    expect(terminal).toMatchObject({
      status: 'cancelled',
      background_task_id: taskId,
    });
    expect(persistBackgroundCodeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundTask: expect.objectContaining({ taskId, status: 'error', cancelled: true }),
      }),
    );
    expect(persistBackgroundCodeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        reapply: true,
        output: expect.stringContaining('cancellation requested'),
        backgroundTask: expect.objectContaining({
          taskId,
          status: 'error',
          cancelled: true,
        }),
      }),
    );
    expect(delayedWrites).toBe(0);

    const reused = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_reuse_bash',
          name: 'bash_tool',
          args: { command: 'pwd', run_in_background: true },
        },
      ],
      agentId: 'agent_cancel_bash',
      configurable,
      metadata: { ...metadata, run_id: 'reuse-run' },
    });
    const reusedTaskId = JSON.parse(reused[0].content).background_task_id as string;
    await flushMicrotasks();
    await flushMicrotasks();
    const reusedTerminal = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'exec_user',
        conversationId: 'cancel_bash_conversation',
        args: { background_task_id: reusedTaskId },
      }),
    );
    expect(reusedTerminal).toMatchObject({ status: 'completed', result: '/workspace' });
    expect(invocations).toBe(2);
  });

  it('blocks normalized arguments before registering or dispatching a background task', async () => {
    const protectedValue = 'PROTECTED-BACKGROUND';
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const searchTool = makeSearchTool(state);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [searchTool] }),
    });
    const configurable = buildConfig(['search_mcp_docs'], {
      toolArguments: {
        pii: {
          starterPatterns: [],
          customPatterns: [
            {
              id: 'protected-value',
              label: 'protected value',
              regex: 'PROTECTED-[A-Z]+',
            },
          ],
        },
      },
    });

    const results = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_filtered_background',
          name: 'search_mcp_docs',
          args: { q: protectedValue, run_in_background: true },
        },
      ],
      agentId: 'agent_1',
      configurable,
      metadata: { thread_id: 'exec_convo_filtered' },
    });
    const result = results[0] as {
      content: string;
      status?: string;
      errorMessage?: string;
    };

    await flushMicrotasks();
    expect(result.status).toBe('error');
    expect(result.content).toBe('');
    expect(result.errorMessage).toContain('content_filter_block');
    expect(result.errorMessage).not.toContain(protectedValue);
    expect(state.calls).toBe(0);
  });

  it.each([
    ['bearer_header', 'Authorization: Bearer background-token', 'Bearer token'],
    ['api_key_header', 'api-key: background-token', 'api-key header'],
  ] as const)(
    'keeps a blocked background %s result stable across repeated model-bound polls',
    async (starterPattern, protectedValue, detectorLabel) => {
      const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
      const searchTool = makeSearchTool(state);
      const handler = createToolExecuteHandler({
        loadTools: async () => ({ loadedTools: [searchTool] }),
      });
      const configurable = buildConfig(['search_mcp_docs'], {
        toolArguments: {
          pii: {
            fields: ['output'],
            starterPatterns: [starterPattern],
          },
        },
      });
      const metadata = { thread_id: `exec_convo_filtered_output_${starterPattern}` };

      const dispatchResults = await runBatch(handler, {
        toolCalls: [
          {
            id: `call_filtered_background_output_${starterPattern}`,
            name: 'search_mcp_docs',
            args: { q: protectedValue, run_in_background: true },
          },
        ],
        agentId: 'agent_1',
        configurable,
        metadata,
      });
      const handle = JSON.parse(dispatchResults[0].content);

      await flushMicrotasks();
      for (const pollSuffix of ['first', 'second']) {
        const [pollResult] = (await runBatch(handler, {
          toolCalls: [
            {
              id: `call_poll_filtered_output_${starterPattern}_${pollSuffix}`,
              name: CHECK_BACKGROUND_TASK_NAME,
              args: { background_task_id: handle.background_task_id },
            },
          ],
          agentId: 'agent_1',
          configurable,
          metadata,
        })) as Array<{ content: string; status?: string; errorMessage?: string }>;
        const polled = JSON.parse(pollResult.content);

        expect(pollResult.status).toBe('success');
        expect(pollResult.errorMessage).toBeUndefined();
        expect(polled.status).toBe('error');
        expect(JSON.parse(polled.error)).toEqual({
          error: 'content_filter_block',
          message: 'Submitted content was blocked by content policy.',
          source: 'tool_argument',
          field: 'output',
        });
        expect(JSON.stringify(polled)).not.toContain(protectedValue);
        expect(JSON.stringify(polled)).not.toContain(detectorLabel);
      }
      expect(state.calls).toBe(1);
    },
  );

  it('filters poll arguments before reading the background task registry', async () => {
    const protectedValue = 'PROTECTED-POLL-ARGUMENT';
    const debugSpy = jest.spyOn(logger, 'debug').mockReturnValue(logger);
    try {
      const handler = createToolExecuteHandler({
        loadTools: async () => ({ loadedTools: [] }),
      });
      const configurable = buildConfig(['search_mcp_docs'], {
        toolArguments: {
          pii: {
            fields: ['arguments'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'protected-argument',
                label: 'protected argument',
                regex: 'PROTECTED-[A-Z-]+',
              },
            ],
          },
        },
      });

      const [result] = (await runBatch(handler, {
        toolCalls: [
          {
            id: 'call_filtered_poll_argument',
            name: CHECK_BACKGROUND_TASK_NAME,
            args: { submitted_selector: protectedValue },
          },
        ],
        agentId: 'agent_1',
        configurable,
        metadata: { thread_id: 'exec_convo_filtered_poll_argument' },
      })) as Array<{ content: string; status?: string; errorMessage?: string }>;

      expect(result.status).toBe('error');
      expect(result.content).toBe('');
      expect(result.errorMessage).toContain('content_filter_block');
      expect(result.errorMessage).not.toContain(protectedValue);
      expect(
        debugSpy.mock.calls.some(([message]) =>
          String(message).includes('check_background_task listed'),
        ),
      ).toBe(false);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('re-inspects a pre-policy background artifact before poll callbacks or delivery', async () => {
    const protectedValue = 'PROTECTED-TIGHTENED-POLL';
    const artifact = { files: [protectedValue] };
    const tool = {
      name: 'search_mcp_docs',
      description: 'returns historical protected output',
      schema: z.object({ q: z.string() }),
      invoke: async () => ({ content: 'safe historical result', artifact }),
    } as unknown as StructuredToolInterface;
    const toolEndCallback = jest.fn();
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      toolEndCallback,
    });
    const metadata = { thread_id: 'exec_convo_tightened_poll' };
    const dispatchConfig = buildConfig(['search_mcp_docs']);
    const [dispatch] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_pre_policy_background',
          name: 'search_mcp_docs',
          args: { q: 'historical', run_in_background: true },
        },
      ],
      agentId: 'agent_1',
      configurable: dispatchConfig,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();
    const taskId = JSON.parse(dispatch.content).background_task_id;

    const tightenedConfig = buildConfig(['search_mcp_docs'], {
      toolArguments: {
        pii: {
          fields: ['output'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'protected-output',
              label: 'protected output',
              regex: 'PROTECTED-[A-Z-]+',
            },
          ],
        },
      },
    });
    const [blockedPoll] = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_tightened_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: taskId },
        },
      ],
      agentId: 'agent_1',
      configurable: tightenedConfig,
      metadata,
    })) as Array<{ content: string; status?: string; errorMessage?: string }>;

    expect(blockedPoll.status).toBe('error');
    expect(blockedPoll.content).toBe('');
    expect(blockedPoll.errorMessage).toContain('content_filter_block');
    expect(blockedPoll.errorMessage).not.toContain(protectedValue);
    expect(toolEndCallback).not.toHaveBeenCalled();

    const [allowedPoll] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_unfiltered_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: taskId },
        },
      ],
      agentId: 'agent_1',
      configurable: dispatchConfig,
      metadata,
    });
    expect(JSON.parse(allowedPoll.content).result).toBe('safe historical result');
    expect(toolEndCallback).toHaveBeenCalledTimes(1);
    /** Delivery callbacks must carry provenance: they report the ORIGINAL
     * tool's name with the poll call's arguments, so identity-fencing
     * consumers (the event-actor action recorder) can exclude them. */
    expect(toolEndCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundDelivery: true,
        input: { background_task_id: taskId },
        output: expect.objectContaining({ artifact }),
      }),
      expect.any(Object),
    );
  });

  it('does not double-dispatch when the same tool call re-executes (resume/replay)', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const searchTool = makeSearchTool(state);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [searchTool] }),
    });
    const configurable = buildConfig();
    const metadata = { thread_id: 'exec_convo_dup' };
    const toolCalls = [
      { id: 'call_same', name: 'search_mcp_docs', args: { q: 'x', run_in_background: true } },
    ];

    const first = await runBatch(handler, { toolCalls, agentId: 'a', configurable, metadata });
    await flushMicrotasks();
    const second = await runBatch(handler, { toolCalls, agentId: 'a', configurable, metadata });
    await flushMicrotasks();

    const firstId = JSON.parse(first[0].content).background_task_id;
    const secondId = JSON.parse(second[0].content).background_task_id;
    expect(secondId).toBe(firstId);
    expect(state.calls).toBe(1);
  });

  it('uses host step identity when repeated provider ids have no turn number', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeSearchTool(state)] }),
    });

    const results = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_repeated',
          name: 'search_mcp_docs',
          args: { q: 'first', run_in_background: true },
          stepId: 'step-first',
        },
        {
          id: 'call_repeated',
          name: 'search_mcp_docs',
          args: { q: 'second', run_in_background: true },
          stepId: 'step-second',
        },
      ],
      agentId: 'a',
      configurable: buildConfig(),
      metadata: { thread_id: 'exec_convo_repeated_steps', run_id: 'response-repeated' },
    });
    await flushMicrotasks();

    expect(state.calls).toBe(2);
    expect(JSON.parse(results[0].content).background_task_id).not.toBe(
      JSON.parse(results[1].content).background_task_id,
    );
  });

  it('runs the tool synchronously when background is not requested', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const searchTool = makeSearchTool(state);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [searchTool] }),
    });
    const configurable = buildConfig();
    const metadata = { thread_id: 'exec_convo_sync' };

    const results = await runBatch(handler, {
      toolCalls: [{ id: 'call_sync', name: 'search_mcp_docs', args: { q: 'now' } }],
      agentId: 'a',
      configurable,
      metadata,
    });

    expect(state.calls).toBe(1);
    expect(results[0].content).toContain('RESULT for now');
  });

  it('enforces the per-tool opt-in: a tool not in backgroundToolNames runs foreground even with the flag', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const searchTool = makeSearchTool(state);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [searchTool] }),
    });
    // background enabled for the run, but for a DIFFERENT tool
    const configurable = buildConfig(['some_other_tool']);
    const metadata = { thread_id: 'exec_convo_gate' };

    const results = await runBatch(handler, {
      toolCalls: [
        { id: 'call_gate', name: 'search_mcp_docs', args: { q: 'x', run_in_background: true } },
      ],
      agentId: 'a',
      configurable,
      metadata,
    });

    // ran in the foreground; result is the tool output, not a background handle
    expect(state.calls).toBe(1);
    expect(results[0].content).toContain('RESULT for x');
  });

  it('never backgrounds an ephemeral request-scoped MCP tool: runs it foreground (no detached, leak-free)', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const ephemeralTool = {
      name: 'search_mcp_docs',
      description: 'search docs',
      schema: z.object({ q: z.string() }),
      // Tagged in createToolInstance for servers on a runtime-body-placeholder
      // connection, which is torn down at request end.
      mcpRequiresEphemeralConnection: true,
      invoke: async (input: Record<string, unknown>) => {
        state.calls += 1;
        state.lastInput = input;
        return { content: `RESULT for ${String(input.q)}` };
      },
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [ephemeralTool] }),
    });
    // background IS enabled for this tool, and the model asked to background it
    const configurable = buildConfig();
    const metadata = { thread_id: 'exec_convo_ephemeral' };

    const results = await runBatch(handler, {
      toolCalls: [
        { id: 'call_eph', name: 'search_mcp_docs', args: { q: 'z', run_in_background: true } },
      ],
      agentId: 'a',
      configurable,
      metadata,
    });

    // ran synchronously in the foreground: real output inline, not a handle, flag stripped
    expect(state.calls).toBe(1);
    expect(state.lastInput).toEqual({ q: 'z' });
    expect(results[0].content).toContain('RESULT for z');
    expect(results[0].content).not.toContain('background_task_id');
  });

  it('does not intercept a check_background_task-named tool when background is off for the run', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const collisionTool = {
      name: CHECK_BACKGROUND_TASK_NAME,
      description: 'a user MCP tool that happens to share the name',
      schema: z.object({ q: z.string() }),
      invoke: async (input: Record<string, unknown>) => {
        state.calls += 1;
        return { content: `REAL for ${String(input.q)}` };
      },
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [collisionTool] }),
    });
    const configurable = buildConfig([]); // background not active for this run
    const metadata = { thread_id: 'exec_convo_collision' };

    const results = await runBatch(handler, {
      toolCalls: [{ id: 'call_collision', name: CHECK_BACKGROUND_TASK_NAME, args: { q: 'y' } }],
      agentId: 'a',
      configurable,
      metadata,
    });

    // the real tool ran; the host poll-tool shortcut did not swallow it
    expect(state.calls).toBe(1);
    expect(results[0].content).toContain('REAL for y');
  });

  it('strips run_in_background:false on a foreground call of a background-capable tool', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const searchTool = makeSearchTool(state);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [searchTool] }),
    });
    const configurable = buildConfig(['search_mcp_docs']);
    const metadata = { thread_id: 'exec_convo_falseflag' };

    const results = await runBatch(handler, {
      toolCalls: [
        { id: 'call_false', name: 'search_mcp_docs', args: { q: 'z', run_in_background: false } },
      ],
      agentId: 'a',
      configurable,
      metadata,
    });

    // ran in the foreground, and the injected flag never reached the real tool
    expect(state.calls).toBe(1);
    expect(state.lastInput).toEqual({ q: 'z' });
    expect(results[0].content).toContain('RESULT for z');
  });

  it('delivers a backgrounded tool artifact on poll (live turn), not on the finalized dispatch turn', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const artifactTool = {
      name: 'search_mcp_docs',
      description: 'returns an artifact',
      schema: z.object({ q: z.string() }),
      invoke: async (input: Record<string, unknown>) => {
        state.calls += 1;
        return { content: `RESULT for ${String(input.q)}`, artifact: { files: ['a.png'] } };
      },
    } as unknown as StructuredToolInterface;
    const toolEndCalls: Array<{ name?: string; artifact?: unknown }> = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [artifactTool] }),
      toolEndCallback: (async (data: { output?: { name?: string; artifact?: unknown } }) => {
        toolEndCalls.push({ name: data.output?.name, artifact: data.output?.artifact });
      }) as unknown as Parameters<typeof createToolExecuteHandler>[0]['toolEndCallback'],
    });
    const configurable = buildConfig(['search_mcp_docs']);
    const metadata = { thread_id: 'exec_convo_artifact', run_id: 'run-artifact' };

    const dispatch = await runBatch(handler, {
      toolCalls: [
        { id: 'call_art', name: 'search_mcp_docs', args: { q: 'img', run_in_background: true } },
      ],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    // the tool ran, but its artifact is NOT pushed through the finalized dispatch turn
    expect(state.calls).toBe(1);
    expect(toolEndCalls).toHaveLength(0);

    const handleId = JSON.parse(dispatch[0].content).background_task_id;
    const poll = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: handleId },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_artifact', run_id: 'run-poll' },
    });

    // the poll turn delivers the artifact once, attributed to the original tool
    expect(JSON.parse(poll[0].content).status).toBe('completed');
    expect(toolEndCalls).toHaveLength(1);
    expect(toolEndCalls[0]).toEqual({ name: 'search_mcp_docs', artifact: { files: ['a.png'] } });

    // polling again does not re-deliver (idempotent)
    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll2',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: handleId },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_artifact', run_id: 'run-poll2' },
    });
    expect(toolEndCalls).toHaveLength(1);
  });

  it('scopes tasks by configurable user_id when req is absent (external service hosts)', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeSearchTool(state)] }),
    });
    const configurable = {
      user_id: 'exec_user_external',
      backgroundToolNames: ['search_mcp_docs'],
    };
    const metadata = { thread_id: 'exec_convo_external', run_id: 'run-external' };

    const dispatch = await runBatch(handler, {
      toolCalls: [
        { id: 'call_ext', name: 'search_mcp_docs', args: { q: 'ping', run_in_background: true } },
      ],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const handleId = JSON.parse(dispatch[0].content).background_task_id;
    const poll = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_ext_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: handleId },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_external', run_id: 'run-external-poll' },
    });
    const polled = JSON.parse(poll[0].content);
    expect(polled.status).toBe('completed');
    expect(polled.result).toContain('RESULT for ping');

    // a different user id cannot see the task (isolation is not conversation-only)
    const foreign = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_foreign_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: handleId },
        },
      ],
      agentId: 'a',
      configurable: { user_id: 'someone_else', backgroundToolNames: ['search_mcp_docs'] },
      metadata: { thread_id: 'exec_convo_external', run_id: 'run-foreign' },
    });
    expect(JSON.parse(foreign[0].content).status).toBe('not_found');
  });

  it('errors immediately (like foreground) when a background-requested tool failed to load', async () => {
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [] }),
    });
    const results = (await runBatch(handler, {
      toolCalls: [
        { id: 'call_missing', name: 'search_mcp_docs', args: { q: 'x', run_in_background: true } },
      ],
      agentId: 'a',
      configurable: buildConfig(['search_mcp_docs']),
      metadata: { thread_id: 'exec_convo_missing', run_id: 'run-missing' },
    })) as Array<{ content: string; status?: string; errorMessage?: string }>;

    expect(results[0].status).toBe('error');
    expect(results[0].errorMessage).toBe('Tool search_mcp_docs not found');
    expect(results[0].content).not.toContain('background_task_id');
  });

  it('strips a run_in_background arg imitated onto a tool this agent never opted in', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeSearchTool(state)] }),
    });
    // background is enabled for the run via another tool; search_mcp_docs is NOT opted in
    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_foreign',
          name: 'search_mcp_docs',
          args: { q: 'hello', run_in_background: true },
        },
      ],
      agentId: 'a',
      configurable: buildConfig(['other_tool']),
      metadata: { thread_id: 'exec_convo_foreign', run_id: 'run-foreign' },
    });

    expect(state.calls).toBe(1);
    expect(state.lastInput).toEqual({ q: 'hello' });
  });

  it('forwards run_in_background untouched to a tool whose own schema declares it', async () => {
    const state = { calls: 0 } as { calls: number; lastInput?: Record<string, unknown> };
    const owningTool = {
      name: 'owns_the_param',
      description: 'declares run_in_background itself',
      schema: z.object({ q: z.string(), run_in_background: z.boolean().optional() }),
      invoke: async (input: Record<string, unknown>) => {
        state.calls += 1;
        state.lastInput = input;
        return { content: 'OWNED' };
      },
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [owningTool] }),
    });
    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_owned',
          name: 'owns_the_param',
          args: { q: 'hello', run_in_background: true },
        },
      ],
      agentId: 'a',
      configurable: buildConfig(['other_tool']),
      metadata: { thread_id: 'exec_convo_owned', run_id: 'run-owned' },
    });

    expect(state.calls).toBe(1);
    expect(state.lastInput).toEqual({ q: 'hello', run_in_background: true });
  });

  it('retries artifact delivery on the next poll when the callback fails (artifact not lost)', async () => {
    const artifactTool = {
      name: 'search_mcp_docs',
      description: 'returns an artifact',
      schema: z.object({ q: z.string() }),
      invoke: async () => ({ content: 'RESULT', artifact: { files: ['a.png'] } }),
    } as unknown as StructuredToolInterface;
    const toolEndCalls: Array<{ name?: string; artifact?: unknown }> = [];
    let failNextDelivery = true;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [artifactTool] }),
      toolEndCallback: (async (data: { output?: { name?: string; artifact?: unknown } }) => {
        if (failNextDelivery) {
          failNextDelivery = false;
          throw new Error('transient storage failure');
        }
        toolEndCalls.push({ name: data.output?.name, artifact: data.output?.artifact });
      }) as unknown as Parameters<typeof createToolExecuteHandler>[0]['toolEndCallback'],
    });
    const configurable = buildConfig(['search_mcp_docs']);

    const dispatch = await runBatch(handler, {
      toolCalls: [
        { id: 'call_art', name: 'search_mcp_docs', args: { q: 'img', run_in_background: true } },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_art_retry', run_id: 'run-artifact' },
    });
    await flushMicrotasks();
    await flushMicrotasks();
    const handleId = JSON.parse(dispatch[0].content).background_task_id;

    // first poll: delivery fails, but the poll itself still succeeds
    const poll1 = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: handleId },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_art_retry', run_id: 'run-poll' },
    });
    expect(JSON.parse(poll1[0].content).status).toBe('completed');
    expect(toolEndCalls).toHaveLength(0);

    // second poll: the restored artifact is re-claimed and delivered
    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll2',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: handleId },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_art_retry', run_id: 'run-poll2' },
    });
    expect(toolEndCalls).toHaveLength(1);
    expect(toolEndCalls[0]).toEqual({ name: 'search_mcp_docs', artifact: { files: ['a.png'] } });
  });
});

describe('createToolExecuteHandler — backgrounded code execution', () => {
  interface CodeToolState {
    calls: number;
    throwError?: boolean;
    errorMessage?: string;
    lastInput?: Record<string, unknown>;
    lastConfig?: { toolCall?: Record<string, unknown> };
  }

  const CODE_ARTIFACT = {
    session_id: 'exec-sess',
    files: [{ id: 'f1', name: 'plot.png', storage_session_id: 'store-1' }],
  };

  const makeCodeTool = (state: CodeToolState) =>
    ({
      name: 'execute_code',
      description: 'run code',
      schema: z.object({ lang: z.string(), code: z.string() }),
      invoke: async (
        input: Record<string, unknown>,
        config: { toolCall?: Record<string, unknown> },
      ) => {
        state.calls += 1;
        state.lastInput = input;
        state.lastConfig = config;
        if (state.throwError) {
          throw new Error(state.errorMessage ?? 'Execution error:\n\nboom');
        }
        return { content: 'stdout:\nhello', artifact: CODE_ARTIFACT };
      },
    }) as unknown as StructuredToolInterface;

  const codeCall = (overrides: Record<string, unknown> = {}) => ({
    id: 'call_code',
    name: 'execute_code',
    args: { lang: 'py', code: 'print(1)', run_in_background: true },
    stepId: 'step_1',
    turn: 2,
    codeSessionContext: {
      session_id: 'sess-prev',
      files: [{ id: 'in1', name: 'data.csv', storage_session_id: 'store-0', resource_id: 'r1' }],
    },
    runtimeSessionHint: 'convo-hint',
    ...overrides,
  });

  it('keeps step-less code harvests available to the legacy poll path', async () => {
    const state: CodeToolState = { calls: 0 };
    const preregister = jest.fn(async () => ({
      renew: jest.fn(async () => true),
      retire: jest.fn(async () => true),
    }));
    const persistBackgroundCodeResult = jest.fn(async () => ({ attachments: [] }));
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      persistBackgroundCodeResult,
      backgroundToolCompletion: {
        preregister,
        persist: jest.fn(async () => true),
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = { thread_id: 'exec_convo_step_less_code', run_id: 'response-step-less' };

    const [dispatch] = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_step_less_code', stepId: undefined, turn: undefined })],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(preregister).not.toHaveBeenCalled();
    expect(persistBackgroundCodeResult).toHaveBeenCalledWith(
      expect.not.objectContaining({ backgroundTask: expect.anything() }),
    );

    const taskId = JSON.parse(dispatch.content).background_task_id;
    const [poll] = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'poll_step_less_code',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: taskId },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: metadata.thread_id, run_id: 'poll-step-less' },
    })) as Array<{ content: string; artifact?: unknown }>;
    await flushMicrotasks();

    expect(JSON.parse(poll.content)).toMatchObject({ status: 'completed' });
    expect(poll.artifact).toEqual(CODE_ARTIFACT);
    expect(persistBackgroundCodeResult).toHaveBeenCalledTimes(2);
    expect(persistBackgroundCodeResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reapply: true,
        toolCallId: 'call_step_less_code',
        stepId: undefined,
      }),
    );
  });

  it('carries full code-session config into the detached invoke, harvests onto the dispatch turn, and re-emits on poll', async () => {
    const state: CodeToolState = { calls: 0 };
    const persistCalls: Array<Record<string, unknown>> = [];
    const emitted: unknown[] = [];
    const toolEndCalls: unknown[] = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      toolEndCallback: (async (data: { output?: unknown }) => {
        toolEndCalls.push(data.output);
      }) as unknown as Parameters<typeof createToolExecuteHandler>[0]['toolEndCallback'],
      persistBackgroundCodeResult: async (params) => {
        persistCalls.push(params as unknown as Record<string, unknown>);
        return { attachments: [{ file_id: 'f1', toolCallId: params.toolCallId }] };
      },
      emitAttachment: (attachment) => {
        emitted.push(attachment);
      },
    });
    const codeExecutionContext = {
      baseUrl: 'https://code-stateful.example.com',
      codeSessionKey: 'execute_code:stateful:convo-hint',
      executionProfile: 'stateful' as const,
      runtimeSessionHint: 'convo-hint',
      statefulSessions: true,
    };
    const configurable = { ...buildConfig(['execute_code']), codeExecutionContext };
    const metadata = { thread_id: 'exec_convo_code', run_id: 'msg-dispatch' };

    const dispatch = await runBatch(handler, {
      toolCalls: [codeCall()],
      agentId: 'a',
      configurable,
      metadata,
    });
    const handle = JSON.parse(dispatch[0].content);
    expect(handle.status).toBe('running');

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // detached invoke received the same session/file config a foreground call gets
    expect(state.calls).toBe(1);
    expect(state.lastInput).toEqual({ lang: 'py', code: 'print(1)' });
    const toolCall = state.lastConfig?.toolCall ?? {};
    expect(toolCall.session_id).toBe('sess-prev');
    expect(toolCall._injected_files).toEqual([
      { id: 'in1', name: 'data.csv', storage_session_id: 'store-0', resource_id: 'r1' },
    ]);
    expect(toolCall._runtime_session_hint).toBe('convo-hint');
    expect(toolCall.id).toBe('call_code');
    expect(toolCall.stepId).toBe('step_1');

    // completion-time harvest anchored to the ORIGINAL dispatch identity
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]).toEqual(
      expect.objectContaining({
        toolName: 'execute_code',
        toolCallId: 'call_code',
        messageId: 'msg-dispatch',
        conversationId: 'exec_convo_code',
        dispatchedAt: expect.any(Number),
        output: 'stdout:\nhello',
        artifact: CODE_ARTIFACT,
        codeExecutionContext,
      }),
    );
    // nothing rode the finalized dispatch turn's callback
    expect(toolEndCalls).toHaveLength(0);

    const poll = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: handle.background_task_id },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_code', run_id: 'msg-poll' },
    })) as Array<{ content: string; artifact?: unknown }>;
    await flushMicrotasks();

    const polled = JSON.parse(poll[0].content);
    expect(polled.status).toBe('completed');
    expect(polled.result).toContain('hello');
    expect(polled.note).toContain('attached to the tool call');
    // harvested attachments re-emitted on the live poll stream (not
    // re-processed), followed by the live completion marker
    expect(emitted).toEqual([
      { file_id: 'f1', toolCallId: 'call_code' },
      expect.objectContaining({
        type: 'background_task_status',
        /** Agent-suffixed: sibling agents' `call_0` markers must not upsert
         *  over each other client-side. */
        file_id: 'bg-call_code-a-step_1',
        messageId: 'msg-dispatch',
        toolCallId: 'call_code',
        stepId: 'step_1',
        status: 'completed',
      }),
    ]);
    expect(toolEndCalls).toHaveLength(0);
    // the claimed artifact rides the poll result so the SDK folds the exec session
    expect(poll[0].artifact).toEqual(CODE_ARTIFACT);
    // the poll also re-anchors the row patch (idempotent heal after full-row saves)
    expect(persistCalls).toHaveLength(2);
    expect(persistCalls[1]).toEqual(
      expect.objectContaining({
        reapply: true,
        toolCallId: 'call_code',
        messageId: 'msg-dispatch',
        output: 'stdout:\nhello',
        attachments: [{ file_id: 'f1', toolCallId: 'call_code' }],
      }),
    );
  });

  it('blocks a pre-policy code artifact before poll claim, emission, or re-persistence', async () => {
    const protectedValue = 'PROTECTED-CODE-ARTIFACT';
    const artifact = {
      session_id: 'exec-protected',
      files: [{ id: 'f-protected', name: protectedValue }],
    };
    const codeTool = {
      name: 'execute_code',
      description: 'run code',
      schema: z.object({ lang: z.string(), code: z.string() }),
      invoke: async () => ({ content: 'safe stdout', artifact }),
    } as unknown as StructuredToolInterface;
    const persistCalls: Array<Record<string, unknown>> = [];
    const emitted: unknown[] = [];
    const toolEndCallback = jest.fn();
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [codeTool] }),
      toolEndCallback,
      persistBackgroundCodeResult: async (params) => {
        persistCalls.push(params as unknown as Record<string, unknown>);
        return { attachments: [{ file_id: 'f-protected', name: 'safe attachment' }] };
      },
      emitAttachment: (attachment) => {
        emitted.push(attachment);
      },
    });
    const metadata = { thread_id: 'exec_convo_tightened_code', run_id: 'msg-dispatch' };
    const dispatchConfig = buildConfig(['execute_code']);
    const [dispatch] = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_pre_policy_code' })],
      agentId: 'a',
      configurable: dispatchConfig,
      metadata,
    });
    const taskId = JSON.parse(dispatch.content).background_task_id;

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(persistCalls).toHaveLength(1);
    persistCalls.length = 0;

    const tightenedConfig = buildConfig(['execute_code'], {
      toolArguments: {
        pii: {
          fields: ['output'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'protected-output',
              label: 'protected output',
              regex: 'PROTECTED-[A-Z-]+',
            },
          ],
        },
      },
    });
    const [blockedPoll] = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_tightened_code_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: taskId },
        },
      ],
      agentId: 'a',
      configurable: tightenedConfig,
      metadata: { thread_id: 'exec_convo_tightened_code', run_id: 'msg-poll' },
    })) as Array<{
      content: string;
      status?: string;
      errorMessage?: string;
      artifact?: unknown;
    }>;
    await flushMicrotasks();

    expect(blockedPoll.status).toBe('error');
    expect(blockedPoll.content).toBe('');
    expect(blockedPoll.errorMessage).toContain('content_filter_block');
    expect(blockedPoll.errorMessage).not.toContain(protectedValue);
    expect(blockedPoll.artifact).toBeUndefined();
    expect(toolEndCallback).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(persistCalls).toEqual([]);

    const [allowedPoll] = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_allowed_code_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: taskId },
        },
      ],
      agentId: 'a',
      configurable: dispatchConfig,
      metadata: { thread_id: 'exec_convo_tightened_code', run_id: 'msg-poll-allowed' },
    })) as Array<{ content: string; artifact?: unknown }>;
    expect(JSON.parse(allowedPoll.content).result).toBe('safe stdout');
    expect(allowedPoll.artifact).toEqual(artifact);
  });

  it('does not gate task completion on the harvest (same-turn polls see completed)', async () => {
    const state: CodeToolState = { calls: 0 };
    const toolEndCalls: unknown[] = [];
    const emitted: unknown[] = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      toolEndCallback: (async (data: { output?: unknown }) => {
        toolEndCalls.push(data.output);
      }) as unknown as Parameters<typeof createToolExecuteHandler>[0]['toolEndCallback'],
      /** The dispatch turn's row does not exist until that turn finalizes, so
       *  the real persister can block for a long time — completion must not. */
      persistBackgroundCodeResult: () => new Promise(() => undefined),
      emitAttachment: (attachment) => {
        emitted.push(attachment);
      },
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = { thread_id: 'exec_convo_code_slow', run_id: 'msg-slow' };

    const dispatch = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_slow' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const poll = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll_slow',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: JSON.parse(dispatch[0].content).background_task_id },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_code_slow', run_id: 'msg-slow-poll' },
    })) as Array<{ content: string; artifact?: unknown }>;

    const polled = JSON.parse(poll[0].content);
    expect(polled.status).toBe('completed');
    expect(polled.result).toContain('hello');
    expect(polled.note).toContain('being attached');
    // Harvest has not landed: no artifact, attachments, status marker, or
    // poll-identity fallback may cross the live boundary before file inspection.
    expect(emitted).toEqual([]);
    expect(toolEndCalls).toHaveLength(0);
    expect(poll[0].artifact).toBeUndefined();
  });

  it('releases stored files to same-turn polls while the row patch waits for the dispatch turn', async () => {
    const state: CodeToolState = { calls: 0 };
    const emitted: unknown[] = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      /** Files are stored; the row patch then waits for the long dispatch turn. */
      persistBackgroundCodeResult: (params) => {
        params.onFilesPersisted?.([{ file_id: 'f1', toolCallId: params.toolCallId }]);
        return new Promise(() => undefined);
      },
      emitAttachment: (attachment) => {
        emitted.push(attachment);
      },
    });
    const configurable = buildConfig(['execute_code']);

    const dispatch = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_long_turn' })],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_code_long_turn', run_id: 'msg-long-turn' },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const poll = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll_long_turn',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: JSON.parse(dispatch[0].content).background_task_id },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_code_long_turn', run_id: 'msg-long-turn' },
    })) as Array<{ content: string; artifact?: unknown }>;

    const polled = JSON.parse(poll[0].content);
    expect(polled.status).toBe('completed');
    expect(polled.note).toContain('attached to the tool call');
    expect(emitted[0]).toEqual({ file_id: 'f1', toolCallId: 'call_code_long_turn' });
    expect(poll[0].artifact).toEqual(CODE_ARTIFACT);
    /** Still protected from retention eviction while the row patch waits. */
    expect(
      backgroundTaskRegistry.get(
        'exec_user',
        'exec_convo_code_long_turn',
        JSON.parse(dispatch[0].content).background_task_id,
      )?.completionPersistencePending,
    ).toBe(true);
  });

  it('falls back to poll-turn delivery when the harvest fails (files not lost)', async () => {
    const state: CodeToolState = { calls: 0 };
    const toolEndCalls: Array<{ name?: string; artifact?: unknown }> = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      toolEndCallback: (async (data: { output?: { name?: string; artifact?: unknown } }) => {
        toolEndCalls.push({ name: data.output?.name, artifact: data.output?.artifact });
      }) as unknown as Parameters<typeof createToolExecuteHandler>[0]['toolEndCallback'],
      persistBackgroundCodeResult: async () => {
        throw new Error('mongo down');
      },
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = { thread_id: 'exec_convo_code_hfail', run_id: 'msg-hfail' };

    const dispatch = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_hfail' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const poll = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll_hfail',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: JSON.parse(dispatch[0].content).background_task_id },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_code_hfail', run_id: 'msg-hfail-poll' },
    })) as Array<{ content: string; artifact?: unknown }>;

    /** Harvest revoked: the poll turn's callback processes the files instead. */
    expect(toolEndCalls).toHaveLength(1);
    expect(toolEndCalls[0].artifact).toEqual(CODE_ARTIFACT);
    expect(poll[0].artifact).toEqual(CODE_ARTIFACT);
  });

  it('does not publish an output-only receipt when generated files miss their message anchor', async () => {
    const state: CodeToolState = { calls: 0 };
    const retire = jest.fn(async () => true);
    const persistResult = jest.fn(async () => true);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      persistBackgroundCodeResult: async () => ({
        deliveryReady: false,
        attachments: [{ filename: 'plot.png' }],
      }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({
          renew: jest.fn(async () => true),
          persistResult,
          retire,
        })),
        persist: jest.fn(async () => true),
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_missing_anchor' })],
      agentId: 'a',
      configurable: buildConfig(['execute_code']),
      metadata: { thread_id: 'exec_convo_code_missing_anchor', run_id: 'msg-missing-anchor' },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(persistResult).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledWith('background code result was not persisted', undefined);
  });

  it('uses the configured durable completion result size', async () => {
    const persistResult: jest.MockedFunction<
      NonNullable<BackgroundToolWakeupAdmission['persistResult']>
    > = jest.fn(
      async (_result: Parameters<NonNullable<BackgroundToolWakeupAdmission['persistResult']>>[0]) =>
        true,
    );
    const tool = {
      name: 'execute_code',
      description: 'run code',
      schema: z.object({ lang: z.string(), code: z.string() }),
      invoke: jest.fn(async () => ({ content: '0123456789'.repeat(10), artifact: CODE_ARTIFACT })),
    } as unknown as StructuredToolInterface;
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [tool] }),
      backgroundCompletionResultMaxChars: 32,
      persistBackgroundCodeResult: async () => ({ deliveryReady: true, attachments: [] }),
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({
          renew: jest.fn(async () => true),
          persistResult,
          retire: jest.fn(async () => true),
        })),
        persist: jest.fn(async () => true),
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });

    await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call-sized-receipt' })],
      agentId: 'agent_parent_1',
      configurable: buildConfig([tool.name]),
      metadata: { thread_id: 'exec_convo', run_id: 'response-sized-receipt' },
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(persistResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', output: expect.any(String) }),
    );
    expect(persistResult.mock.calls[0][0].output).toHaveLength(32);
  });

  it('makes a completion-time generated-file policy rejection terminal across polls', async () => {
    const protectedValue = 'PROTECTED-GENERATED-FILE-BYTES';
    const blockedArtifact = {
      session_id: 'exec-blocked',
      files: [{ id: 'f-blocked', name: 'output.txt', opaqueBytes: protectedValue }],
    };
    const codeTool = {
      name: 'execute_code',
      description: 'run code',
      schema: z.object({ lang: z.string(), code: z.string() }),
      invoke: async () => ({ content: 'safe stdout', artifact: blockedArtifact }),
    } as unknown as StructuredToolInterface;
    const persistBackgroundCodeResult = jest.fn(async () => {
      throw new ContentFilterError({
        detectorId: 'custom',
        ruleId: 'blocked-generated-file',
        label: 'protected generated-file content',
        source: 'file',
        field: 'content',
        provenance: 'tool',
        fragmentId: 'generated-file',
        fragmentPath: '/content',
      });
    });
    const toolEndCallback = jest.fn();
    const retire = jest.fn(async () => true);
    const persistResult = jest.fn(async () => true);
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [codeTool] }),
      toolEndCallback,
      persistBackgroundCodeResult,
      backgroundToolCompletion: {
        preregister: jest.fn(async () => ({
          renew: jest.fn(async () => true),
          retire,
          persistResult,
        })),
        persist: jest.fn(async () => true),
        claim: jest.fn(async () => ({ status: 'acquired' as const, results: [] })),
      },
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = {
      thread_id: 'exec_convo_code_policy_reject',
      run_id: 'msg-policy-reject',
    };

    const dispatch = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_policy_reject' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    const taskId = JSON.parse(dispatch[0].content).background_task_id;
    await flushMicrotasks();
    await flushMicrotasks();
    expect(persistResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', output: MODEL_BOUND_FILE_CONTENT_BLOCK }),
    );
    expect(retire).not.toHaveBeenCalled();
    await flushMicrotasks();

    for (const pollId of ['call_policy_poll_1', 'call_policy_poll_2']) {
      const [poll] = (await runBatch(handler, {
        toolCalls: [
          {
            id: pollId,
            name: CHECK_BACKGROUND_TASK_NAME,
            args: { background_task_id: taskId },
          },
        ],
        agentId: 'a',
        configurable,
        metadata: {
          thread_id: 'exec_convo_code_policy_reject',
          run_id: `msg-${pollId}`,
        },
      })) as Array<{ content: string; artifact?: unknown }>;
      const polled = JSON.parse(poll.content);

      expect(polled).toEqual(
        expect.objectContaining({
          status: 'error',
          error: MODEL_BOUND_FILE_CONTENT_BLOCK,
        }),
      );
      expect(polled.result).toBeUndefined();
      expect(poll.artifact).toBeUndefined();
      expect(JSON.stringify(poll)).not.toContain(protectedValue);
    }

    expect(persistBackgroundCodeResult).toHaveBeenCalledTimes(1);
    expect(toolEndCallback).not.toHaveBeenCalled();
  });

  it('withholds code-session artifacts while completion-time file inspection is pending', async () => {
    const protectedValue = 'PROTECTED-PENDING-HARVEST-BYTES';
    const blockedArtifact = {
      session_id: 'exec-pending-blocked',
      files: [{ id: 'f-pending-blocked', name: 'output.txt', opaqueBytes: protectedValue }],
    };
    const codeTool = {
      name: 'execute_code',
      description: 'run code',
      schema: z.object({ lang: z.string(), code: z.string() }),
      invoke: async () => ({ content: 'safe stdout', artifact: blockedArtifact }),
    } as unknown as StructuredToolInterface;
    let rejectInspection: (error: Error) => void = () => undefined;
    const persistBackgroundCodeResult = jest.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectInspection = reject;
        }),
    );
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [codeTool] }),
      persistBackgroundCodeResult,
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = {
      thread_id: 'exec_convo_code_pending_policy',
      run_id: 'msg-pending-policy',
    };

    const dispatch = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_pending_policy' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    const taskId = JSON.parse(dispatch[0].content).background_task_id;
    await flushMicrotasks();

    const [pendingPoll] = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_pending_policy_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: taskId },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: {
        thread_id: 'exec_convo_code_pending_policy',
        run_id: 'msg-pending-policy-poll',
      },
    })) as Array<{ content: string; artifact?: unknown }>;

    expect(JSON.parse(pendingPoll.content).status).toBe('completed');
    expect(pendingPoll.artifact).toBeUndefined();
    expect(JSON.stringify(pendingPoll)).not.toContain(protectedValue);

    rejectInspection(
      new ContentFilterError({
        detectorId: 'custom',
        ruleId: 'blocked-pending-file',
        label: 'protected generated-file content',
        source: 'file',
        field: 'content',
        provenance: 'tool',
        fragmentId: 'pending-generated-file',
        fragmentPath: '/content',
      }),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    const [blockedPoll] = (await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_blocked_after_pending_poll',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: taskId },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: {
        thread_id: 'exec_convo_code_pending_policy',
        run_id: 'msg-blocked-after-pending',
      },
    })) as Array<{ content: string; artifact?: unknown }>;

    expect(JSON.parse(blockedPoll.content)).toEqual(
      expect.objectContaining({
        status: 'error',
        error: MODEL_BOUND_FILE_CONTENT_BLOCK,
      }),
    );
    expect(blockedPoll.artifact).toBeUndefined();
    expect(JSON.stringify(blockedPoll)).not.toContain(protectedValue);
  });

  it('makes a poll-time generated-file policy rejection terminal without delivering bytes', async () => {
    const protectedValue = 'PROTECTED-POLL-FALLBACK-BYTES';
    const blockedArtifact = {
      session_id: 'exec-poll-blocked',
      files: [{ id: 'f-poll-blocked', name: 'output.txt', opaqueBytes: protectedValue }],
    };
    const codeTool = {
      name: 'execute_code',
      description: 'run code',
      schema: z.object({ lang: z.string(), code: z.string() }),
      invoke: async () => ({ content: 'safe stdout', artifact: blockedArtifact }),
    } as unknown as StructuredToolInterface;
    const persistBackgroundCodeResult = jest.fn(async () => {
      throw new Error('temporary harvest storage failure');
    });
    const toolEndCallback = jest.fn(async () => {
      throw new ContentFilterError({
        detectorId: 'custom',
        ruleId: 'blocked-poll-file',
        label: 'protected generated-file content',
        source: 'file',
        field: 'content',
        provenance: 'tool',
        fragmentId: 'poll-generated-file',
        fragmentPath: '/content',
      });
    });
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [codeTool] }),
      toolEndCallback: toolEndCallback as unknown as Parameters<
        typeof createToolExecuteHandler
      >[0]['toolEndCallback'],
      persistBackgroundCodeResult,
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = {
      thread_id: 'exec_convo_code_poll_policy_reject',
      run_id: 'msg-poll-policy-reject',
    };

    const dispatch = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_poll_policy_reject' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    const taskId = JSON.parse(dispatch[0].content).background_task_id;
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    for (const pollId of ['call_poll_policy_reject_1', 'call_poll_policy_reject_2']) {
      const [poll] = (await runBatch(handler, {
        toolCalls: [
          {
            id: pollId,
            name: CHECK_BACKGROUND_TASK_NAME,
            args: { background_task_id: taskId },
          },
        ],
        agentId: 'a',
        configurable,
        metadata: {
          thread_id: 'exec_convo_code_poll_policy_reject',
          run_id: `msg-${pollId}`,
        },
      })) as Array<{ content: string; artifact?: unknown }>;
      const polled = JSON.parse(poll.content);

      expect(polled).toEqual(
        expect.objectContaining({
          status: 'error',
          error: MODEL_BOUND_FILE_CONTENT_BLOCK,
        }),
      );
      expect(polled.result).toBeUndefined();
      expect(poll.artifact).toBeUndefined();
      expect(JSON.stringify(poll)).not.toContain(protectedValue);
    }

    expect(persistBackgroundCodeResult).toHaveBeenCalledTimes(1);
    expect(toolEndCallback).toHaveBeenCalledTimes(1);
  });

  it('re-anchors failed code tasks on poll (error output heals like success)', async () => {
    const state: CodeToolState = { calls: 0, throwError: true };
    const persistCalls: Array<Record<string, unknown>> = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      persistBackgroundCodeResult: async (params) => {
        persistCalls.push(params as unknown as Record<string, unknown>);
        return { attachments: [] };
      },
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = { thread_id: 'exec_convo_code_errheal', run_id: 'msg-errheal' };

    const dispatch = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_errheal' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll_errheal',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: JSON.parse(dispatch[0].content).background_task_id },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_code_errheal', run_id: 'msg-errheal-poll' },
    });
    await flushMicrotasks();

    expect(persistCalls).toHaveLength(2);
    expect(persistCalls[1]).toEqual(
      expect.objectContaining({ reapply: true, toolCallId: 'call_code_errheal' }),
    );
    expect(String(persistCalls[1].output)).toContain('boom');
  });

  it('wraps filtered background code output before registry and harvest persistence', async () => {
    const protectedValue = 'Authorization: Bearer returned-background-token';
    const codeTool = {
      name: 'execute_code',
      description: 'run code',
      schema: z.object({ lang: z.string(), code: z.string() }),
      invoke: async () => ({ content: protectedValue }),
    } as unknown as StructuredToolInterface;
    const persistCalls: Array<Record<string, unknown>> = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [codeTool] }),
      persistBackgroundCodeResult: async (params) => {
        persistCalls.push(params as unknown as Record<string, unknown>);
        return { attachments: [] };
      },
    });
    const configurable = buildConfig(['execute_code'], {
      toolArguments: {
        pii: {
          fields: ['output'],
          starterPatterns: ['bearer_header'],
        },
      },
    });
    const metadata = {
      thread_id: 'exec_convo_filtered_background_result',
      run_id: 'msg-filtered-result',
    };

    const [dispatch] = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_filtered_background_result' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].output).toBe(CODE_TOOL_OUTPUT_BLOCK);
    expect(JSON.stringify(persistCalls)).not.toContain(protectedValue);
    expect(JSON.stringify(persistCalls)).not.toContain('Bearer token');

    const [poll] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll_filtered_background_result',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: JSON.parse(dispatch.content).background_task_id },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: {
        thread_id: 'exec_convo_filtered_background_result',
        run_id: 'msg-filtered-result-poll',
      },
    });
    const polled = JSON.parse(poll.content);
    expect(polled).toEqual(
      expect.objectContaining({
        status: 'error',
        error: CODE_TOOL_OUTPUT_BLOCK,
      }),
    );
    expect(JSON.stringify(polled)).not.toContain(protectedValue);
    expect(JSON.stringify(polled)).not.toContain('Bearer token');
  });

  it('filters thrown background errors before registry, harvest, and persistence', async () => {
    const protectedValue = 'Authorization: Bearer persisted-background-token';
    const state: CodeToolState = {
      calls: 0,
      throwError: true,
      errorMessage: protectedValue,
    };
    const persistCalls: Array<Record<string, unknown>> = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      persistBackgroundCodeResult: async (params) => {
        persistCalls.push(params as unknown as Record<string, unknown>);
        return { attachments: [] };
      },
    });
    const configurable = buildConfig(['execute_code'], {
      toolArguments: {
        pii: {
          fields: ['output'],
          starterPatterns: ['bearer_header'],
        },
      },
    });
    const metadata = {
      thread_id: 'exec_convo_filtered_background_error',
      run_id: 'msg-filtered-error',
    };

    const [dispatch] = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_filtered_background_error' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].output).toBe(CODE_TOOL_OUTPUT_BLOCK);
    expect(JSON.stringify(persistCalls)).not.toContain(protectedValue);
    expect(JSON.stringify(persistCalls)).not.toContain('Bearer token');

    const [poll] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll_filtered_background_error',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: JSON.parse(dispatch.content).background_task_id },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: {
        thread_id: 'exec_convo_filtered_background_error',
        run_id: 'msg-filtered-error-poll',
      },
    });
    const polled = JSON.parse(poll.content);
    expect(polled.status).toBe('error');
    expect(polled.error).toBe(CODE_TOOL_OUTPUT_BLOCK);
    expect(JSON.stringify(polled)).not.toContain(protectedValue);
    expect(JSON.stringify(polled)).not.toContain('Bearer token');
  });

  it('wraps a thrown background content-policy error without detector details', async () => {
    const detectorLabel = 'generated-file bearer token';
    const detectorRule = 'generated-file-bearer';
    const codeTool = {
      name: 'execute_code',
      description: 'run code',
      schema: z.object({ lang: z.string(), code: z.string() }),
      invoke: async () => {
        throw new ContentFilterError({
          detectorId: 'pii-pattern',
          ruleId: detectorRule,
          label: detectorLabel,
          source: 'file',
          field: 'content',
          provenance: 'tool',
          fragmentId: 'generated-file',
          fragmentPath: '/content',
        });
      },
    } as unknown as StructuredToolInterface;
    const persistCalls: Array<Record<string, unknown>> = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [codeTool] }),
      persistBackgroundCodeResult: async (params) => {
        persistCalls.push(params as unknown as Record<string, unknown>);
        return { attachments: [] };
      },
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = {
      thread_id: 'exec_convo_policy_background_error',
      run_id: 'msg-policy-error',
    };

    const [dispatch] = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_policy_background_error' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].output).toBe(CODE_FILE_CONTENT_BLOCK);
    expect(JSON.stringify(persistCalls)).not.toContain(detectorLabel);
    expect(JSON.stringify(persistCalls)).not.toContain(detectorRule);

    const [poll] = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll_policy_background_error',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: JSON.parse(dispatch.content).background_task_id },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: {
        thread_id: 'exec_convo_policy_background_error',
        run_id: 'msg-policy-error-poll',
      },
    });
    const polled = JSON.parse(poll.content);
    expect(polled).toEqual(
      expect.objectContaining({
        status: 'error',
        error: CODE_FILE_CONTENT_BLOCK,
      }),
    );
    expect(JSON.stringify(polled)).not.toContain(detectorLabel);
    expect(JSON.stringify(polled)).not.toContain(detectorRule);
  });

  it('re-anchors abort-confirmed timeout failures with the client-recognized wrapper', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const persistCalls: Array<Record<string, unknown>> = [];
      const hangingTool = {
        name: 'execute_code',
        description: 'never settles',
        schema: z.object({ lang: z.string(), code: z.string() }),
        invoke: (_input: unknown, config?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const signal = config?.signal;
            if (signal?.aborted === true) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      } as unknown as StructuredToolInterface;
      const handler = createToolExecuteHandler({
        loadTools: async () => ({ loadedTools: [hangingTool] }),
        persistBackgroundCodeResult: async (params) => {
          persistCalls.push(params as unknown as Record<string, unknown>);
          return { attachments: [] };
        },
      });
      const configurable = buildConfig(['execute_code']);

      const dispatch = await runBatch(handler, {
        toolCalls: [codeCall({ id: 'call_code_reap' })],
        agentId: 'a',
        configurable,
        metadata: { thread_id: 'exec_convo_reap', run_id: 'msg-reap' },
      });

      /** Past the deadline the tool acknowledges abort by rejecting. */
      jest.advanceTimersByTime(31 * 60 * 1000);
      await flushMicrotasks();
      await flushMicrotasks();

      const poll = await runBatch(handler, {
        toolCalls: [
          {
            id: 'call_poll_reap',
            name: CHECK_BACKGROUND_TASK_NAME,
            args: { background_task_id: JSON.parse(dispatch[0].content).background_task_id },
          },
        ],
        agentId: 'a',
        configurable,
        metadata: { thread_id: 'exec_convo_reap', run_id: 'msg-reap-poll' },
      });
      await flushMicrotasks();

      expect(JSON.parse(poll[0].content).status).toBe('error');
      const timeoutPersistence = persistCalls.find((call) =>
        String(call.output).includes('timed out'),
      );
      expect(timeoutPersistence).toBeDefined();
      expect(String(timeoutPersistence?.output)).toMatch(
        /^Error:\s*\[execute_code\]\s*tool call failed:/,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('patches the dispatch turn with the error message when a backgrounded code call fails', async () => {
    const state: CodeToolState = { calls: 0, throwError: true };
    const persistCalls: Array<Record<string, unknown>> = [];
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      persistBackgroundCodeResult: async (params) => {
        persistCalls.push(params as unknown as Record<string, unknown>);
        return { attachments: [] };
      },
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = { thread_id: 'exec_convo_code_err', run_id: 'msg-err' };

    const dispatch = await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_err' })],
      agentId: 'a',
      configurable,
      metadata,
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(persistCalls).toHaveLength(1);
    expect(String(persistCalls[0].output)).toContain('boom');
    /** Parity with foreground failures (the graph's error wrapper) so the
     *  client's `isError` detection flags the patched output on reload. */
    expect(String(persistCalls[0].output)).toMatch(
      /^Error:\s*\[execute_code\]\s*tool call failed:/,
    );
    expect(String(persistCalls[0].output).match(/tool call failed:/gi)).toHaveLength(1);
    expect(persistCalls[0].artifact).toBeUndefined();

    const poll = await runBatch(handler, {
      toolCalls: [
        {
          id: 'call_poll_err',
          name: CHECK_BACKGROUND_TASK_NAME,
          args: { background_task_id: JSON.parse(dispatch[0].content).background_task_id },
        },
      ],
      agentId: 'a',
      configurable,
      metadata: { thread_id: 'exec_convo_code_err', run_id: 'msg-err-poll' },
    });
    const polled = JSON.parse(poll[0].content);
    expect(polled.status).toBe('error');
    expect(polled.error).toContain('boom');
  });

  it('downgrades code calls to foreground when the host wires no persister (OpenAI-compat routes)', async () => {
    const state: CodeToolState = { calls: 0 };
    const handler = createToolExecuteHandler({
      loadTools: async () => ({ loadedTools: [makeCodeTool(state)] }),
      /** No persistBackgroundCodeResult: generated files could only anchor
       *  via a later poll (or never) — safer to run the call foreground. */
    });
    const configurable = buildConfig(['execute_code']);
    const metadata = { thread_id: 'exec_convo_code_fg', run_id: 'msg-fg' };

    const results = (await runBatch(handler, {
      toolCalls: [codeCall({ id: 'call_code_fg' })],
      agentId: 'a',
      configurable,
      metadata,
    })) as Array<{ content: string; artifact?: unknown }>;

    expect(state.calls).toBe(1);
    expect(results[0].content).not.toContain('background_task_id');
    expect(results[0].content).toContain('hello');
    expect(results[0].artifact).toEqual(CODE_ARTIFACT);
    /** The injected flag never reaches the real tool. */
    expect(state.lastInput).toEqual({ lang: 'py', code: 'print(1)' });
  });
});
