import {
  backgroundTaskOutcome,
  formatBackgroundCodeOutput,
  parseBackgroundTaskOutput,
} from '../background';

describe('formatBackgroundCodeOutput', () => {
  it('indents a JSON log line without changing surrounding stdout and exit code', () => {
    const raw =
      'stdout:\nchecked at=2026-09-27T00:11:09Z\n{"checks":[{"status":"IN_PROGRESS"}]}\n[exit code: 0]';
    expect(formatBackgroundCodeOutput(raw)).toBe(
      'stdout:\nchecked at=2026-09-27T00:11:09Z\n{\n  "checks": [\n    {\n      "status": "IN_PROGRESS"\n    }\n  ]\n}\n[exit code: 0]',
    );
  });

  it('leaves non-JSON lines, single JSON results, and very large outputs untouched', () => {
    expect(formatBackgroundCodeOutput('stdout:\n[exit code: 0]')).toBe('stdout:\n[exit code: 0]');
    expect(formatBackgroundCodeOutput('{"ok":true}')).toBe('{"ok":true}');
    const large = `stdout:\n${'a'.repeat(64_001)}`;
    expect(formatBackgroundCodeOutput(large)).toBe(large);
  });
});

describe('backgroundTaskOutcome', () => {
  it.each([
    'invalid',
    'rejected',
    'unavailable',
    'not_found',
    'outcome_unknown',
    'result_unavailable',
    'error',
    'future_control_rejected',
  ])('flags the %s notice as a failed task check, despite a successful tool run step', (status) => {
    const display = parseBackgroundTaskOutput(JSON.stringify({ status, message: 'Host advice' }));
    expect(backgroundTaskOutcome(display)).toBe('failed');
  });

  it.each(['delivery_scheduled', 'result_persisting'])(
    'does not mistake the %s retry state for a failed task',
    (status) => {
      const display = parseBackgroundTaskOutput(JSON.stringify({ status, message: 'Host advice' }));
      expect(backgroundTaskOutcome(display)).toBeUndefined();
    },
  );

  it.each(['error', 'interrupted', 'failed', 'not_running', 'control_not_found'])(
    'flags a %s task or control receipt as failed',
    (status) => {
      const display = parseBackgroundTaskOutput(
        JSON.stringify({ background_task_id: 't1', tool: 'subagent', status }),
      );
      expect(backgroundTaskOutcome(display)).toBe('failed');
    },
  );

  it('distinguishes a discarded result from a still-running cancellation request', () => {
    expect(
      backgroundTaskOutcome(
        parseBackgroundTaskOutput(
          JSON.stringify({ status: 'cancelled', message: 'Result discarded.' }),
        ),
      ),
    ).toBe('cancelled');
    expect(
      backgroundTaskOutcome(
        parseBackgroundTaskOutput(
          JSON.stringify({
            background_task_id: 't1',
            tool: 'bash_tool',
            status: 'cancellation_requested',
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it('warns about an incomplete list, not an ordinary list of already failed tasks', () => {
    const incomplete = parseBackgroundTaskOutput(
      JSON.stringify({ tasks: [], partial: true, warning: 'Some results are missing.' }),
    );
    const complete = parseBackgroundTaskOutput(
      JSON.stringify({
        tasks: [{ background_task_id: 't1', tool: 'bash_tool', status: 'error' }],
        partial: false,
      }),
    );
    expect(backgroundTaskOutcome(incomplete)).toBe('failed');
    expect(backgroundTaskOutcome(complete)).toBeUndefined();
  });
});

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

  it('shows a cancellation_requested flag in a list as stopping, not cancelled', () => {
    expect(
      parseBackgroundTaskOutput(
        JSON.stringify({
          tasks: [
            {
              background_task_id: 'task-1',
              tool: 'bash_tool',
              status: 'running',
              cancellation_requested: true,
            },
          ],
          outstanding: 1,
        }),
      ),
    ).toMatchObject({ kind: 'list', tasks: [{ status: 'stopping' }] });
  });

  it('keeps accepted subagent controls queued rather than labeling them completed', () => {
    expect(
      parseBackgroundTaskOutput(
        JSON.stringify({
          background_task_id: 'subagent-1',
          subagent_thread_id: 'thread-1',
          tool: 'subagent',
          subagent_type: 'researcher',
          status: 'accepted',
          control_id: 'control-42',
        }),
      ),
    ).toEqual({
      kind: 'task',
      task: {
        taskId: 'subagent-1',
        toolName: 'subagent',
        subagentType: 'researcher',
        status: 'accepted',
        threadId: 'thread-1',
      },
    });
  });

  it('parses a subagent progress digest and drops only a malformed one', () => {
    const task = {
      background_task_id: 'subagent-1',
      tool: 'subagent',
      subagent_type: 'reviewer',
      status: 'running',
    };
    const activity = {
      turns: 2,
      tools: 3,
      errors: 0,
      active: '2.1',
      cursor: '1.2',
      phase: 'thinking',
      nodes: [
        { path: '1', kind: 'turn', status: 'ok', summary: 'read_file ×2', folded: true, ms: 10 },
        { path: '2.1', kind: 'tool', status: 'running', name: 'bash_tool', label: 'Run', ms: 5 },
        { path: '1-14', kind: 'range', evicted: true, errors: 0 },
      ],
    };
    expect(parseBackgroundTaskOutput(JSON.stringify({ ...task, activity }))).toMatchObject({
      kind: 'task',
      task: {
        activity: {
          turns: 2,
          tools: 3,
          errors: 0,
          active: '2.1',
          phase: 'thinking',
          nodes: [
            { path: '1', kind: 'turn', status: 'ok', summary: 'read_file ×2', folded: true },
            { path: '2.1', name: 'bash_tool', label: 'Run' },
            { path: '1-14', kind: 'range', evicted: true },
          ],
        },
      },
    });
    for (const malformed of [
      { ...activity, turns: -1 },
      { ...activity, nodes: [{ path: '2.1', kind: 'script' }] },
      { ...activity, nodes: 'none' },
    ]) {
      const parsed = parseBackgroundTaskOutput(JSON.stringify({ ...task, activity: malformed }));
      expect(parsed).toMatchObject({ kind: 'task', task: { status: 'running' } });
      expect(parsed?.kind === 'task' ? parsed.task.activity : 'missing').toBeUndefined();
    }
  });

  it.each(['claimed', 'not_running', 'control_not_found'])(
    'renders a subagent %s receipt as a task instead of raw JSON',
    (status) => {
      expect(
        parseBackgroundTaskOutput(
          JSON.stringify({
            background_task_id: 'task-1',
            tool: 'subagent',
            subagent_type: 'researcher',
            status,
            result_available: true,
            result_claimed: true,
          }),
        ),
      ).toEqual({
        kind: 'task',
        task: {
          taskId: 'task-1',
          toolName: 'subagent',
          subagentType: 'researcher',
          status,
          resultAvailable: true,
          resultClaimed: true,
        },
      });
    },
  );

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
