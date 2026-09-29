import React from 'react';
import { RecoilRoot } from 'recoil';
import { useAtomValue } from 'jotai';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ParentSubagentSummary } from 'librechat-data-provider';
import { activeSubagentPanel } from '~/components/Chat/Subagents/state';
import { ChatSurfaceHarness } from 'test/harness';
import Wakeup from '../Wakeup';

/** The hooks barrel drags the full data-provider graph into jsdom, so only
 *  localization is faked; the collapse hooks the card depends on stay real. */
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, vars?: Record<string, string>) =>
    vars == null ? key : `${key}:${Object.values(vars).join(',')}`,
  useExpandCollapse: jest.requireActual('~/hooks/Messages/useExpandCollapse').default,
  useLazyCollapseBody: jest.requireActual('~/hooks/Messages/useLazyCollapseBody').default,
}));

jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
  useMCPServerNames: () => [],
}));

jest.mock('../ToolOutput', () => ({
  StackedToolIcons: () => <div data-testid="stacked-tool-icons" />,
  ToolIcon: ({ type }: { type: string }) => <span data-testid="tool-icon">{type}</span>,
  getToolIconType: (name: string) => name,
  getMCPServerName: () => '',
  OutputRenderer: ({ text, copyText }: { text: string; copyText?: string }) => (
    <pre data-testid="task-output" data-copy-text={copyText}>
      {text}
    </pre>
  ),
}));

jest.mock('../MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

jest.mock('lucide-react', () => ({
  AlertCircle: () => null,
  CheckCircle2: () => null,
  ChevronDown: () => null,
  Clock3: () => null,
  Users: () => null,
  XCircle: () => null,
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  useMediaQuery: () => false,
}));

const child: ParentSubagentSummary = {
  threadId: 'thread-1',
  parentMessageId: 'parent-message',
  parentToolCallId: 'tool-call-1',
  subagentType: 'self',
  subagentKind: 'agent',
  origin: 'tool',
  status: 'completed',
  latestTaskId: 'task-1',
  tasks: [{ taskId: 'task-1', status: 'completed', createdAt: '2026-08-30T00:00:00.000Z' }],
  tasksTruncated: false,
  title: 'Subagent: self',
} as ParentSubagentSummary;

jest.mock('~/components/Chat/Subagents/ParentSubagentsProvider', () => ({
  useParentSubagents: () => ({
    byThreadId: new Map([['thread-1', child]]),
    byMessageId: new Map(),
    refresh: async () => undefined,
  }),
}));

function SelectionProbe() {
  const selection = useAtomValue(activeSubagentPanel);
  return <div data-testid="selection">{selection == null ? '' : selection.durable?.taskId}</div>;
}

const subagentDisplay = {
  kind: 'subagent' as const,
  tasks: [
    {
      taskId: 'task-1',
      status: 'completed' as const,
      result: '## Briefing\nAll clear.',
      threadId: 'thread-1',
      subagentType: 'self',
    },
  ],
};

describe('Wakeup', () => {
  it('renders a collapsible subagent completion card with the result and panel affordance', () => {
    render(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Wakeup display={subagentDisplay} conversationId="conversation-1" />
          <SelectionProbe />
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    const header = screen.getByRole('button', { name: 'com_ui_wakeup_subagent_completed' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');

    expect(screen.getByTestId('markdown')).toHaveTextContent('Briefing');
    expect(screen.getByText('com_ui_wakeup_explainer')).toBeInTheDocument();
    expect(screen.getByText('com_ui_subagent_thread_status_completed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_wakeup_view_activity' }));
    expect(screen.getByTestId('selection')).toHaveTextContent('task-1');
  });

  it('keeps the panel affordance for a thread omitted from the bounded index', () => {
    render(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Wakeup
            display={{
              kind: 'subagent',
              tasks: [
                {
                  taskId: 'task-9',
                  status: 'completed',
                  result: 'ok',
                  threadId: 'thread-9',
                  subagentType: 'self',
                },
              ],
            }}
            conversationId="conversation-1"
          />
          <SelectionProbe />
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_wakeup_subagent_completed' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_wakeup_view_activity' }));
    expect(screen.getByTestId('selection')).toHaveTextContent('task-9');
  });

  it('renders a failed background tool batch with per-task statuses and no panel affordance', () => {
    render(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Wakeup
            display={{
              kind: 'background_tool',
              tasks: [
                {
                  taskId: 'bg-1',
                  status: 'completed',
                  result: 'ok',
                  toolCallId: 'call-1',
                  toolName: 'web_search',
                },
                {
                  taskId: 'bg-2',
                  status: 'error',
                  result: 'boom',
                  toolCallId: 'call-2',
                  toolName: 'execute_code',
                },
              ],
            }}
            conversationId="conversation-1"
          />
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    const header = screen.getByRole('button', { name: 'com_ui_wakeup_tasks_finished:2' });
    fireEvent.click(header);
    expect(screen.getByTestId('stacked-tool-icons')).toBeInTheDocument();
    expect(screen.getByText('com_ui_background_tasks_completed')).toBeInTheDocument();
    expect(screen.getByText('com_ui_failed')).toBeInTheDocument();
    expect(screen.getAllByTestId('background-task-card')).toHaveLength(2);
    expect(screen.getByText('com_ui_error')).toHaveClass('text-status-error');
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_wakeup_view_activity' }),
    ).not.toBeInTheDocument();
  });

  it('shows a cancelled background result as a warning with its task details', () => {
    render(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Wakeup
            display={{
              kind: 'background_tool',
              tasks: [
                {
                  taskId: 'bg-cancelled',
                  status: 'cancelled',
                  result: 'The task was stopped.',
                  toolCallId: 'call-cancelled',
                  toolName: 'bash_tool',
                },
              ],
            }}
          />
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );
    const header = screen.getByRole('button', { name: 'com_ui_wakeup_task_cancelled' });
    expect(header.querySelector('[role="status"]')).toHaveClass('text-text-warning');
    fireEvent.click(header);
    expect(screen.getByTestId('background-task-card')).toHaveTextContent('com_ui_cancelled');
    expect(screen.getByTestId('task-output')).toHaveTextContent('The task was stopped.');
  });

  it('shows the originating MCP tool and its server separately', () => {
    render(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Wakeup
            display={{
              kind: 'background_tool',
              tasks: [
                {
                  taskId: 'bg-mcp',
                  status: 'completed',
                  result: 'Found 3 documents.',
                  toolCallId: 'call-mcp',
                  toolName: 'search_repository_mcp_Docs',
                },
              ],
            }}
          />
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_wakeup_task_finished' }));
    const card = screen.getByTestId('background-task-card');
    expect(within(card).getByText('search_repository')).toBeInTheDocument();
    expect(within(card).getByText('Docs')).toBeInTheDocument();
    expect(within(card).getByTestId('task-output')).toHaveTextContent('Found 3 documents.');
  });

  it('renders the code completion as tool output rather than prose or host-internal JSON', () => {
    const output = 'stdout:\nchecked at=2026-09-27T00:11:09Z\n{"checks":[]}\n[exit code: 0]';
    render(
      <ChatSurfaceHarness>
        <RecoilRoot>
          <Wakeup
            display={{
              kind: 'background_tool',
              tasks: [
                {
                  taskId: 'bg-1',
                  status: 'completed',
                  result: output,
                  toolCallId: 'call-1',
                  toolName: 'bash_tool',
                },
              ],
            }}
          />
        </RecoilRoot>
      </ChatSurfaceHarness>,
    );

    const header = screen.getByRole('button', { name: 'com_ui_wakeup_task_finished' });
    expect(header.parentElement).not.toHaveClass('w-[36rem]');
    fireEvent.click(header);
    expect(header.parentElement).toHaveClass('w-[36rem]');

    const card = screen.getByTestId('background-task-card');
    expect(card).toHaveTextContent('com_ui_tool_name_code');
    expect(card).toHaveTextContent('com_ui_background_tasks_completed');
    expect(screen.getByTestId('tool-icon')).toHaveTextContent('bash_tool');
    expect(screen.getByText('com_ui_output')).toBeInTheDocument();
    expect(screen.getByTestId('task-output')).toHaveTextContent('"checks": []');
    expect(screen.getByTestId('task-output').textContent).toContain('{\n  "checks": []\n}');
    expect(screen.getByTestId('task-output')).toHaveAttribute('data-copy-text', output);
    expect(screen.queryByText('com_ui_wakeup_explainer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();
  });
});
