import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ContentTypes, ForkOptions } from 'librechat-data-provider';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ParentSubagentSummary,
  SubagentThreadView,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { ActiveSubagentPanel } from './state';
import type { JotaiStore } from 'test/harness';
import { activeSubagentPanel, subagentProgressByToolCallId, subagentProgressKey } from './state';
import { initSubagentAggregatorState, initSubagentTickerState } from '~/utils/subagentContent';
import { ChatSurfaceHarness, testChatSurface } from 'test/harness';
import SubagentThreadPanel from './SubagentThreadPanel';
import { getDraft } from '~/utils';

const mockUseSubagentThreadQuery = jest.fn();
const mockUseSubagentActivityStream = jest.fn();
const mockForkMutate = jest.fn();
const mockControlMutate = jest.fn();
const mockNavigateToConvo = jest.fn();
const mockShowToast = jest.fn();
const mockGetSubagentThread = jest.fn();
const mockApprovalProviderMounted = jest.fn();
const mockApprovalProviderUnmounted = jest.fn();
let mockIsMobile = false;
let mockCoarsePointer = false;
let mockParentChildrenByMessage = new Map<string, ParentSubagentSummary[]>();
let mockParentChildrenByThread = new Map<string, ParentSubagentSummary>();
const mockRefreshParentChildren = jest.fn().mockResolvedValue(undefined);
/** The host's half of the chat surface, supplied here instead of reached for:
 *  what the panel promises is that it consults the preference and hands the
 *  words over, not which application atom either one lives in. */
let mockEnterToSend = true;
const mockClaimForeground = jest.fn();
const mockHandOffComposerText = jest.fn();

function Root({
  seed,
  children,
}: {
  seed?: (store: JotaiStore) => void;
  children: React.ReactNode;
}) {
  return (
    <ChatSurfaceHarness
      seed={seed}
      surface={testChatSurface({
        enterToSend: mockEnterToSend,
        claimForeground: mockClaimForeground,
        handOffComposerText: mockHandOffComposerText,
      })}
    >
      {children}
    </ChatSurfaceHarness>
  );
}

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSubagentThread: (...args: unknown[]) => mockGetSubagentThread(...args),
    },
  };
});

jest.mock('~/data-provider', () => ({
  ACTIVE_THREAD_REFRESH_MS: 2000,
  /** The panel's bottom clearance follows the conversation's configured footer
   *  (`useConfiguredFooter`), so the panel now reads the startup config. */
  useGetStartupConfig: () => ({ data: undefined }),
  useSubagentThreadQuery: (...args: unknown[]) => mockUseSubagentThreadQuery(...args),
  subagentThreadHasTaskEvidence: (view: SubagentThreadView | undefined, taskId: string): boolean =>
    view?.messages.some(
      (message) =>
        message.messageId === `${taskId}:user` || message.messageId === `${taskId}:assistant`,
    ) === true,
  useForkConvoMutation: (options: {
    onSuccess: (result: unknown) => void;
    onError: () => void;
  }) => ({
    mutate: (payload: unknown) => mockForkMutate(payload, options),
    isLoading: false,
  }),
  useSubagentControlMutation: (options: {
    onSuccess: (result: unknown, variables: unknown) => void;
    onError: (error: unknown, variables: unknown) => void;
  }) => ({
    mutate: (variables: unknown) =>
      mockControlMutate(variables, {
        onSuccess: (result: unknown) => options.onSuccess(result, variables),
        onError: (error: unknown) => options.onError(error, variables),
      }),
    isLoading: false,
  }),
}));

jest.mock('~/data-provider/Subagents/useSubagentActivityStream', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseSubagentActivityStream(...args),
}));

jest.mock('~/hooks', () => ({
  /** The real trap: its Escape listener is native and sits on the panel, so it
   *  runs before the panel's own React handler. Stubbing it made the panel's
   *  Escape assertions pass in both directions. */
  useFocusTrap: jest.requireActual('~/hooks/useFocusTrap').default,
  useLocalize: () => (key: string, values?: { 0: string }) =>
    values == null ? key : `${key}: ${values[0]}`,
  useNavigateToConvo: () => ({ navigateToConvo: mockNavigateToConvo }),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({
    'agent-1': { id: 'agent-1', name: 'Analyst One', avatar: { filepath: '/analyst.png' } },
    'agent-2': { id: 'agent-2', name: 'Analyst Two' },
  }),
}));

jest.mock('./ParentSubagentsProvider', () => ({
  useParentSubagents: () => ({
    byMessageId: mockParentChildrenByMessage,
    byThreadId: mockParentChildrenByThread,
    refresh: mockRefreshParentChildren,
  }),
}));

jest.mock('~/components/Chat/Messages/Content/ApprovalContext', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => {
    const mockReact = jest.requireActual<typeof import('react')>('react');
    mockReact.useEffect(() => {
      mockApprovalProviderMounted();
      return () => mockApprovalProviderUnmounted();
    }, []);
    return children;
  },
}));

jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

jest.mock('./SubagentActivity', () => ({
  __esModule: true,
  SubagentActivityScrollSurface: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shared-scroll-surface">{children}</div>
  ),
  default: ({
    activity,
    activityId,
    state,
    onCancelControl,
  }: {
    activity: {
      status: string;
      prompt?: string;
      items: Array<{ type: string; text?: string }>;
      controls?: Array<{ invocationId: string; status: string }>;
    };
    activityId?: string;
    state: string;
    onCancelControl?: (controlId: string) => void;
  }) => (
    <div
      data-testid="shared-activity"
      data-activity-id={activityId}
      data-state={state}
      data-status={activity.status}
      data-can-withdraw={onCancelControl != null ? 'true' : 'false'}
    >
      {activity.prompt}
      {activity.items.map((item, index) => (
        <span key={index}>{item.text ?? item.type}</span>
      ))}
      {activity.controls?.map((control) => (
        <span key={control.invocationId}>{control.status}</span>
      ))}
      {onCancelControl != null && (
        <button
          type="button"
          data-testid="withdraw-control"
          onClick={() => onCancelControl('control-1')}
        />
      )}
    </div>
  ),
}));

jest.mock('./SubagentConversation', () => ({
  __esModule: true,
  default: ({
    turns,
    stateByTask,
    detailStateByTask,
    onLoadTurnDetails,
  }: {
    turns: Array<{
      taskId: string;
      trigger: { summary: string };
      activity: { items: Array<{ text?: string }>; activityTruncated?: boolean };
    }>;
    stateByTask?: ReadonlyMap<string, string>;
    detailStateByTask?: ReadonlyMap<string, string>;
    onLoadTurnDetails?: (taskId: string) => void;
  }) => (
    <div
      data-testid="subagent-conversation"
      data-state={turns[0] == null ? undefined : stateByTask?.get(turns[0].taskId)}
    >
      {turns.map((turn) => (
        <div key={turn.taskId} data-testid="conversation-turn">
          {turn.trigger.summary}
          {turn.activity.items.map((item, index) => (
            <span key={index}>{item.text}</span>
          ))}
          {turn.activity.activityTruncated === true && onLoadTurnDetails != null && (
            <button type="button" onClick={() => onLoadTurnDetails(turn.taskId)}>
              {`load-${turn.taskId}`}
            </button>
          )}
          {detailStateByTask?.get(turn.taskId)}
        </div>
      ))}
    </div>
  ),
}));

/** The shared composer's own Enter contract, for the mock to fall back on when
 *  a host supplies no key policy. */
const mockComposerVerdict = (
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  submitOnEnter: boolean,
): 'submit' | 'newline' | 'none' => {
  if (event.key !== 'Enter' || event.shiftKey) return 'none';
  if (!submitOnEnter && !(event.metaKey || event.ctrlKey)) return 'newline';
  return 'submit';
};

jest.mock('@librechat/client', () => ({
  Alert: ({ children, ...props }: React.ComponentProps<'div'>) => (
    <div role="alert" {...props}>
      {children}
    </div>
  ),
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  Skeleton: () => null,
  /** Renders the anchored control itself; the tooltip text is the control's
   *  accessible name here, which is what the assertions read. */
  TooltipAnchor: ({ render }: { render: React.ReactElement }) => render,
  ControlCombobox: ({
    items,
    setValue,
    ariaLabel,
    displayValue,
    onOpenChange,
    disabled,
  }: {
    items: { value: string; label: string }[];
    setValue: (value: string) => void;
    ariaLabel: string;
    displayValue?: string;
    onOpenChange?: (open: boolean) => void;
    disabled?: boolean;
  }) => (
    <div>
      <button
        type="button"
        role="combobox"
        aria-controls="mock-combobox-options"
        aria-expanded="true"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onOpenChange?.(true)}
      >
        {displayValue}
      </button>
      <div id="mock-combobox-options">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            role="option"
            aria-selected="false"
            disabled={disabled}
            onClick={() => setValue(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  ),
  /** Mirrors the real composer's contract: one field, the caller's action row,
   *  and a send control whose accessible name says what Enter will do. */
  Composer: ({
    value,
    onChange,
    onSubmit,
    canSubmit,
    submitLabel,
    ariaLabel,
    placeholder,
    disabled,
    actions,
    submitOnEnter = true,
    resolveKeyVerdict,
    maxLength,
    onStop,
    stopLabel,
    submitActions,
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: (event?: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    canSubmit: boolean;
    submitLabel: string;
    ariaLabel: string;
    placeholder?: string;
    disabled?: boolean;
    actions?: React.ReactNode;
    submitOnEnter?: boolean;
    resolveKeyVerdict?: (
      event: React.KeyboardEvent<HTMLTextAreaElement>,
      isComposing: boolean,
    ) => 'submit' | 'block' | 'newline' | 'none';
    maxLength?: number;
    onStop?: () => void;
    stopLabel?: string;
    submitActions?: Array<{
      key: string;
      label: string;
      disabled?: boolean;
      onClick: () => void;
    }>;
  }) => (
    <div>
      <textarea
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          const verdict =
            resolveKeyVerdict?.(event, false) ?? mockComposerVerdict(event, submitOnEnter);
          if (verdict !== 'submit') return;
          event.preventDefault();
          /** The real composer hands the submitting event to the host, which is
           *  how a chord picks its control; a pointer click passes nothing. */
          if (canSubmit && value.trim() !== '') onSubmit(event);
        }}
      />
      {actions}
      {/* The real composer hides these behind the send control until it is
          hovered; rendering them inline keeps them reachable to assertions. */}
      {(submitActions ?? []).map((action) => (
        <button
          key={action.key}
          type="button"
          aria-disabled={action.disabled === true}
          onClick={action.disabled === true ? undefined : action.onClick}
        >
          {action.label}
        </button>
      ))}
      {onStop != null && value.trim() === '' ? (
        <button type="button" aria-label={stopLabel} onClick={onStop}>
          {stopLabel}
        </button>
      ) : (
        <button
          type="button"
          aria-label={submitLabel}
          disabled={disabled === true || !canSubmit}
          onClick={() => onSubmit()}
        >
          {submitLabel}
        </button>
      )}
    </div>
  ),
  useMediaQuery: (query: string) => (query.includes('hover') ? mockCoarsePointer : mockIsMobile),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('lucide-react', () => ({
  AlertCircle: () => null,
  CornerUpLeft: () => null,
  CheckCircle2: () => null,
  Clock: () => null,
  Clock3: () => null,
  Feather: () => null,
  OctagonPause: () => null,
  X: () => null,
  XCircle: () => null,
  Zap: () => null,
}));

const selection: ActiveSubagentPanel = {
  host: 'conversation',
  parentConversationId: 'parent-conversation',
  parentMessageId: 'parent-message',
  toolCallId: 'tool-call',
  partIndex: 2,
  subagentType: 'researcher',
  initialProgress: 1,
  isSubmitting: false,
  durable: { threadId: 'child-thread', taskId: 'task' },
};

const completedView: SubagentThreadView = {
  threadId: 'child-thread',
  parentConversationId: 'parent-conversation',
  parentMessageId: 'parent-message',
  parentToolCallId: 'tool-call',
  subagentType: 'researcher',
  subagentKind: 'agent',
  depth: 1,
  agentId: 'agent-1',
  title: 'Research child',
  status: 'completed',
  activity: [{ type: 'writing', text: 'The release is ready.' }],
  activityTruncated: false,
  historyTruncated: true,
  messages: [
    {
      messageId: 'task:user',
      parentMessageId: null,
      role: 'user',
      text: 'Investigate the release.',
    },
    {
      messageId: 'task:assistant',
      parentMessageId: 'task:user',
      role: 'assistant',
      text: 'The release is ready.',
      textTruncated: true,
    },
  ],
};

describe('SubagentThreadPanel', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mockIsMobile = false;
    mockCoarsePointer = false;
    mockEnterToSend = true;
    mockClaimForeground.mockClear();
    mockHandOffComposerText.mockClear();
    mockApprovalProviderMounted.mockClear();
    mockApprovalProviderUnmounted.mockClear();
    mockForkMutate.mockClear();
    mockControlMutate.mockClear();
    mockNavigateToConvo.mockClear();
    mockShowToast.mockClear();
    mockGetSubagentThread.mockReset();
    mockRefreshParentChildren.mockClear();
    mockParentChildrenByMessage = new Map();
    mockParentChildrenByThread = new Map();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['agent-1', 'missing-agent', 'self'])(
    'resolves the saved foreground identity %s in the panel',
    (subagentType) => {
      mockUseSubagentThreadQuery.mockReturnValue({ isLoading: false, isError: false });
      const foregroundSelection = {
        ...selection,
        durable: undefined,
        subagentType,
        subagentIdentity: { subagentKind: 'agent' as const, subagentAgentId: subagentType },
      };
      render(
        <Root>
          <SubagentThreadPanel selection={foregroundSelection} />
        </Root>,
      );
      const title =
        subagentType === 'self'
          ? 'com_ui_subagent_dialog_title_self'
          : `com_ui_subagent_dialog_title: ${subagentType === 'agent-1' ? 'Analyst One' : subagentType}`;
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
      if (subagentType === 'agent-1') {
        expect(screen.getByAltText('Analyst One avatar')).toHaveAttribute('src', '/analyst.png');
      }
    },
  );

  it.each([undefined, { subagentKind: 'graph' as const, subagentAgentId: 'graph:agent-1' }])(
    'does not resolve graph or legacy panel types as saved agents',
    (subagentIdentity) => {
      mockUseSubagentThreadQuery.mockReturnValue({ isLoading: false, isError: false });
      render(
        <Root>
          <SubagentThreadPanel
            selection={{
              ...selection,
              durable: undefined,
              subagentType: 'agent-1',
              subagentIdentity,
            }}
          />
        </Root>,
      );
      expect(
        screen.getByRole('heading', { name: 'com_ui_subagent_dialog_title: agent-1' }),
      ).toBeInTheDocument();
      expect(screen.queryByAltText('Analyst One avatar')).not.toBeInTheDocument();
    },
  );

  it('renders a bounded read-only activity timeline and closes its selection', async () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    let active: ActiveSubagentPanel | null = selection;
    const Observer = () => {
      active = useAtomValue(activeSubagentPanel);
      return null;
    };

    const { container } = render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <button
          type="button"
          data-subagent-tool-call="tool-call"
          data-subagent-parent-message="parent-message"
          data-subagent-part-index="2"
        />
        <Observer />
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(mockUseSubagentThreadQuery).toHaveBeenCalledWith(
      'parent-conversation',
      'child-thread',
      'task',
      { keepPreviousData: true },
    );
    expect(mockUseSubagentActivityStream).toHaveBeenCalledWith(selection, false);
    expect(screen.getByText('Research child')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_depth')).not.toBeInTheDocument();
    expect(screen.getByText('Investigate the release.')).toBeInTheDocument();
    expect(screen.getByText('The release is ready.')).toBeInTheDocument();
    expect(screen.getByTestId('shared-activity')).toHaveAttribute('data-status', 'completed');

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));
    expect(active).toBeNull();
    await waitFor(() =>
      expect(
        container.querySelector(
          '[data-subagent-tool-call="tool-call"][data-subagent-parent-message="parent-message"][data-subagent-part-index="2"]',
        ),
      ).toHaveFocus(),
    );
  });

  it('returns to and restores focus on the originating parent activity', async () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    let active: ActiveSubagentPanel | null = selection;
    const Observer = () => {
      active = useAtomValue(activeSubagentPanel);
      return null;
    };
    const { container } = render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <button
          type="button"
          data-subagent-tool-call="tool-call"
          data-subagent-parent-message="parent-message"
          data-subagent-part-index="2"
        />
        <Observer />
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));

    expect(active).toBeNull();
    await waitFor(() =>
      expect(container.querySelector('[data-subagent-tool-call="tool-call"]')).toHaveFocus(),
    );
  });

  it('renders the durable branch as one conversation-native chronological thread', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        turns: [
          {
            taskId: 'task-earlier',
            trigger: { kind: 'parent_dispatch', summary: 'Initial request.' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Initial response.' }],
            activityTruncated: false,
            messages: [],
          },
          {
            taskId: 'task',
            trigger: { kind: 'parent_continuation', summary: 'Follow-up request.' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Follow-up response.' }],
            activityTruncated: false,
            messages: [completedView.messages[1]],
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(screen.getByTestId('subagent-conversation')).toBeInTheDocument();
    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2);
    expect(screen.getByText(/Initial request/)).toBeInTheDocument();
    expect(screen.getByText(/Follow-up request/)).toBeInTheDocument();
    expect(screen.queryByTestId('shared-activity')).not.toBeInTheDocument();
  });

  it('keeps the exact selected activity when the bounded response retains only newer turns', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        turns: [
          {
            taskId: 'task-newer',
            trigger: { kind: 'parent_continuation', summary: 'A newer request.' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'A newer response.' }],
            activityTruncated: false,
            messages: [],
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2);
    expect(screen.getByText('The release is ready.')).toBeInTheDocument();
    expect(screen.getByText(/A newer request/)).toBeInTheDocument();
  });

  /** The panel composer obeys the same "Press Enter to send" preference the
   *  main chat form does: with it off, reaching for a line break must not steer
   *  a live run. */
  it('leaves a bare Enter alone when the reader turned Enter-to-send off', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    mockEnterToSend = false;
    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    const composer = screen.getByLabelText('com_ui_message_input');
    fireEvent.change(composer, { target: { value: 'Check the primary source.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(mockControlMutate).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    expect(mockControlMutate).toHaveBeenCalledTimes(1);
    expect(mockControlMutate.mock.calls[0][0].command.action).toBe('steer');
  });

  /** A delivery re-keys the query to its new task and the task view blanks for
   *  the render or two that takes. Measured against the live panel, the
   *  composer used to unmount and remount inside 10ms there — taking focus and
   *  a half-typed steer with it. */
  it('keeps the composer mounted while a delivery re-keys the task view', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    /** A fresh element each time: React bails out of an update whose element is
     *  the very same object, so a reused tree would assert nothing. */
    const tree = () => (
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>
    );
    const { rerender } = render(tree());

    const composer = screen.getByLabelText('com_ui_message_input');
    fireEvent.change(composer, { target: { value: 'Half-typed steer.' } });

    /** The new task's view has not landed: `isPreviousData` withholds the task
     *  view precisely so task-scoped fields are not misattributed. */
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isPreviousData: true,
      isReadinessPending: false,
    });
    rerender(tree());

    expect(screen.getByLabelText('com_ui_message_input')).toHaveValue('Half-typed steer.');
    /** Present, but not submittable until the new task's own view arrives. */
    expect(screen.getByRole('button', { name: 'com_ui_steer_send' })).toBeDisabled();
  });

  /** A task on its way to an executor is live: withdrawing the composer until
   *  the first token lands is the swap this panel exists to avoid. But the
   *  server can only address a task that has a durable input row — it answers
   *  404 otherwise, which this panel reads as inaccessible and closes controls
   *  for good — so the field stays and submission waits instead. */
  it.each([
    ['has its durable input row', completedView.messages, 1],
    ['has not been written yet', [], 0],
  ])('keeps the composer while a dispatched task %s', (_label, messages, invocations) => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'dispatched', messages, controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    const composer = screen.getByLabelText('com_ui_message_input');
    expect(composer).toBeInTheDocument();
    /** Stop is a command too: on an unaddressable task it would 404 and close
     *  this task's controls for good, so the retained surface withholds it. It
     *  occupies the send slot only while the field is empty. */
    expect(screen.queryByRole('button', { name: 'com_ui_subagent_cancel_task' }) != null).toBe(
      invocations === 1,
    );

    fireEvent.change(composer, { target: { value: 'Check the primary source.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(mockControlMutate).toHaveBeenCalledTimes(invocations);
  });

  /** Every door onto a command answers to the same gate — including the inline
   *  controls a touch reader gets instead of the hovercard. */
  it('withholds the inline actions while a dispatched task is unaddressable', () => {
    mockCoarsePointer = true;
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'dispatched', messages: [], controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Check the primary source.' },
    });
    const queue = screen.getByRole('button', { name: 'com_ui_queue' });
    expect(queue).toBeDisabled();
    fireEvent.click(queue);
    expect(mockControlMutate).not.toHaveBeenCalled();
  });

  /** While the panel is a focus-trapped modal the portaled list sits outside
   *  the `aside` the trap knows, so Tab never reaches it — the actions come
   *  inside the panel instead, hover or no hover. */
  it('keeps the actions inside the panel while it is a modal', () => {
    mockIsMobile = true;
    mockCoarsePointer = false;
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Check the primary source.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_queue' }));

    expect(mockControlMutate).toHaveBeenCalledTimes(1);
    expect(mockControlMutate.mock.calls[0][0].command.action).toBe('queue');
  });

  /** Queue and interrupt keep the chords main chat gives them instead of
   *  spelling themselves out beside the field. */
  it.each([
    ['queue', { key: 'Enter', ctrlKey: true }, 'queue'],
    ['interrupt', { key: 'Enter', altKey: true }, 'interrupt'],
    ['steer', { key: 'Enter' }, 'steer'],
  ])('submits a %s from its chord', (_label, event, action) => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    const composer = screen.getByLabelText('com_ui_message_input');
    fireEvent.change(composer, { target: { value: 'Check the primary source.' } });
    fireEvent.keyDown(composer, event);

    expect(mockControlMutate).toHaveBeenCalledTimes(1);
    expect(mockControlMutate.mock.calls[0][0].command.action).toBe(action);
  });

  /** A chord the composer refuses must leave nothing behind: the next pointer
   *  click carries no event and therefore always means the default steer. */
  it('does not let a refused chord decide a later pointer submission', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    const composer = screen.getByLabelText('com_ui_message_input');
    /** Refused: the field is empty, so the composer never submits it. */
    fireEvent.keyDown(composer, { key: 'Enter', altKey: true });
    expect(mockControlMutate).not.toHaveBeenCalled();

    fireEvent.change(composer, { target: { value: 'Check the primary source.' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_steer_send' }));

    expect(mockControlMutate).toHaveBeenCalledTimes(1);
    expect(mockControlMutate.mock.calls[0][0].command.action).toBe('steer');
  });

  /** Where there is no hover, the send control's action list cannot be opened —
   *  a tap on that anchor submits — so those readers get the actions as
   *  controls of their own instead. */
  it('offers the alternate submissions inline when the pointer cannot hover', () => {
    mockIsMobile = true;
    mockCoarsePointer = true;
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Check the primary source.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_queue' }));

    expect(mockControlMutate).toHaveBeenCalledTimes(1);
    expect(mockControlMutate.mock.calls[0][0].command.action).toBe('queue');
  });

  /** Queue and interrupt keep a pointer of their own — a touch reader, or one
   *  whose shortcuts are off or rebound, still has to reach them. */
  it.each([
    ['com_ui_queue', 'queue'],
    ['com_ui_subagent_interrupt', 'interrupt'],
  ])('offers %s to a pointer', (label, action) => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Check the primary source.' },
    });
    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(mockControlMutate).toHaveBeenCalledTimes(1);
    expect(mockControlMutate.mock.calls[0][0].command.action).toBe(action);
  });

  it('submits one command invocation, blocks duplicate clicks, and shows its receipt', async () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Check the primary source.' },
    });
    const composer = screen.getByLabelText('com_ui_message_input');
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });

    expect(mockControlMutate).toHaveBeenCalledTimes(1);
    const [variables, callbacks] = mockControlMutate.mock.calls[0] as [
      {
        parentConversationId: string;
        threadId: string;
        command: { taskId: string; invocationId: string; action: string; message: string };
      },
      { onSuccess: (value: unknown) => void },
    ];
    expect(variables).toEqual({
      parentConversationId: 'parent-conversation',
      threadId: 'child-thread',
      submittedAt: expect.any(String),
      command: {
        taskId: 'task',
        invocationId: expect.any(String),
        action: 'queue',
        message: 'Check the primary source.',
      },
    });
    act(() => {
      callbacks.onSuccess({
        receipt: {
          invocationId: variables.command.invocationId,
          controlId: 'control-1',
          action: 'queue',
          status: 'accepted',
          createdAt: '2026-08-24T12:00:00.000Z',
          updatedAt: '2026-08-24T12:00:00.000Z',
        },
      });
    });
    expect(screen.getByText('accepted')).toBeInTheDocument();
    expect(screen.getByTestId('shared-activity')).toHaveAttribute('data-can-withdraw', 'true');
  });

  it('retries an unavailable owner with the same authoritative invocation id', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Use the primary source.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_steer_send' }));
    const firstCommand = mockControlMutate.mock.calls[0][0].command;
    act(() => {
      mockControlMutate.mock.calls[0][1].onError({ response: { status: 503 } });
    });

    expect(screen.getByLabelText('com_ui_message_input')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'com_ui_steer_send' })).toBeDisabled();
    expect(screen.getByTestId('shared-activity')).toHaveAttribute('data-can-withdraw', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));

    expect(mockControlMutate).toHaveBeenCalledTimes(2);
    expect(mockControlMutate.mock.calls[1][0].command).toEqual(firstCommand);
  });

  it('releases the composer after a definitive policy rejection', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Blocked guidance.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_steer_send' }));
    act(() => {
      mockControlMutate.mock.calls[0][1].onError({ response: { status: 400 } });
    });

    expect(screen.getByText('com_ui_subagent_control_reason_invalid_command')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_message_input')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'com_ui_steer_send' })).toBeEnabled();
  });

  it('retains an ambiguous invocation across closing and reopening the panel', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const PanelHost = () => {
      const current = useAtomValue(activeSubagentPanel);
      const setCurrent = useSetAtom(activeSubagentPanel);
      return current == null ? (
        <button type="button" onClick={() => setCurrent(selection)}>
          {selection.subagentType}
        </button>
      ) : (
        <SubagentThreadPanel selection={current} />
      );
    };
    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <PanelHost />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Use the primary source.' },
    });
    fireEvent.keyDown(screen.getByLabelText('com_ui_message_input'), {
      key: 'Enter',
      ctrlKey: true,
    });
    const firstCommand = mockControlMutate.mock.calls[0][0].command;
    act(() => {
      mockControlMutate.mock.calls[0][1].onError({ response: { status: 503 } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));
    fireEvent.click(screen.getByRole('button', { name: selection.subagentType }));

    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockControlMutate.mock.calls[1][0].command).toEqual(firstCommand);
  });

  it('retains an ambiguous invocation across a full page-state reload', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const first = render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Keep the same invocation.' },
    });
    fireEvent.keyDown(screen.getByLabelText('com_ui_message_input'), {
      key: 'Enter',
      ctrlKey: true,
    });
    const firstCommand = mockControlMutate.mock.calls[0][0].command;
    act(() => {
      mockControlMutate.mock.calls[0][1].onError({ response: { status: 503 } });
    });
    first.unmount();

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );
    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockControlMutate.mock.calls[1][0].command).toEqual(firstCommand);
  });

  it('records an ambiguous result after the panel closes before the mutation settles', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const PanelHost = () => {
      const current = useAtomValue(activeSubagentPanel);
      const setCurrent = useSetAtom(activeSubagentPanel);
      return current == null ? (
        <button type="button" onClick={() => setCurrent(selection)}>
          {selection.subagentType}
        </button>
      ) : (
        <SubagentThreadPanel selection={current} />
      );
    };
    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <PanelHost />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Retry after closing.' },
    });
    fireEvent.keyDown(screen.getByLabelText('com_ui_message_input'), {
      key: 'Enter',
      ctrlKey: true,
    });
    const firstCommand = mockControlMutate.mock.calls[0][0].command;
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));
    act(() => {
      mockControlMutate.mock.calls[0][1].onError({ response: { status: 503 } });
    });
    fireEvent.click(screen.getByRole('button', { name: selection.subagentType }));

    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockControlMutate.mock.calls[1][0].command).toEqual(firstCommand);
  });

  it('keeps an unavailable-owner retry visible if the child settles before the receipt appears', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const { rerender } = render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Use the primary source.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_steer_send' }));
    act(() => {
      mockControlMutate.mock.calls[0][1].onError({ response: { status: 503 } });
    });

    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    rerender(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(
      screen.getByText('com_ui_subagent_control_reason_owner_unavailable'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
    /** The settled child leaves the composer standing — Enter continues the
     *  thread from here — but nothing in it still addresses the finished run. */
    expect(screen.queryByRole('button', { name: 'com_ui_steer_send' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_subagent_cancel_task' }),
    ).not.toBeInTheDocument();
  });

  it('preserves drafted guidance when withdrawing an accepted control', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        status: 'running',
        controlReceipts: [
          {
            invocationId: 'accepted-control',
            controlId: 'control-1',
            action: 'queue',
            status: 'accepted',
            createdAt: '2026-08-24T12:00:00.000Z',
            updatedAt: '2026-08-24T12:00:00.000Z',
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    const composer = screen.getByLabelText('com_ui_message_input');
    fireEvent.change(composer, { target: { value: 'Keep this draft.' } });
    fireEvent.click(screen.getByTestId('withdraw-control'));
    const command = mockControlMutate.mock.calls[0][0].command;
    act(() => {
      mockControlMutate.mock.calls[0][1].onSuccess({
        receipt: {
          invocationId: command.invocationId,
          controlId: 'control-1',
          action: 'cancel_message',
          status: 'applied',
          createdAt: '2026-08-24T12:00:01.000Z',
          updatedAt: '2026-08-24T12:00:01.000Z',
        },
      });
    });

    expect(composer).toHaveValue('Keep this draft.');
  });

  it('clears transient retry state when refresh returns the same durable invocation', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const { rerender } = render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Use the primary source.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_steer_send' }));
    const command = mockControlMutate.mock.calls[0][0].command;
    act(() => {
      mockControlMutate.mock.calls[0][1].onError({ response: { status: 503 } });
    });
    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(1);

    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        status: 'running',
        controlReceipts: [
          {
            invocationId: command.invocationId,
            action: 'steer',
            status: 'applied',
            createdAt: '2026-08-24T12:00:00.000Z',
            updatedAt: '2026-08-24T12:00:01.000Z',
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    rerender(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(screen.getByText('applied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_message_input')).toHaveValue('');
    expect(
      screen.queryByText('com_ui_subagent_control_reason_owner_unavailable'),
    ).not.toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('closes stale running controls after task cancellation is applied', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_cancel_task' }));
    const command = mockControlMutate.mock.calls[0][0].command;
    act(() => {
      mockControlMutate.mock.calls[0][1].onSuccess({
        receipt: {
          invocationId: command.invocationId,
          action: 'cancel',
          status: 'applied',
          createdAt: '2026-08-24T12:00:00.000Z',
          updatedAt: '2026-08-24T12:00:01.000Z',
        },
      });
    });

    expect(screen.queryByLabelText('com_ui_message_input')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_subagent_cancel_task' }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('shared-activity')).toHaveAttribute('data-can-withdraw', 'false');
  });

  it('reports an inaccessible task without offering a misleading retry', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_cancel_task' }));
    act(() => {
      mockControlMutate.mock.calls[0][1].onError({ response: { status: 404 } });
    });

    expect(
      screen.getByText('com_ui_subagent_control_reason_task_inaccessible'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('com_ui_message_input')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_subagent_cancel_task' }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('shared-activity')).toHaveAttribute('data-can-withdraw', 'false');
  });

  it('renders rejected and refreshed applied receipts independently from child status', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        status: 'running',
        controlReceipts: [
          {
            invocationId: 'persisted',
            action: 'interrupt',
            status: 'applied',
            createdAt: '2026-08-24T12:00:00.000Z',
            updatedAt: '2026-08-24T12:00:01.000Z',
          },
          {
            invocationId: 'terminal-race',
            action: 'steer',
            status: 'rejected',
            createdAt: '2026-08-24T12:00:02.000Z',
            updatedAt: '2026-08-24T12:00:03.000Z',
            reason: 'task_completed',
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(screen.getByText('applied')).toBeInTheDocument();
    expect(screen.getByText('rejected')).toBeInTheDocument();
    expect(screen.getByTestId('shared-activity')).toHaveAttribute('data-status', 'running');
    expect(screen.queryByLabelText('com_ui_message_input')).not.toBeInTheDocument();
    expect(screen.getByTestId('shared-activity')).toHaveAttribute('data-can-withdraw', 'false');
  });

  it('does not expose task controls after the selected child is terminal', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(screen.queryByRole('button', { name: 'com_ui_steer_send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_queue' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_subagent_cancel_task' }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('shared-activity')).toHaveAttribute('data-can-withdraw', 'false');
  });

  it('renders foreground persisted activity through the same shared panel without a durable read', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const foreground: ActiveSubagentPanel = {
      host: 'conversation',
      parentConversationId: 'parent-conversation',
      parentMessageId: 'parent-message',
      toolCallId: 'foreground-call',
      partIndex: 3,
      subagentType: 'researcher',
      prompt: 'Review this change.',
      persistedContent: [
        { type: 'text', text: 'Review complete.' },
      ] as unknown as TMessageContentParts[],
      initialProgress: 1,
      isSubmitting: false,
    };

    render(
      <Root>
        <SubagentThreadPanel selection={foreground} />
      </Root>,
    );

    expect(screen.getByText('Review this change.')).toBeInTheDocument();
    expect(screen.getByText('Review complete.')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute('data-state', 'ready');
    expect(
      screen.queryByRole('button', { name: 'com_ui_subagent_continue_new_chat' }),
    ).not.toBeInTheDocument();
  });

  it('continues a completed durable agent task as an ordinary conversation snapshot', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    /** The settled thread keeps ONE composer: Enter continues from it, and what
     *  the reader typed rides along instead of being discarded with the panel. */
    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Take this further.' },
    });
    fireEvent.keyDown(screen.getByLabelText('com_ui_message_input'), { key: 'Enter' });
    expect(mockForkMutate).toHaveBeenCalledWith(
      {
        conversationId: 'child-thread',
        messageId: 'task:assistant',
        option: ForkOptions.DIRECT_PATH,
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );

    const mutationOptions = mockForkMutate.mock.calls[0][1];
    const conversation = { conversationId: 'continued-chat', agent_id: 'agent-1' };
    /** Typed AFTER the request went out: the fork lands a round trip later and
     *  the composer stays live for it, so the newer words are the ones that
     *  travel. */
    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Take this further, starting from the endgame.' },
    });
    act(() => mutationOptions.onSuccess({ conversation, messages: [] }));
    expect(mockNavigateToConvo).toHaveBeenCalledWith(conversation);
    /** In memory, never in the composer draft store: an unsent draft must not
     *  be written to storage a reader may have asked not to use. */
    expect(mockHandOffComposerText).toHaveBeenCalledWith(
      'continued-chat',
      'Take this further, starting from the endgame.',
    );
    expect(getDraft('continued-chat')).toBe('');
  });

  /** The composer is shared across selections, so a continuation that lands
   *  after the reader has moved on must hand over the words IT was sent with,
   *  and must not take the words now in front of them. */
  it('binds the continuation draft to the selection that asked for it', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const { rerender } = render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Keep going on the first task.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_continue_new_chat' }));

    /** A different selection owns the composer now — same child thread, but the
     *  panel is showing it for another parent, so its control identity (and its
     *  draft) is not the one the fork was sent from. */
    const laterSelection = { ...selection, parentConversationId: 'other-parent-conversation' };
    rerender(
      <Root>
        <SubagentThreadPanel selection={laterSelection} />
      </Root>,
    );
    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'A different question entirely.' },
    });

    const conversation = { conversationId: 'continued-chat', agent_id: 'agent-1' };
    act(() => mockForkMutate.mock.calls[0][1].onSuccess({ conversation, messages: [] }));

    expect(mockHandOffComposerText).toHaveBeenCalledWith(
      'continued-chat',
      'Keep going on the first task.',
    );
    expect(screen.getByLabelText('com_ui_message_input')).toHaveValue(
      'A different question entirely.',
    );
  });

  /** The cap belongs to the bounded control command, not to ordinary chat text
   *  bound for a composer that caps nothing. */
  it.each([
    ['a live run composes a bounded control command', 'running' as const, 4096],
    ['a settled run composes an ordinary continuation', 'completed' as const, null],
  ])('caps the field only while %s', (_label, status, expected) => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status, controlReceipts: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, selection)}>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    const composer = screen.getByLabelText('com_ui_message_input');
    expect(composer.getAttribute('maxlength')).toBe(expected == null ? null : String(expected));
  });

  /** The panel holds the draft that travels with a continuation, so nothing may
   *  swap the composer for another actor's while that request is out. */
  it('freezes the actor picker while a continuation is in flight', () => {
    const first: ParentSubagentSummary = {
      threadId: 'child-thread',
      parentMessageId: 'parent-message',
      subagentType: 'agent-1',
      subagentKind: 'agent',
      agentId: 'agent-1',
      title: 'First actor',
      origin: 'event',
      actorId: 'actor-1',
      status: 'completed',
      latestTaskId: 'task',
      tasks: [{ taskId: 'task', status: 'completed' }],
      tasksTruncated: false,
    };
    const second: ParentSubagentSummary = {
      ...first,
      threadId: 'child-thread-2',
      subagentType: 'agent-2',
      agentId: 'agent-2',
      title: 'Second actor',
      actorId: 'actor-2',
      latestTaskId: 'task-2',
      tasks: [{ taskId: 'task-2', status: 'completed' }],
    };
    mockParentChildrenByMessage = new Map([['parent-message', [first, second]]]);
    mockParentChildrenByThread = new Map([
      [first.threadId, first],
      [second.threadId, second],
    ]);
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const eventSelection: ActiveSubagentPanel = {
      ...selection,
      event: { actorId: 'actor-1', progressKey: 'event-task:child-thread:task' },
    };

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, eventSelection)}>
        <SubagentThreadPanel selection={eventSelection} />
      </Root>,
    );

    expect(screen.getByRole('combobox', { name: 'com_ui_subagent_actor' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_continue_new_chat' }));
    expect(screen.getByRole('combobox', { name: 'com_ui_subagent_actor' })).toBeDisabled();

    act(() => mockForkMutate.mock.calls[0][1].onError());
    expect(screen.getByRole('combobox', { name: 'com_ui_subagent_actor' })).toBeEnabled();
  });

  /** An advance changes the control identity, which empties the composer, so
   *  unsent words hold the selection wherever they came from: typed and not yet
   *  sent, or left behind by a continuation that failed and is waiting to be
   *  retried. The hold lifts once the draft is gone. */
  it.each([
    ['a draft that was never submitted', false],
    ['a draft left behind by a failed continuation', true],
  ])('holds the selection for %s', (_label, submitAndFail) => {
    const actor: ParentSubagentSummary = {
      threadId: 'child-thread',
      parentMessageId: 'parent-message',
      subagentType: 'agent-1',
      subagentKind: 'agent',
      agentId: 'agent-1',
      title: 'First actor',
      origin: 'event',
      actorId: 'actor-1',
      status: 'completed',
      latestTaskId: 'task',
      tasks: [{ taskId: 'task', status: 'completed' }],
      tasksTruncated: false,
    };
    const withNewerTask: ParentSubagentSummary = {
      ...actor,
      latestTaskId: 'task-newer',
      tasks: [
        { taskId: 'task-newer', status: 'completed' },
        { taskId: 'task', status: 'completed' },
      ],
    };
    mockParentChildrenByMessage = new Map([['parent-message', [actor]]]);
    mockParentChildrenByThread = new Map([[actor.threadId, actor]]);
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    let active: ActiveSubagentPanel | null = null;
    const Observer = () => {
      active = useAtomValue(activeSubagentPanel);
      return null;
    };
    const eventSelection: ActiveSubagentPanel = {
      ...selection,
      event: { actorId: 'actor-1', progressKey: 'event-task:child-thread:task' },
    };

    /** A fresh element each time: React bails out of an update whose element is
     *  the very same object, so a reused tree would assert nothing. */
    const tree = () => (
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, eventSelection)}>
        <Observer />
        <SubagentThreadPanel selection={eventSelection} />
      </Root>
    );
    const { rerender } = render(tree());

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Try that again.' },
    });
    if (submitAndFail) {
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_continue_new_chat' }));
    }

    mockParentChildrenByThread = new Map([[actor.threadId, withNewerTask]]);
    mockParentChildrenByMessage = new Map([['parent-message', [withNewerTask]]]);
    rerender(tree());
    if (submitAndFail) {
      act(() => mockForkMutate.mock.calls[0][1].onError());
    }
    rerender(tree());

    expect(screen.getByLabelText('com_ui_message_input')).toHaveValue('Try that again.');
    expect((active as ActiveSubagentPanel | null)?.durable?.taskId).toBe('task');

    /** Draft gone, nothing left to protect: the panel follows the actor again. */
    fireEvent.change(screen.getByLabelText('com_ui_message_input'), { target: { value: '' } });
    rerender(tree());
    expect((active as ActiveSubagentPanel | null)?.durable?.taskId).toBe('task-newer');
  });

  /** Emptying the field after asking to continue is the reader withdrawing the
   *  words, not leaving them behind — the destination must not reinstate what
   *  they deleted. */
  it('hands over nothing when the draft is cleared before the fork lands', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'On second thought.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_continue_new_chat' }));
    fireEvent.change(screen.getByLabelText('com_ui_message_input'), { target: { value: '' } });

    const conversation = { conversationId: 'continued-chat', agent_id: 'agent-1' };
    act(() => mockForkMutate.mock.calls[0][1].onSuccess({ conversation, messages: [] }));

    expect(mockNavigateToConvo).toHaveBeenCalledWith(conversation);
    expect(mockHandOffComposerText).not.toHaveBeenCalled();
  });

  it('continues with no draft when the reader asks for the chat without typing', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_continue_new_chat' }));
    const mutationOptions = mockForkMutate.mock.calls[0][1];
    const conversation = { conversationId: 'empty-continuation', agent_id: 'agent-1' };
    act(() => mutationOptions.onSuccess({ conversation, messages: [] }));
    expect(mockNavigateToConvo).toHaveBeenCalledWith(conversation);
    expect(mockHandOffComposerText).not.toHaveBeenCalled();
  });

  it.each([
    ['a running task', { ...completedView, status: 'running' as const }],
    ['a graph child', { ...completedView, subagentKind: 'graph' as const, agentId: undefined }],
    ['a child without an agent identity', { ...completedView, agentId: undefined }],
  ])('does not offer human continuation for %s', (_label, view) => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: view,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(
      screen.queryByRole('button', { name: 'com_ui_subagent_continue_new_chat' }),
    ).not.toBeInTheDocument();
  });

  it('reports continuation failures without closing the child panel', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.change(screen.getByLabelText('com_ui_message_input'), {
      target: { value: 'Carry this over.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_continue_new_chat' }));
    act(() => mockForkMutate.mock.calls[0][1].onError());
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_continue_chat_error',
      status: 'error',
    });
    expect(screen.getByRole('region')).toBeInTheDocument();
    /** The panel stays open on this path and never took the words away, so the
     *  reader can retry with them still in front of them. */
    expect(screen.getByLabelText('com_ui_message_input')).toHaveValue('Carry this over.');
  });

  it('renders newer detached progress instead of a dispatch-time parent snapshot', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running', activity: [] },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const progressKey = subagentProgressKey(
      selection.parentMessageId,
      selection.toolCallId,
      selection.partIndex,
    );
    const detachedSelection: ActiveSubagentPanel = {
      ...selection,
      persistedContent: [
        { type: ContentTypes.TEXT, text: 'Dispatch-time snapshot.' },
      ] as TMessageContentParts[],
    };

    render(
      <Root
        seed={(jotai) =>
          jotai.set(subagentProgressByToolCallId(progressKey), {
            subagentRunId: 'child-run',
            subagentType: 'researcher',
            status: 'message_delta',
            contentParts: [{ type: ContentTypes.TEXT, text: 'latest detached text.' }],
            aggregatorState: initSubagentAggregatorState(),
            tickerState: initSubagentTickerState(),
            coverage: 'suffix',
          })
        }
      >
        <SubagentThreadPanel selection={detachedSelection} />
      </Root>,
    );

    expect(screen.getByText('Dispatch-time snapshot.latest detached text.')).toBeInTheDocument();
  });

  it('resets invocation-scoped approval state when the selected card changes', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const { rerender } = render(
      <Root>
        <SubagentThreadPanel selection={{ ...selection, durable: undefined }} />
      </Root>,
    );

    expect(mockApprovalProviderMounted).toHaveBeenCalledTimes(1);
    expect(mockApprovalProviderUnmounted).not.toHaveBeenCalled();

    rerender(
      <Root>
        <SubagentThreadPanel
          selection={{ ...selection, partIndex: selection.partIndex + 1, durable: undefined }}
        />
      </Root>,
    );

    expect(mockApprovalProviderUnmounted).toHaveBeenCalledTimes(1);
    expect(mockApprovalProviderMounted).toHaveBeenCalledTimes(2);
  });

  it('keeps an expected pre-reservation 404 in the readiness state', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isReadinessPending: true,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute('data-state', 'loading');
    expect(screen.queryByTestId('shared-activity')).not.toBeInTheDocument();
    expect(mockUseSubagentActivityStream).toHaveBeenLastCalledWith(selection, true);
  });

  it('opens live activity before the durable child becomes addressable', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isReadinessPending: true,
    });

    const { rerender } = render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );
    expect(mockUseSubagentActivityStream).toHaveBeenLastCalledWith(selection, true);

    mockUseSubagentThreadQuery.mockReturnValue({
      data: { ...completedView, status: 'running' },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    rerender(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(mockUseSubagentActivityStream).toHaveBeenLastCalledWith(selection, true);
  });

  it('keeps streaming when terminal thread state belongs to an older task', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        messages: [{ ...completedView.messages[1], messageId: 'older-task:assistant' }],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(mockUseSubagentActivityStream).toHaveBeenLastCalledWith(selection, true);
  });

  it('revalidates a cached terminal event task when its lease resumes', async () => {
    const refetch = jest.fn().mockResolvedValue({ data: { ...completedView, status: 'running' } });
    const eventSelection: ActiveSubagentPanel = {
      ...selection,
      event: { actorId: 'actor-1', progressKey: 'event-task:child-thread:task' },
    };
    mockParentChildrenByThread = new Map([
      [
        'child-thread',
        {
          threadId: 'child-thread',
          parentMessageId: 'parent-message',
          subagentType: 'agent-1',
          subagentKind: 'agent',
          title: 'Event child',
          origin: 'event',
          actorId: 'actor-1',
          status: 'running',
          latestTaskId: 'task',
          tasks: [{ taskId: 'task', status: 'running' }],
          tasksTruncated: false,
        },
      ],
    ]);
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
      refetch,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={eventSelection} />
      </Root>,
    );

    expect(mockUseSubagentThreadQuery).toHaveBeenCalledWith(
      'parent-conversation',
      'child-thread',
      'task',
      { keepPreviousData: true, refetchInterval: 2000 },
    );
    expect(mockUseSubagentActivityStream).toHaveBeenLastCalledWith(eventSelection, true);
    expect(
      screen.queryByRole('combobox', { name: 'com_ui_subagent_turn' }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it('surfaces a durable read failure after the readiness window', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute('data-state', 'error');
    expect(screen.queryByTestId('shared-activity')).not.toBeInTheDocument();
  });

  it('shows live detached activity while its durable view is still becoming ready', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root
        seed={(jotai) =>
          jotai.set(
            subagentProgressByToolCallId(
              subagentProgressKey(
                selection.parentMessageId,
                selection.toolCallId,
                selection.partIndex,
              ),
            ),
            {
              subagentRunId: 'run',
              subagentType: 'researcher',
              status: 'message_delta',
              contentParts: [{ type: ContentTypes.TEXT, text: 'Live child update.' }],
              aggregatorState: initSubagentAggregatorState(),
              tickerState: initSubagentTickerState(),
            },
          )
        }
      >
        <SubagentThreadPanel selection={{ ...selection, runStepStatus: 'completed' }} />
      </Root>,
    );

    expect(screen.getByText('Live child update.')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute('data-state', 'ready');
    expect(screen.queryByTestId('shared-activity')).not.toBeInTheDocument();
  });

  it('exposes the focus-trapped mobile overlay as a modal dialog', () => {
    mockIsMobile = true;
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('navigates event actors and renders exact durable turns as one chronological thread', () => {
    const first: ParentSubagentSummary = {
      threadId: 'child-thread',
      parentMessageId: 'parent-message',
      subagentType: 'agent-1',
      subagentKind: 'agent',
      agentId: 'agent-1',
      title: 'First actor',
      origin: 'event',
      actorId: 'actor-1',
      status: 'completed',
      latestTaskId: 'task',
      tasks: [
        { taskId: 'task', status: 'completed' },
        { taskId: 'task-earlier', status: 'completed' },
      ],
      tasksTruncated: false,
    };
    const second: ParentSubagentSummary = {
      ...first,
      threadId: 'child-thread-2',
      subagentType: 'agent-2',
      agentId: 'agent-2',
      title: 'Second actor',
      actorId: 'actor-2',
      latestTaskId: 'task-2',
      tasks: [{ taskId: 'task-2', status: 'running' }],
      status: 'running',
    };
    mockParentChildrenByMessage = new Map([
      ['parent-message', [first]],
      ['assistant-message', [second]],
    ]);
    mockParentChildrenByThread = new Map([
      [first.threadId, first],
      [second.threadId, second],
    ]);
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const eventSelection: ActiveSubagentPanel = {
      ...selection,
      event: {
        actorId: 'actor-1',
        progressKey: 'event-task:child-thread:task',
        siblingParentMessageIds: ['parent-message', 'assistant-message'],
      },
    };
    let active: ActiveSubagentPanel | null = eventSelection;
    const Observer = () => {
      active = useAtomValue(activeSubagentPanel);
      return null;
    };

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, eventSelection)}>
        <Observer />
        <SubagentThreadPanel selection={eventSelection} />
      </Root>,
    );

    expect(screen.queryByRole('button', { name: 'com_ui_subagent_turn' })).not.toBeInTheDocument();
    const turns = screen.getAllByTestId('shared-activity');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveAttribute(
      'data-activity-id',
      'parent-message\u0000tool-call\u0000task-earlier',
    );
    expect(turns[1]).toHaveAttribute('data-activity-id', 'parent-message\u0000tool-call\u0000task');
    expect(mockUseSubagentThreadQuery).toHaveBeenCalledWith(
      'parent-conversation',
      'child-thread',
      'task-earlier',
    );

    fireEvent.click(screen.getByRole('option', { name: /Analyst Two/ }));
    expect(active).toEqual(
      expect.objectContaining({
        subagentType: 'agent-2',
        event: {
          actorId: 'actor-2',
          progressKey: 'event-task:child-thread-2:task-2',
          siblingParentMessageIds: ['parent-message', 'assistant-message'],
        },
        durable: { threadId: 'child-thread-2', taskId: 'task-2' },
      }),
    );
    expect(mockRefreshParentChildren).toHaveBeenCalled();
  });

  /** The picker's popover renders inside the panel so the mobile focus trap can
   *  see it. That same trap closes the panel on Escape, which would take the
   *  composer's text with it — so an Escape aimed at the open picker has to
   *  stop there. */
  /** The picker's popover renders inside the panel so the mobile focus trap can
   *  see it. That same trap closes the panel on Escape, which would take the
   *  composer's text with it — so an Escape aimed at the OPEN picker has to stop
   *  there, while an Escape anywhere else still closes the panel. */
  it.each([
    ['closes the panel when the actor picker is shut', false, true],
    ['is left to the actor picker while it is open', true, false],
  ])('Escape %s', (_label, openPicker, expectsClose) => {
    const first: ParentSubagentSummary = {
      threadId: 'child-thread',
      parentMessageId: 'parent-message',
      subagentType: 'agent-1',
      subagentKind: 'agent',
      agentId: 'agent-1',
      title: 'First actor',
      origin: 'event',
      actorId: 'actor-1',
      status: 'completed',
      latestTaskId: 'task',
      tasks: [{ taskId: 'task', status: 'completed' }],
      tasksTruncated: false,
    };
    const second: ParentSubagentSummary = {
      ...first,
      threadId: 'child-thread-2',
      subagentType: 'agent-2',
      agentId: 'agent-2',
      title: 'Second actor',
      actorId: 'actor-2',
      latestTaskId: 'task-2',
      tasks: [{ taskId: 'task-2', status: 'completed' }],
    };
    mockParentChildrenByMessage = new Map([['parent-message', [first, second]]]);
    mockParentChildrenByThread = new Map([
      [first.threadId, first],
      [second.threadId, second],
    ]);
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    mockIsMobile = true;
    let active: ActiveSubagentPanel | null = null;
    const Observer = () => {
      active = useAtomValue(activeSubagentPanel);
      return null;
    };
    const eventSelection: ActiveSubagentPanel = {
      ...selection,
      event: { actorId: 'actor-1', progressKey: 'event-task:child-thread:task' },
    };

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, eventSelection)}>
        <Observer />
        <SubagentThreadPanel selection={eventSelection} />
      </Root>,
    );

    const picker = screen.getByRole('combobox', { name: 'com_ui_subagent_actor' });
    if (openPicker) fireEvent.click(picker);
    fireEvent.keyDown(picker, { key: 'Escape' });

    expect(active == null).toBe(expectsClose);
  });

  it('keeps a single event actor in the compact header without a duplicate selector', () => {
    const eventChild: ParentSubagentSummary = {
      threadId: 'child-thread',
      parentMessageId: 'parent-message',
      subagentType: 'agent-1',
      subagentKind: 'agent',
      agentId: 'agent-1',
      title: 'First actor',
      origin: 'event',
      actorId: 'actor-1',
      status: 'completed',
      latestTaskId: 'task',
      tasks: [{ taskId: 'task', status: 'completed' }],
      tasksTruncated: false,
    };
    mockParentChildrenByMessage = new Map([['parent-message', [eventChild]]]);
    mockParentChildrenByThread = new Map([[eventChild.threadId, eventChild]]);
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel
          selection={{
            ...selection,
            event: { actorId: 'actor-1', progressKey: 'event-task:child-thread:task' },
          }}
        />
      </Root>,
    );

    expect(screen.getByRole('heading', { name: 'Analyst One' })).toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'com_ui_subagent_actor' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_depth')).not.toBeInTheDocument();
  });

  it.each([
    ['newest known task', 'task-new', 'last'],
    ['displaced older task', 'task-old-displaced', 'first'],
  ] as const)(
    'places a turn missing from the durable window per its identity: %s',
    (_label, selectedTaskId, position) => {
      mockParentChildrenByThread = new Map([
        [
          'child-thread',
          {
            threadId: 'child-thread',
            parentMessageId: 'parent-message',
            parentToolCallId: 'tool-call',
            subagentType: 'researcher',
            subagentKind: 'agent',
            title: 'Research child',
            origin: 'tool',
            status: 'running',
            latestTaskId: 'task-new',
            tasks: [{ taskId: 'task-new', status: 'running' }],
            tasksTruncated: false,
          } as ParentSubagentSummary,
        ],
      ]);
      mockUseSubagentThreadQuery.mockReturnValue({
        data: {
          ...completedView,
          turns: [
            {
              taskId: 'task-durable',
              trigger: { kind: 'parent_dispatch', summary: 'Durable window turn' },
              status: 'completed',
              activity: [{ type: 'writing', text: 'Durable result' }],
              activityTruncated: false,
              messages: [],
            },
          ],
        },
        isLoading: false,
        isError: false,
        isReadinessPending: false,
      });
      const missingSelection: ActiveSubagentPanel = {
        ...selection,
        prompt: 'Synthesized window turn',
        durable: { threadId: 'child-thread', taskId: selectedTaskId },
      };
      render(
        <Root seed={(jotai) => jotai.set(activeSubagentPanel, missingSelection)}>
          <SubagentThreadPanel selection={missingSelection} />
        </Root>,
      );

      const turns = screen.getAllByTestId('conversation-turn');
      expect(turns).toHaveLength(2);
      const synthesizedIndex = position === 'last' ? 1 : 0;
      expect(turns[synthesizedIndex]).toHaveTextContent('Synthesized window turn');
      expect(turns[1 - synthesizedIndex]).toHaveTextContent('Durable window turn');
    },
  );

  it('loads an exact older turn projection only after the local disclosure is opened', async () => {
    const truncatedView: SubagentThreadView = {
      ...completedView,
      turns: [
        {
          taskId: 'task-old',
          trigger: { kind: 'parent_dispatch', summary: 'Old prompt' },
          status: 'completed',
          activity: [],
          activityTruncated: true,
          messages: [],
        },
        {
          taskId: 'task',
          trigger: { kind: 'parent_continuation', summary: 'Current prompt' },
          status: 'completed',
          activity: [{ type: 'writing', text: 'Current result' }],
          activityTruncated: false,
          messages: [],
        },
      ],
    };
    mockUseSubagentThreadQuery.mockReturnValue({
      data: truncatedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    mockGetSubagentThread.mockResolvedValue({
      ...completedView,
      activity: [{ type: 'writing', text: 'Loaded exact activity' }],
      activityTruncated: false,
      messages: [
        {
          messageId: 'task-old:assistant',
          parentMessageId: 'task-old:user',
          role: 'assistant',
          text: 'Loaded exact activity',
        },
      ],
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(mockGetSubagentThread).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'load-task-old' }));
    await waitFor(() => expect(screen.getByText('Loaded exact activity')).toBeInTheDocument());
    expect(mockGetSubagentThread).toHaveBeenCalledTimes(1);
    expect(mockGetSubagentThread).toHaveBeenCalledWith(
      'parent-conversation',
      'child-thread',
      'task-old',
    );
  });

  it('retains partial activity when an exact historical task has vanished', async () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        turns: [
          {
            taskId: 'task-old',
            trigger: { kind: 'parent_dispatch', summary: 'Retained prompt' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Retained partial result' }],
            activityTruncated: true,
            messages: [],
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    mockGetSubagentThread.mockResolvedValue({
      ...completedView,
      activity: [],
      activityTruncated: false,
      messages: [],
      turns: [],
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'load-task-old' }));
    await waitFor(() =>
      expect(screen.getAllByTestId('conversation-turn')[1]).toHaveTextContent('unavailable'),
    );
    expect(screen.getByText('Retained partial result')).toBeInTheDocument();
  });

  it('prepends an older bounded page without adding it to live polling', async () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        nextCursor: 'older:assistant',
        turns: [
          {
            taskId: 'task',
            trigger: { kind: 'parent_dispatch', summary: 'Current prompt' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Current result' }],
            activityTruncated: false,
            messages: [],
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    mockGetSubagentThread.mockResolvedValue({
      ...completedView,
      activity: [],
      messages: [],
      historyTruncated: false,
      turns: [
        {
          taskId: 'older',
          trigger: { kind: 'parent_dispatch', summary: 'Older prompt' },
          status: 'completed',
          activity: [{ type: 'writing', text: 'Older result' }],
          activityTruncated: false,
          messages: [],
        },
      ],
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2));
    expect(mockGetSubagentThread).toHaveBeenCalledWith(
      'parent-conversation',
      'child-thread',
      undefined,
      'older:assistant',
    );
    expect(mockUseSubagentThreadQuery.mock.calls.every((call) => call[2] === 'task')).toBe(true);
  });

  it('discards an older-page response when the latest cursor generation advances', async () => {
    let resolveOlderPage: (view: SubagentThreadView) => void = () => undefined;
    const olderPage = new Promise<SubagentThreadView>((resolve) => {
      resolveOlderPage = resolve;
    });
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        nextCursor: 'older-a:assistant',
        turns: [
          {
            taskId: 'task',
            trigger: { kind: 'parent_dispatch', summary: 'Current prompt' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Current result' }],
            activityTruncated: false,
            messages: [],
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    mockGetSubagentThread.mockReturnValueOnce(olderPage);

    const { rerender } = render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));

    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        nextCursor: 'older-b:assistant',
        turns: [
          {
            taskId: 'task-new',
            trigger: { kind: 'parent_continuation', summary: 'New prompt' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'New result' }],
            activityTruncated: false,
            messages: [],
          },
          {
            taskId: 'task',
            trigger: { kind: 'parent_dispatch', summary: 'Current prompt' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Current result' }],
            activityTruncated: false,
            messages: [],
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    rerender(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    await act(async () => {
      resolveOlderPage({
        ...completedView,
        activity: [],
        messages: [],
        turns: [
          {
            taskId: 'older-a',
            trigger: { kind: 'parent_dispatch', summary: 'Displaced prompt' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Displaced result' }],
            activityTruncated: false,
            messages: [],
          },
        ],
      });
      await olderPage;
    });

    expect(screen.queryByText('Displaced result')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }),
      ).toBeEnabled(),
    );
  });

  it('shows only the retry control after an earlier-history request fails', async () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        nextCursor: 'older:assistant',
        turns: [
          {
            taskId: 'task',
            trigger: { kind: 'parent_dispatch', summary: 'Current prompt' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Current result' }],
            activityTruncated: false,
            messages: [],
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    mockGetSubagentThread.mockRejectedValueOnce(new Error('history unavailable'));

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeEnabled());
    expect(
      screen.queryByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }),
    ).not.toBeInTheDocument();
  });

  it('shows a compact inaccessible-history boundary when no recovery cursor exists', () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        historyTruncated: true,
        turns: [
          {
            taskId: 'task',
            trigger: { kind: 'parent_dispatch', summary: 'Current prompt' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Current result' }],
            activityTruncated: false,
            messages: [],
          },
        ],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    expect(
      screen.getByRole('status', { name: 'com_ui_subagent_thread_history_truncated' }),
    ).toHaveTextContent('•••');
    expect(
      screen.queryByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }),
    ).not.toBeInTheDocument();
  });

  it('preserves an unrecoverable boundary while loading later cursor pages', async () => {
    mockUseSubagentThreadQuery.mockReturnValue({
      data: {
        ...completedView,
        nextCursor: 'older:assistant',
        turns: [],
      },
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    mockGetSubagentThread
      .mockResolvedValueOnce({
        ...completedView,
        nextCursor: 'oldest:assistant',
        historyTruncated: true,
        historyUnavailable: true,
        activity: [],
        messages: [],
        turns: [],
      })
      .mockResolvedValueOnce({
        ...completedView,
        historyTruncated: false,
        activity: [],
        messages: [],
        turns: [],
      });

    render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));
    await waitFor(() =>
      expect(mockGetSubagentThread).toHaveBeenLastCalledWith(
        'parent-conversation',
        'child-thread',
        undefined,
        'older:assistant',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));
    await waitFor(() =>
      expect(mockGetSubagentThread).toHaveBeenLastCalledWith(
        'parent-conversation',
        'child-thread',
        undefined,
        'oldest:assistant',
      ),
    );

    expect(
      screen.getByRole('status', { name: 'com_ui_subagent_thread_history_truncated' }),
    ).toHaveTextContent('•••');
  });

  it('preserves a cursorless truncated boundary after the latest polling window moves', async () => {
    let latestView: SubagentThreadView = {
      ...completedView,
      historyTruncated: true,
      historyUnavailable: undefined,
      nextCursor: undefined,
      turns: [],
    };
    mockUseSubagentThreadQuery.mockImplementation(() => ({
      data: latestView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    }));

    const { rerender } = render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );
    expect(
      screen.getByRole('status', { name: 'com_ui_subagent_thread_history_truncated' }),
    ).toBeInTheDocument();

    latestView = {
      ...latestView,
      historyTruncated: false,
      nextCursor: 'new-boundary:assistant',
    };
    rerender(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: 'com_ui_subagent_thread_history_truncated' }),
      ).toBeInTheDocument(),
    );
  });

  it('rejects stale exact-detail responses across an actor A-B-A switch', async () => {
    let resolveStaleDetail: (view: SubagentThreadView) => void = () => undefined;
    const staleDetail = new Promise<SubagentThreadView>((resolve) => {
      resolveStaleDetail = resolve;
    });
    const viewFor = (threadId: string, taskId: string): SubagentThreadView => ({
      ...completedView,
      threadId,
      activity: [],
      activityTruncated: true,
      messages: [],
      turns: [
        {
          taskId,
          trigger: { kind: 'parent_dispatch', summary: `${threadId} prompt` },
          status: 'completed',
          activity: [],
          activityTruncated: true,
          messages: [],
        },
      ],
    });
    mockUseSubagentThreadQuery.mockImplementation(
      (_parentConversationId: string, requestedThreadId: string, requestedTaskId: string) => ({
        data: viewFor(requestedThreadId, requestedTaskId),
        isLoading: false,
        isError: false,
        isReadinessPending: false,
      }),
    );
    mockGetSubagentThread.mockReturnValueOnce(staleDetail).mockResolvedValueOnce({
      ...completedView,
      threadId: 'thread-a',
      activity: [{ type: 'writing', text: 'Fresh detail' }],
      activityTruncated: false,
      messages: [
        {
          messageId: 'task-a:assistant',
          parentMessageId: 'task-a:user',
          role: 'assistant',
          text: 'Fresh detail',
        },
      ],
    });
    const selectionA: ActiveSubagentPanel = {
      ...selection,
      durable: { threadId: 'thread-a', taskId: 'task-a' },
    };
    const selectionB: ActiveSubagentPanel = {
      ...selection,
      durable: { threadId: 'thread-b', taskId: 'task-b' },
    };

    const { rerender } = render(
      <Root>
        <SubagentThreadPanel selection={selectionA} />
      </Root>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'load-task-a' }));
    rerender(
      <Root>
        <SubagentThreadPanel selection={selectionB} />
      </Root>,
    );
    rerender(
      <Root>
        <SubagentThreadPanel selection={selectionA} />
      </Root>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'load-task-a' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'load-task-a' }));
    await waitFor(() => expect(screen.getByText('Fresh detail')).toBeInTheDocument());

    await act(async () => {
      resolveStaleDetail({
        ...completedView,
        threadId: 'thread-a',
        activity: [{ type: 'writing', text: 'Stale detail' }],
        activityTruncated: false,
        messages: [],
      });
      await staleDetail;
    });

    expect(screen.getByText('Fresh detail')).toBeInTheDocument();
    expect(screen.queryByText('Stale detail')).not.toBeInTheDocument();
  });

  it('rejects stale history responses across an actor A-B-A switch', async () => {
    let resolveStaleHistory: (view: SubagentThreadView) => void = () => undefined;
    const staleHistory = new Promise<SubagentThreadView>((resolve) => {
      resolveStaleHistory = resolve;
    });
    const viewFor = (threadId: string, taskId: string): SubagentThreadView => ({
      ...completedView,
      threadId,
      nextCursor: `${taskId}-older:assistant`,
      activity: [{ type: 'writing', text: `${threadId} current` }],
      turns: [
        {
          taskId,
          trigger: { kind: 'parent_dispatch', summary: `${threadId} prompt` },
          status: 'completed',
          activity: [{ type: 'writing', text: `${threadId} current` }],
          activityTruncated: false,
          messages: [],
        },
      ],
    });
    mockUseSubagentThreadQuery.mockImplementation(
      (_parentConversationId: string, requestedThreadId: string, requestedTaskId: string) => ({
        data: viewFor(requestedThreadId, requestedTaskId),
        isLoading: false,
        isError: false,
        isReadinessPending: false,
      }),
    );
    mockGetSubagentThread.mockReturnValueOnce(staleHistory).mockResolvedValueOnce({
      ...completedView,
      threadId: 'thread-a',
      activity: [],
      messages: [],
      turns: [
        {
          taskId: 'fresh-older',
          trigger: { kind: 'parent_dispatch', summary: 'Fresh older prompt' },
          status: 'completed',
          activity: [{ type: 'writing', text: 'Fresh older result' }],
          activityTruncated: false,
          messages: [],
        },
      ],
    });
    const selectionA: ActiveSubagentPanel = {
      ...selection,
      durable: { threadId: 'thread-a', taskId: 'task-a' },
    };
    const selectionB: ActiveSubagentPanel = {
      ...selection,
      durable: { threadId: 'thread-b', taskId: 'task-b' },
    };

    const { rerender } = render(
      <Root>
        <SubagentThreadPanel selection={selectionA} />
      </Root>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));
    rerender(
      <Root>
        <SubagentThreadPanel selection={selectionB} />
      </Root>,
    );
    rerender(
      <Root>
        <SubagentThreadPanel selection={selectionA} />
      </Root>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));
    await waitFor(() => expect(screen.getByText('Fresh older result')).toBeInTheDocument());

    await act(async () => {
      resolveStaleHistory({
        ...completedView,
        threadId: 'thread-a',
        activity: [],
        messages: [],
        turns: [
          {
            taskId: 'stale-older',
            trigger: { kind: 'parent_dispatch', summary: 'Stale older prompt' },
            status: 'completed',
            activity: [{ type: 'writing', text: 'Stale older result' }],
            activityTruncated: false,
            messages: [],
          },
        ],
      });
      await staleHistory;
    });

    expect(screen.getByText('Fresh older result')).toBeInTheDocument();
    expect(screen.queryByText('Stale older result')).not.toBeInTheDocument();
  });

  it('retains a latest-window turn displaced after older history has loaded', async () => {
    const makeTurn = (taskId: string, text: string) => ({
      taskId,
      trigger: { kind: 'parent_dispatch' as const, summary: `${text} prompt` },
      status: 'completed' as const,
      activity: [{ type: 'writing' as const, text }],
      activityTruncated: false,
      messages: [],
    });
    let latestView: SubagentThreadView = {
      ...completedView,
      nextCursor: 'boundary:assistant',
      activity: [{ type: 'writing', text: 'Current result' }],
      turns: [makeTurn('boundary', 'Boundary result'), makeTurn('task', 'Current result')],
    };
    let resolveReconnect: (view: SubagentThreadView) => void = () => undefined;
    const reconnectPage = new Promise<SubagentThreadView>((resolve) => {
      resolveReconnect = resolve;
    });
    mockUseSubagentThreadQuery.mockImplementation(() => ({
      data: latestView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    }));
    mockGetSubagentThread
      .mockResolvedValueOnce({
        ...completedView,
        nextCursor: 'very-old:assistant',
        activity: [],
        messages: [],
        turns: [makeTurn('very-old', 'Very old result')],
      })
      .mockResolvedValueOnce({
        ...completedView,
        nextCursor: 'middle-older:assistant',
        activity: [],
        messages: [],
        historyTruncated: true,
        turns: [makeTurn('middle-newer', 'Newer middle result')],
      })
      .mockReturnValueOnce(reconnectPage);

    const { rerender } = render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(3));

    latestView = {
      ...latestView,
      nextCursor: 'middle:assistant',
      turns: [makeTurn('task-new', 'New result'), makeTurn('task-newer', 'Newest result')],
    };
    rerender(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(5));
    expect(screen.getByText('Very old result')).toBeInTheDocument();
    expect(screen.getByText('Boundary result')).toBeInTheDocument();
    expect(screen.getByText('Current result')).toBeInTheDocument();
    expect(screen.getByText('New result')).toBeInTheDocument();
    expect(screen.getByText('Newest result')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));
    await waitFor(() =>
      expect(mockGetSubagentThread).toHaveBeenLastCalledWith(
        'parent-conversation',
        'child-thread',
        undefined,
        'middle:assistant',
      ),
    );
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(6));

    latestView = {
      ...latestView,
      nextCursor: 'new-live-boundary:assistant',
      turns: [makeTurn('task-final', 'Final live result')],
    };
    rerender(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(7));

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }));
    await waitFor(() =>
      expect(mockGetSubagentThread).toHaveBeenLastCalledWith(
        'parent-conversation',
        'child-thread',
        undefined,
        'middle-older:assistant',
      ),
    );

    latestView = {
      ...latestView,
      nextCursor: 'ultimate-live-boundary:assistant',
      turns: [makeTurn('task-ultimate', 'Ultimate live result')],
    };
    rerender(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );
    await waitFor(() => expect(screen.getByText('Ultimate live result')).toBeInTheDocument());

    await act(async () => {
      resolveReconnect({
        ...completedView,
        activity: [],
        messages: [],
        historyTruncated: false,
        turns: [
          makeTurn('boundary', 'Boundary result'),
          makeTurn('middle-older', 'Older middle result'),
        ],
      });
      await reconnectPage;
    });

    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(9));
    expect(screen.getAllByTestId('conversation-turn').map((turn) => turn.textContent)).toEqual([
      expect.stringContaining('Very old result'),
      expect.stringContaining('Boundary result'),
      expect.stringContaining('Current result'),
      expect.stringContaining('Older middle result'),
      expect.stringContaining('Newer middle result'),
      expect.stringContaining('New result'),
      expect.stringContaining('Newest result'),
      expect.stringContaining('Final live result'),
      expect.stringContaining('Ultimate live result'),
    ]);
    expect(
      screen.queryByRole('button', { name: 'com_ui_subagent_load_earlier_activity' }),
    ).not.toBeInTheDocument();
  });

  it('does not accumulate displaced latest-window turns before history is requested', async () => {
    const makeTurn = (taskId: string, text: string) => ({
      taskId,
      trigger: { kind: 'parent_dispatch' as const, summary: `${text} prompt` },
      status: 'completed' as const,
      activity: [{ type: 'writing' as const, text }],
      activityTruncated: false,
      messages: [],
    });
    let latestView: SubagentThreadView = {
      ...completedView,
      nextCursor: 'old:assistant',
      turns: [makeTurn('old', 'Old result'), makeTurn('task', 'Current result')],
    };
    mockUseSubagentThreadQuery.mockImplementation(() => ({
      data: latestView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    }));

    const { rerender } = render(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );
    expect(screen.getByText('Old result')).toBeInTheDocument();

    latestView = {
      ...latestView,
      nextCursor: 'task:assistant',
      turns: [makeTurn('task', 'Current result'), makeTurn('new', 'New result')],
    };
    rerender(
      <Root>
        <SubagentThreadPanel selection={selection} />
      </Root>,
    );

    await waitFor(() => expect(screen.queryByText('Old result')).not.toBeInTheDocument());
    expect(screen.getByText('Current result prompt')).toBeInTheDocument();
    expect(screen.getByText('New result')).toBeInTheDocument();
  });

  it('follows a newly appended latest turn while preserving the continuous history', async () => {
    const eventChild: ParentSubagentSummary = {
      threadId: 'child-thread',
      parentMessageId: 'parent-message',
      subagentType: 'agent-1',
      subagentKind: 'agent',
      agentId: 'agent-1',
      title: 'Actor',
      origin: 'event',
      actorId: 'actor-1',
      status: 'running',
      latestTaskId: 'task-new',
      tasks: [
        { taskId: 'task-new', status: 'running' },
        { taskId: 'task-old', status: 'completed' },
      ],
      tasksTruncated: false,
    };
    mockParentChildrenByMessage = new Map([['parent-message', [eventChild]]]);
    mockParentChildrenByThread = new Map([[eventChild.threadId, eventChild]]);
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const staleSelection: ActiveSubagentPanel = {
      ...selection,
      durable: { threadId: 'child-thread', taskId: 'task-old' },
      event: { actorId: 'actor-1', progressKey: 'event-task:child-thread:task-old' },
    };
    let active: ActiveSubagentPanel | null = staleSelection;
    const Observer = () => {
      active = useAtomValue(activeSubagentPanel);
      return null;
    };

    render(
      <Root seed={(jotai) => jotai.set(activeSubagentPanel, staleSelection)}>
        <Observer />
        <SubagentThreadPanel selection={staleSelection} />
      </Root>,
    );

    await waitFor(() =>
      expect(active?.durable).toEqual({ threadId: 'child-thread', taskId: 'task-new' }),
    );
    expect(screen.getAllByTestId('shared-activity')).toHaveLength(2);
  });

  it('loads retained event history in bounded pages and marks an omitted beginning', () => {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      taskId: `task-${5 - index}`,
      status: 'completed' as const,
    }));
    const eventChild: ParentSubagentSummary = {
      threadId: 'child-thread',
      parentMessageId: 'parent-message',
      subagentType: 'agent-1',
      subagentKind: 'agent',
      agentId: 'agent-1',
      title: 'Actor',
      origin: 'event',
      actorId: 'actor-1',
      status: 'completed',
      latestTaskId: 'task-5',
      tasks,
      tasksTruncated: true,
    };
    mockParentChildrenByMessage = new Map([['parent-message', [eventChild]]]);
    mockParentChildrenByThread = new Map([[eventChild.threadId, eventChild]]);
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });
    const eventSelection: ActiveSubagentPanel = {
      ...selection,
      durable: { threadId: 'child-thread', taskId: 'task-5' },
      event: { actorId: 'actor-1', progressKey: 'event-task:child-thread:task-5' },
    };

    render(
      <Root>
        <SubagentThreadPanel selection={eventSelection} />
      </Root>,
    );

    expect(screen.getAllByTestId('shared-activity')).toHaveLength(3);
    expect(new Set(mockUseSubagentThreadQuery.mock.calls.map((call) => call[2]))).toEqual(
      new Set(['task-5', 'task-4', 'task-3']),
    );
    expect(screen.queryByText('com_ui_subagent_thread_history_truncated')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_load_more' }));

    expect(screen.getAllByTestId('shared-activity')).toHaveLength(5);
    expect(new Set(mockUseSubagentThreadQuery.mock.calls.map((call) => call[2]))).toEqual(
      new Set(['task-5', 'task-4', 'task-3', 'task-2', 'task-1']),
    );
    expect(
      screen.getByRole('status', { name: 'com_ui_subagent_thread_history_truncated' }),
    ).toHaveTextContent('•••');
  });

  it('marks a truncated one-task legacy event window as incomplete', () => {
    const eventChild: ParentSubagentSummary = {
      threadId: 'child-thread',
      parentMessageId: 'parent-message',
      subagentType: 'agent-1',
      subagentKind: 'agent',
      agentId: 'agent-1',
      title: 'Actor',
      origin: 'event',
      actorId: 'actor-1',
      status: 'completed',
      latestTaskId: 'task',
      tasks: [{ taskId: 'task', status: 'completed' }],
      tasksTruncated: true,
    };
    mockParentChildrenByMessage = new Map([['parent-message', [eventChild]]]);
    mockParentChildrenByThread = new Map([[eventChild.threadId, eventChild]]);
    mockUseSubagentThreadQuery.mockReturnValue({
      data: completedView,
      isLoading: false,
      isError: false,
      isReadinessPending: false,
    });

    render(
      <Root>
        <SubagentThreadPanel
          selection={{
            ...selection,
            event: { actorId: 'actor-1', progressKey: 'event-task:child-thread:task' },
          }}
        />
      </Root>,
    );

    expect(screen.getAllByTestId('shared-activity')).toHaveLength(1);
    expect(
      screen.getByRole('status', { name: 'com_ui_subagent_thread_history_truncated' }),
    ).toHaveTextContent('•••');
  });
});
