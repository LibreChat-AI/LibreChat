import { z } from 'zod';
import { Constants } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import type { ToolExecuteBatchRequest, ToolExecuteResult } from '@librechat/agents';
import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';
import { createToolExecuteHandler } from './handlers';
import { instrumentPtcToolMap } from './ptc';

function invoke(
  tools: StructuredToolInterface[],
  options: Partial<ToolExecuteBatchRequest> = {},
): Promise<ToolExecuteResult[]> {
  const handler = createToolExecuteHandler({ loadTools: async () => ({ loadedTools: tools }) });
  return new Promise((resolve, reject) => {
    void handler.handle('on_tool_execute', {
      toolCalls: [
        { id: 'call-1', stepId: 'step-1', name: 'lookup', args: { token: 'input-canary' } },
      ],
      agentId: 'agent-1',
      configurable: {
        user_id: 'fallback-user',
        req: { user: { id: 'authenticated-user', tenantId: 'tenant-1' } },
      },
      metadata: { thread_id: 'conversation-1', run_id: 'run-1', secret: 'metadata-canary' },
      ...options,
      resolve,
      reject,
    });
  });
}

function fixtureTool(
  name: string,
  execute: () => Promise<{ content: string; status?: string }>,
): StructuredToolInterface {
  return tool(execute, { name, description: name, schema: z.object({}).passthrough() });
}

describe('tool executor telemetry', () => {
  let info: jest.SpyInstance;

  beforeEach(() => {
    info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  it('correlates a foreground tool with its authenticated user and execution identity', async () => {
    const results = await invoke([
      fixtureTool('lookup', async () => ({ content: 'output-canary' })),
    ]);
    expect(results[0].status).toBe('success');
    expect(info).toHaveBeenCalledWith(
      'librechat.tool.execution.completed',
      expect.objectContaining({
        'gen_ai.tool.name': 'lookup',
        'gen_ai.tool.call.id': 'call-1',
        'librechat.tool.step.id': 'step-1',
        'librechat.agent.id': 'agent-1',
        'librechat.run.id': 'run-1',
        'librechat.conversation.id': 'conversation-1',
        'enduser.id': 'authenticated-user',
        'librechat.tenant.id': 'tenant-1',
        'librechat.tool.execution.mode': 'foreground',
        'librechat.tool.status': 'success',
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('canary');
  });

  it('does not log a tool that fails the argument policy before invocation', async () => {
    const results = await invoke([fixtureTool('lookup', async () => ({ content: 'ok' }))], {
      configurable: {
        req: {
          user: { id: 'user-1' },
          config: {
            filters: {
              toolArguments: {
                pii: {
                  fields: ['arguments'],
                  starterPatterns: [],
                  customPatterns: [{ id: 'private', label: 'private', regex: 'input-canary' }],
                },
              },
            },
          },
        },
      },
    });
    expect(results[0].status).toBe('error');
    expect(info).not.toHaveBeenCalled();
  });

  it('logs host-owned tool failures even though no loaded tool is invoked', async () => {
    const results = await invoke([], {
      toolCalls: [{ id: 'read-1', name: Constants.READ_FILE, args: { path: 'missing.txt' } }],
    });
    expect(results[0].status).toBe('error');
    expect(logger.warn).toHaveBeenCalledWith(
      'librechat.tool.execution.completed',
      expect.objectContaining({
        'gen_ai.tool.call.id': 'read-1',
        'librechat.tool.status': 'error',
      }),
    );
  });

  it('waits for detached execution, not the synthetic background handle', async () => {
    let finish!: (value: { content: string }) => void;
    const tool = fixtureTool(
      'lookup',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const results = await invoke([tool], {
      toolCalls: [{ id: 'background-1', name: 'lookup', args: { run_in_background: true } }],
      configurable: {
        user_id: 'background-user',
        backgroundToolNames: ['lookup'],
        thread_id: 'background-conversation',
      },
    });
    expect(results[0].content).toContain('background_task_id');
    expect(info).toHaveBeenCalledWith(
      'librechat.tool.execution.started',
      expect.objectContaining({ 'librechat.tool.execution.mode': 'background' }),
    );
    expect(info.mock.calls.some(([event]) => event === 'librechat.tool.execution.completed')).toBe(
      false,
    );
    finish({ content: 'late-private-result-canary' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(info).toHaveBeenCalledWith(
      'librechat.tool.execution.completed',
      expect.objectContaining({
        'gen_ai.tool.call.id': 'background-1',
        'librechat.tool.status': 'success',
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('canary');
  });

  it('gives programmatic calls their own IDs and links the parent without exposing previews', async () => {
    const tools = instrumentPtcToolMap({
      toolMap: new Map([
        ['lookup', fixtureTool('lookup', async () => ({ content: 'private-result' }))],
      ]),
      toolCallId: 'parent-1',
      telemetry: {
        toolName: 'run_tools_with_code',
        toolCallId: 'parent-1',
        userId: 'user-1',
        mode: 'programmatic',
      },
      emit: () => undefined,
    });
    await tools.get('lookup')?.invoke({ token: 'ptc-input-canary' });
    expect(info).toHaveBeenCalledWith(
      'librechat.tool.execution.completed',
      expect.objectContaining({
        'gen_ai.tool.name': 'lookup',
        'gen_ai.tool.call.id': 'parent-1:0',
        'librechat.tool.parent_call.id': 'parent-1',
        'librechat.tool.execution.mode': 'programmatic',
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('canary');
    expect(JSON.stringify(info.mock.calls)).not.toContain('private-result');
  });

  it('does not export a programmatic tool name excluded by the deployment policy', async () => {
    const tools = instrumentPtcToolMap({
      toolMap: new Map([
        ['private-name', fixtureTool('private-name', async () => ({ content: 'ok' }))],
      ]),
      toolCallId: 'parent-1',
      telemetry: { toolName: 'run_tools_with_code', toolCallId: 'parent-1', mode: 'programmatic' },
      traceExclusions: new Set(['private-name']),
      emit: () => undefined,
    });
    await tools.get('private-name')?.invoke({});
    expect(info).not.toHaveBeenCalled();
  });
});
