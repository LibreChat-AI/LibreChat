jest.mock('../prewarm', () => ({ markSandboxReady: jest.fn() }));

import { z } from 'zod';
import { ToolMessage } from '@librechat/agents/langchain';
import { tool } from '@librechat/agents/langchain/tools';
import type {
  SubagentExecutionContext,
  ToolExecuteBatchRequest,
  ToolExecuteResult,
} from '@librechat/agents';
import type { CodeExecutionContext } from '../execution';
import type { ToolExecuteOptions } from '../handlers';
import { createToolExecuteHandler } from '../handlers';

const identity: SubagentExecutionContext = {
  rootRunId: 'run',
  hookSessionId: 'run',
  depth: 1,
  ancestry: [
    {
      subagentRunId: 'child-execution',
      subagentType: 'worker',
      subagentKind: 'agent',
      subagentAgentId: 'worker',
      parentRunId: 'run',
      parentAgentId: 'parent',
      parentToolCallId: 'spawn-call',
    },
  ],
};

function setup(context?: Partial<CodeExecutionContext>, toolName = 'execute_code') {
  const signal = new AbortController().signal;
  const calls: string[] = [];
  const prepareTools = jest.fn(async () => {
    calls.push('prepare');
  });
  const provisionFiles = jest.fn(async () => {
    calls.push('provision');
  });
  const loadedTool = tool(async () => '', {
    name: toolName,
    description: 'Execute code',
    schema: z.object({ code: z.string() }),
  });
  const invoke = jest.spyOn(loadedTool, 'invoke').mockImplementation(async () => {
    calls.push('invoke');
    return new ToolMessage({
      content: 'Created results.csv',
      tool_call_id: 'code-call',
      artifact: { session_id: 'child-sandbox', files: [{ id: 'output', name: 'results.csv' }] },
    });
  });
  const loadTools = jest.fn<
    ReturnType<ToolExecuteOptions['loadTools']>,
    Parameters<ToolExecuteOptions['loadTools']>
  >(async () => {
    calls.push('load');
    return {
      loadedTools: [loadedTool],
      configurable: {
        executionContext: { spoofed: true },
        codeExecutionContext: {
          baseUrl: 'https://sandbox.invalid',
          codeSessionKey: 'private-child-partition',
          runtimeSessionHint: 'private-child-runtime',
          executionProfile: 'stateful',
          statefulSessions: true,
          ...context,
        },
      },
    };
  });
  const toolEndCallback = jest.fn(async () => {
    calls.push('capture');
  });
  let queue = Promise.resolve();
  const withCodeExecution: NonNullable<ToolExecuteOptions['runFiles']>['withCodeExecution'] = (
    _agentId,
    _context,
    _signal,
    execute,
  ) => {
    const result = queue.then(async () => {
      calls.push('enter');
      try {
        return await execute();
      } finally {
        calls.push('leave');
      }
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const handler = createToolExecuteHandler({
    runFiles: { isActive: () => true, prepareTools, withCodeExecution },
    loadTools,
    provisionFiles,
    toolEndCallback,
  });
  const execute = (
    executionContext = identity,
    toolCalls: ToolExecuteBatchRequest['toolCalls'] = [
      {
        id: 'code-call',
        name: toolName,
        args: { code: 'print("results")' },
        runtimeSessionHint: 'parent-runtime',
      },
    ],
  ) =>
    new Promise<ToolExecuteResult[]>((resolve, reject) => {
      const request = {
        agentId: 'worker',
        executionContext,
        configurable: { run_id: 'run', executionContext: { inherited: true } },
        metadata: { run_id: 'run', executionContext: { inherited: true } },
        toolCalls,
        signal,
        resolve,
        reject,
      } as ToolExecuteBatchRequest & { executionContext: SubagentExecutionContext };
      void handler.handle('on_tool_execute', request);
    });
  return {
    execute,
    calls,
    signal,
    prepareTools,
    provisionFiles,
    loadTools,
    invoke,
    toolEndCallback,
  };
}

describe('shared-file event execution identity', () => {
  it('authorizes before provisioning and overwrites inherited tool and artifact identities', async () => {
    const test = setup();
    expect((await test.execute())[0].status).toBe('success');
    expect(test.calls).toEqual([
      'prepare',
      'provision',
      'load',
      'enter',
      'invoke',
      'capture',
      'leave',
    ]);
    expect(test.prepareTools).toHaveBeenCalledWith('worker', identity, test.signal, 'refresh');
    expect(test.provisionFiles).toHaveBeenCalledWith(
      ['execute_code'],
      'worker',
      test.signal,
      identity,
    );
    expect(test.loadTools).toHaveBeenCalledWith(
      ['execute_code'],
      'worker',
      expect.objectContaining({ executionContext: identity }),
      undefined,
      test.signal,
      identity,
    );
    expect(test.invoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        configurable: expect.objectContaining({ executionContext: identity }),
        metadata: expect.objectContaining({ executionContext: identity }),
        toolCall: expect.objectContaining({ _runtime_session_hint: 'private-child-runtime' }),
      }),
    );
    expect(test.toolEndCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ artifact: expect.any(Object) }),
      }),
      expect.objectContaining({ executionContext: identity, executingAgentId: 'worker' }),
    );
  });

  it.each(['calculator', 'web_search', 'weather_mcp_example'])(
    'prepares the authorized snapshot before unrelated %s batches execute',
    async (toolName) => {
      const test = setup(undefined, toolName);
      expect((await test.execute())[0].status).toBe('success');
      expect((await test.execute())[0].status).toBe('success');
      expect(test.prepareTools).toHaveBeenCalledTimes(2);
      expect(test.prepareTools).toHaveBeenCalledWith('worker', identity, test.signal, 'snapshot');
      expect(test.calls.slice(0, 4)).toEqual(['prepare', 'provision', 'load', 'invoke']);
      expect(test.calls).not.toContain('enter');
    },
  );

  it.each([
    'execute_code',
    'bash_tool',
    'run_tools_with_code',
    'run_tools_with_bash',
    'create_file',
    'edit_file',
    'read_file',
    'write_file',
    'search_workspace',
    'list_workspace_files',
    'file_search',
    'image_gen_oai',
    'image_edit_oai',
    'gemini_image_gen',
  ])('refreshes publications before the %s file consumer loads', async (toolName) => {
    const test = setup(undefined, toolName);
    test.prepareTools.mockRejectedValueOnce(new Error('Publication refresh failed'));
    await expect(test.execute()).rejects.toThrow('Publication refresh failed');
    expect(test.prepareTools).toHaveBeenCalledWith('worker', identity, test.signal, 'refresh');
    expect(test.provisionFiles).not.toHaveBeenCalled();
    expect(test.loadTools).not.toHaveBeenCalled();
  });

  it('refreshes a mixed batch before either unrelated or file-consuming tools load', async () => {
    const test = setup();
    test.prepareTools.mockRejectedValueOnce(new Error('Publication refresh failed'));
    await expect(
      test.execute(identity, [
        { id: 'search', name: 'web_search', args: { query: 'related work' } },
        { id: 'files', name: 'file_search', args: { query: 'uploaded report' } },
      ]),
    ).rejects.toThrow('Publication refresh failed');
    expect(test.prepareTools).toHaveBeenCalledWith('worker', identity, test.signal, 'refresh');
    expect(test.loadTools).not.toHaveBeenCalled();
  });

  it.each(['execute_code', 'calculator'])(
    'stops before loading or executing %s when the child grant is denied',
    async (toolName) => {
      const test = setup(undefined, toolName);
      test.prepareTools.mockRejectedValueOnce(new Error('Execution grant denied'));
      await expect(test.execute()).rejects.toThrow('Execution grant denied');
      expect(test.provisionFiles).not.toHaveBeenCalled();
      expect(test.loadTools).not.toHaveBeenCalled();
      expect(test.invoke).not.toHaveBeenCalled();
    },
  );

  it('holds the code queue through artifact capture before another call can mutate the sandbox', async () => {
    const test = setup();
    let finishCapture: () => void = () => undefined;
    const captured = new Promise<void>((resolve) => {
      finishCapture = resolve;
    });
    let captureStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    test.toolEndCallback.mockImplementationOnce(async () => {
      test.calls.push('capture');
      captureStarted();
      await captured;
    });
    const completion = test.execute(identity, [
      { id: 'one', name: 'execute_code', args: { code: 'first' } },
      { id: 'two', name: 'execute_code', args: { code: 'second' } },
    ]);
    await started;
    expect(test.invoke).toHaveBeenCalledTimes(1);
    expect(test.calls).not.toContain('leave');
    finishCapture();
    expect((await completion).map((result) => result.status)).toEqual(['success', 'success']);
    expect(test.calls.slice(3)).toEqual([
      'enter',
      'invoke',
      'capture',
      'leave',
      'enter',
      'invoke',
      'capture',
      'leave',
    ]);
  });

  it('rejects background code before it can bypass the file generation queue', async () => {
    const test = setup();
    const [result] = await test.execute(identity, [
      {
        id: 'background',
        name: 'execute_code',
        args: { code: 'write()', run_in_background: true },
      },
    ]);
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('foreground execution');
    expect(test.invoke).not.toHaveBeenCalled();
    expect(test.toolEndCallback).not.toHaveBeenCalled();
  });

  it.each([{ runtimeSessionHint: undefined }, { environmentType: 'attached' as const }])(
    'fails closed without a managed child sandbox (%j)',
    async (context) => {
      const test = setup(context);
      await expect(test.execute()).rejects.toThrow('no isolated file workspace');
      expect(test.invoke).not.toHaveBeenCalled();
      expect(test.toolEndCallback).not.toHaveBeenCalled();
    },
  );
});
