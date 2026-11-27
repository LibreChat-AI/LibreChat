import React from 'react';
import { RecoilRoot } from 'recoil';
import { useAtomValue, useSetAtom } from 'jotai';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { ContentTypes, QueryKeys, dataService } from 'librechat-data-provider';
import { activeSubagentPanel, ParentSubagentsProvider } from '@librechat/chat/react';
import type { ParentSubagentSummary, BackgroundTaskIndex, TMessage } from 'librechat-data-provider';
import type { JotaiStore } from 'test/harness';
import {
  sessionRailOpen,
  sessionRailSlot,
  sessionRailDocked,
  sessionRailSheetSlot,
  sessionRailAutoOpen,
  sessionRailDismissed,
  SESSION_RAIL_DISMISSED_LIMIT,
} from '../state';
import { AgentsMapContext } from '~/Providers/AgentsMapContext';
import { SubagentIndexHostProvider } from 'test/streamHost';
import { ChatSurfaceHarness } from 'test/harness';
import Session from '../Session';

const mockSheet = { current: false };

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

const mockTailPart = jest.fn<unknown, [string, boolean]>(() => null);
jest.mock('@librechat/chat/react', () => ({
  ...jest.requireActual('@librechat/chat/react'),
  /** The thread followers need the stream host; what they read is the chat package's to test. */
  useThreadTailPart: (threadId: string, live: boolean) => mockTailPart(threadId, live),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/hooks/useScaledMaxWidth', () => () => mockSheet.current);
jest.mock('~/components/Share/MessageIcon', () => ({
  __esModule: true,
  default: ({ agent }: { agent?: { name?: string } }) => (
    <span data-testid="agent-face">{agent?.name ?? ''}</span>
  ),
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
      messageId: 'message-1',
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
      delivery: 'pending',
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
  agentId: 'agent-1',
  title: 'Research the API',
  origin: 'tool',
  status: 'running',
  latestTaskId: 'sub-task-1',
  tasks: [{ taskId: 'sub-task-1', status: 'running', createdAt: startedAt }],
  tasksTruncated: false,
};

const failedChild: ParentSubagentSummary = {
  ...runningChild,
  threadId: 'thread-2',
  agentId: undefined,
  title: 'Draft the changelog',
  status: 'failed',
  updatedAt: new Date().toISOString(),
  latestTaskId: 'sub-task-2',
  tasks: [{ taskId: 'sub-task-2', status: 'failed', createdAt: startedAt }],
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

const agentsMap = { 'agent-1': { id: 'agent-1', name: 'Code Reviewer' } };

/**
 * The two places the layout gives the rail, without the layout: the column a docked rail is
 * drawn in, which exists only while one is showing, and the slot for the small-screen sheet.
 * The real layout sizes its column with the resize library, which reads pointer positions
 * jsdom does not have; `Layout.test.tsx` and the browser scenario cover that.
 */
function Slots() {
  const docked = useAtomValue(sessionRailDocked);
  const setSlot = useSetAtom(sessionRailSlot);
  const setSheetSlot = useSetAtom(sessionRailSheetSlot);
  return (
    <>
      {docked && <div ref={setSlot} data-testid="session-rail-slot" />}
      <div ref={setSheetSlot} data-testid="session-rail-sheet-slot" />
    </>
  );
}

const renderSession = ({
  children = [],
  remembered,
  id = conversationId,
  autoOpen = false,
  wanted,
  dismissed,
  thread = messages,
  files,
}: {
  /** Whether the conversation's files are listed; the control's default when left out. */
  files?: boolean;
  /** The loaded messages; the fixture's by default. */
  thread?: TMessage[];
  children?: ParentSubagentSummary[];
  /** The reader's stored choice for the docked rail. */
  remembered?: boolean;
  id?: string;
  /** Off unless a test is about the rail showing itself, so the others open it by hand. */
  autoOpen?: boolean;
  /** The reader's own setting for the rail showing itself. */
  wanted?: boolean;
  /** Conversations the reader has already closed the rail in. */
  dismissed?: string[];
} = {}) => {
  jest.spyOn(dataService, 'getSubagentThread').mockImplementation(() => new Promise(() => {}));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.messages, conversationId], thread);
  jest.spyOn(dataService, 'getParentSubagents').mockResolvedValue({
    parentConversationId: conversationId,
    children,
    childrenTruncated: false,
  });
  let atoms!: JotaiStore;
  const rendered = render(
    <ChatSurfaceHarness
      seed={(store) => {
        atoms = store;
        if (remembered != null) store.set(sessionRailOpen, remembered);
        if (wanted != null) store.set(sessionRailAutoOpen, wanted);
        if (dismissed != null) store.set(sessionRailDismissed, dismissed);
      }}
    >
      <RecoilRoot>
        <QueryClientProvider client={queryClient}>
          <AgentsMapContext.Provider value={agentsMap as never}>
            <SubagentIndexHostProvider>
              <ParentSubagentsProvider conversationId={id} enabled>
                <header>
                  <Session
                    conversationId={id}
                    isSubmitting={false}
                    autoOpen={autoOpen}
                    files={files}
                  />
                </header>
                <Slots />
              </ParentSubagentsProvider>
            </SubagentIndexHostProvider>
          </AgentsMapContext.Provider>
        </QueryClientProvider>
      </RecoilRoot>
    </ChatSurfaceHarness>,
  );
  return {
    ...rendered,
    queryClient,
    getSelection: () => atoms.get(activeSubagentPanel),
    isRemembered: () => atoms.get(sessionRailOpen),
    dismissedIn: () => atoms.get(sessionRailDismissed),
  };
};

const toggle = () => screen.getByTestId('header-background-tasks-button');
const openRail = async () => {
  await userEvent.click(toggle());
  return screen.findByTestId('session-rail');
};

beforeEach(() => {
  mockSheet.current = false;
  mockTailPart.mockReset();
  mockTailPart.mockReturnValue(null);
  localStorage.clear();
});
afterEach(() => jest.restoreAllMocks());

describe('Session', () => {
  it('is offered for a conversation with nothing running, and says so when opened', async () => {
    const getTasks = jest
      .spyOn(dataService, 'getBackgroundTasks')
      .mockResolvedValue(index({ tasks: [] }));
    renderSession();
    await waitFor(() => expect(getTasks).toHaveBeenCalledWith(conversationId));
    expect(toggle()).toHaveAccessibleName('com_ui_session');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('background-tasks-indicator')).toBeNull();
    expect(screen.queryByTestId('session-rail')).toBeNull();

    const rail = await openRail();
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(toggle()).toHaveAttribute('aria-controls', rail.id);
    expect(rail).toHaveAccessibleName('com_ui_session');
    expect(rail).toHaveTextContent('com_ui_session_empty');
    expect(within(rail).queryByTestId('session-stop-all')).toBeNull();
  });

  describe('files', () => {
    const thread: TMessage[] = [
      {
        messageId: 'user-1',
        conversationId,
        parentMessageId: null,
        isCreatedByUser: true,
        text: 'Compare these',
        files: [
          { file_id: 'shot', filename: 'screenshot.png', type: 'image/png', bytes: 2048 },
          {
            file_id: 'sheet',
            filename: 'figures.csv',
            llmDeliveryPath: 'none',
            metadata: { fileIdentifier: 'session/figures.csv' },
          },
        ],
      } as TMessage,
    ];
    const file = (name: string) =>
      screen.getAllByTestId('session-file').find((row) => row.textContent?.includes(name));
    const switchFor = (name: string) => within(file(name) as HTMLElement).getByRole('switch');

    beforeEach(() => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    });

    it('lists the conversation’s files, says what happens to each, and which are left out', async () => {
      const getFileExclusion = jest
        .spyOn(dataService, 'getFileExclusion')
        .mockResolvedValue({ excludedFiles: ['sheet'] });
      renderSession({ thread });
      const rail = await openRail();

      await waitFor(() => expect(getFileExclusion).toHaveBeenCalledWith(conversationId));
      expect(within(rail).getAllByTestId('session-file')).toHaveLength(2);
      expect(file('screenshot.png')).toHaveTextContent('com_ui_session_file_to_model');
      expect(switchFor('screenshot.png')).toBeChecked();
      await waitFor(() => expect(switchFor('figures.csv')).not.toBeChecked());
      expect(file('figures.csv')).toHaveTextContent('com_ui_session_file_left_out');
      expect(rail).toHaveTextContent('com_ui_session_files_left_out');
      expect(rail).not.toHaveTextContent('com_ui_session_empty');
      expect(switchFor('screenshot.png')).toHaveAccessibleName('com_ui_session_file_include');
    });

    it('names where a kept tool file goes', async () => {
      jest.spyOn(dataService, 'getFileExclusion').mockResolvedValue({ excludedFiles: [] });
      renderSession({ thread });
      await openRail();

      await waitFor(() =>
        expect(file('figures.csv')).toHaveTextContent('com_ui_session_file_code'),
      );
    });

    it('leaves a file out from its switch, at once, and takes the server’s list when it answers', async () => {
      jest.spyOn(dataService, 'getFileExclusion').mockResolvedValue({ excludedFiles: [] });
      let answer!: (value: { excludedFiles: string[] }) => void;
      const setFileExclusion = jest
        .spyOn(dataService, 'setFileExclusion')
        .mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      renderSession({ thread });
      await openRail();
      await waitFor(() => expect(switchFor('screenshot.png')).toBeChecked());

      await userEvent.click(switchFor('screenshot.png'));

      expect(setFileExclusion).toHaveBeenCalledWith(conversationId, {
        fileIds: ['shot'],
        excluded: true,
      });
      await waitFor(() => expect(switchFor('screenshot.png')).not.toBeChecked());
      await act(async () => answer({ excludedFiles: ['shot'] }));
      expect(switchFor('screenshot.png')).not.toBeChecked();
      expect(switchFor('figures.csv')).toBeChecked();
    });

    it('takes a file back in', async () => {
      jest.spyOn(dataService, 'getFileExclusion').mockResolvedValue({ excludedFiles: ['shot'] });
      const setFileExclusion = jest
        .spyOn(dataService, 'setFileExclusion')
        .mockResolvedValue({ excludedFiles: [] });
      renderSession({ thread });
      await openRail();
      await waitFor(() => expect(switchFor('screenshot.png')).not.toBeChecked());

      await userEvent.click(switchFor('screenshot.png'));

      expect(setFileExclusion).toHaveBeenCalledWith(conversationId, {
        fileIds: ['shot'],
        excluded: false,
      });
      await waitFor(() => expect(switchFor('screenshot.png')).toBeChecked());
    });

    it('puts the switch back and says so when the change is refused', async () => {
      jest.spyOn(dataService, 'getFileExclusion').mockResolvedValue({ excludedFiles: [] });
      jest.spyOn(dataService, 'setFileExclusion').mockRejectedValue(new Error('offline'));
      renderSession({ thread });
      const rail = await openRail();
      await waitFor(() => expect(switchFor('screenshot.png')).toBeChecked());

      await userEvent.click(switchFor('screenshot.png'));

      await waitFor(() =>
        expect(within(rail).getByRole('alert')).toHaveTextContent('com_ui_session_files_failed'),
      );
      expect(switchFor('screenshot.png')).toBeChecked();
    });

    it('says when too many files are already left out', async () => {
      jest.spyOn(dataService, 'getFileExclusion').mockResolvedValue({ excludedFiles: [] });
      jest.spyOn(dataService, 'setFileExclusion').mockRejectedValue({ response: { status: 409 } });
      renderSession({ thread });
      const rail = await openRail();
      await waitFor(() => expect(switchFor('screenshot.png')).toBeChecked());

      await userEvent.click(switchFor('screenshot.png'));

      await waitFor(() =>
        expect(within(rail).getByRole('alert')).toHaveTextContent('com_ui_session_files_full'),
      );
    });

    it('keeps the switches still until the stored list has been read', async () => {
      let answer!: (value: { excludedFiles: string[] }) => void;
      jest
        .spyOn(dataService, 'getFileExclusion')
        .mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const setFileExclusion = jest.spyOn(dataService, 'setFileExclusion');
      renderSession({ thread });
      await openRail();

      expect(switchFor('screenshot.png')).toBeDisabled();
      await userEvent.click(switchFor('screenshot.png'));
      expect(setFileExclusion).not.toHaveBeenCalled();

      await act(async () => answer({ excludedFiles: ['shot'] }));
      await waitFor(() => expect(switchFor('screenshot.png')).toBeEnabled());
      expect(switchFor('screenshot.png')).not.toBeChecked();
    });

    it('says so when the stored list cannot be read, and changes nothing until it can', async () => {
      const getFileExclusion = jest
        .spyOn(dataService, 'getFileExclusion')
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ excludedFiles: ['shot'] });
      const setFileExclusion = jest.spyOn(dataService, 'setFileExclusion');
      renderSession({ thread });
      const rail = await openRail();

      const alert = await within(rail).findByRole('alert');
      expect(alert).toHaveTextContent('com_ui_session_files_load_failed');
      expect(switchFor('screenshot.png')).toBeDisabled();
      expect(setFileExclusion).not.toHaveBeenCalled();

      await userEvent.click(within(alert).getByRole('button', { name: 'com_ui_retry' }));

      await waitFor(() => expect(switchFor('screenshot.png')).toBeEnabled());
      expect(getFileExclusion).toHaveBeenCalledTimes(2);
      expect(switchFor('screenshot.png')).not.toBeChecked();
      expect(within(rail).queryByRole('alert')).toBeNull();
    });

    it('does not let an earlier answer undo a later change, and reads the list once both land', async () => {
      const getFileExclusion = jest
        .spyOn(dataService, 'getFileExclusion')
        .mockResolvedValueOnce({ excludedFiles: [] })
        .mockResolvedValue({ excludedFiles: ['shot', 'sheet'] });
      const answers: Array<(value: { excludedFiles: string[] }) => void> = [];
      jest
        .spyOn(dataService, 'setFileExclusion')
        .mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
      renderSession({ thread });
      await openRail();
      await waitFor(() => expect(switchFor('screenshot.png')).toBeEnabled());

      await userEvent.click(switchFor('screenshot.png'));
      await userEvent.click(switchFor('figures.csv'));
      expect(answers).toHaveLength(2);

      /** The second change is answered first; the first answer still lists only its own file. */
      await act(async () => answers[1]({ excludedFiles: ['shot', 'sheet'] }));
      await act(async () => answers[0]({ excludedFiles: ['shot'] }));

      expect(switchFor('screenshot.png')).not.toBeChecked();
      expect(switchFor('figures.csv')).not.toBeChecked();
      await waitFor(() => expect(getFileExclusion).toHaveBeenCalledTimes(2));
      expect(switchFor('figures.csv')).not.toBeChecked();
    });

    it('undoes only the change that was refused', async () => {
      jest.spyOn(dataService, 'getFileExclusion').mockResolvedValue({ excludedFiles: [] });
      const settle: Array<{
        resolve: (value: { excludedFiles: string[] }) => void;
        reject: (reason: unknown) => void;
      }> = [];
      jest
        .spyOn(dataService, 'setFileExclusion')
        .mockImplementation(
          () => new Promise((resolve, reject) => settle.push({ resolve, reject })),
        );
      renderSession({ thread });
      await openRail();
      await waitFor(() => expect(switchFor('screenshot.png')).toBeEnabled());

      await userEvent.click(switchFor('screenshot.png'));
      await userEvent.click(switchFor('figures.csv'));
      await act(async () => settle[0].reject(new Error('offline')));

      await waitFor(() => expect(switchFor('screenshot.png')).toBeChecked());
      expect(switchFor('figures.csv')).not.toBeChecked();
    });

    it('names a file that a message only points at by what it is', async () => {
      jest.spyOn(dataService, 'getFileExclusion').mockResolvedValue({ excludedFiles: [] });
      renderSession({
        thread: [
          {
            messageId: 'assistant-1',
            conversationId,
            parentMessageId: null,
            isCreatedByUser: false,
            text: '',
            content: [{ type: 'image_file', image_file: { file_id: 'generated' } }],
          } as unknown as TMessage,
        ],
      });
      const rail = await openRail();

      const row = within(rail).getByTestId('session-file');
      expect(row).toHaveTextContent('com_ui_session_file_unnamed_image');
      expect(row).toHaveTextContent('com_ui_session_file_made');
    });

    it('lists no files, and asks about none, where leaving one out would change nothing', async () => {
      const getFileExclusion = jest
        .spyOn(dataService, 'getFileExclusion')
        .mockResolvedValue({ excludedFiles: [] });
      renderSession({ thread, files: false });
      const rail = await openRail();

      expect(within(rail).queryByTestId('session-file')).toBeNull();
      expect(rail).toHaveTextContent('com_ui_session_empty');
      expect(getFileExclusion).not.toHaveBeenCalled();
    });

    it('asks nothing about files while the rail is closed, or for a thread that has none', async () => {
      const getFileExclusion = jest
        .spyOn(dataService, 'getFileExclusion')
        .mockResolvedValue({ excludedFiles: [] });
      const closed = renderSession({ thread });
      await waitFor(() => expect(toggle()).toHaveAccessibleName('com_ui_session'));
      expect(getFileExclusion).not.toHaveBeenCalled();
      closed.unmount();

      renderSession();
      const rail = await openRail();
      expect(within(rail).queryByTestId('session-file')).toBeNull();
      expect(getFileExclusion).not.toHaveBeenCalled();
    });
  });

  it('draws the rail in the layout column, not in the header', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    renderSession();
    const rail = await openRail();
    expect(screen.getByTestId('session-rail-slot')).toContainElement(rail);
    expect(screen.getByRole('banner')).not.toContainElement(rail);
    expect(rail.tagName).toBe('ASIDE');
  });

  it('counts running work on the control whether the rail is open or not', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    renderSession({ children: [runningChild] });
    await waitFor(() =>
      expect(toggle()).toHaveAccessibleName(
        'com_ui_session_label_running; com_ui_session_label_pending',
      ),
    );
    expect(screen.getByTestId('background-tasks-indicator')).toHaveClass(
      'bg-status-info',
      'animate-pulse',
    );
    expect(screen.queryByTestId('session-rail')).toBeNull();
  });

  it('lists subagents and background tools as separate sections', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    renderSession({ children: [runningChild, failedChild] });
    const rail = await openRail();
    await waitFor(() => expect(within(rail).getAllByTestId('session-row')).toHaveLength(4));

    const subagents = within(rail)
      .getByRole('button', { name: /^com_ui_agent_subagents\s*\d/ })
      .closest('section') as HTMLElement;
    const tools = within(rail)
      .getByRole('button', { name: /^com_ui_background_tasks\s*\d/ })
      .closest('section') as HTMLElement;
    const subagentRows = within(subagents).getAllByTestId('session-row');
    const toolRows = within(tools).getAllByTestId('session-row');
    expect(subagentRows.map((row) => row.dataset.kind)).toEqual(['subagent', 'subagent']);
    expect(toolRows.map((row) => row.dataset.kind)).toEqual(['tool', 'tool']);

    /** Running work leads each section and carries the live mark; a named agent is named. */
    expect(subagentRows[0]).toHaveTextContent('Research the API');
    expect(subagentRows[0]).toHaveTextContent('Code Reviewer');
    expect(within(subagentRows[0]).getByTestId('agent-face')).toHaveTextContent('Code Reviewer');
    expect(within(subagentRows[0]).getByTestId('session-row-live')).toBeInTheDocument();
    expect(subagentRows[1]).toHaveTextContent('Draft the changelog');
    expect(subagentRows[1]).toHaveTextContent('researcher');
    expect(subagentRows[1]).toHaveTextContent('com_ui_failed');
    expect(within(subagentRows[1]).queryByTestId('session-row-live')).toBeNull();
    expect(subagents).toHaveTextContent('com_ui_subagent_count_running_one');

    expect(toolRows[0]).toHaveTextContent('Rerun the focused specs');
    expect(toolRows[1]).toHaveTextContent('com_ui_background_tasks_completed');
    expect(within(toolRows[1]).getByTestId('background-task-delivery')).toHaveTextContent(
      'com_ui_background_tasks_result_pending',
    );
  });

  it('says what a running subagent is doing now, and nothing for one that has finished', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    mockTailPart.mockReturnValue({
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'call-read',
        name: 'bash_tool',
        args: '{"intent":"Read the auth service","command":"cat AuthService.js"}',
      },
    });
    renderSession({ children: [runningChild, failedChild] });
    const rail = await openRail();
    await waitFor(() => expect(within(rail).getAllByTestId('session-row')).toHaveLength(2));
    const [running, failed] = within(rail).getAllByTestId('session-row');
    expect(within(running).getByTestId('session-row-now')).toHaveTextContent(
      'Read the auth service',
    );
    expect(mockTailPart).toHaveBeenCalledWith('thread-1', true);
    expect(within(failed).queryByTestId('session-row-now')).toBeNull();
    expect(mockTailPart).not.toHaveBeenCalledWith('thread-2', expect.anything());
  });

  it('draws no line for a running subagent the page is not following', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    renderSession({ children: [runningChild] });
    const rail = await openRail();
    await within(rail).findByTestId('session-row');
    expect(within(rail).queryByTestId('session-row-now')).toBeNull();
  });

  it('opens a subagent from its row and marks the row while its thread is open', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    const { getSelection } = renderSession({ children: [runningChild] });
    const rail = await openRail();
    const open = await within(rail).findByRole('button', {
      name: 'com_ui_background_tasks_open_subagent: Research the API',
    });
    expect(open).not.toHaveAttribute('aria-current');
    await userEvent.click(open);
    expect(getSelection()).toMatchObject({
      durable: { threadId: 'thread-1', taskId: 'sub-task-1' },
    });
    await waitFor(() => expect(open).toHaveAttribute('aria-current', 'true'));
    /** Docked, the rail stays beside the thread it opened. */
    expect(screen.getByTestId('session-rail')).toBeInTheDocument();
  });

  it('unfolds what a tool ran and goes to its call in the conversation', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    renderSession();
    const target = document.createElement('button');
    target.id = 'message-1';
    target.dataset.toolCallId = 'call-running';
    target.scrollIntoView = jest.fn();
    document.body.append(target);
    try {
      const rail = await openRail();
      const row = (await within(rail).findAllByTestId('session-row'))[0];
      expect(row).not.toHaveTextContent('npx jest tasks.spec.ts');
      await userEvent.click(
        await within(row).findByRole('button', { name: /^Rerun the focused specs/ }),
      );
      expect(row).toHaveTextContent('npx jest tasks.spec.ts');
      await userEvent.click(
        within(row).getByRole('button', { name: /^com_ui_background_tasks_go_to_tool:/ }),
      );
      expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
      expect(target).toHaveFocus();
      expect(screen.getByTestId('session-rail')).toBeInTheDocument();
    } finally {
      target.remove();
    }
  });

  it('says when a tool call is not in the loaded messages', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    renderSession();
    const rail = await openRail();
    const row = (await within(rail).findAllByTestId('session-row'))[0];
    await userEvent.click(
      within(row).getByRole('button', { name: /^com_ui_background_tasks_go_to_tool:/ }),
    );
    expect(within(row).getByRole('status')).toHaveTextContent(
      'com_ui_background_tasks_tool_unavailable',
    );
  });

  it('stops one task from its row and every running task from the header', async () => {
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
    renderSession({ children: [runningChild] });
    const rail = await openRail();
    await waitFor(() => expect(within(rail).getAllByTestId('session-row')).toHaveLength(3));

    await userEvent.click(
      within(rail).getByRole('button', {
        name: 'com_ui_background_tasks_stop: Rerun the focused specs',
      }),
    );
    await waitFor(() =>
      expect(cancelTools).toHaveBeenCalledWith(conversationId, { taskIds: ['task-running'] }),
    );
    expect(cancelSubagent).not.toHaveBeenCalled();

    await waitFor(() => expect(within(rail).getByTestId('session-stop-all')).toBeEnabled());
    await userEvent.click(within(rail).getByTestId('session-stop-all'));
    await waitFor(() =>
      expect(cancelSubagent).toHaveBeenCalledWith(
        conversationId,
        'thread-1',
        expect.objectContaining({ taskId: 'sub-task-1', action: 'cancel' }),
      ),
    );
  });

  it('keeps stop-all disabled and explained when the server does not let tools be stopped', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ cancellable: false }));
    renderSession();
    const rail = await openRail();
    const stopAll = await within(rail).findByTestId('session-stop-all');
    expect(stopAll).toBeDisabled();
    expect(stopAll).toHaveAccessibleName('com_ui_background_tasks_cancel_disabled');
    expect(
      within(rail).queryByRole('button', { name: /^com_ui_background_tasks_stop:/ }),
    ).toBeNull();
  });

  it('shows a load failure in the rail and lets the reader retry', async () => {
    const getTasks = jest
      .spyOn(dataService, 'getBackgroundTasks')
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue(index());
    renderSession();
    const rail = await openRail();
    const alert = await within(rail).findByRole('alert');
    expect(alert).toHaveTextContent('com_ui_background_tasks_load_failed');
    expect(rail).not.toHaveTextContent('com_ui_session_empty');
    await userEvent.click(within(alert).getByRole('button', { name: 'com_ui_retry' }));
    await waitFor(() => expect(within(rail).getAllByTestId('session-row')).toHaveLength(2));
    expect(within(rail).queryByRole('alert')).toBeNull();
    expect(getTasks).toHaveBeenCalledTimes(2);
  });

  it('warns that results may be missing while the task store is incomplete', async () => {
    jest
      .spyOn(dataService, 'getBackgroundTasks')
      .mockResolvedValue(index({ tasks: [], complete: false }));
    renderSession();
    await waitFor(() =>
      expect(toggle()).toHaveAccessibleName('com_ui_background_tasks_incomplete'),
    );
    expect(screen.getByTestId('background-tasks-indicator')).toHaveClass('bg-status-warning');
    const rail = await openRail();
    expect(within(rail).getByRole('status')).toHaveTextContent(
      'com_ui_background_tasks_incomplete',
    );
    expect(rail).not.toHaveTextContent('com_ui_session_empty');
  });

  it('closes from its own button, hands focus back, and remembers the choice', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    const { isRemembered } = renderSession();
    const rail = await openRail();
    expect(isRemembered()).toBe(true);
    await userEvent.click(within(rail).getByRole('button', { name: 'com_ui_session_close' }));
    expect(screen.queryByTestId('session-rail')).toBeNull();
    expect(toggle()).toHaveFocus();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(isRemembered()).toBe(false);
  });

  it('reopens docked from the remembered choice', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
    renderSession({ remembered: true });
    const rail = await screen.findByTestId('session-rail');
    await waitFor(() => expect(within(rail).getAllByTestId('session-row')).toHaveLength(2));
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('leaves the docked rail out of the tab trap', async () => {
    jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
    renderSession();
    const rail = await openRail();
    expect(rail).not.toHaveAttribute('aria-modal');
    expect(toggle()).toHaveFocus();
    await userEvent.tab();
    expect(within(rail).getByRole('button', { name: 'com_ui_session_close' })).toHaveFocus();
    await userEvent.tab();
    expect(rail).not.toContainElement(document.activeElement as HTMLElement);
  });

  describe('showing itself when work starts', () => {
    it('opens for running work without being asked, and without that becoming the remembered choice', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      const { isRemembered } = renderSession({ autoOpen: true });
      const rail = await screen.findByTestId('session-rail');
      await waitFor(() => expect(within(rail).getAllByTestId('session-row')).toHaveLength(2));
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      /** Focus stays where the reader had it. */
      expect(rail).not.toContainElement(document.activeElement as HTMLElement);
      expect(isRemembered()).toBe(false);
    });

    it('stays closed for a conversation that only has finished work to list', async () => {
      jest
        .spyOn(dataService, 'getBackgroundTasks')
        .mockResolvedValue(index({ tasks: [index().tasks[1]] }));
      renderSession({ autoOpen: true });
      await waitFor(() => expect(toggle()).toHaveAccessibleName('com_ui_session_label_pending'));
      expect(screen.queryByTestId('session-rail')).toBeNull();
    });

    it('takes closing as an answer for the conversation, whatever starts next', async () => {
      const running = index();
      const getTasks = jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(running);
      const { queryClient, isRemembered } = renderSession({ autoOpen: true });
      const rail = await screen.findByTestId('session-rail');
      await userEvent.click(within(rail).getByRole('button', { name: 'com_ui_session_close' }));
      expect(screen.queryByTestId('session-rail')).toBeNull();
      expect(isRemembered()).toBe(false);

      /** Everything finishes, then something new starts running. */
      getTasks.mockResolvedValue(index({ tasks: [running.tasks[1]] }));
      await queryClient.refetchQueries([QueryKeys.backgroundTasks, conversationId]);
      await waitFor(() => expect(toggle()).toHaveAccessibleName('com_ui_session_label_pending'));
      getTasks.mockResolvedValue(
        index({ tasks: [{ ...running.tasks[0], taskId: 'task-later', toolCallId: 'call-later' }] }),
      );
      await queryClient.refetchQueries([QueryKeys.backgroundTasks, conversationId]);
      await waitFor(() => expect(toggle()).toHaveAccessibleName('com_ui_session_label_running'));
      expect(screen.queryByTestId('session-rail')).toBeNull();
    });

    it('remembers that answer when the reader leaves the conversation and comes back', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      const first = renderSession({ autoOpen: true });
      const rail = await screen.findByTestId('session-rail');
      await userEvent.click(within(rail).getByRole('button', { name: 'com_ui_session_close' }));
      expect(first.dismissedIn()).toEqual([conversationId]);
      first.unmount();

      /** A fresh visit: nothing of the first is left but what was stored. */
      const second = renderSession({ autoOpen: true });
      await waitFor(() =>
        expect(toggle()).toHaveAccessibleName(
          'com_ui_session_label_running; com_ui_session_label_pending',
        ),
      );
      expect(screen.queryByTestId('session-rail')).toBeNull();
      second.unmount();

      /** It was an answer for that conversation, not for every one. */
      renderSession({ autoOpen: true, id: 'convo-2' });
      expect(await screen.findByTestId('session-rail')).toBeInTheDocument();
    });

    it('takes the answer back when the reader opens the rail by hand', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      const { dismissedIn } = renderSession({
        autoOpen: true,
        dismissed: ['convo-0', conversationId],
      });
      await waitFor(() => expect(toggle()).not.toHaveAccessibleName('com_ui_session'));
      expect(screen.queryByTestId('session-rail')).toBeNull();
      await userEvent.click(toggle());
      expect(await screen.findByTestId('session-rail')).toBeInTheDocument();
      expect(dismissedIn()).toEqual(['convo-0']);
    });

    it('keeps a bounded memory of where it was closed, dropping the oldest', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      const earlier = Array.from(
        { length: SESSION_RAIL_DISMISSED_LIMIT },
        (_, position) => `earlier-${position}`,
      );
      const { dismissedIn } = renderSession({ autoOpen: true, dismissed: earlier });
      const rail = await screen.findByTestId('session-rail');
      await userEvent.click(within(rail).getByRole('button', { name: 'com_ui_session_close' }));
      expect(dismissedIn()).toHaveLength(SESSION_RAIL_DISMISSED_LIMIT);
      expect(dismissedIn()[0]).toBe('earlier-1');
      expect(dismissedIn()[SESSION_RAIL_DISMISSED_LIMIT - 1]).toBe(conversationId);
    });

    it('stays out of the way of a reader who turned this off in their settings', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      renderSession({ autoOpen: true, wanted: false });
      await waitFor(() => expect(toggle()).not.toHaveAccessibleName('com_ui_session'));
      expect(screen.queryByTestId('session-rail')).toBeNull();
      /** The control still opens it. */
      await userEvent.click(toggle());
      expect(await screen.findByTestId('session-rail')).toBeInTheDocument();
    });

    it('does not cover the conversation on a small screen', async () => {
      mockSheet.current = true;
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      renderSession({ autoOpen: true });
      await waitFor(() => expect(toggle()).not.toHaveAccessibleName('com_ui_session'));
      expect(screen.queryByTestId('session-rail')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('leaves the rail to the control when the deployment turns this off', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      renderSession({ autoOpen: false });
      await waitFor(() => expect(toggle()).not.toHaveAccessibleName('com_ui_session'));
      expect(screen.queryByTestId('session-rail')).toBeNull();
    });
  });

  describe('on a small screen', () => {
    beforeEach(() => {
      mockSheet.current = true;
    });

    it('does not cover the conversation from a remembered choice', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      const { isRemembered } = renderSession({ remembered: true });
      await waitFor(() => expect(toggle()).not.toHaveAccessibleName('com_ui_session'));
      expect(screen.queryByTestId('session-rail')).toBeNull();
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(isRemembered()).toBe(true);
    });

    it('opens as a sheet that takes focus and closes on Escape', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      const { isRemembered } = renderSession();
      await userEvent.click(toggle());
      const sheet = await screen.findByRole('dialog', { name: 'com_ui_session' });
      expect(sheet).toHaveClass('fixed', 'inset-0');
      expect(within(sheet).getByRole('button', { name: 'com_ui_session_close' })).toHaveFocus();
      /** A sheet is a visit, not a layout choice: it is not what the docked rail remembers. */
      expect(isRemembered()).toBe(false);
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(toggle()).toHaveFocus();
    });

    it('keeps keyboard focus inside the sheet, which covers everything else', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
      renderSession();
      await userEvent.click(toggle());
      const sheet = await screen.findByRole('dialog', { name: 'com_ui_session' });
      expect(sheet).toHaveAttribute('aria-modal', 'true');
      const close = within(sheet).getByRole('button', { name: 'com_ui_session_close' });
      expect(close).toHaveFocus();

      /** The control behind the sheet is the next tab stop in the page, and is not reached. */
      await userEvent.tab();
      expect(sheet).toContainElement(document.activeElement as HTMLElement);
      await userEvent.tab({ shift: true });
      expect(sheet).toContainElement(document.activeElement as HTMLElement);

      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(toggle()).toHaveFocus();
    });

    it('starts on the close button, not on the control that stops everything', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index());
      renderSession();
      await waitFor(() => expect(toggle()).not.toHaveAccessibleName('com_ui_session'));
      await userEvent.click(toggle());
      const sheet = await screen.findByRole('dialog', { name: 'com_ui_session' });
      expect(within(sheet).getByTestId('session-stop-all')).toBeInTheDocument();
      expect(within(sheet).getByRole('button', { name: 'com_ui_session_close' })).toHaveFocus();
    });

    it('gets out of the way of the thread it opens', async () => {
      jest.spyOn(dataService, 'getBackgroundTasks').mockResolvedValue(index({ tasks: [] }));
      const { getSelection } = renderSession({ children: [runningChild] });
      await userEvent.click(toggle());
      const sheet = await screen.findByRole('dialog', { name: 'com_ui_session' });
      await userEvent.click(
        await within(sheet).findByRole('button', {
          name: 'com_ui_background_tasks_open_subagent: Research the API',
        }),
      );
      expect(getSelection()).toMatchObject({ durable: { threadId: 'thread-1' } });
      expect(screen.queryByRole('dialog', { name: 'com_ui_session' })).toBeNull();
    });
  });
});
