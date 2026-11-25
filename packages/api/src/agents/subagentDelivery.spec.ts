import type { TAgentsEndpoint } from 'librechat-data-provider';
import type { PostToolUseHookInput } from '@librechat/agents';
import {
  SUBAGENT_WAKEUP_GUIDANCE,
  backgroundCompletionWakeupsEnabled,
  createSubagentWakeupHandleHook,
} from './subagentDelivery';

describe('background completion wakeup policy', () => {
  it('defaults to automatic delivery and honors the administrator opt-out', () => {
    expect(backgroundCompletionWakeupsEnabled(undefined)).toBe(true);
    expect(backgroundCompletionWakeupsEnabled({} as TAgentsEndpoint)).toBe(true);
    expect(
      backgroundCompletionWakeupsEnabled({
        backgroundTasks: { completionWakeups: false },
      } as TAgentsEndpoint),
    ).toBe(false);
  });
});

const hookSignal = new AbortController().signal;

function input(
  toolName: string,
  toolOutput: unknown,
  executingAgentId = 'agent_parent',
): PostToolUseHookInput {
  return {
    hook_event_name: 'PostToolUse',
    toolName,
    toolInput: {},
    toolOutput,
    toolUseId: 'call-1',
    executingAgentId,
  } as PostToolUseHookInput;
}

describe('createSubagentWakeupHandleHook', () => {
  it('replaces the legacy poll-first instruction on a running detached subagent handle', async () => {
    const output = JSON.stringify({
      background_task_id: 'task-1',
      subagent_thread_id: 'thread-1',
      tool: 'subagent',
      subagent_type: 'researcher',
      status: 'running',
      message: 'Poll the host background-task tool.',
    });

    const result = await createSubagentWakeupHandleHook()(input('subagent', output), hookSignal);
    const updated = JSON.parse(result.updatedOutput as string);

    expect(updated).toMatchObject({
      background_task_id: 'task-1',
      subagent_thread_id: 'thread-1',
      status: 'running',
    });
    expect(updated.message).toContain('background_task_id "task-1"');
    expect(updated.message).toContain(SUBAGENT_WAKEUP_GUIDANCE);
  });

  it('leaves ordinary background tools and terminal subagent results unchanged', async () => {
    const hook = createSubagentWakeupHandleHook();

    await expect(
      hook(
        input('execute_code', JSON.stringify({ background_task_id: 'code-1', status: 'running' })),
        hookSignal,
      ),
    ).resolves.toEqual({});
    await expect(
      hook(
        input('subagent', JSON.stringify({ background_task_id: 'task-1', status: 'completed' })),
        hookSignal,
      ),
    ).resolves.toEqual({});
  });

  it('fails closed on malformed or non-handle subagent output', async () => {
    const hook = createSubagentWakeupHandleHook();

    await expect(hook(input('subagent', 'not-json'), hookSignal)).resolves.toEqual({});
    await expect(
      hook(input('subagent', JSON.stringify({ status: 'running' })), hookSignal),
    ).resolves.toEqual({});
  });

  it('leaves the handle unchanged when the executing agent cannot receive wakeups', async () => {
    const hook = createSubagentWakeupHandleHook((agentId) => agentId === 'agent_supported');
    const output = JSON.stringify({ background_task_id: 'task-1', status: 'running' });

    await expect(hook(input('subagent', output, 'ephemeral'), hookSignal)).resolves.toEqual({});
    await expect(
      hook({ ...input('subagent', output), executingAgentId: undefined }, hookSignal),
    ).resolves.toEqual({});
    await expect(hook(input('subagent', output, 'agent_supported'), hookSignal)).resolves.toEqual(
      expect.objectContaining({ updatedOutput: expect.any(String) }),
    );
  });
});
