import { parseBackgroundTaskOutput } from '../background';

describe('parseBackgroundTaskOutput', () => {
  it('parses an ordinary task result with the receipt and its exact output', () => {
    const result =
      'stdout:\nchecked at=2026-09-27T00:11:09Z\n{"checks":[{"status":"IN_PROGRESS"}]}\n[exit code: 0]';
    expect(
      parseBackgroundTaskOutput(
        JSON.stringify({
          background_task_id: 'task-1',
          tool: 'bash_tool',
          status: 'completed',
          result,
          delivery: 'delivered',
          started_at: '2026-09-27T00:11:00Z',
        }),
      ),
    ).toEqual({
      kind: 'task',
      task: {
        taskId: 'task-1',
        toolName: 'bash_tool',
        status: 'completed',
        result,
        delivery: 'delivered',
      },
    });
  });

  it('parses running, failed, cancelled, and pending tasks in a list without inventing results', () => {
    expect(
      parseBackgroundTaskOutput(
        JSON.stringify({
          tasks: [
            { background_task_id: 't1', tool: 'web_search', status: 'running' },
            {
              background_task_id: 't2',
              tool: 'execute_code',
              status: 'completed',
              delivery: 'pending',
              result_available: true,
            },
            {
              background_task_id: 't3',
              tool: 'read_file',
              status: 'error',
              error: 'Could not read file',
              delivery: 'failed',
            },
            {
              background_task_id: 't4',
              tool: 'subagent',
              status: 'cancelled',
              subagent_type: 'researcher',
            },
          ],
          outstanding: 2,
          partial: true,
          warning: 'Some results were not loaded.',
        }),
      ),
    ).toEqual({
      kind: 'list',
      tasks: [
        { taskId: 't1', toolName: 'web_search', status: 'running' },
        {
          taskId: 't2',
          toolName: 'execute_code',
          status: 'completed',
          delivery: 'pending',
          resultAvailable: true,
        },
        {
          taskId: 't3',
          toolName: 'read_file',
          status: 'error',
          error: 'Could not read file',
          delivery: 'failed',
        },
        {
          taskId: 't4',
          toolName: 'subagent',
          status: 'cancelled',
          subagentType: 'researcher',
        },
      ],
      partial: true,
      warning: 'Some results were not loaded.',
    });
  });

  it('shows a cancellation request as still stopping rather than cancelled', () => {
    expect(
      parseBackgroundTaskOutput(
        JSON.stringify({
          background_task_id: 'task-1',
          tool: 'bash_tool',
          status: 'cancellation_requested',
          message: 'Cancellation requested; execution continues until settlement.',
        }),
      ),
    ).toMatchObject({ kind: 'task', task: { status: 'stopping' } });
  });

  it('recognizes delivery and invalid-id notices without pretending they are tasks', () => {
    const message = 'The result is already assigned to an automatic continuation.';
    expect(
      parseBackgroundTaskOutput(
        JSON.stringify({ status: 'delivery_scheduled', background_task_id: 't1', message }),
      ),
    ).toEqual({ kind: 'notice', status: 'delivery_scheduled', message });
  });

  it.each([
    '',
    '{"tasks":',
    JSON.stringify({ tasks: [{ background_task_id: 't1', tool: 'bash_tool', status: 'unknown' }] }),
    JSON.stringify({
      tasks: [
        { background_task_id: 't1', tool: 'bash_tool', status: 'running', delivery: 'unknown' },
      ],
    }),
    JSON.stringify({
      background_task_id: 't1',
      tool: 'bash_tool',
      status: 'completed',
      result: {},
    }),
    JSON.stringify({ status: 'completed', result: 'unrelated tool output' }),
    JSON.stringify({ tasks: 'corrupt', status: 'invalid', message: 'Retry the request.' }),
  ])('keeps malformed or unknown tool output on the raw fallback path', (output) => {
    expect(parseBackgroundTaskOutput(output)).toBeNull();
  });
});
