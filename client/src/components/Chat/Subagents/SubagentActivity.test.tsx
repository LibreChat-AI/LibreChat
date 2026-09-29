import React from 'react';
import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import type { ChildActivity } from './adapters';
import SubagentActivity, { SubagentActivityScrollSurface } from './SubagentActivity';
import { ChatSurfaceHarness } from 'test/harness';

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <ChatSurfaceHarness>{children}</ChatSurfaceHarness>
);
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: Wrapper });

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Chat/Messages/Content/Parts/Text', () => ({
  __esModule: true,
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

jest.mock('~/components/Chat/Messages/Content/Parts', () => ({
  EmptyText: () => <div data-testid="thinking-cursor" />,
}));

jest.mock('~/components/Chat/Messages/Content/ContentParts', () => ({
  __esModule: true,
  default: function MockContentParts({
    content,
    messageId,
  }: {
    content: Array<{
      type: string;
      text?: string;
      phase?: string;
      think?: string;
      reasoning_label?: string;
      activity_label?: string;
      tool_call?: {
        id: string;
        name: string;
        args?: unknown;
        output?: string;
        inputValidationError?: true;
        approval?: unknown;
        runStepStatus?: string;
      };
    }>;
    messageId: string;
  }) {
    const { useState } = jest.requireActual<typeof import('react')>('react');
    const [expandedTool, setExpandedTool] = useState<string | null>(null);
    const tools = content.filter((part) => part.type === 'tool_call');
    return (
      <div data-testid="regular-content-parts" data-message-id={messageId}>
        {content.map((part, index) => {
          if (part.type === 'text') {
            return (
              <div key={index} data-phase={part.phase}>
                {part.text}
              </div>
            );
          }
          if (part.type === 'think') {
            if ((part as { reasoning_unavailable?: boolean }).reasoning_unavailable === true) {
              return <div key={index}>{`reasoning-marker:${part.reasoning_label ?? ''}`}</div>;
            }
            return <div key={index}>{part.reasoning_label ?? part.think}</div>;
          }
          if (part.type === 'activity_label') {
            return <div key={index}>{part.activity_label}</div>;
          }
          if (part.type !== 'tool_call' || part.tool_call == null) return null;
          const tool = part.tool_call;
          return (
            <div key={tool.id}>
              <button
                type="button"
                aria-expanded={expandedTool === tool.id}
                data-run-step-status={tool.runStepStatus}
                data-input-validation-error={tool.inputValidationError}
                onClick={() => setExpandedTool(expandedTool === tool.id ? null : tool.id)}
              >
                {tool.name}
              </button>
              {expandedTool === tool.id && (
                <div>
                  {JSON.stringify(tool.args)} {tool.output}
                </div>
              )}
              {tool.approval != null && <div data-testid="tool-approval" />}
            </div>
          );
        })}
        {/* eslint-disable-next-line i18next/no-literal-string */}
        {tools.length > 1 && <div>Used {tools.length} tools</div>}
      </div>
    );
  },
}));

jest.mock('~/components/Chat/Messages/Content/Parts/Reasoning', () => ({
  __esModule: true,
  default: ({ reasoning }: { reasoning: string }) => <div>{reasoning}</div>,
}));

jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

jest.mock('~/components/Chat/Messages/Content/Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('~/components/Chat/Messages/Content/ToolCall', () => ({
  __esModule: true,
  default: function MockToolCall({
    name,
    args,
    output,
    runStepStatus,
  }: {
    name: string;
    args: unknown;
    output: string;
    runStepStatus?: string;
  }) {
    const { useState } = jest.requireActual<typeof import('react')>('react');
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button
          type="button"
          aria-expanded={open}
          data-run-step-status={runStepStatus}
          onClick={() => setOpen((value) => !value)}
        >
          {name}
        </button>
        {open && (
          <div>
            {JSON.stringify(args)} {output}
          </div>
        )}
      </div>
    );
  },
}));

jest.mock('~/components/Chat/Messages/Content/ToolCallGroup', () => ({
  __esModule: true,
  default: ({
    parts,
    renderPart,
    lastContentIdx,
  }: {
    parts: Array<{ part: unknown; idx: number }>;
    renderPart: (part: unknown, idx: number, isLast: boolean) => React.ReactNode;
    lastContentIdx: number;
  }) => (
    <div>
      {/* eslint-disable-next-line i18next/no-literal-string */}
      <div>Used {parts.length} tools</div>
      {parts.map(({ part, idx }) => renderPart(part, idx, idx === lastContentIdx))}
    </div>
  ),
}));

jest.mock('~/components/Chat/Messages/Content/ToolApproval', () => ({
  __esModule: true,
  // eslint-disable-next-line i18next/no-literal-string
  default: () => <div data-testid="tool-approval">approval</div>,
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('lucide-react', () => ({
  AlertCircle: () => null,
  CheckCircle2: () => null,
  ChevronDown: () => null,
  Clock3: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
  XCircle: () => null,
}));

const base: ChildActivity = {
  title: 'Research child',
  prompt: 'Investigate.',
  status: 'completed',
  items: [
    { type: 'reasoning', text: 'Visible reasoning.' },
    {
      type: 'tool',
      toolCallId: 'tool-1',
      name: 'search',
      input: '{"query":"release"}',
      output: 'Found it.',
      status: 'completed',
    },
    {
      type: 'tool',
      toolCallId: 'tool-2',
      name: 'calculator',
      input: '{"value":4}',
      output: '4',
      status: 'completed',
    },
    { type: 'writing', text: 'Final answer.' },
  ],
};

describe('SubagentActivity', () => {
  it.each(['failed', 'cancelled'] as const)(
    'renders the %s lifecycle through the shared view',
    (status) => {
      render(<SubagentActivity activity={{ ...base, status }} />);
      expect(screen.getByText(`com_ui_subagent_thread_status_${status}`)).toBeInTheDocument();
    },
  );

  it('shows no status chip while running, matching the main chat view', () => {
    render(<SubagentActivity activity={{ ...base, status: 'running' }} />);
    expect(screen.queryByText('com_ui_subagent_thread_status_running')).not.toBeInTheDocument();
  });

  it('does not repeat the completed lifecycle in the conversation body', () => {
    render(<SubagentActivity activity={base} />);

    expect(screen.queryByText('com_ui_subagent_thread_status_completed')).not.toBeInTheDocument();
  });

  it('reports when the durable control history is bounded', () => {
    render(<SubagentActivity activity={{ ...base, controlsTruncated: true }} />);

    expect(screen.getByText('com_ui_subagent_control_history_truncated')).toBeInTheDocument();
  });

  it('preserves question input-validation failure for the regular renderer', () => {
    render(
      <SubagentActivity
        activity={{
          ...base,
          items: [
            {
              type: 'tool',
              toolCallId: 'question',
              name: 'ask_user_question',
              output: 'Invalid question schema',
              status: 'completed',
              inputValidationError: true,
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole('button', { name: 'ask_user_question' })).toHaveAttribute(
      'data-input-validation-error',
      'true',
    );
  });

  it('renders approval controls when the provider persists an empty output', () => {
    render(
      <SubagentActivity
        activity={{
          ...base,
          status: 'running',
          items: [
            {
              type: 'tool',
              toolCallId: 'tool',
              name: 'protected_tool',
              output: '',
              status: 'running',
              approval: {} as Agents.ToolCall['approval'],
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('tool-approval')).toBeInTheDocument();
  });

  it('renders bounded tool details without any shortening caption', () => {
    render(
      <SubagentActivity
        activity={{
          ...base,
          items: [
            {
              type: 'tool',
              toolCallId: 'tool',
              name: 'search',
              input: 'bounded input',
              status: 'completed',
              inputTruncated: true,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByText('bounded input')).not.toBeInTheDocument();
    expect(
      screen.queryByText('com_ui_subagent_activity_details_truncated'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_thread_history_truncated')).not.toBeInTheDocument();
  });

  it('renders writing, reasoning, grouped tools, and collapsed details', () => {
    render(<SubagentActivity activity={base} />);

    expect(screen.queryByText('com_ui_subagent_ticker_writing')).not.toBeInTheDocument();
    expect(screen.getByText('Final answer.')).toBeInTheDocument();
    expect(screen.getByText('Visible reasoning.')).toBeInTheDocument();
    expect(screen.getByText('Used 2 tools')).toBeInTheDocument();
    expect(screen.queryByText(/Found it/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'search' }));
    expect(screen.getByText(/Found it/)).toBeInTheDocument();
  });

  it('routes parent phase and reasoning labels through regular ContentParts', () => {
    render(
      <SubagentActivity
        activity={{
          ...base,
          items: [
            { type: 'reasoning', text: 'Reasoned.', label: 'Checked constraints' },
            { type: 'writing', text: 'Draft.', phase: 'commentary' },
            {
              type: 'activity_label',
              label: 'Prepared the release',
              labelType: 'phase',
              activityStartIndex: 0,
              activityEndIndex: 2,
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('regular-content-parts')).toBeInTheDocument();
    expect(screen.getByText('Checked constraints')).toBeInTheDocument();
    expect(screen.getByText('Draft.')).toHaveAttribute('data-phase', 'commentary');
    expect(screen.getByText('Prepared the release')).toBeInTheDocument();
  });

  it('renders command receipts separately from child status and allows an accepted withdrawal', () => {
    const onCancelControl = jest.fn();
    render(
      <SubagentActivity
        activity={{
          ...base,
          status: 'running',
          controls: [
            {
              invocationId: 'submitted',
              action: 'steer',
              status: 'submitted',
              createdAt: '2026-08-24T12:00:00.000Z',
              updatedAt: '2026-08-24T12:00:00.000Z',
              message: 'Check the source.',
            },
            {
              invocationId: 'accepted',
              controlId: 'control-1',
              action: 'queue',
              status: 'accepted',
              createdAt: '2026-08-24T12:00:01.000Z',
              updatedAt: '2026-08-24T12:00:01.000Z',
              message: 'Add a citation.',
              messageTruncated: true,
            },
            {
              invocationId: 'applied',
              action: 'interrupt',
              status: 'applied',
              createdAt: '2026-08-24T12:00:02.000Z',
              updatedAt: '2026-08-24T12:00:03.000Z',
              boundary: 'preempt',
            },
            {
              invocationId: 'rejected',
              action: 'steer',
              status: 'rejected',
              createdAt: '2026-08-24T12:00:04.000Z',
              updatedAt: '2026-08-24T12:00:05.000Z',
              reason: 'task_completed',
            },
          ],
        }}
        onCancelControl={onCancelControl}
      />,
    );

    expect(screen.queryByText('com_ui_subagent_thread_status_running')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_subagent_control_status_submitted')).toBeInTheDocument();
    expect(screen.getByText('com_ui_subagent_control_status_accepted')).toBeInTheDocument();
    expect(screen.getByText('com_ui_subagent_control_status_applied')).toBeInTheDocument();
    expect(screen.getByText('com_ui_subagent_control_status_rejected')).toBeInTheDocument();
    expect(screen.getByText('com_ui_subagent_control_message_truncated')).toBeInTheDocument();
    expect(screen.getByText('com_ui_subagent_control_reason_task_completed')).toBeInTheDocument();

    const accepted = screen.getByText('com_ui_subagent_control_status_accepted');
    const withdraw = screen.getByRole('button', { name: 'com_ui_subagent_control_withdraw' });
    expect(accepted.parentElement).toContainElement(withdraw);
    expect(screen.queryByText('com_ui_queued_turn_starting')).toBeNull();
    fireEvent.click(withdraw);
    expect(onCancelControl).toHaveBeenCalledWith('control-1');
  });

  it('renders storage-prioritized control receipts in chronological order', () => {
    render(
      <SubagentActivity
        activity={{
          ...base,
          controls: [
            {
              invocationId: 'new-accepted',
              controlId: 'control-2',
              action: 'queue',
              status: 'accepted',
              createdAt: '2026-08-24T12:00:02.000Z',
              updatedAt: '2026-08-24T12:00:02.000Z',
            },
            {
              invocationId: 'old-applied',
              controlId: 'control-1',
              action: 'steer',
              status: 'applied',
              createdAt: '2026-08-24T12:00:01.000Z',
              updatedAt: '2026-08-24T12:00:03.000Z',
            },
          ],
        }}
      />,
    );

    const applied = screen.getByText('com_ui_subagent_control_status_applied');
    const accepted = screen.getByText('com_ui_subagent_control_status_accepted');
    expect(
      applied.compareDocumentPosition(accepted) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('scopes regular-chat renderer state to the selected child activity', () => {
    render(<SubagentActivity activity={base} activityId="parent:tool:child" />);

    expect(screen.getByTestId('regular-content-parts')).toHaveAttribute(
      'data-message-id',
      'parent:tool:child',
    );
  });

  it('renders an embedded turn without creating a nested scroll surface', () => {
    const { container } = render(<SubagentActivity activity={base} embedded />);

    expect(container.querySelector('[data-subagent-thread-turn]')).toBeInTheDocument();
    expect(container.querySelector('.overflow-y-auto')).not.toBeInTheDocument();
    expect(screen.getByText('Final answer.')).toBeInTheDocument();
  });

  it('keeps the shared scroll surface pinned when activity grows at the bottom', () => {
    let resize!: ResizeObserverCallback;
    const resizeObserver = window.ResizeObserver as unknown as jest.Mock;
    const originalImplementation = resizeObserver.getMockImplementation();
    resizeObserver.mockImplementation((callback: ResizeObserverCallback) => {
      resize = callback;
      return { observe: jest.fn(), disconnect: jest.fn(), unobserve: jest.fn() };
    });

    const { container, unmount } = render(
      <SubagentActivityScrollSurface padded={false}>
        {/* eslint-disable-next-line i18next/no-literal-string */}
        <div>Growing timeline</div>
      </SubagentActivityScrollSurface>,
    );
    const surface = container.querySelector<HTMLElement>('[data-subagent-activity-scroll-surface]');
    expect(surface).not.toBeNull();
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 640 });

    act(() => resize([], {} as ResizeObserver));
    expect(surface?.scrollTop).toBe(640);

    unmount();
    if (originalImplementation == null) {
      resizeObserver.mockReset();
    } else {
      resizeObserver.mockImplementation(originalImplementation);
    }
  });

  it('renders a sanitized reasoning marker through regular ContentParts', () => {
    render(
      <SubagentActivity
        activity={{ ...base, status: 'running', items: [{ type: 'reasoning' }] }}
      />,
    );

    expect(screen.getByTestId('regular-content-parts')).toBeInTheDocument();
    expect(screen.getByText('reasoning-marker:')).toBeInTheDocument();
  });

  it('keeps the display-safe reasoning label on a sanitized marker', () => {
    render(
      <SubagentActivity
        activity={{
          ...base,
          status: 'running',
          items: [{ type: 'reasoning', label: 'Planning the answer' }],
        }}
      />,
    );

    expect(screen.getByText('reasoning-marker:Planning the answer')).toBeInTheDocument();
  });

  it('uses the regular thinking cursor without running-state prose', () => {
    render(<SubagentActivity activity={{ ...base, status: 'running', items: [] }} />);

    expect(screen.getByTestId('thinking-cursor')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_no_result_yet')).not.toBeInTheDocument();
  });

  it.each(['running', 'completed', 'failed', 'cancelled'] as const)(
    'renders a %s tool lifecycle through the shared view',
    (status) => {
      render(
        <SubagentActivity
          activity={{
            ...base,
            items: [{ type: 'tool', toolCallId: 'tool', name: 'search', status }],
          }}
        />,
      );

      const tool = screen.getByRole('button', { name: 'search' });
      if (status === 'running') {
        expect(tool).not.toHaveAttribute('data-run-step-status');
      } else {
        expect(tool).toHaveAttribute('data-run-step-status', status);
      }
    },
  );

  it('renders loading as the regular thinking cursor without prose', () => {
    render(
      <SubagentActivity activity={{ ...base, status: 'running', items: [] }} state="loading" />,
    );
    expect(screen.getByTestId('thinking-cursor')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_waiting')).not.toBeInTheDocument();
  });

  it('renders the load error state', () => {
    render(<SubagentActivity activity={{ ...base, items: [] }} state="error" />);
    expect(screen.getByText('com_ui_subagent_thread_load_error')).toBeInTheDocument();
  });

  it('does not describe a completed tool-only child as missing a result', () => {
    render(<SubagentActivity activity={{ ...base, status: 'completed', items: [] }} />);
    expect(screen.queryByText('com_ui_subagent_empty_result')).not.toBeInTheDocument();
  });
});
