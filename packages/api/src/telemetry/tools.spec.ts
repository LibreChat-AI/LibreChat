import { logger } from '@librechat/data-schemas';
import type { ToolExecutionIdentity } from './tools';
import { observeToolExecution } from './tools';

const identity: ToolExecutionIdentity = {
  toolName: 'search_mcp_docs',
  toolCallId: 'call-1',
  stepId: 'step-1',
  agentId: 'agent-1',
  runId: 'run-1',
  conversationId: 'conversation-1',
  userId: 'user-1',
  tenantId: 'tenant-1',
  mode: 'foreground',
};

describe('tool execution logs', () => {
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  it('reports identity and duration without inspecting input or serializing output', async () => {
    const result = { content: 'private-result-canary', artifact: { secret: 'artifact-canary' } };
    expect(await observeToolExecution(identity, async () => result)).toBe(result);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(1, 'librechat.tool.execution.started', {
      'event.name': 'librechat.tool.execution.started',
      'gen_ai.tool.name': 'search_mcp_docs',
      'gen_ai.tool.call.id': 'call-1',
      'librechat.tool.step.id': 'step-1',
      'librechat.agent.id': 'agent-1',
      'librechat.run.id': 'run-1',
      'librechat.conversation.id': 'conversation-1',
      'enduser.id': 'user-1',
      'librechat.tenant.id': 'tenant-1',
      'librechat.tool.execution.mode': 'foreground',
      'librechat.tool.status': 'running',
    });
    expect(info).toHaveBeenNthCalledWith(
      2,
      'librechat.tool.execution.completed',
      expect.objectContaining({
        'librechat.tool.status': 'success',
        'librechat.tool.duration_ms': expect.any(Number),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('canary');
  });

  it.each([{ status: 'error' }, { isError: true }])(
    'recognizes a returned failure: %p',
    async (result) => {
      expect(await observeToolExecution(identity, async () => result)).toBe(result);
      expect(warn).toHaveBeenCalledWith(
        'librechat.tool.execution.completed',
        expect.objectContaining({ 'librechat.tool.status': 'error' }),
      );
    },
  );

  it.each([true, false])(
    'preserves a rejection without logging its payload (sync=%s)',
    async (sync) => {
      const error = Object.assign(new Error('private-message-canary'), {
        name: 'private-name-canary',
        config: { headers: { Authorization: 'private-credential-canary' } },
      });
      const execute = sync
        ? () => {
            throw error;
          }
        : () => Promise.reject(error);
      await expect(observeToolExecution(identity, execute)).rejects.toBe(error);
      expect(warn).toHaveBeenCalledWith(
        'librechat.tool.execution.completed',
        expect.objectContaining({ 'librechat.tool.status': 'error', 'error.type': 'Error' }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('canary');
    },
  );

  it('distinguishes owned cancellation from an unrelated failure racing Stop', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      observeToolExecution(identity, () => Promise.reject(controller.signal.reason), {
        signal: controller.signal,
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(info).toHaveBeenLastCalledWith(
      'librechat.tool.execution.completed',
      expect.objectContaining({ 'librechat.tool.status': 'cancelled' }),
    );
    const error = new Error('upstream failure');
    await expect(
      observeToolExecution(identity, () => Promise.reject(error), { signal: controller.signal }),
    ).rejects.toBe(error);
    expect(warn).toHaveBeenLastCalledWith(
      'librechat.tool.execution.completed',
      expect.objectContaining({ 'librechat.tool.status': 'error' }),
    );
  });

  it('reports a background deadline as an error rather than a user cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('timeout', 'AbortError'));
    await expect(
      observeToolExecution(
        { ...identity, mode: 'background', backgroundTaskId: 'task-1' },
        () => Promise.reject(controller.signal.reason),
        { signal: controller.signal, getAbortSource: () => 'timeout' },
      ),
    ).rejects.toBe(controller.signal.reason);
    expect(warn).toHaveBeenCalledWith(
      'librechat.tool.execution.completed',
      expect.objectContaining({
        'librechat.tool.status': 'error',
        'librechat.tool.abort_source': 'timeout',
        'librechat.tool.background_task.id': 'task-1',
      }),
    );
  });

  it('keeps overlapping calls separate and finishes only when each execution settles', async () => {
    let finishFirst!: (value: string) => void;
    const first = observeToolExecution(
      { ...identity, mode: 'background' },
      () =>
        new Promise<string>((resolve) => {
          finishFirst = resolve;
        }),
    );
    await observeToolExecution({ ...identity, toolCallId: 'call-2' }, async () => 'done');
    expect(info.mock.calls.filter(([event]) => event.endsWith('.completed'))).toEqual([
      [
        'librechat.tool.execution.completed',
        expect.objectContaining({ 'gen_ai.tool.call.id': 'call-2' }),
      ],
    ]);
    finishFirst('late-result');
    await first;
    expect(info).toHaveBeenLastCalledWith(
      'librechat.tool.execution.completed',
      expect.objectContaining({
        'gen_ai.tool.call.id': 'call-1',
        'librechat.tool.execution.mode': 'background',
      }),
    );
  });

  it('does not let a result metadata getter change a successful execution', async () => {
    const result = Object.defineProperty({}, 'status', {
      get() {
        throw new Error('private getter');
      },
    });
    expect(await observeToolExecution(identity, async () => result)).toBe(result);
  });

  it('does not let a logging failure change execution or its result', async () => {
    info.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    warn.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    expect(await observeToolExecution(identity, async () => 'ok')).toBe('ok');
    const error = new Error('original');
    await expect(observeToolExecution(identity, () => Promise.reject(error))).rejects.toBe(error);
  });
});
