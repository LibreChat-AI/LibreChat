import React from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { TMessageContentParts, Agents } from 'librechat-data-provider';
import type { ChildActivity } from './adapters';
import SubagentActivity, { SubagentActivityScrollSurface } from './SubagentActivity';
import { TaskContentScopeContext } from '~/data-provider/Subagents/content';
import { ChatSurfaceHarness } from 'test/harness';

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <ChatSurfaceHarness>{children}</ChatSurfaceHarness>
);
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: Wrapper });

const mockShowMore = 'com_ui_show_more';
const mockReadControl = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSubagentControlReceipt: (...args: unknown[]) => mockReadControl(...args),
    },
  };
});
const mockContentParts = jest.fn();
let mockAutoExpandTools = false;

jest.mock('~/Providers/MessagePartsHostContext', () => ({
  useMessagePartsHost: () => ({
    useShowThinking: () => false,
    useAutoExpandTools: () => mockAutoExpandTools,
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Chat/Messages/Content/Parts/SteerPart', () => ({
  __esModule: true,
  default: ({
    steer,
    steerId,
    receiptState,
    hasMore,
    onExpand,
  }: {
    steer: string;
    steerId?: string;
    receiptState?: string | null;
    hasMore?: boolean;
    onExpand?: () => void;
  }) => (
    <div data-testid="shared-steer-part" data-receipt={receiptState} data-steer-id={steerId}>
      {steer}
      {hasMore && (
        <button type="button" onClick={onExpand}>
          {mockShowMore}
        </button>
      )}
    </div>
  ),
}));

jest.mock('~/components/Chat/Messages/Content/Parts', () => ({
  EmptyText: () => <div data-testid="thinking-cursor" />,
}));

jest.mock('~/components/Chat/Messages/Content/ContentParts', () => ({
  __esModule: true,
  default: function MockContentParts({
    content,
    messageId,
    ...props
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
    foldLiveActivity?: boolean;
  }) {
    mockContentParts({ content, messageId, ...props });
    const { useState } = jest.requireActual<typeof import('react')>('react');
    const [expandedTool, setExpandedTool] = useState<string | null>(null);
    const tools = content.filter((part) => part?.type === 'tool_call');
    return (
      <div data-testid="regular-content-parts" data-message-id={messageId}>
        {content.map((part, index) => {
          if (part == null) return null;
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

jest.mock('~/components/Chat/Steering/Receipt', () => ({
  __esModule: true,
  default: ({ state }: { state: string }) => (
    <span data-testid="steer-receipt" data-receipt-state={state} />
  ),
}));

jest.mock('@librechat/client', () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
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

it('keeps a host notice inside the floating-header clearance', () => {
  const activity: ChildActivity = { title: 'Review', status: 'running', items: [] };
  const { container } = render(
    <SubagentActivity
      activity={activity}
      headerInset
      notice={<div role="status">{String(19)}</div>}
    />,
  );
  const inset = container.querySelector('[class~="pt-13"]');
  expect(inset).toContainElement(screen.getByRole('status'));
});

describe('SubagentActivity', () => {
  beforeEach(() => {
    mockContentParts.mockClear();
    mockAutoExpandTools = false;
  });

  it('passes standard content unchanged with its stable message identity', () => {
    const content: TMessageContentParts[] = [
      {
        type: ContentTypes.THINK,
        think: 'Reasoning.',
        agentId: 'agent-1',
        reasoning_label: 'Checked constraints',
        reasoning_label_step_id: 'step-1',
        reasoning_label_revision: 4,
      },
      {
        type: ContentTypes.TOOL_CALL,
        agentId: 'agent-1',
        tool_call: {
          id: 'call-1',
          name: 'bash',
          args: '{}',
          output: 'result',
          stepId: 'step-2',
          progress: 1,
          outputTruncated: true,
          previewRevision: 'revision-2',
          toolPreparationDurationMs: 21,
          toolExecutionDurationMs: 34,
        },
      },
      { type: ContentTypes.ERROR, error: 'Failure', agentId: 'agent-1' },
    ] as TMessageContentParts[];
    render(
      <SubagentActivity
        activity={{ ...base, content, messageId: 'stable-response', items: [] }}
        activityId="synthetic-response"
      />,
    );
    expect(mockContentParts).toHaveBeenLastCalledWith(
      expect.objectContaining({ content, messageId: 'stable-response' }),
    );
    expect(mockContentParts.mock.calls.at(-1)?.[0].content).toBe(content);
  });

  it.each([false, true])(
    'uses the shared default fold policy with card auto-expand=%s',
    (autoExpand) => {
      mockAutoExpandTools = autoExpand;
      render(<SubagentActivity activity={{ ...base, status: 'running' }} />);
      expect(mockContentParts).toHaveBeenLastCalledWith(
        expect.objectContaining({ isSubmitting: true }),
      );
      expect(mockContentParts.mock.calls.at(-1)?.[0].foldLiveActivity).toBeUndefined();
    },
  );
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

  it('keeps a genuine legacy truncation notice instead of claiming full details', () => {
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
    expect(screen.queryByText('com_ui_subagent_activity_details_unavailable')).toBeInTheDocument();
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
    expect(screen.queryByText('com_ui_subagent_control_message_truncated')).not.toBeInTheDocument();
    expect(
      screen
        .getAllByTestId('shared-steer-part')
        .some((part) => part.textContent === 'Add a citation.'),
    ).toBe(true);
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
    expect(screen.getByText('com_ui_conversation_load_error')).toBeInTheDocument();
  });

  it('does not describe a completed tool-only child as missing a result', () => {
    render(<SubagentActivity activity={{ ...base, status: 'completed', items: [] }} />);
    expect(screen.queryByText('com_ui_subagent_empty_result')).not.toBeInTheDocument();
  });
});

it('retains standard content when a refresh fails and reports the failure', () => {
  render(<SubagentActivity activity={base} state="error" />);
  expect(screen.getByText('Final answer.')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_conversation_load_error');
});

it('does not repeat an applied control already rendered at its standard content position', () => {
  render(
    <SubagentActivity
      activity={{
        ...base,
        content: [{ type: ContentTypes.STEER, steer: 'Applied message', steerId: 'control-1' }],
        controls: [
          {
            invocationId: 'invocation-1',
            controlId: 'control-1',
            action: 'steer',
            status: 'applied',
            message: 'Applied message',
            createdAt: '2026-10-20T00:00:00Z',
            updatedAt: '2026-10-20T00:00:01Z',
          },
        ],
      }}
    />,
  );
  expect(screen.queryByText('com_ui_subagent_control_status_applied')).not.toBeInTheDocument();
  expect(mockContentParts.mock.calls.at(-1)?.[0].content[0]).toMatchObject({
    type: ContentTypes.STEER,
    steerId: 'control-1',
  });
});

it('does not claim delivery or application before the server confirms it', () => {
  render(
    <SubagentActivity
      activity={{
        ...base,
        controls: [
          {
            invocationId: 'invocation-1',
            action: 'steer',
            status: 'submitted',
            message: 'Check it',
            createdAt: '2026-10-20T00:00:00Z',
            updatedAt: '2026-10-20T00:00:00Z',
          },
        ],
      }}
    />,
  );
  expect(screen.getByTestId('shared-steer-part')).toHaveAttribute('data-receipt', 'sending');
});

it('preserves empty recovered slots when rendering applied control receipts', () => {
  const sparse = new Array<TMessageContentParts>(2);
  sparse[1] = {
    type: ContentTypes.TOOL_CALL,
    tool_call: { id: 'retained', name: 'retained', args: '{}', output: 'Done', progress: 1 },
  };
  const content: TMessageContentParts[] = JSON.parse(JSON.stringify(sparse));
  render(
    <SubagentActivity
      activity={{
        ...base,
        content,
        controls: [
          {
            invocationId: 'applied-sparse',
            controlId: 'guidance',
            action: 'steer',
            status: 'applied',
            createdAt: '2026-10-20T00:00:00.000Z',
            updatedAt: '2026-10-20T00:00:00.000Z',
            message: 'Continue',
          },
        ],
      }}
    />,
  );
  expect(screen.getAllByTestId('regular-content-parts').length).toBeGreaterThan(0);
  expect(mockContentParts.mock.calls[0][0].content[0]).toBeNull();
  expect(mockContentParts.mock.calls[0][0].content[1].tool_call.id).toBe('retained');
});

it('renders applied controls inline once instead of repeating them below all current activity', () => {
  const part = {
    type: ContentTypes.STEER as const,
    steer: 'Apply now.',
    steerId: 'control',
    createdAt: 100,
  };
  render(
    <SubagentActivity
      activity={{
        ...base,
        content: [part, { type: ContentTypes.TEXT, text: 'Work after guidance.' }],
        controls: [
          {
            invocationId: 'invocation',
            controlId: 'control',
            action: 'steer',
            status: 'applied',
            message: 'Apply now.',
            createdAt: '2026-08-24T12:00:00.000Z',
            updatedAt: '2026-08-24T12:00:01.000Z',
          },
        ],
      }}
    />,
  );
  expect(screen.queryByTestId('shared-steer-part')).not.toBeInTheDocument();
  expect(mockContentParts.mock.calls.at(-1)?.[0].content).toEqual([
    part,
    { type: ContentTypes.TEXT, text: 'Work after guidance.' },
  ]);
});

it('keeps retained applied guidance that a partial legacy transcript does not contain', () => {
  render(
    <SubagentActivity
      activity={{
        ...base,
        activityTruncated: true,
        content: [
          { type: ContentTypes.STEER, steer: 'Guidance present in the transcript.' },
          { type: ContentTypes.TEXT, text: 'Continued work.' },
        ],
        controls: [
          {
            invocationId: 'retained',
            controlId: 'retained-control',
            action: 'steer',
            status: 'applied',
            message: 'Different retained guidance outside this transcript prefix.',
            createdAt: '2026-10-23T00:00:00Z',
            updatedAt: '2026-10-23T00:00:01Z',
          },
        ],
      }}
    />,
  );
  expect(screen.getByTestId('shared-steer-part')).toHaveTextContent(
    'Different retained guidance outside this transcript prefix.',
  );
});

it('suppresses only the corresponding number of legacy guidance bodies and does not invent identities', () => {
  const receipt = {
    action: 'steer' as const,
    status: 'applied' as const,
    message: 'Repeated guidance.',
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:01Z',
  };
  render(
    <SubagentActivity
      activity={{
        ...base,
        activityTruncated: true,
        content: [{ type: ContentTypes.STEER, steer: 'Repeated guidance.' }],
        controls: [
          { ...receipt, invocationId: 'one', controlId: 'one' },
          { ...receipt, invocationId: 'two', controlId: 'two' },
        ],
      }}
    />,
  );
  expect(screen.getAllByTestId('shared-steer-part')).toHaveLength(1);
  expect(screen.getByTestId('shared-steer-part')).toHaveTextContent('Repeated guidance.');
  expect(screen.getByTestId('shared-steer-part')).toHaveAttribute('data-steer-id', 'one');
  expect(mockContentParts.mock.calls.at(-1)?.[0].content).toEqual([
    { type: ContentTypes.STEER, steer: 'Repeated guidance.' },
  ]);
});

it('loads a budgeted retained body only after expansion while keeping Withdraw actionable', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const full = 'Full retained guidance. '.repeat(80);
  const control = {
    invocationId: 'budgeted',
    controlId: 'pending-control',
    action: 'queue' as const,
    status: 'accepted' as const,
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:01Z',
    message: 'Budgeted prefix',
    messageTruncated: true,
  };
  mockReadControl.mockResolvedValueOnce({
    receipt: { ...control, message: full, messageTruncated: false },
  });
  const withdraw = jest.fn();
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <TaskContentScopeContext.Provider
        value={{ parentConversationId: 'parent', threadId: 'child', taskId: 'task' }}
      >
        <SubagentActivity activity={{ ...base, controls: [control] }} onCancelControl={withdraw} />
      </TaskContentScopeContext.Provider>
    </QueryClientProvider>,
  );
  expect(mockReadControl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: mockShowMore }));
  await waitFor(() =>
    expect(screen.getByTestId('shared-steer-part')).toHaveTextContent(full.trim()),
  );
  expect(mockReadControl).toHaveBeenCalledTimes(1);
  expect(mockReadControl).toHaveBeenCalledWith('parent', 'child', 'task', 'budgeted');
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_control_withdraw' }));
  expect(withdraw).toHaveBeenCalledWith('pending-control');
  expect(screen.queryByText('Message shortened for display.')).not.toBeInTheDocument();
  unmount();
  client.clear();
});

it.each(['submitted', 'accepted', 'failed'] as const)(
  'retires an already-applied %s receipt by its client identity without waiting for the ledger',
  (status) => {
    const applied = {
      type: ContentTypes.STEER as const,
      steer: 'Applied guidance.',
      steerId: 'server-control',
      clientSteerId: 'client-invocation',
    };
    render(
      <SubagentActivity
        activity={{
          ...base,
          content: [applied, { type: ContentTypes.TEXT, text: 'Later activity.' }],
          controls: [
            {
              invocationId: 'client-invocation',
              action: 'steer',
              status,
              message: 'Applied guidance.',
              createdAt: '2026-10-23T00:00:00Z',
              updatedAt: '2026-10-23T00:00:01Z',
            },
          ],
        }}
      />,
    );
    expect(screen.queryByTestId('shared-steer-part')).not.toBeInTheDocument();
    expect(mockContentParts.mock.calls.at(-1)?.[0].content).toContainEqual(applied);
  },
);

it('does not hide a failed withdrawal just because its target was already applied', () => {
  render(
    <SubagentActivity
      activity={{
        ...base,
        content: [
          { type: ContentTypes.STEER, steer: 'Applied guidance.', steerId: 'server-control' },
        ],
        controls: [
          {
            invocationId: 'withdrawal',
            controlId: 'server-control',
            action: 'cancel_message',
            status: 'rejected',
            reason: 'control_not_found',
            createdAt: '2026-10-23T00:00:00Z',
            updatedAt: '2026-10-23T00:00:01Z',
          },
        ],
      }}
    />,
  );
  expect(screen.getByText('com_ui_subagent_control_reason_control_not_found')).toBeInTheDocument();
});

it.each(['failed', 'rejected'] as const)(
  'keeps the %s guidance body readable without asserting enqueue or application',
  (status) => {
    render(
      <SubagentActivity
        activity={{
          ...base,
          controls: [
            {
              invocationId: 'terminal',
              action: 'steer',
              status,
              message: 'Retained terminal guidance.',
              reason: status === 'rejected' ? 'withdrawn' : 'owner_unavailable',
              createdAt: '2026-10-23T00:00:00Z',
              updatedAt: '2026-10-23T00:00:01Z',
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('shared-steer-part')).toHaveTextContent(
      'Retained terminal guidance.',
    );
    expect(screen.getByTestId('shared-steer-part')).not.toHaveAttribute('data-receipt');
    expect(screen.getByText(`com_ui_subagent_control_status_${status}`)).toBeVisible();
  },
);

it.each(['submitted', 'failed'] as const)(
  'retains the durable client identity to retire an already-applied %s receipt',
  (status) => {
    render(
      <SubagentActivity
        activity={{
          ...base,
          items: [
            {
              type: 'steer',
              steer: 'Durably applied guidance.',
              steerId: 'server-control',
              clientSteerId: 'client-invocation',
              createdAt: 100,
            },
            { type: 'writing', text: 'Later durable work.' },
          ],
          controls: [
            {
              invocationId: 'client-invocation',
              action: 'steer',
              status,
              message: 'Durably applied guidance.',
              createdAt: '2026-10-23T00:00:00Z',
              updatedAt: '2026-10-23T00:00:01Z',
            },
          ],
        }}
      />,
    );
    expect(screen.queryByTestId('shared-steer-part')).not.toBeInTheDocument();
    expect(mockContentParts.mock.calls.at(-1)?.[0].content).toEqual([
      {
        type: ContentTypes.STEER,
        steer: 'Durably applied guidance.',
        steerId: 'server-control',
        clientSteerId: 'client-invocation',
        createdAt: 100,
      },
      { type: ContentTypes.TEXT, text: 'Later durable work.' },
    ]);
  },
);

it('reserves identified inline controls before matching the newest legacy occurrences', () => {
  const receipt = {
    action: 'steer' as const,
    status: 'applied' as const,
    message: 'Same guidance.',
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:01Z',
  };
  render(
    <SubagentActivity
      activity={{
        ...base,
        activityTruncated: true,
        content: [
          { type: ContentTypes.STEER, steer: 'Same guidance.' },
          { type: ContentTypes.STEER, steer: 'Same guidance.', steerId: 'identified' },
        ],
        controls: [
          { ...receipt, invocationId: 'oldest', controlId: 'oldest' },
          { ...receipt, invocationId: 'legacy', controlId: 'legacy' },
          { ...receipt, invocationId: 'identified', controlId: 'identified' },
        ],
      }}
    />,
  );
  expect(screen.getAllByTestId('shared-steer-part')).toHaveLength(1);
  expect(screen.getByTestId('shared-steer-part')).toHaveAttribute('data-steer-id', 'oldest');
});
