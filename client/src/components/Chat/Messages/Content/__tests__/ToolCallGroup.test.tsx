import React from 'react';
import { RecoilRoot } from 'recoil';
import { Tools, Constants, ContentTypes } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import { FailedRevealContext, useFailedReveal } from '../reveal';
import { scheduleMessageContentLayoutReconcile } from '~/hooks';
import ToolCallGroup from '../ToolCallGroup';
import { ToolAuthWarning } from '../auth';

const mockMCPServerNames: string[] = [];

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string | number, string>) => {
    if (key === 'com_ui_ran_n_actions') {
      return `Ran ${values?.[0]} actions`;
    }
    if (key === 'com_ui_running_n_actions') {
      return `Running ${values?.[0]} actions`;
    }
    if (key === 'com_ui_n_searches') {
      return `${values?.[0]} searches`;
    }
    if (key === 'com_ui_background_tasks_checked') {
      return 'Checked background tasks';
    }
    if (key === 'com_ui_background_tasks_checking') {
      return 'Checking background tasks';
    }
    if (key === 'com_ui_background_tasks_n_checks') {
      return `${values?.[0]} checks`;
    }
    if (key === 'com_ui_n_of_n_actions_failed') {
      return `${values?.[0]}/${values?.[1]} failed`;
    }
    if (key === 'com_ui_n_actions_cancelled') {
      return `${values?.[0]} cancelled`;
    }
    if (key === 'com_ui_one_action_cancelled') {
      return '1 cancelled';
    }
    if (key === 'com_ui_web_searched') {
      return 'Searched the web';
    }
    if (key === 'com_ui_web_searching') {
      return 'Searching the web';
    }
    if (key === 'com_ui_retrieved_files') {
      return 'Searched your files';
    }
    if (key === 'com_ui_searching_files') {
      return 'Searching your files';
    }
    if (key === 'com_ui_searched_web_and_files') {
      return 'Searched web and files';
    }
    if (key === 'com_ui_searching_web_and_files') {
      return 'Searching web and files';
    }
    if (key === 'com_ui_asked_n_questions') {
      return `Asked ${values?.[0]} questions`;
    }
    if (key === 'com_ui_asking_n_questions') {
      return `Asking ${values?.[0]} questions`;
    }
    if (key === 'com_ui_asked_one_question') {
      return 'Asked 1 question';
    }
    if (key === 'com_ui_asking_one_question') {
      return 'Asking 1 question';
    }
    if (key === 'com_ui_subagent_complete') {
      return 'Ran agent';
    }
    if (key === 'com_ui_subagent_running') {
      return 'Running agent';
    }
    if (key === 'com_ui_via_server') {
      return `via ${values?.[0]}`;
    }
    if (key === 'com_assistants_allow_sites_you_trust') {
      return 'Only allow sites you trust';
    }
    return key;
  },
  useExpandCollapse: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
    },
    ref: { current: null },
  }),
  scheduleMessageContentLayoutReconcile: jest.fn(() => jest.fn()),
}));

jest.mock('~/hooks/MCP', () => {
  return {
    useMCPIconMap: () => new Map(),
    useMCPServerNames: () => mockMCPServerNames,
  };
});

jest.mock('../ToolOutput', () => ({
  StackedToolIcons: ({ toolNames }: { toolNames: string[] }) => (
    <span data-testid="stacked-icons" data-tool-names={toolNames.join(',')} />
  ),
  getMCPServerName: () => '',
  isError: (output: string) => output.startsWith('Error processing tool'),
}));

jest.mock('lucide-react', () => ({
  ChevronDown: ({ className }: { className?: string }) => (
    <span data-testid="group-chevron" className={className}>
      {'chevron'}
    </span>
  ),
  Users: () => <span>{'users'}</span>,
  MessageCircleQuestion: () => <span data-testid="question-icon">{'question'}</span>,
  ListChecks: () => <span data-testid="task-check-icon">{'checks'}</span>,
  TriangleAlert: () => <span>{'warning'}</span>,
}));

const mockSubmittedAskAnswers = new Map<string, string>();

jest.mock('~/utils/approval', () => ({
  ASK_USER_QUESTION: 'ask_user_question',
  getSubmittedAskAnswer: (toolCallId?: string) =>
    toolCallId != null ? mockSubmittedAskAnswers.get(toolCallId) : undefined,
}));

jest.mock('~/utils', () => ({
  getPartKeyIndex: jest.requireActual('~/utils').getPartKeyIndex,
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getToolDisplayLabel: (name: string, _localize: unknown, knownServerNames?: readonly string[]) => {
    const configuredServer = knownServerNames?.find((server) => name.endsWith(`_mcp_${server}`));
    if (configuredServer) {
      return configuredServer;
    }
    if (name.includes('_mcp_')) {
      return name.slice(name.lastIndexOf('_mcp_') + '_mcp_'.length);
    }
    if (
      ['execute_code', 'bash_tool', 'run_tools_with_code', 'run_tools_with_bash'].includes(name)
    ) {
      return 'Code';
    }
    const friendlyNames: Record<string, string> = {
      web_search: 'Web Search',
      file_search: 'File Search',
      retrieval: 'File Search',
      create_file: 'Create File',
      edit_file: 'Edit File',
      ask_user_question: 'Question',
      check_background_task: 'Background tasks',
    };
    return friendlyNames[name] ?? name;
  },
  /** Real implementations: the group header resolves its text through these,
   *  so stubbing them out would hide the header logic under test. */
  getBatchActivityLabelPart: jest.requireActual('~/utils/activityLabels').getBatchActivityLabelPart,
  getActivityLabelText: jest.requireActual('~/utils/activityLabels').getActivityLabelText,
  hasPendingApprovalInPart: jest.requireActual('~/utils/groupToolCalls').hasPendingApprovalInPart,
  hasPendingAuthInPart: jest.requireActual('~/utils/groupToolCalls').hasPendingAuthInPart,
}));

jest.mock('../Parts', () => ({
  AttachmentGroup: ({ attachments }: { attachments?: TAttachment[] }) => (
    <div data-testid="attachment-group" data-count={attachments?.length ?? 0} />
  ),
  ReasoningCompact: ({ isAfterTool }: { isAfterTool?: boolean }) => (
    <div data-testid="compact-reasoning" data-after-tool={String(isAfterTool)} />
  ),
}));

const makePart = (
  id: string,
  output = 'done',
  name = 'fetch_image',
  args: string | Record<string, unknown> = '{}',
): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name,
      args,
      output,
    },
  }) as unknown as TMessageContentParts;

const makeApprovalPart = (id: string, output = ''): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name: 'approval_probe',
      args: {},
      output,
      approval: {
        actionId: 'action-1',
        allowed_decisions: ['approve', 'reject'],
      },
    },
  }) as unknown as TMessageContentParts;

const makeSubagentPart = (
  id: string,
  subagentContent: TMessageContentParts[],
): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name: Constants.SUBAGENT,
      args: {},
      output: '',
      subagent_content: subagentContent,
    },
  }) as unknown as TMessageContentParts;

const makeAuthPart = (
  id: string,
  name: string,
  progress = 0.1,
  output = '',
): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name,
      args: '{}',
      output,
      progress,
      auth: `https://${name}.example.com/oauth`,
    },
  }) as unknown as TMessageContentParts;

const imageAttachment: TAttachment = {
  filename: 'foo.png',
  filepath: '/files/foo.png',
  width: 128,
  height: 128,
  messageId: 'm1',
  toolCallId: 't1',
  conversationId: 'c1',
} as unknown as TAttachment;

const fileAttachment: TAttachment = {
  filename: 'bar.pdf',
  filepath: '/files/bar.pdf',
  messageId: 'm1',
  toolCallId: 't2',
  conversationId: 'c1',
} as unknown as TAttachment;

const renderGroup = (props: React.ComponentProps<typeof ToolCallGroup>) =>
  render(
    <RecoilRoot>
      <ToolCallGroup {...props} />
    </RecoilRoot>,
  );

const mockScheduleMessageContentLayoutReconcile =
  scheduleMessageContentLayoutReconcile as jest.Mock;

describe('ToolCallGroup image hoisting', () => {
  const parts = [
    { part: makePart('t1'), idx: 0 },
    { part: makePart('t2'), idx: 1 },
  ];

  const baseProps = {
    parts,
    isSubmitting: false,
    isLast: false,
    showThinking: false,
    lastContentIdx: 1,
    renderPart: (_p: TMessageContentParts, idx: number) => (
      <div data-testid={`inner-${idx}`} key={idx}>
        {'inner'}
      </div>
    ),
  } satisfies React.ComponentProps<typeof ToolCallGroup>;

  beforeEach(() => {
    mockScheduleMessageContentLayoutReconcile.mockClear();
    mockMCPServerNames.length = 0;
    mockSubmittedAskAnswers.clear();
  });

  it('renders an AttachmentGroup outside the collapsible container with all attachments', () => {
    renderGroup({
      ...baseProps,
      groupAttachments: [imageAttachment, fileAttachment],
    });

    const group = screen.getByTestId('attachment-group');
    expect(group).toBeInTheDocument();
    expect(group.getAttribute('data-count')).toBe('2');
  });

  it('hoists non-image attachments so they survive collapse', () => {
    renderGroup({
      ...baseProps,
      groupAttachments: [fileAttachment],
    });

    const group = screen.getByTestId('attachment-group');
    expect(group).toBeInTheDocument();
    expect(group.getAttribute('data-count')).toBe('1');
  });

  it('does not render an AttachmentGroup when there are no group attachments', () => {
    renderGroup(baseProps);
    expect(screen.queryByTestId('attachment-group')).not.toBeInTheDocument();
  });

  it('renders one shared trust warning for multiple pending authentication calls', () => {
    const authParts = ['zapier', 'test', 'vercel', 'spotify'].map((name, idx) => ({
      part: makeAuthPart(`auth-${idx}`, name),
      idx,
    }));

    renderGroup({
      ...baseProps,
      parts: authParts,
      isSubmitting: true,
      lastContentIdx: authParts.length - 1,
      renderPart: (_part, idx) => <ToolAuthWarning key={idx} />,
    });

    expect(screen.getAllByText('Only allow sites you trust')).toHaveLength(1);
  });

  it('keeps the trust warning for a persisted incomplete authentication call', () => {
    renderGroup({
      ...baseProps,
      parts: [{ part: makeAuthPart('auth-persisted', 'zapier'), idx: 0 }],
      lastContentIdx: 0,
      renderPart: () => <ToolAuthWarning key="auth-persisted" />,
    });

    expect(screen.getByText('Only allow sites you trust')).toBeInTheDocument();
  });

  it('does not render a shared trust warning for completed authentication calls', () => {
    renderGroup({
      ...baseProps,
      parts: [{ part: makeAuthPart('auth-complete', 'zapier', 1, 'done'), idx: 0 }],
      lastContentIdx: 0,
      renderPart: () => null,
    });

    expect(screen.queryByText('Only allow sites you trust')).not.toBeInTheDocument();
  });

  it('keeps the group disclosure chevron visible', () => {
    renderGroup(baseProps);

    expect(screen.getByTestId('group-chevron')).not.toHaveClass('opacity-0');
  });

  it('does not reconcile layout for an initially collapsed completed group', () => {
    renderGroup(baseProps);
    expect(mockScheduleMessageContentLayoutReconcile).not.toHaveBeenCalled();
  });

  /** A settled label proves the batch finished — a void tool's legitimate
   *  empty output must not keep its labeled group expanded forever. */
  it('auto-collapses a labeled group whose only tool returned an empty output', () => {
    const voidToolParts = [{ part: makePart('t1', '', 'update_settings'), idx: 0 }];
    const labelPart = {
      part: {
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: 'Updated the notification settings',
        pending: false,
      } as unknown as TMessageContentParts,
      idx: 1,
    };

    renderGroup({
      ...baseProps,
      parts: voidToolParts,
      lastContentIdx: 1,
      labelPart,
    });

    expect(
      screen.getByRole('button', { name: 'Updated the notification settings' }),
    ).toBeInTheDocument();
    /** Collapsed: bodies not mounted. */
    expect(screen.queryByTestId('inner-0')).not.toBeInTheDocument();
  });

  it('keeps a pending-label group expanded while its tool has no output', () => {
    const voidToolParts = [{ part: makePart('t1', '', 'update_settings'), idx: 0 }];
    const labelPart = {
      part: {
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: '',
        pending: true,
      } as unknown as TMessageContentParts,
      idx: 1,
    };

    renderGroup({
      ...baseProps,
      parts: voidToolParts,
      lastContentIdx: 1,
      labelPart,
      isSubmitting: true,
    });

    expect(screen.getByTestId('inner-0')).toBeInTheDocument();
  });

  /** A remount into a completed phase card must not flash open and collapse
   *  again while the parent entrance fold is playing — the phase summary
   *  already speaks for this activity. */
  it('mounts collapsed inside a completed phase even while a tool is still active', () => {
    const voidToolParts = [{ part: makePart('t1', '', 'update_settings'), idx: 0 }];
    const labelPart = {
      part: {
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: '',
        pending: true,
      } as unknown as TMessageContentParts,
      idx: 1,
    };

    renderGroup({
      ...baseProps,
      parts: voidToolParts,
      lastContentIdx: 1,
      labelPart,
      isSubmitting: true,
      withinActivityPhase: true,
    });

    expect(screen.queryByTestId('inner-0')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  /** A phase can resolve while an approval inside it still blocks the run
   *  (see ActivityPhaseGroup's pending-approval retention) — the remounted
   *  group must keep the actionable card mounted, not bury it behind a
   *  second collapsed disclosure. */
  it('keeps a pending approval expanded inside a completed phase', () => {
    renderGroup({
      ...baseProps,
      parts: [
        { part: makeApprovalPart('t1'), idx: 0 },
        { part: makeApprovalPart('t2'), idx: 1 },
      ],
      isSubmitting: true,
      withinActivityPhase: true,
    });

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('inner-0')).toBeInTheDocument();
    expect(screen.getByTestId('inner-1')).toBeInTheDocument();
  });

  it('still expands on user toggle inside a completed phase', () => {
    renderGroup({ ...baseProps, withinActivityPhase: true });

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByTestId('inner-0')).toBeInTheDocument();
    expect(screen.getByTestId('inner-1')).toBeInTheDocument();
  });

  it('does not render tool bodies for an initially collapsed large completed group', () => {
    const largeParts = Array.from({ length: 59 }, (_, idx) => ({
      part: makePart(`t${idx}`),
      idx,
    }));
    const renderPart = jest.fn((_p: TMessageContentParts, idx: number) => (
      <div data-testid={`inner-${idx}`} key={idx}>
        {'inner'}
      </div>
    ));

    renderGroup({
      ...baseProps,
      parts: largeParts,
      lastContentIdx: largeParts.length - 1,
      renderPart,
    });

    expect(screen.getByRole('button', { name: /^Ran 59 actions/ })).toBeInTheDocument();
    expect(renderPart).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inner-0')).not.toBeInTheDocument();
  });

  it('mounts tool bodies when a collapsed group is expanded', () => {
    renderGroup(baseProps);

    fireEvent.click(screen.getByRole('button', { name: /^Ran 2 actions/ }));

    expect(screen.getByTestId('inner-0')).toBeInTheDocument();
    expect(screen.getByTestId('inner-1')).toBeInTheDocument();
  });

  it('removes the extra Thoughts top margin after a tool row', () => {
    const reasoningPart = {
      type: ContentTypes.THINK,
      [ContentTypes.THINK]: 'A useful thought',
    } as TMessageContentParts;

    renderGroup({
      ...baseProps,
      parts: [
        { part: makePart('t1'), idx: 0 },
        { part: reasoningPart, idx: 1 },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /^Fetch_image/ }));

    expect(screen.getByTestId('compact-reasoning')).toHaveAttribute('data-after-tool', 'true');
  });

  it('delegates an unavailable-reasoning part to the standalone renderer', () => {
    /** A detached-subagent projection has no text to compact, so `Part`'s
     *  `ReasoningMarker` is the only thing that stands for it. Rendering it
     *  as a compact row drops the marker the moment the call joins a group. */
    const unavailablePart = {
      type: ContentTypes.THINK,
      [ContentTypes.THINK]: '',
      reasoning_unavailable: true,
    } as TMessageContentParts;

    renderGroup({
      ...baseProps,
      parts: [
        { part: makePart('t1'), idx: 0 },
        { part: unavailablePart, idx: 1 },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /^Fetch_image/ }));

    expect(screen.getByTestId('inner-1')).toBeInTheDocument();
    expect(screen.queryByTestId('compact-reasoning')).not.toBeInTheDocument();
  });

  it('unmounts tool bodies after a collapsed group finishes transitioning', () => {
    renderGroup(baseProps);

    const button = screen.getByRole('button', { name: /^Ran 2 actions/ });
    const collapsible = screen.getByTestId('tool-call-group-panel');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByTestId('inner-0')).toBeInTheDocument();

    fireEvent.transitionEnd(collapsible);

    expect(screen.queryByTestId('inner-0')).not.toBeInTheDocument();
  });

  it('keeps unresolved approval bodies mounted while the group is collapsed', () => {
    const approvalParts = [
      { part: makeApprovalPart('t1'), idx: 0 },
      { part: makeApprovalPart('t2'), idx: 1 },
    ];
    renderGroup({
      ...baseProps,
      parts: approvalParts,
      renderPart: (_p: TMessageContentParts, idx: number) => (
        <div data-testid={`approval-${idx}`} key={idx}>
          {'approval'}
        </div>
      ),
    });

    const button = screen.getByRole('button', { name: /^Ran 2 actions/ });
    const collapsible = screen.getByTestId('tool-call-group-panel');
    expect(screen.getByTestId('approval-0')).toBeInTheDocument();

    fireEvent.click(button);
    fireEvent.transitionEnd(collapsible);

    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('approval-0')).toBeInTheDocument();
    expect(screen.getByTestId('approval-1')).toBeInTheDocument();
  });

  it('keeps deeply nested unresolved approval bodies mounted while the group is collapsed', () => {
    const nestedApprovalParts = [
      {
        part: makeSubagentPart('parent', [
          makeSubagentPart('child', [makeApprovalPart('grandchild')]),
        ]),
        idx: 0,
      },
      { part: makePart('sibling'), idx: 1 },
    ];
    renderGroup({
      ...baseProps,
      parts: nestedApprovalParts,
      renderPart: (_p: TMessageContentParts, idx: number) => (
        <div data-testid={`nested-${idx}`} key={idx}>
          {'nested'}
        </div>
      ),
    });

    const button = screen.getByRole('button', { name: /^Ran 2 actions/ });
    const collapsible = screen.getByTestId('tool-call-group-panel');
    fireEvent.click(button);
    fireEvent.transitionEnd(collapsible);

    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('nested-0')).toBeInTheDocument();
    expect(screen.getByTestId('nested-1')).toBeInTheDocument();
  });

  it('does not retain a collapsed group for an already resolved nested approval', () => {
    const nestedApprovalParts = [
      {
        part: makeSubagentPart('parent', [
          makeSubagentPart('child', [makeApprovalPart('grandchild', 'done')]),
        ]),
        idx: 0,
      },
      { part: makePart('sibling'), idx: 1 },
    ];
    renderGroup({
      ...baseProps,
      parts: nestedApprovalParts,
      renderPart: (_p: TMessageContentParts, idx: number) => (
        <div data-testid={`resolved-nested-${idx}`} key={idx}>
          {'nested'}
        </div>
      ),
    });

    const button = screen.getByRole('button', { name: /^Ran 2 actions/ });
    const collapsible = screen.getByTestId('tool-call-group-panel');
    fireEvent.click(button);
    fireEvent.transitionEnd(collapsible);

    expect(screen.queryByTestId('resolved-nested-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resolved-nested-1')).not.toBeInTheDocument();
  });

  it('unmounts retained approval bodies after every approval in a collapsed group resolves', async () => {
    const renderPart = (_p: TMessageContentParts, idx: number) => (
      <div data-testid={`retained-${idx}`} key={idx}>
        {'approval'}
      </div>
    );
    const propsFor = (
      firstOutput = '',
      secondOutput = '',
    ): React.ComponentProps<typeof ToolCallGroup> => ({
      ...baseProps,
      parts: [
        { part: makeApprovalPart('t1', firstOutput), idx: 0 },
        { part: makeApprovalPart('t2', secondOutput), idx: 1 },
      ],
      renderPart,
    });
    const { rerender } = renderGroup(propsFor());

    const button = screen.getByRole('button', { name: /^Ran 2 actions/ });
    const collapsible = screen.getByTestId('tool-call-group-panel');
    fireEvent.click(button);
    fireEvent.transitionEnd(collapsible);
    expect(screen.getByTestId('retained-0')).toBeInTheDocument();

    rerender(
      <RecoilRoot>
        <ToolCallGroup {...propsFor('first done')} />
      </RecoilRoot>,
    );
    expect(screen.getByTestId('retained-0')).toBeInTheDocument();
    expect(screen.getByTestId('retained-1')).toBeInTheDocument();

    rerender(
      <RecoilRoot>
        <ToolCallGroup {...propsFor('first done', 'second done')} />
      </RecoilRoot>,
    );
    await waitFor(() => {
      expect(screen.queryByTestId('retained-0')).not.toBeInTheDocument();
      expect(screen.queryByTestId('retained-1')).not.toBeInTheDocument();
    });
  });

  it('waits for an active collapse transition before unmounting resolved approval bodies', () => {
    const renderPart = (_p: TMessageContentParts, idx: number) => (
      <div data-testid={`transitioning-${idx}`} key={idx}>
        {'approval'}
      </div>
    );
    const propsFor = (output = ''): React.ComponentProps<typeof ToolCallGroup> => ({
      ...baseProps,
      parts: [
        { part: makeApprovalPart('t1', output), idx: 0 },
        { part: makeApprovalPart('t2', output), idx: 1 },
      ],
      renderPart,
    });
    const { rerender } = renderGroup(propsFor());

    const button = screen.getByRole('button', { name: /^Ran 2 actions/ });
    const collapsible = screen.getByTestId('tool-call-group-panel');
    fireEvent.click(button);

    rerender(
      <RecoilRoot>
        <ToolCallGroup {...propsFor('done')} />
      </RecoilRoot>,
    );
    expect(screen.getByTestId('transitioning-0')).toBeInTheDocument();
    expect(screen.getByTestId('transitioning-1')).toBeInTheDocument();

    fireEvent.transitionEnd(collapsible);
    expect(screen.queryByTestId('transitioning-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('transitioning-1')).not.toBeInTheDocument();
  });

  it('reconciles layout after the group collapses from an expanded state', async () => {
    renderGroup(baseProps);

    fireEvent.click(screen.getByRole('button', { name: /^Ran 2 actions/ }));
    expect(mockScheduleMessageContentLayoutReconcile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Ran 2 actions/ }));

    await waitFor(() => {
      expect(mockScheduleMessageContentLayoutReconcile).toHaveBeenCalledTimes(1);
    });
  });

  it('renders the image AttachmentGroup as a sibling of the collapsible panel, not a child', () => {
    const { container } = renderGroup({
      ...baseProps,
      groupAttachments: [imageAttachment],
    });

    const outer = container.firstChild as HTMLElement;
    const attachmentGroup = screen.getByTestId('attachment-group');
    expect(attachmentGroup.parentElement).toBe(outer);

    const collapsible = outer.querySelector('[style]');
    expect(collapsible?.contains(attachmentGroup)).toBe(false);
  });

  it('summarizes mixed bash PTC and bash_tool calls as one Code tool family', () => {
    renderGroup({
      ...baseProps,
      parts: [
        {
          part: makePart('t1', 'ptc done', Constants.PROGRAMMATIC_TOOL_CALLING, {
            code: 'echo via ptc',
          }),
          idx: 0,
        },
        {
          part: makePart('t2', 'bash done', Tools.bash_tool, {
            command: 'echo via bash',
          }),
          idx: 1,
        },
      ],
    });

    expect(screen.getByText('· Code ×2')).toBeInTheDocument();
    expect(screen.queryByText(/Code, bash_tool/)).not.toBeInTheDocument();
    expect(screen.getByTestId('stacked-icons')).toHaveAttribute(
      'data-tool-names',
      'bash_tool,bash_tool',
    );
  });

  it('preserves a configured MCP server boundary in a single-tool label', () => {
    mockMCPServerNames.push('Google_mcp_Workspace');
    renderGroup({
      ...baseProps,
      parts: [
        {
          part: makePart('mcp-1', 'result', 'search_documents_mcp_Google_mcp_Workspace'),
          idx: 0,
        },
      ],
      lastContentIdx: 0,
    });

    expect(screen.getByRole('button', { name: /^Google_mcp_Workspace$/ })).toBeInTheDocument();
  });

  it('summarizes repeated completed web searches as an outcome and count', () => {
    const searchParts = Array.from({ length: 9 }, (_, idx) => ({
      part: makePart(`w${idx}`, 'result', 'web_search'),
      idx,
    }));

    renderGroup({
      ...baseProps,
      parts: searchParts,
      lastContentIdx: searchParts.length - 1,
    });

    expect(
      screen.getByRole('button', { name: 'Searched the web, 9 searches' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Searched the web')).toBeInTheDocument();
    expect(screen.getByText('· 9 searches')).toBeInTheDocument();
  });

  it('uses the active tense while a web-search group is running', () => {
    renderGroup({
      ...baseProps,
      isSubmitting: true,
      parts: [
        { part: makePart('w1', 'result', 'web_search'), idx: 0 },
        { part: makePart('w2', '', 'web_search'), idx: 1 },
      ],
    });

    expect(
      screen.getByRole('button', { name: 'Searching the web, 2 searches' }),
    ).toBeInTheDocument();
  });

  it('summarizes mixed web and file searches without exposing tool ids', () => {
    renderGroup({
      ...baseProps,
      parts: [
        { part: makePart('w1', 'result', 'web_search'), idx: 0 },
        { part: makePart('f1', 'result', 'file_search'), idx: 1 },
        { part: makePart('f2', 'result', 'retrieval'), idx: 2 },
      ],
      lastContentIdx: 2,
    });

    expect(
      screen.getByRole('button', { name: 'Searched web and files, 3 searches' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/web_search|file_search|retrieval/)).not.toBeInTheDocument();
  });

  it('uses the edit glyph for a create_file overwrite without changing its tool label', () => {
    renderGroup({
      ...baseProps,
      parts: [
        {
          part: makePart(
            'file-1',
            'Updated AGENTS.md with safe diagnostic guidance',
            'create_file',
          ),
          idx: 0,
        },
      ],
      lastContentIdx: 0,
    });

    expect(screen.getByTestId('stacked-icons')).toHaveAttribute('data-tool-names', 'edit_file');
    expect(screen.getByRole('button', { name: 'Create File' })).toBeInTheDocument();
  });

  it('keeps repeated action counts and failed-call status in the compact summary', () => {
    renderGroup({
      ...baseProps,
      parts: [
        { part: makePart('c1', 'created', 'create_file'), idx: 0 },
        {
          part: makePart('c2', 'Error processing tool: disk full', 'create_file'),
          idx: 1,
        },
        { part: makePart('e1', 'edited', 'edit_file'), idx: 2 },
      ],
      lastContentIdx: 2,
    });

    expect(
      screen.getByRole('button', {
        name: 'Ran 3 actions, Create File ×2, Edit File · 1/3 failed',
      }),
    ).toBeInTheDocument();
  });

  it('summarizes repeated task checks as checks rather than separate tasks or generic actions', () => {
    const parts = Array.from({ length: 3 }, (_, idx) => ({
      part: makePart(
        `check-${idx}`,
        JSON.stringify({
          background_task_id: 'same-task',
          tool: 'bash_tool',
          status: 'running',
        }),
        Constants.CHECK_BACKGROUND_TASK,
      ),
      idx,
    }));
    renderGroup({ ...baseProps, parts, lastContentIdx: 2 });

    expect(
      screen.getByRole('button', { name: 'Checked background tasks, 3 checks' }),
    ).toBeInTheDocument();
    expect(screen.getByText('· 3 checks')).toBeInTheDocument();
    expect(screen.getByTestId('task-check-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('stacked-icons')).not.toBeInTheDocument();
    expect(screen.queryByText(/Ran 3 actions|check_background_task/)).not.toBeInTheDocument();
  });

  it('keeps the check group active until its outstanding poll settles', () => {
    renderGroup({
      ...baseProps,
      isSubmitting: true,
      parts: [
        { part: makePart('check-1', '{"tasks":[]}', Constants.CHECK_BACKGROUND_TASK), idx: 0 },
        { part: makePart('check-2', '', Constants.CHECK_BACKGROUND_TASK), idx: 1 },
      ],
    });

    expect(
      screen.getByRole('button', { name: 'Checking background tasks, 2 checks' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('task-check-icon').parentElement).toHaveClass('animate-pulse');
  });

  it('uses the same check verb for one poll and preserves mixed-tool summaries', () => {
    const check = makePart('check-1', '{"tasks":[]}', Constants.CHECK_BACKGROUND_TASK);
    const { rerender } = renderGroup({
      ...baseProps,
      parts: [{ part: check, idx: 0 }],
      lastContentIdx: 0,
    });
    expect(screen.getByRole('button', { name: 'Checked background tasks' })).toBeInTheDocument();

    rerender(
      <RecoilRoot>
        <ToolCallGroup
          {...baseProps}
          parts={[
            { part: check, idx: 0 },
            { part: makePart('b1', 'done', Tools.bash_tool), idx: 1 },
          ]}
        />
      </RecoilRoot>,
    );
    expect(
      screen.getByRole('button', { name: 'Ran 2 actions, Background tasks, Code' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('stacked-icons')).toBeInTheDocument();
  });

  it.each([
    ['error', '1/1 failed'],
    ['cancelled', '1 cancelled'],
    ['interrupted', '1/1 failed'],
  ])('reflects a %s task poll in the collapsed group', (status, suffix) => {
    renderGroup({
      ...baseProps,
      parts: [
        {
          part: makePart(
            'check-1',
            JSON.stringify({
              background_task_id: 'bg-1',
              tool: 'bash_tool',
              status,
              ...(status === 'error' ? { error: 'Disk full' } : {}),
            }),
            Constants.CHECK_BACKGROUND_TASK,
          ),
          idx: 0,
        },
      ],
      lastContentIdx: 0,
    });

    expect(
      screen.getByRole('button', { name: `Checked background tasks, ${suffix}` }),
    ).toBeInTheDocument();
  });

  it.each(['invalid', 'rejected', 'unavailable', 'outcome_unknown', 'result_unavailable'])(
    'shows a failed group for the %s background-task notice even when the poll step succeeds',
    (status) => {
      const part = makePart(
        'poll-1',
        JSON.stringify({ status, message: 'Host guidance about the failed check.' }),
        Constants.CHECK_BACKGROUND_TASK,
      );
      Object.assign(part[ContentTypes.TOOL_CALL] ?? {}, { runStepStatus: 'completed' });
      renderGroup({ ...baseProps, parts: [{ part, idx: 0 }], lastContentIdx: 0 });
      expect(
        screen.getByRole('button', { name: 'Checked background tasks, 1/1 failed' }),
      ).toBeInTheDocument();
    },
  );

  it('marks an incomplete background-task list as a failed check', () => {
    renderGroup({
      ...baseProps,
      parts: [
        {
          part: makePart(
            'poll-1',
            JSON.stringify({ tasks: [], partial: true, warning: 'A replica is unreachable.' }),
            Constants.CHECK_BACKGROUND_TASK,
          ),
          idx: 0,
        },
      ],
      lastContentIdx: 0,
    });
    expect(
      screen.getByRole('button', { name: 'Checked background tasks, 1/1 failed' }),
    ).toBeInTheDocument();
  });

  it('counts background failures per step when provider call IDs repeat', () => {
    const executions = [
      { stepId: 'step-success', status: 'completed' },
      { stepId: 'step-failure', status: 'error' },
    ];
    const groupAttachments = executions.map(({ stepId, status }) => ({
      type: 'background_task_status',
      messageId: 'message-1',
      toolCallId: 'call_0',
      agentId: 'agent-a',
      stepId,
      status,
    })) as unknown as TAttachment[];
    const props = {
      ...baseProps,
      groupAttachments,
      parts: executions.map(({ stepId }, idx) => ({
        idx,
        part: {
          type: ContentTypes.TOOL_CALL,
          [ContentTypes.TOOL_CALL]: {
            id: 'call_0',
            name: 'execute_code',
            args: '{}',
            agentId: 'agent-a',
            stepId,
            runStepStatus: 'completed',
            output: JSON.stringify({
              background_task_id: stepId,
              tool: 'execute_code',
              status: 'running',
              message: 'Use check_background_task to poll.',
            }),
          },
        } as unknown as TMessageContentParts,
      })),
    };
    const { rerender } = renderGroup(props);
    expect(screen.getByRole('button', { name: /· 1\/2 failed$/ })).toBeInTheDocument();

    rerender(
      <RecoilRoot>
        <ToolCallGroup {...props} groupAttachments={[...groupAttachments].reverse()} />
      </RecoilRoot>,
    );
    expect(screen.getByRole('button', { name: /· 1\/2 failed$/ })).toBeInTheDocument();
  });

  it('honors a terminal failed run step whose output reads as benign', () => {
    const closedFailure = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'c2',
        name: 'create_file',
        args: '{}',
        output: '',
        runStepStatus: 'failed',
      },
    } as unknown as TMessageContentParts;

    renderGroup({
      ...baseProps,
      isSubmitting: true,
      parts: [
        { part: makePart('c1', 'created', 'create_file'), idx: 0 },
        { part: closedFailure, idx: 1 },
      ],
      lastContentIdx: 1,
    });

    /** The run closed this step as failed, so the group must read it as
     *  settled (past tense while still submitting) and count it as a
     *  failure even though the empty output never parses as an error. */
    expect(
      screen.getByRole('button', { name: 'Ran 2 actions, Create File ×2 · 1/2 failed' }),
    ).toBeInTheDocument();
  });

  it('names a cancelled action in the header before collapsing', () => {
    const cancelled = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'c2',
        name: 'create_file',
        args: '{}',
        output: '',
        runStepStatus: 'cancelled',
      },
    } as unknown as TMessageContentParts;

    renderGroup({
      ...baseProps,
      parts: [
        { part: makePart('c1', 'created', 'create_file'), idx: 0 },
        { part: cancelled, idx: 1 },
      ],
      lastContentIdx: 1,
    });

    /** A stopped action is settled but not successful, and the group collapses
     *  over the only other notice, so the header must carry it and must not
     *  count it as a failure. */
    expect(
      screen.getByRole('button', { name: 'Ran 2 actions, Create File ×2 · 1 cancelled' }),
    ).toBeInTheDocument();
  });

  it('counts a persisted ordinary background cancellation as cancelled', () => {
    const cancelled = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'c2',
        name: 'bash_tool',
        args: '{"command":"sleep 600"}',
        output: 'Error: [bash_tool] tool call failed: Background task cancellation requested',
        runStepStatus: 'completed',
        backgrounded: true,
        backgroundTask: {
          version: 1,
          taskId: 'background-task-1',
          toolName: 'bash_tool',
          status: 'error',
          cancelled: true,
          settledAt: new Date(),
        },
      },
    } as unknown as TMessageContentParts;

    renderGroup({
      ...baseProps,
      parts: [
        { part: makePart('c1', 'created', 'create_file'), idx: 0 },
        { part: cancelled, idx: 1 },
      ],
      lastContentIdx: 1,
    });

    expect(screen.getByRole('button', { name: /· 1 cancelled$/ })).toBeInTheDocument();
  });

  it('labels a homogeneous ask_user_question group as its own category', () => {
    renderGroup({
      ...baseProps,
      parts: [
        { part: makePart('q1', 'blue', 'ask_user_question'), idx: 0 },
        { part: makePart('q2', 'staging', 'ask_user_question'), idx: 1 },
      ],
    });

    // Own verb, not "Used N tools"; question glyph instead of stacked wrenches;
    // raw-name summary suppressed (like subagent groups).
    expect(screen.getByRole('button', { name: 'Asked 2 questions' })).toBeInTheDocument();
    expect(screen.queryByText('Ran 2 actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('question-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('stacked-icons')).not.toBeInTheDocument();
    expect(screen.queryByText(/· ask_user_question/)).not.toBeInTheDocument();
  });

  it('uses the present tense while a multi-question turn is still streaming', () => {
    renderGroup({
      ...baseProps,
      isSubmitting: true,
      parts: [
        { part: makePart('q1', 'blue', 'ask_user_question'), idx: 0 },
        // Second question not yet answered (no output) — turn still in flight.
        { part: makePart('q2', '', 'ask_user_question'), idx: 1 },
      ],
    });

    expect(screen.getByRole('button', { name: 'Asking 2 questions' })).toBeInTheDocument();
    expect(screen.getByTestId('question-icon').parentElement).toHaveClass('animate-pulse');
  });

  it('uses a singular completed label for one question grouped with reasoning', () => {
    renderGroup({
      ...baseProps,
      parts: [{ part: makePart('q1', 'blue', 'ask_user_question'), idx: 0 }],
      lastContentIdx: 0,
    });

    expect(screen.getByRole('button', { name: 'Asked 1 question' })).toBeInTheDocument();
  });

  /** The `tool_call` part carries no output until the turn finalizes, so a group
   *  the user already answered kept reading "Asking 1 question" for the rest of
   *  the turn. Position cannot settle it: a live pause appends its interactive
   *  card AFTER this group, so the group is not the last part exactly while the
   *  question is open. */
  it('settles the question label once the answer is recorded locally', () => {
    mockSubmittedAskAnswers.set('q1', 'Option A');
    renderGroup({
      ...baseProps,
      isSubmitting: true,
      parts: [{ part: makePart('q1', '', 'ask_user_question'), idx: 0 }],
      lastContentIdx: 0,
    });

    expect(screen.getByRole('button', { name: 'Asked 1 question' })).toBeInTheDocument();
    /** The glyph reads as part of the same control, so it settles with it. */
    expect(screen.getByTestId('question-icon').parentElement).not.toHaveClass('animate-pulse');
  });

  it('keeps the active label while one question of a batch is unanswered', () => {
    mockSubmittedAskAnswers.set('q1', 'Option A');
    renderGroup({
      ...baseProps,
      isSubmitting: true,
      parts: [
        { part: makePart('q1', '', 'ask_user_question'), idx: 0 },
        { part: makePart('q2', '', 'ask_user_question'), idx: 1 },
      ],
    });

    expect(screen.getByRole('button', { name: 'Asking 2 questions' })).toBeInTheDocument();
  });

  it('uses a singular active label for one question grouped with reasoning', () => {
    renderGroup({
      ...baseProps,
      isSubmitting: true,
      parts: [{ part: makePart('q1', '', 'ask_user_question'), idx: 0 }],
      lastContentIdx: 0,
    });

    expect(screen.getByRole('button', { name: 'Asking 1 question' })).toBeInTheDocument();
  });

  it('uses a singular completed label for one subagent grouped with reasoning', () => {
    renderGroup({
      ...baseProps,
      parts: [{ part: makePart('a1', 'done', Constants.SUBAGENT), idx: 0 }],
      lastContentIdx: 0,
    });

    expect(screen.getByRole('button', { name: 'Ran agent' })).toBeInTheDocument();
  });

  it('uses a singular active label for one subagent grouped with reasoning', () => {
    renderGroup({
      ...baseProps,
      isSubmitting: true,
      parts: [{ part: makePart('a1', '', Constants.SUBAGENT), idx: 0 }],
      lastContentIdx: 0,
    });

    expect(screen.getByRole('button', { name: 'Running agent' })).toBeInTheDocument();
  });

  it('uses an action summary for a mixed group containing a question', () => {
    renderGroup({
      ...baseProps,
      parts: [
        { part: makePart('t1', 'result', 'web_search'), idx: 0 },
        { part: makePart('q1', 'blue', 'ask_user_question'), idx: 1 },
      ],
    });

    expect(
      screen.getByRole('button', { name: 'Ran 2 actions, Web Search, Question' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('stacked-icons')).toBeInTheDocument();
  });
});

describe('ToolCallGroup failure fast path', () => {
  const RevealProbe = ({ onReveal }: { onReveal: () => void }) => {
    useFailedReveal(true, onReveal);
    return <div data-testid="probe" />;
  };
  const failedParts = [
    { part: makePart('c1', 'created', 'create_file'), idx: 0 },
    { part: makePart('c2', 'Error processing tool: disk full', 'create_file'), idx: 1 },
  ];
  const props = (onReveal: () => void) =>
    ({
      parts: failedParts,
      isSubmitting: false,
      isLast: false,
      showThinking: false,
      lastContentIdx: 1,
      renderPart: (_p: TMessageContentParts, idx: number) => (
        <RevealProbe key={idx} onReveal={onReveal} />
      ),
    }) satisfies React.ComponentProps<typeof ToolCallGroup>;

  it('opens the group and asks its rows to open from the pill beside a standalone header', () => {
    const onReveal = jest.fn();
    renderGroup(props(onReveal));
    const header = screen.getByRole('button', { name: /· 1\/2 failed$/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_show_failed_one_of_n' }));

    expect(header).toHaveAttribute('aria-expanded', 'true');
    /** Once per row the group rendered, after those rows mounted. */
    expect(onReveal).toHaveBeenCalledTimes(failedParts.length);
  });

  it('shows the failure count once, on the pill, when it stands alone', () => {
    renderGroup(props(jest.fn()));
    const header = screen.getByRole('button', { name: /· 1\/2 failed$/ });
    expect(header).not.toHaveTextContent('1/2 failed');
    expect(screen.getByTestId('failed-reveal-pill')).toHaveTextContent('1/2 failed');
  });

  it("keeps the count in text inside a phase, where the pill is the phase's", () => {
    renderGroup({ ...props(jest.fn()), withinActivityPhase: true });
    expect(screen.getByRole('button', { name: /· 1\/2 failed$/ })).toHaveTextContent('1/2 failed');
  });

  it('leaves the pill to a live phase without collapsing its running group', () => {
    renderGroup({
      ...props(jest.fn()),
      parts: [...failedParts, { part: makePart('c3', '', 'create_file'), idx: 2 }],
      lastContentIdx: 2,
      isSubmitting: true,
      parentPhaseOwnsFailurePill: true,
    });

    const group = screen.getByRole('button', { name: /1\/3 failed$/ });
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(group).toHaveTextContent('1/3 failed');
    expect(screen.queryByTestId('failed-reveal-pill')).not.toBeInTheDocument();
  });

  it('leaves the pill to the phase header when nested in one', () => {
    renderGroup({ ...props(jest.fn()), withinActivityPhase: true });
    expect(screen.queryByTestId('failed-reveal-pill')).not.toBeInTheDocument();
  });

  it('opens for a request from a phase above when it holds a failure', () => {
    const onReveal = jest.fn();
    const { rerender } = render(
      <RecoilRoot>
        <FailedRevealContext.Provider value={{ tick: 0, claimFocus: null }}>
          <ToolCallGroup {...props(onReveal)} withinActivityPhase />
        </FailedRevealContext.Provider>
      </RecoilRoot>,
    );
    const header = screen.getByRole('button', { name: /· 1\/2 failed$/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    rerender(
      <RecoilRoot>
        <FailedRevealContext.Provider value={{ tick: 1, claimFocus: null }}>
          <ToolCallGroup {...props(onReveal)} withinActivityPhase />
        </FailedRevealContext.Provider>
      </RecoilRoot>,
    );
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('sets an open header in the primary colour over railed rows', () => {
    renderGroup(props(jest.fn()));
    const header = screen.getByRole('button', { name: /· 1\/2 failed$/ });
    expect(header).not.toHaveClass('text-text-primary');
    fireEvent.click(header);
    expect(header).toHaveClass('text-text-primary');
    expect(screen.getByTestId('tool-call-group-panel').firstElementChild).toHaveClass('pl-6');
  });
});
