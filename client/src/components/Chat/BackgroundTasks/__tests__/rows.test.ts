import { ContentTypes } from 'librechat-data-provider';
import type { ParentSubagentSummary, TMessage } from 'librechat-data-provider';
import {
  RECENT_SUBAGENT_WINDOW_MS,
  countAwaitingDelivery,
  countFailedDelivery,
  buildTaskRows,
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
