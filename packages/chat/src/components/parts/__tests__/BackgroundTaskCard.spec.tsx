/**
 * @jest-environment jsdom
 */
import React from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { render, screen, within } from '@testing-library/react';
import type { ParentSubagentSummary, SubagentDigest, TMessage } from 'librechat-data-provider';
import type { BackgroundTaskView } from '../../../core/parts/background';
import BackgroundTaskCard, { endedTaskDurationMs } from '../BackgroundTaskCard';
import { MessageContext, useMessageContext } from '../../../react/message';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../react/host';
import SubagentProgress from '../SubagentProgress';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize:
    () =>
    (key: string, values?: Record<string, string | number>): string =>
      values == null ? key : `${key}(${Object.values(values).join(',')})`,
}));

jest.mock('../../../core/parts/toolLabels', () => ({
  ...jest.requireActual('../../../core/parts/toolLabels'),
  getToolDisplayLabel: (name: string) =>
    (({ bash_tool: 'Code', read_file: 'Read File' }) as Record<string, string>)[name] ?? name,
}));

jest.mock('../ToolIcon', () => ({
  __esModule: true,
  default: ({ type }: { type: string }) => <span data-testid="tool-icon">{type}</span>,
  getToolIconType: (name: string) => name,
}));

const output = JSON.stringify({
  background_task_id: 'task-1',
  subagent_thread_id: 'thread-1',
  tool: 'subagent',
  subagent_type: 'agent_reviewer',
  status: 'running',
  message: 'Running in the background. background_task_id: task-1',
});

const dispatch: TMessage = {
  messageId: 'parent-turn',
  parentMessageId: null,
  conversationId: 'convo-1',
  isCreatedByUser: false,
  model: 'agent_lia',
  sender: 'Lia',
  text: '',
  content: [
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call-1',
        name: 'subagent',
        args: JSON.stringify({
          intent: 'Asking the reviewer to restate its findings',
          description: 'A long brief the card never shows.',
          subagent_type: 'agent_reviewer',
          run_in_background: true,
        }),
        output,
        subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'agent_reviewer' },
      },
    },
  ],
};

const agents = {
  agent_reviewer: { id: 'agent_reviewer', name: 'PR Reviewer' },
  agent_lia: { id: 'agent_lia', name: 'Lia' },
};

function renderCard(task: BackgroundTaskView, messages: TMessage[] = [dispatch]) {
  const host = createMessagesHost({
    useGetMessages: () => () => messages,
    useAgentsMap: () => agents as never,
    renderMessageIcon: ({ agent }) => <span data-testid="avatar">{agent?.name ?? 'none'}</span>,
  });
  const parts = createMessagePartsHost({ useMessage: () => useMessageContext() });
  return render(
    <MessagePartsHostProvider host={parts}>
      <MessagesHostProvider host={host}>
        <MessageContext.Provider
          value={{ messageId: 'poll-turn', conversationId: 'convo-1', isExpanded: true }}
        >
          <BackgroundTaskCard task={task} />
        </MessageContext.Provider>
      </MessagesHostProvider>
    </MessagePartsHostProvider>,
  );
}

describe('BackgroundTaskCard subagent header', () => {
  it('names the child by its agent and shows the dispatching intent, never the brief or ids', () => {
    renderCard({
      taskId: 'task-1',
      toolName: 'subagent',
      status: 'claimed',
      subagentType: 'agent_reviewer',
      threadId: 'thread-1',
    });
    const card = screen.getByTestId('background-task-card');
    expect(within(card).getByTitle('PR Reviewer')).toHaveTextContent('PR Reviewer');
    expect(within(card).getByTestId('avatar')).toHaveTextContent('PR Reviewer');
    expect(
      within(card).getByText('Asking the reviewer to restate its findings'),
    ).toBeInTheDocument();
    expect(within(card).getByText('com_ui_subagent_status_finished')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('agent_reviewer');
    expect(card).not.toHaveTextContent('task-1');
    expect(card).not.toHaveTextContent('A long brief');
    expect(card).not.toHaveTextContent('com_ui_background_tasks_result_claimed');
  });

  it('falls back to the generic subagent name and no task line when the dispatch is not loaded', () => {
    renderCard(
      {
        taskId: 'task-1',
        toolName: 'subagent',
        status: 'failed',
        subagentType: 'agent_unknown',
        threadId: 'thread-1',
      },
      [],
    );
    const card = screen.getByTestId('background-task-card');
    expect(within(card).getByText('com_ui_background_tasks_subagent')).toBeInTheDocument();
    expect(within(card).getByText('com_ui_failed')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('agent_unknown');
  });
});

describe('endedTaskDurationMs', () => {
  const child = (status: ParentSubagentSummary['status']): ParentSubagentSummary => ({
    threadId: 'thread-1',
    parentMessageId: 'parent-turn',
    subagentType: 'agent_reviewer',
    subagentKind: 'agent',
    title: 'PR Reviewer',
    origin: 'tool',
    status,
    tasks: [
      {
        taskId: 'task-1',
        status,
        startedAt: '2026-11-23T10:00:00.000Z',
        createdAt: '2026-11-23T10:02:05.000Z',
      },
    ],
    tasksTruncated: false,
  });

  it('measures an ended task from its dispatch to its end record', () => {
    expect(endedTaskDurationMs(child('completed'), 'task-1')).toBe(125_000);
  });

  it('reports nothing while running, for another task, or without a dispatch time', () => {
    expect(endedTaskDurationMs(child('running'), 'task-1')).toBeUndefined();
    expect(endedTaskDurationMs(child('completed'), 'task-2')).toBeUndefined();
    const legacy = child('completed');
    delete legacy.tasks[0].startedAt;
    expect(endedTaskDurationMs(legacy, 'task-1')).toBeUndefined();
    expect(endedTaskDurationMs(undefined, 'task-1')).toBeUndefined();
  });
});

describe('SubagentProgress timeline', () => {
  const finished: SubagentDigest = {
    turns: 17,
    tools: 30,
    errors: 0,
    nodes: [
      {
        path: '1-10',
        kind: 'range',
        status: 'ok',
        ms: 92_000,
        summary: 'bash_tool ×9, read_file ×4 +3 more',
        folded: true,
      },
      {
        path: '15',
        kind: 'turn',
        status: 'ok',
        ms: 1_900,
        summary: 'github, bash_tool ×2',
        label: 'Fetching a sample pull request',
        folded: true,
      },
      { path: '16', kind: 'turn', status: 'ok', ms: 1_400, summary: 'bash_tool', folded: true },
      { path: '17', kind: 'turn', status: 'ok', ms: 6_100 },
      { path: '17.1', kind: 'text', status: 'ok', ms: 6_100, chars: 1284 },
    ],
  };

  it('reads each step as a sentence, tallies folded ranges, and marks the finish', () => {
    render(<SubagentProgress digest={finished} settled />);
    const progress = screen.getByTestId('subagent-progress');
    expect(progress).toHaveTextContent('com_ui_subagent_progress_tool_calls(30)');
    expect(progress).toHaveTextContent('com_ui_subagent_progress_steps(17)');
    expect(progress).not.toHaveTextContent('com_ui_subagent_progress_failed');
    const rows = within(progress).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('com_ui_subagent_progress_steps_range(1–10)');
    expect(rows[0]).toHaveTextContent('com_ui_subagent_progress_more(3)');
    expect(within(rows[0]).getByText('9')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Fetching a sample pull request');
    expect(rows[1]).toHaveTextContent('com_ui_subagent_progress_more(2)');
    expect(rows[2]).toHaveTextContent('Code');
    expect(rows[3]).toHaveTextContent('com_ui_subagent_progress_wrote_reply');
    expect(rows[3]).toHaveTextContent('com_ui_subagent_progress_chars(1,284)');
    const finish = within(rows[3]).getByRole('img', { name: 'com_ui_background_tasks_completed' });
    expect(finish).toHaveClass('bg-status-success');
    const earlier = within(rows[2]).getByRole('img', { name: 'com_ui_background_tasks_completed' });
    expect(earlier).not.toHaveClass('bg-status-success');
  });

  it('scales each duration bar to the longest step at its level', () => {
    const { container } = render(<SubagentProgress digest={finished} settled />);
    const widths = Array.from(
      container.querySelectorAll<HTMLElement>('li > div > span[aria-hidden] > span[style]'),
    ).map((bar) => bar.style.width);
    expect(widths[0]).toBe('100%');
    expect(Number.parseFloat(widths[3])).toBeCloseTo((6_100 / 92_000) * 100, 3);
    expect(Number.parseFloat(widths[2])).toBe(2.5);
  });

  it('shows a running call and a thinking phase without marking a finish', () => {
    render(
      <SubagentProgress
        digest={{
          turns: 3,
          tools: 3,
          errors: 1,
          phase: 'thinking',
          nodes: [
            { path: '2', kind: 'turn', status: 'error', ms: 900, summary: 'github', folded: true },
            { path: '3', kind: 'turn', status: 'ok', ms: 4_000 },
            {
              path: '3.1',
              kind: 'tool',
              status: 'ok',
              name: 'read_file',
              label: 'Reading the diff',
              ms: 4_000,
            },
          ],
        }}
      />,
    );
    const progress = screen.getByTestId('subagent-progress');
    expect(progress).toHaveTextContent('com_ui_subagent_progress_failed(1)');
    const rows = within(progress).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('com_ui_failed');
    expect(rows[1]).toHaveTextContent('Reading the diff');
    expect(within(rows[1]).getByRole('img')).not.toHaveClass('bg-status-success');
    expect(rows[2]).toHaveTextContent('com_ui_subagent_progress_thinking');
    expect(
      within(rows[2]).getByRole('img', { name: 'com_ui_background_tasks_running' }),
    ).toBeInTheDocument();
  });

  it('nests a nested subagent run beneath the call that started it', () => {
    render(
      <SubagentProgress
        digest={{
          turns: 1,
          tools: 2,
          errors: 0,
          nodes: [
            { path: '1', kind: 'turn', status: 'running', ms: 3_000 },
            {
              path: '1.1',
              kind: 'tool',
              status: 'running',
              name: 'subagent',
              label: 'Asking a helper',
              ms: 3_000,
              summary: '1 turn, 1 tool',
            },
            { path: '1.1.1', kind: 'turn', status: 'running', ms: 2_000 },
            {
              path: '1.1.1.1',
              kind: 'tool',
              status: 'running',
              name: 'bash_tool',
              label: 'Listing files',
              ms: 2_000,
            },
          ],
        }}
      />,
    );
    const lists = screen.getAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(lists[0]).toHaveTextContent('Asking a helper');
    expect(lists[0]).toHaveTextContent('com_ui_subagent_progress_nested(1,1)');
    expect(lists[1]).toHaveTextContent('Listing files');
  });
});
