import React from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { ContentTypes, QueryKeys, dataService } from 'librechat-data-provider';
import type { ParentSubagentSummary, BackgroundTaskIndex, TMessage } from 'librechat-data-provider';
import { ParentSubagentsProvider } from '~/components/Chat/Subagents/ParentSubagentsProvider';
import BackgroundTasksButton from '../Button';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const conversationId = 'convo-1';
const startedAt = new Date(Date.now() - 30_000).toISOString();

const index = (overrides: Partial<BackgroundTaskIndex> = {}): BackgroundTaskIndex => ({
  conversationId,
  cancellable: true,
  tasks: [
    {
      taskId: 'task-running',
      toolName: 'bash_tool',
      toolCallId: 'call-running',
      status: 'running',
      cancellationRequested: false,
      startedAt,
    },
    {
      taskId: 'task-done',
      toolName: 'bash_tool',
      toolCallId: 'call-done',
      status: 'completed',
      cancellationRequested: false,
      startedAt,
      settledAt: new Date().toISOString(),
    },
  ],
  ...overrides,
});

const runningChild: ParentSubagentSummary = {
  threadId: 'thread-1',
  parentMessageId: 'parent-message',
  parentToolCallId: 'call-subagent',
  subagentType: 'researcher',
  subagentKind: 'agent',
  title: 'Research the API',
  origin: 'tool',
  status: 'running',
  latestTaskId: 'sub-task-1',
  tasks: [{ taskId: 'sub-task-1', status: 'running', createdAt: startedAt }],
  tasksTruncated: false,
};

const messages: TMessage[] = [
  {
    messageId: 'message-1',
    conversationId,
    parentMessageId: null,
    isCreatedByUser: false,
    text: '',
    content: [
      {
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: {
          id: 'call-running',
          name: 'bash_tool',
          args: '{"intent":"Rerun the focused specs","command":"npx jest tasks.spec.ts"}',
        },
      },
    ],
  } as TMessage,
];

const renderButton = (children: ParentSubagentSummary[] = [], initialMessages = messages) => {
  jest.spyOn(dataService, 'getSubagentThread').mockImplementation(() => new Promise(() => {}));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.messages, conversationId], initialMessages);
  jest.spyOn(dataService, 'getParentSubagents').mockResolvedValue({
    parentConversationId: conversationId,
    children,
    childrenTruncated: false,
  });
  const rendered = render(
    <RecoilRoot>
      <QueryClientProvider client={queryClient}>
        <ParentSubagentsProvider conversationId={conversationId} enabled>
          <BackgroundTasksButton conversationId={conversationId} isSubmitting={false} />
        </ParentSubagentsProvider>
      </QueryClientProvider>
    </RecoilRoot>,
  );
  return { ...rendered, queryClient };
};

afterEach(() => jest.restoreAllMocks());

describe('BackgroundTasksButton', () => {
  it('does not expose the previous conversation tasks while host context catches up to navigation', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.parentSubagents, 'old-chat'], {
      parentConversationId: 'old-chat',
      children: [runningChild],
      childrenTruncated: false,
    });
    const getTasks = jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    jest.spyOn(dataService, 'getParentSubagents').mockResolvedValue({
      parentConversationId: 'old-chat',
      children: [runningChild],
      childrenTruncated: false,
    });
    const panel = (hostId: string) => (
      <RecoilRoot>
        <QueryClientProvider client={queryClient}>
          <ParentSubagentsProvider conversationId={hostId} enabled>
            <BackgroundTasksButton conversationId={conversationId} isSubmitting={false} />
          </ParentSubagentsProvider>
        </QueryClientProvider>
      </RecoilRoot>
    );
    const { rerender, container } = render(panel('old-chat'));
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(getTasks).not.toHaveBeenCalled();
    rerender(panel(conversationId));
    await waitFor(() => expect(getTasks).toHaveBeenCalledWith(conversationId));
  });

  it.each(['pending', 'failed'] as const)(
    'keeps a long-waiting %s result visible without rescheduling its expiry',
    async (delivery) => {
      jest.useFakeTimers();
      try {
        const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
        const startedAt = new Date(Date.now() - 2 * 60 * 60_000 - 1_000).toISOString();
        jest
          .spyOn(dataService, 'getBackgroundTasks')
          .mockResolvedValue(
            index({ tasks: [{ ...index().tasks[1], startedAt, settledAt: old, delivery }] }),
          );
        renderButton([], []);
        await act(async () => {
          await jest.advanceTimersByTimeAsync(100);
        });
        const trigger = screen.getByTestId('header-background-tasks-button');
        expect(trigger).toHaveAccessibleName(
          delivery === 'pending'
            ? 'com_ui_background_tasks_pending_label'
            : 'com_ui_background_tasks_failed_label',
        );
        expect(screen.getByTestId('background-tasks-indicator')).toHaveClass(
          delivery === 'pending' ? 'bg-status-info' : 'bg-status-warning',
        );
        expect(screen.getByTestId('background-tasks-indicator')).not.toHaveClass('animate-pulse');
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1_100);
        });
        expect(trigger).toBeInTheDocument();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('announces a failed-only result inside the task list after its tool settled hours ago', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(
      index({
        tasks: [{ ...index().tasks[1], startedAt: old, settledAt: old, delivery: 'failed' }],
      }),
    );
    renderButton([], []);
    const trigger = await screen.findByTestId('header-background-tasks-button');
    const user = userEvent.setup();
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'com_ui_background_tasks' });
    expect(within(dialog).getByTestId('background-task-delivery')).toHaveTextContent(
      'com_ui_background_tasks_result_undelivered',
    );
  });

  it('keeps an incomplete empty index discoverable and recovers after the store returns', async () => {
    const getTasks = jest
      .spyOn(dataService, 'getBackgroundTasks')
      .mockResolvedValueOnce(index({ tasks: [], complete: false }))
      .mockResolvedValue(index({ tasks: [], complete: true }));
    const { queryClient } = renderButton([], []);
    const trigger = await screen.findByTestId('header-background-tasks-button');
    expect(trigger).toHaveAccessibleName('com_ui_background_tasks_incomplete');
    expect(screen.getByTestId('background-tasks-indicator')).toHaveClass('bg-status-warning');
    const user = userEvent.setup();
    await user.click(trigger);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_background_tasks_incomplete');
    await queryClient.invalidateQueries([QueryKeys.backgroundTasks, conversationId]);
    await waitFor(() => expect(screen.queryByTestId('header-background-tasks-button')).toBeNull());
    expect(getTasks).toHaveBeenCalledTimes(2);
  });

  it.each(['tool', 'subagent'])(
    'ages out the last finished %s even while the panel is closed',
    async (kind) => {
      jest.useFakeTimers();
      try {
        const settledAt = new Date(Date.now() - 3_599_000).toISOString();
        jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(
          index({
            tasks:
              kind === 'tool'
                ? [
                    {
                      ...index().tasks[1],
                      settledAt,
                    },
                  ]
                : [],
          }),
        );
        renderButton(
          kind === 'subagent'
            ? [
                {
                  ...runningChild,
                  status: 'completed',
                  updatedAt: settledAt,
                },
              ]
            : [],
        );
        await act(async () => {
          await jest.advanceTimersByTimeAsync(100);
        });
        expect(screen.getByTestId('header-background-tasks-button')).toBeInTheDocument();
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1_100);
        });
        expect(screen.queryByTestId('header-background-tasks-button')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('keeps an accepted cancellation pending through an observation failure, then reconciles failure', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    const cancel = jest
      .spyOn(dataService, 'controlSubagentTask')
      .mockImplementation(async (_parent, _thread, command) => ({
        receipt: {
          invocationId: command.invocationId,
          action: 'cancel',
          status: 'accepted',
          createdAt: startedAt,
          updatedAt: startedAt,
        },
      }));
    const { queryClient } = renderButton([runningChild]);
    jest
      .mocked(dataService.getSubagentThread)
      .mockRejectedValueOnce(new Error('receipt read unavailable'));
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('header-background-tasks-button'));
    await user.click(await screen.findByRole('button', { name: /com_ui_background_tasks_stop:/ }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'com_ui_background_tasks_load_failed',
    );
    expect(screen.queryByRole('button', { name: /com_ui_background_tasks_stop:/ })).toBeNull();
    const invocationId = cancel.mock.calls[0][2].invocationId;
    act(() => {
      queryClient.setQueryData(
        [
          QueryKeys.subagentThread,
          conversationId,
          runningChild.threadId,
          runningChild.latestTaskId,
        ],
        {
          controlReceipts: [{ invocationId, status: 'failed' }],
        },
      );
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('com_ui_background_tasks_stop_failed'),
    );
    expect(
      await screen.findByRole('button', { name: /com_ui_background_tasks_stop:/ }),
    ).toBeEnabled();
  });

  it('shows an initial load failure and lets the user retry', async () => {
    const getTasks = jest
      .spyOn(dataService, 'getBackgroundTasks')
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(index());
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('header-background-tasks-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'com_ui_background_tasks_load_failed',
    );
    await user.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Rerun the focused specs')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('fills in commands when restored messages arrive after the task index', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    const { queryClient } = renderButton([], []);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('header-background-tasks-button'));
    expect(screen.queryByText('Rerun the focused specs')).toBeNull();
    act(() => {
      queryClient.setQueryData([QueryKeys.messages, conversationId], messages);
    });
    expect(await screen.findByText('Rerun the focused specs')).toBeVisible();
  });

  it('does not carry stopping into a new task on the same child thread', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    jest.spyOn(dataService, 'controlSubagentTask').mockResolvedValue({
      receipt: {
        invocationId: 'cancel-a',
        action: 'cancel',
        status: 'accepted',
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    });
    const { queryClient } = renderButton([runningChild]);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('header-background-tasks-button'));
    await user.click(await screen.findByRole('button', { name: /com_ui_background_tasks_stop:/ }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /com_ui_background_tasks_stop:/ })).toBeNull(),
    );
    act(() => {
      queryClient.setQueryData([QueryKeys.parentSubagents, conversationId], {
        parentConversationId: conversationId,
        childrenTruncated: false,
        children: [
          {
            ...runningChild,
            latestTaskId: 'sub-task-2',
            tasks: [
              ...runningChild.tasks,
              { taskId: 'sub-task-2', status: 'running', createdAt: new Date().toISOString() },
            ],
          },
        ],
      });
    });
    expect(
      await screen.findByRole('button', { name: /com_ui_background_tasks_stop:/ }),
    ).toBeEnabled();
  });
  it('renders nothing when the conversation has no background tasks', async () => {
    const getTasks = jest
      .spyOn(dataService, 'getBackgroundTasks')
      .mockResolvedValue(index({ tasks: [] }));
    const { container } = renderButton();
    await waitFor(() => expect(getTasks).toHaveBeenCalledWith(conversationId));
    expect(container).toBeEmptyDOMElement();
  });

  it('groups running and finished tasks and reveals the command on demand', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    renderButton();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('header-background-tasks-button'));
    const dialog = await screen.findByRole('dialog', { name: 'com_ui_background_tasks' });
    const title = within(dialog).getByRole('button', { name: 'Rerun the focused specs' });
    expect(within(dialog).getAllByTestId('background-task-row')).toHaveLength(2);
    expect(within(dialog).queryByText('npx jest tasks.spec.ts')).toBeNull();

    await user.click(title);
    expect(title).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByText('npx jest tasks.spec.ts')).toBeInTheDocument();

    const finished = within(dialog).getByRole('button', {
      name: /com_ui_background_tasks_finished/,
    });
    await user.click(finished);
    expect(finished).toHaveAttribute('aria-expanded', 'false');
    expect(within(dialog).getAllByTestId('background-task-row')).toHaveLength(1);
  });

  it('stops every running tool and subagent from the running row, even when collapsed', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    const cancelTools = jest
      .spyOn(dataService, 'cancelBackgroundTasks')
      .mockResolvedValue({ results: [{ taskId: 'task-running', status: 'requested' }] });
    const cancelSubagent = jest.spyOn(dataService, 'controlSubagentTask').mockResolvedValue({
      receipt: {
        invocationId: 'invocation',
        action: 'cancel',
        status: 'accepted',
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    });
    renderButton([runningChild]);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('header-background-tasks-button'));
    const dialog = await screen.findByRole('dialog', { name: 'com_ui_background_tasks' });
    await waitFor(() =>
      expect(within(dialog).getAllByTestId('background-task-row')).toHaveLength(3),
    );
    await user.click(
      within(dialog).getByRole('button', { name: /com_ui_background_tasks_running/ }),
    );
    await user.click(within(dialog).getByTestId('background-tasks-stop-all'));

    await waitFor(() =>
      expect(cancelTools).toHaveBeenCalledWith(conversationId, { taskIds: ['task-running'] }),
    );
    expect(cancelSubagent).toHaveBeenCalledWith(
      conversationId,
      'thread-1',
      expect.objectContaining({ taskId: 'sub-task-1', action: 'cancel' }),
    );
  });

  it('keeps stop-all disabled when the server does not allow tool cancellation', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ cancellable: false }));
    const cancelTools = jest.spyOn(dataService, 'cancelBackgroundTasks');
    renderButton();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('header-background-tasks-button'));
    const stopAll = await screen.findByTestId('background-tasks-stop-all');
    expect(stopAll).toBeDisabled();
    expect(stopAll).toHaveAccessibleName('com_ui_background_tasks_cancel_disabled');
    const explanation = stopAll.parentElement!;
    expect(explanation).toHaveAttribute('tabindex', '0');
    expect(explanation).toHaveAttribute('aria-label', 'com_ui_background_tasks_cancel_disabled');
    act(() => explanation.focus());
    expect(explanation).toHaveFocus();
    expect(screen.queryByRole('button', { name: /com_ui_background_tasks_stop:/ })).toBeNull();
    expect(cancelTools).not.toHaveBeenCalled();
  });

  it('labels partial stop-all accurately when tool cancellation is disabled', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ cancellable: false }));
    const cancelTools = jest.spyOn(dataService, 'cancelBackgroundTasks');
    const cancelSubagent = jest.spyOn(dataService, 'controlSubagentTask').mockResolvedValue({
      receipt: {
        invocationId: 'invocation',
        action: 'cancel',
        status: 'accepted',
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    });
    renderButton([runningChild]);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('header-background-tasks-button'));
    const dialog = screen.getByRole('dialog', { name: 'com_ui_background_tasks' });
    await waitFor(() =>
      expect(within(dialog).getAllByTestId('background-task-row')).toHaveLength(3),
    );
    const stopAll = within(dialog).getByTestId('background-tasks-stop-all');
    expect(stopAll).toHaveAccessibleName('com_ui_background_tasks_stop_available');
    await user.click(stopAll);
    expect(cancelTools).not.toHaveBeenCalled();
    expect(cancelSubagent).toHaveBeenCalledTimes(1);
  });

  it('shows failed cancellation and restores the retry control for a running subagent', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    const cancelSubagent = jest
      .spyOn(dataService, 'controlSubagentTask')
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue({
        receipt: {
          invocationId: 'invocation',
          action: 'cancel',
          status: 'accepted',
          createdAt: startedAt,
          updatedAt: startedAt,
        },
      });
    renderButton([runningChild]);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('header-background-tasks-button'));
    const dialog = screen.getByRole('dialog', { name: 'com_ui_background_tasks' });
    const stop = await within(dialog).findByRole('button', {
      name: /com_ui_background_tasks_stop:/,
    });
    await user.click(stop);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'com_ui_background_tasks_stop_failed',
    );
    expect(
      within(dialog).getByRole('button', { name: /com_ui_background_tasks_stop:/ }),
    ).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: /com_ui_background_tasks_stop:/ }));
    await waitFor(() => expect(cancelSubagent).toHaveBeenCalledTimes(2));
  });

  it('re-enables stopping after the server rejects a cancellation receipt', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    jest.spyOn(dataService, 'controlSubagentTask').mockResolvedValue({
      receipt: {
        invocationId: 'invocation',
        action: 'cancel',
        status: 'rejected',
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    });
    renderButton([runningChild]);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('header-background-tasks-button'));
    const dialog = screen.getByRole('dialog', { name: 'com_ui_background_tasks' });
    await user.click(
      await within(dialog).findByRole('button', { name: /com_ui_background_tasks_stop:/ }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'com_ui_background_tasks_stop_failed',
    );
    expect(
      within(dialog).getByRole('button', { name: /com_ui_background_tasks_stop:/ }),
    ).toBeEnabled();
  });
});
