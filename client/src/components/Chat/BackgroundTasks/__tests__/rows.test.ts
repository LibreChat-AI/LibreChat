import { ContentTypes } from 'librechat-data-provider';
import type { ParentSubagentSummary, TMessage } from 'librechat-data-provider';
import {
  RECENT_SUBAGENT_WINDOW_MS,
  countAwaitingDelivery,
  countFailedDelivery,
  buildTaskRows,
  nextTaskExpiry,
  findToolCallArgs,
  subagentTaskKey,
} from '../rows';

const now = Date.parse('2026-09-24T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();

const child = (overrides: Partial<ParentSubagentSummary>): ParentSubagentSummary => ({
  threadId: 'thread',
  parentMessageId: 'message',
  subagentType: 'researcher',
  subagentKind: 'agent',
  title: 'Child',
  origin: 'tool',
  status: 'completed',
  latestTaskId: 'task',
  tasks: [{ taskId: 'task', status: 'completed', createdAt: iso(60_000) }],
  tasksTruncated: false,
  ...overrides,
});

describe('buildTaskRows', () => {
  it('keeps a finished result the agent has not received ahead of delivered ones', () => {
    const tool = (taskId: string, extra: object) => ({
      taskId,
      toolName: 'bash_tool',
      toolCallId: `call-${taskId}`,
      status: 'completed' as const,
      cancellationRequested: false,
      startedAt: iso(RECENT_SUBAGENT_WINDOW_MS * 2),
      settledAt: iso(RECENT_SUBAGENT_WINDOW_MS * 2 - 1_000),
      ...extra,
    });
    const rows = buildTaskRows({
      now,
      args: new Map(),
      describe: () => ({}),
      stoppingThreads: new Set(),
      subagents: [],
      tools: [
        tool('recent-delivered', {
          delivery: 'delivered',
          startedAt: iso(2_000),
          settledAt: iso(1_000),
        }),
        tool('old-pending', { delivery: 'pending' }),
        tool('old-failed', {
          delivery: 'failed',
          startedAt: iso(RECENT_SUBAGENT_WINDOW_MS * 3),
          settledAt: iso(RECENT_SUBAGENT_WINDOW_MS * 3 - 1_000),
        }),
        tool('old-delivered', { delivery: 'delivered' }),
        {
          ...tool('running', {}),
          status: 'running' as const,
          delivery: 'pending' as const,
          settledAt: undefined,
        },
      ],
    });

    expect(rows.map((row) => [row.id, row.status, row.delivery])).toEqual([
      ['tool:running', 'running', undefined],
      ['tool:old-pending', 'completed', 'pending'],
      ['tool:old-failed', 'completed', 'failed'],
      ['tool:recent-delivered', 'completed', undefined],
    ]);
    expect(countAwaitingDelivery(rows)).toBe(1);
    expect(countFailedDelivery(rows)).toBe(1);
  });

  it('orders active rows first and drops subagents settled past the retention window', () => {
    const rows = buildTaskRows({
      now,
      args: new Map(),
      describe: () => ({}),
      stoppingThreads: new Set([subagentTaskKey('running-child', 'task')]),
      tools: [
        {
          taskId: 'done',
          toolName: 'bash_tool',
          toolCallId: 'call-done',
          status: 'completed',
          cancellationRequested: false,
          startedAt: iso(1_000),
          settledAt: iso(500),
        },
        {
          taskId: 'stopping',
          toolName: 'bash_tool',
          toolCallId: 'call-stopping',
          status: 'running',
          cancellationRequested: true,
          startedAt: iso(90_000),
        },
      ],
      subagents: [
        child({ threadId: 'running-child', status: 'dispatched' }),
        child({ threadId: 'recent-child', status: 'failed', updatedAt: iso(10_000) }),
        child({ threadId: 'old-child', updatedAt: iso(RECENT_SUBAGENT_WINDOW_MS + 1) }),
      ],
    });

    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ['subagent:running-child\u0000task', 'stopping'],
      ['tool:stopping', 'stopping'],
      ['tool:done', 'completed'],
      ['subagent:recent-child\u0000task', 'error'],
    ]);
    expect(rows[0].subagent).toEqual({ threadId: 'running-child', taskId: 'task' });
    expect(rows[3].subagent).toBeUndefined();
    expect(rows[3].taskId).toBe('task');
  });

  /**
   * A child task's summary carries the time of its newest record: its dispatch while it runs,
   * its end once it has replied. Read as the start, that made every finished task take 0s.
   */
  it('times a finished subagent from its dispatch to when its thread was last written', () => {
    const [row] = buildTaskRows({
      now,
      args: new Map(),
      describe: () => ({}),
      stoppingThreads: new Set(),
      tools: [],
      subagents: [
        child({
          status: 'completed',
          updatedAt: iso(58_000),
          tasks: [
            {
              taskId: 'task',
              status: 'completed',
              startedAt: iso(300_000),
              createdAt: iso(60_000),
            },
          ],
        }),
      ],
    });

    expect(row.startedAt).toBe(now - 300_000);
    expect(row.settledAt).toBe(now - 58_000);
  });

  /**
   * A child that pauses for an approval writes its reply at the pause and updates that same
   * record when it resumes and ends, so the reply's creation time is when it stopped to ask,
   * not when it finished. Taken for the end, it would leave out everything after the approval,
   * and age a task that just finished out of the list if it had waited over an hour for one.
   */
  it('does not take the reply of a child that paused for approval as its end', () => {
    const rows = buildTaskRows({
      now,
      args: new Map(),
      describe: () => ({}),
      stoppingThreads: new Set(),
      tools: [],
      subagents: [
        child({
          status: 'completed',
          origin: 'event',
          updatedAt: iso(5_000),
          tasks: [
            {
              taskId: 'task',
              status: 'completed',
              startedAt: iso(RECENT_SUBAGENT_WINDOW_MS + 600_000),
              createdAt: iso(RECENT_SUBAGENT_WINDOW_MS + 300_000),
            },
          ],
        }),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].startedAt).toBe(now - RECENT_SUBAGENT_WINDOW_MS - 600_000);
    expect(rows[0].settledAt).toBe(now - 5_000);
  });

  it('shows no duration for a finished subagent whose dispatch time is unknown', () => {
    const [row] = buildTaskRows({
      now,
      args: new Map(),
      describe: () => ({}),
      stoppingThreads: new Set(),
      tools: [],
      subagents: [
        child({
          status: 'completed',
          updatedAt: iso(50_000),
          tasks: [{ taskId: 'task', status: 'completed', createdAt: iso(60_000) }],
        }),
      ],
    });

    expect(row.startedAt).toBeUndefined();
    expect(row.settledAt).toBe(now - 50_000);
  });

  it('times a running subagent from its dispatch, with or without a named start', () => {
    const rows = buildTaskRows({
      now,
      args: new Map(),
      describe: () => ({}),
      stoppingThreads: new Set(),
      tools: [],
      subagents: [
        child({
          threadId: 'named',
          status: 'running',
          tasks: [
            { taskId: 'task', status: 'running', startedAt: iso(90_000), createdAt: iso(90_000) },
          ],
        }),
        child({
          threadId: 'older-server',
          status: 'running',
          tasks: [{ taskId: 'task', status: 'running', createdAt: iso(120_000) }],
        }),
      ],
    });

    expect(rows.map((row) => [row.threadId, row.startedAt, row.settledAt])).toEqual([
      ['named', now - 90_000, undefined],
      ['older-server', now - 120_000, undefined],
    ]);
  });

  it('carries who a subagent runs as, for a surface that names the agent', () => {
    const [row] = buildTaskRows({
      now,
      args: new Map(),
      describe: () => ({}),
      stoppingThreads: new Set(),
      tools: [],
      subagents: [child({ agentId: 'agent-1', subagentType: 'agent-1', subagentKind: 'agent' })],
    });

    expect(row).toMatchObject({
      agentId: 'agent-1',
      subagentType: 'agent-1',
      subagentKind: 'agent',
    });
  });
});

describe('nextTaskExpiry', () => {
  const rows = (settled: Parameters<typeof buildTaskRows>[0]['tools']) =>
    buildTaskRows({
      now,
      args: new Map(),
      describe: () => ({}),
      stoppingThreads: new Set(),
      tools: settled,
      subagents: [],
    });
  const tool = { toolName: 'bash_tool', toolCallId: 'call', cancellationRequested: false };

  it('is the moment the earliest delivered, settled row leaves the list', () => {
    const settledAt = iso(10_000);
    expect(
      nextTaskExpiry(
        rows([
          {
            ...tool,
            taskId: 'later',
            status: 'completed',
            startedAt: iso(9_000),
            settledAt: iso(5_000),
          },
          { ...tool, taskId: 'earlier', status: 'completed', startedAt: iso(20_000), settledAt },
        ]),
      ),
    ).toBe(Date.parse(settledAt) + RECENT_SUBAGENT_WINDOW_MS + 1);
  });

  it('never schedules for running work or for a result still owed to the agent', () => {
    expect(
      nextTaskExpiry(
        rows([
          { ...tool, taskId: 'running', status: 'running', startedAt: iso(9_000) },
          {
            ...tool,
            taskId: 'owed',
            status: 'completed',
            startedAt: iso(9_000),
            settledAt: iso(5_000),
            delivery: 'pending',
          },
        ]),
      ),
    ).toBe(Infinity);
  });
});

describe('findToolCallArgs', () => {
  it('does not guess when a provider reuses a call id within one response', () => {
    const messages = [
      {
        messageId: 'm',
        content: ['first', 'second'].map((stepId) => ({
          type: ContentTypes.TOOL_CALL,
          tool_call: { id: 'call_0', stepId, args: { command: stepId } },
        })),
      },
    ] as unknown as TMessage[];
    expect(findToolCallArgs(messages, [{ messageId: 'm', toolCallId: 'call_0' }]).size).toBe(0);
    expect(
      findToolCallArgs(messages, [{ messageId: 'm', toolCallId: 'call_0', stepId: 'second' }]),
    ).toEqual(new Map([['m\u0000call_0\u0000second', { command: 'second' }]]));
  });
  it('resolves only the requested tool calls', () => {
    const messages = [
      {
        messageId: 'm1',
        content: [
          { type: ContentTypes.TEXT, text: 'hi' },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: { id: 'a', name: 'bash_tool', args: '{"command":"ls"}' },
          },
          { type: ContentTypes.TOOL_CALL, tool_call: { id: 'b', name: 'bash_tool', args: '{}' } },
        ],
      },
    ] as unknown as TMessage[];
    expect(findToolCallArgs(messages, [{ messageId: 'm1', toolCallId: 'a' }])).toEqual(
      new Map([['m1\u0000a', '{"command":"ls"}']]),
    );
    expect(findToolCallArgs(undefined, [{ toolCallId: 'a' }]).size).toBe(0);
  });

  it('keeps separate commands for tasks whose call ids repeat in different messages', () => {
    const tools = [
      {
        taskId: 'older',
        messageId: 'm1',
        toolCallId: 'call_0',
        toolName: 'bash_tool',
        status: 'completed' as const,
        cancellationRequested: false,
        startedAt: iso(2_000),
      },
      {
        taskId: 'newer',
        messageId: 'm2',
        toolCallId: 'call_0',
        toolName: 'bash_tool',
        status: 'running' as const,
        cancellationRequested: false,
        startedAt: iso(1_000),
      },
    ];
    const messages = [
      {
        messageId: 'm1',
        content: [{ type: ContentTypes.TOOL_CALL, tool_call: { id: 'call_0', args: 'older' } }],
      },
      {
        messageId: 'm2',
        content: [{ type: ContentTypes.TOOL_CALL, tool_call: { id: 'call_0', args: 'newer' } }],
      },
    ] as unknown as TMessage[];
    const args = findToolCallArgs(messages, tools);
    const rows = buildTaskRows({
      now,
      args,
      tools,
      subagents: [],
      stoppingThreads: new Set(),
      describe: (value) => ({ detail: String(value) }),
    });
    expect(rows.find((row) => row.taskId === 'older')?.detail).toBe('older');
    expect(rows.find((row) => row.taskId === 'newer')?.detail).toBe('newer');
    expect(findToolCallArgs(messages, [{ toolCallId: 'call_0' }]).size).toBe(0);
  });
});
