import React from 'react';
import { RecoilRoot } from 'recoil';
import { ContentTypes, Tools } from 'librechat-data-provider';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import ContentParts from '../ContentParts';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string | number, string>) => {
    if (key === 'com_ui_ran_n_actions') {
      return `Ran ${values?.[0]} actions`;
    }
    if (key === 'com_ui_running_n_actions') {
      return `Running ${values?.[0]} actions`;
    }
    return key;
  },
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
  useLazyCollapseBody: jest.requireActual('~/hooks/Messages/useLazyCollapseBody').default,
  useProgress: (initial: number) => (initial >= 1 ? 1 : initial),
  scheduleMessageContentLayoutReconcile: jest.fn(() => jest.fn()),
}));

jest.mock('~/hooks/MCP', () => {
  const mcpServerNames: string[] = [];
  return {
    useMCPIconMap: () => new Map(),
    useMCPServerNames: () => mcpServerNames,
  };
});

jest.mock('../ToolOutput', () => ({
  StackedToolIcons: () => <span data-testid="stacked-icons" />,
  getMCPServerName: () => '',
  ToolIcon: () => <span data-testid="tool-icon" />,
  getToolIconType: () => 'mcp',
  isError: () => false,
}));

jest.mock('../ToolCallInfo', () => ({
  __esModule: true,
  default: () => <div data-testid="tool-call-info" />,
}));

jest.mock('../ProgressText', () => ({
  __esModule: true,
  default: ({ onClick, finishedText }: { onClick?: () => void; finishedText?: string }) => (
    <div data-testid="progress-text" onClick={onClick}>
      {finishedText}
    </div>
  ),
}));

/** Spread the real module: an icon set listed export-by-export goes silently
 *  undefined the moment a component imports one more glyph. */
jest.mock('lucide-react', () => ({
  ...jest.requireActual('lucide-react'),
  ChevronDown: () => <span>{'chevron'}</span>,
  TriangleAlert: () => <span>{'alert'}</span>,
  Users: () => <span>{'users'}</span>,
}));

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('../Parts', () => ({
  StreamingThoughtPeek: ({ text }: { text: string }) => (
    <div data-testid="streaming-thought-peek">{text}</div>
  ),
  AttachmentGroup: ({ attachments }: { attachments?: TAttachment[] }) => (
    <div
      data-testid="attachment-group"
      data-count={attachments?.length ?? 0}
      data-paths={(attachments ?? []).map((a) => a.filepath).join(',')}
    />
  ),
  ExecuteCode: () => <div data-testid="execute-code" />,
  ImageGen: () => <div data-testid="image-gen" />,
  AgentUpdate: () => <div data-testid="agent-update" />,
  EmptyText: () => <div data-testid="empty-text" />,
  Reasoning: () => <div data-testid="reasoning" />,
  ReasoningCompact: () => <div data-testid="compact-reasoning" />,
  Summary: () => <div data-testid="summary" />,
  Text: ({ text }: { text?: string }) => <div data-testid="text">{text}</div>,
  MemoryCall: ({ attachments }: { attachments?: TAttachment[] }) => (
    <div data-testid="memory-call" data-count={attachments?.length ?? 0} />
  ),
}));

jest.mock('../MemoryArtifacts', () => ({
  __esModule: true,
  default: () => <div data-testid="memory-artifacts" />,
}));

jest.mock('../WebSearch', () => ({
  __esModule: true,
  default: ({ attachments }: { attachments?: TAttachment[] }) => (
    <div data-testid="web-search" data-count={attachments?.length ?? 0} />
  ),
}));

jest.mock('../RetrievalCall', () => ({
  __esModule: true,
  default: () => <div data-testid="retrieval-call" />,
}));

jest.mock('../AgentHandoff', () => ({
  __esModule: true,
  default: () => <div data-testid="agent-handoff" />,
}));

jest.mock('../CodeAnalyze', () => ({
  __esModule: true,
  default: () => <div data-testid="code-analyze" />,
}));

jest.mock('../Image', () => ({
  __esModule: true,
  default: () => <div data-testid="image" />,
}));

jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('../SiblingHeader', () => ({
  __esModule: true,
  default: ({ agentId }: { agentId?: string }) => (
    <div data-testid="sibling-header" data-agent-id={agentId} />
  ),
}));

jest.mock('~/utils', () => {
  const actual = jest.requireActual('~/utils');
  return {
    ...actual,
    cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
    logger: { error: jest.fn() },
  };
});

const MCP_DELIMITER = '_mcp_';

const makeMcpToolCall = (
  id: string,
  hasOutput = true,
  stepId?: string,
  agentId?: string,
): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name: `getTinyImage${MCP_DELIMITER}Everything`,
      args: '{}',
      output: hasOutput ? 'image_returned' : '',
      ...(stepId == null ? {} : { stepId }),
      ...(agentId == null ? {} : { agentId }),
    },
  }) as unknown as TMessageContentParts;

const makeOwnedToolCall = (
  name: string,
  id: string,
  stepId?: string,
  agentId?: string,
): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name,
      args: '{}',
      output: 'completed',
      ...(stepId == null ? {} : { stepId }),
      ...(agentId == null ? {} : { agentId }),
    },
  }) as unknown as TMessageContentParts;

const makeMcpToolCallWithoutId = (name: string, hasOutput = true): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      name: `${name}${MCP_DELIMITER}Everything`,
      args: '{}',
      output: hasOutput ? 'image_returned' : '',
    },
  }) as unknown as TMessageContentParts;

const makeTextPart = (text: string): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, text }) as unknown as TMessageContentParts;

const makePhasePart = (start: number, end: number, label: string): TMessageContentParts =>
  ({
    type: ContentTypes.ACTIVITY_LABEL,
    [ContentTypes.ACTIVITY_LABEL]: label,
    activity_label_type: 'phase',
    activity_start_index: start,
    activity_end_index: end,
    activity_count: end - start,
    pending: false,
  }) as unknown as TMessageContentParts;

const imageAttachment = (toolCallId: string, name = 'tiny.png'): TAttachment =>
  ({
    filename: name,
    filepath: `/files/${name}`,
    width: 16,
    height: 16,
    messageId: 'm1',
    toolCallId,
    conversationId: 'c1',
  }) as unknown as TAttachment;

const renderContentParts = (props: React.ComponentProps<typeof ContentParts>) =>
  render(
    <RecoilRoot>
      <ContentParts {...props} />
    </RecoilRoot>,
  );

describe('ContentParts integration: MCP image hoist and grouping', () => {
  const baseProps = {
    messageId: 'msg1',
    isCreatedByUser: false,
    isLast: true,
    isSubmitting: false,
    showThinking: false,
    isLatestMessage: true,
  };

  it('groups 2+ MCP tool calls and hoists their attachments outside the collapsible', () => {
    const content = [makeMcpToolCall('t1'), makeMcpToolCall('t2')];
    const attachments = [imageAttachment('t1', 'a.png'), imageAttachment('t2', 'b.png')];

    renderContentParts({
      ...baseProps,
      content,
      attachments,
    });

    const groups = screen.getAllByTestId('attachment-group');
    // One AttachmentGroup hoisted at the group level — inner ToolCalls skip rendering theirs.
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute('data-count')).toBe('2');
  });

  it('does not group a single tool call — image renders inline (no hoist)', () => {
    const content = [makeMcpToolCall('t1')];
    const attachments = [imageAttachment('t1', 'a.png')];

    renderContentParts({
      ...baseProps,
      content,
      attachments,
    });

    // Single tool call: AttachmentGroup is rendered by ToolCall, not hoisted.
    const groups = screen.queryAllByTestId('attachment-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute('data-count')).toBe('1');
    // No tool group label.
    expect(screen.queryByText(/Used .* tools/)).not.toBeInTheDocument();
  });

  it('hoists attachments from all parts in the group, even mixed image and non-image', () => {
    const fileAtt: TAttachment = {
      filename: 'doc.pdf',
      filepath: '/files/doc.pdf',
      messageId: 'm1',
      toolCallId: 't2',
      conversationId: 'c1',
    } as unknown as TAttachment;

    const content = [makeMcpToolCall('t1'), makeMcpToolCall('t2')];
    const attachments = [imageAttachment('t1', 'a.png'), fileAtt];

    renderContentParts({
      ...baseProps,
      content,
      attachments,
    });

    const groups = screen.getAllByTestId('attachment-group');
    expect(groups).toHaveLength(1);
    // Both image and file are in the hoisted group.
    expect(groups[0].getAttribute('data-count')).toBe('2');
  });

  it('renders no AttachmentGroup when grouped tool calls have no attachments', () => {
    const content = [makeMcpToolCall('t1'), makeMcpToolCall('t2')];

    renderContentParts({
      ...baseProps,
      content,
      attachments: [],
    });

    expect(screen.queryByTestId('attachment-group')).not.toBeInTheDocument();
  });

  it('keeps an earlier step attachment off a live repeated provider call', () => {
    const content = [
      makeMcpToolCall('call_0', true, 'step-1', 'agent_a'),
      makeMcpToolCall('call_1', true, 'step-1', 'agent_a'),
      makeTextPart('between runs'),
      makeMcpToolCall('call_0', false, undefined, 'agent_a'),
      makeMcpToolCall('call_2', false, undefined, 'agent_a'),
    ];
    const previousAttachment = {
      ...imageAttachment('call_0', 'previous.png'),
      agentId: 'agent_a',
      stepId: 'step-1',
    } as unknown as TAttachment;

    renderContentParts({ ...baseProps, content, attachments: [previousAttachment] });

    const groups = screen.getAllByTestId('attachment-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveAttribute('data-count', '1');
  });

  it('routes producer-shaped search snapshots by agent and host step', () => {
    const content = [
      makeOwnedToolCall(Tools.web_search, 'call_0', 'step-search-1', 'agent-a'),
      makeTextPart('between searches'),
      makeOwnedToolCall(Tools.web_search, 'call_0', undefined, 'agent-a'),
    ];
    const attachments = [
      {
        type: Tools.web_search,
        messageId: 'm1',
        toolCallId: 'call_0',
        agentId: 'agent-a',
        stepId: 'step-search-1',
        conversationId: 'c1',
        [Tools.web_search]: { turn: 0, organic: [{ link: 'https://first.example' }] },
      },
      {
        type: Tools.web_search,
        messageId: 'm1',
        toolCallId: 'call_0',
        agentId: 'agent-a',
        stepId: 'step-search-2',
        conversationId: 'c1',
        [Tools.web_search]: { turn: 0, organic: [{ link: 'https://second.example' }] },
      },
    ] as unknown as TAttachment[];

    renderContentParts({ ...baseProps, content, attachments });

    expect(screen.getAllByTestId('web-search').map((card) => card.dataset.count)).toEqual([
      '1',
      '1',
    ]);
  });

  it('routes producer-shaped memory artifacts by agent and host step', () => {
    const content = [
      makeOwnedToolCall('set_memory', 'call_0', 'step-memory-1', 'agent-a'),
      makeTextPart('between memory writes'),
      makeOwnedToolCall('set_memory', 'call_0', undefined, 'agent-a'),
    ];
    const attachments = [
      {
        type: Tools.memory,
        messageId: 'm1',
        toolCallId: 'call_0',
        agentId: 'agent-a',
        stepId: 'step-memory-1',
        conversationId: 'c1',
        [Tools.memory]: { key: 'first', type: 'update' },
      },
      {
        type: Tools.memory,
        messageId: 'm1',
        toolCallId: 'call_0',
        agentId: 'agent-a',
        stepId: 'step-memory-2',
        conversationId: 'c1',
        [Tools.memory]: { key: 'second', type: 'update' },
      },
    ] as unknown as TAttachment[];

    renderContentParts({ ...baseProps, content, attachments });

    expect(screen.getAllByTestId('memory-call').map((card) => card.dataset.count)).toEqual([
      '1',
      '1',
    ]);
  });
  it('keeps a manually expanded completed tool group open when its content index shifts', () => {
    const content = [makeMcpToolCall('t1'), makeMcpToolCall('t2')];
    const nextContent = [makeTextPart('streamed preface'), ...content];

    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} content={content} />
      </RecoilRoot>,
    );

    const toggle = screen.getByRole('button', { name: /^Ran 2 actions/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <RecoilRoot>
        <ContentParts {...baseProps} content={nextContent} />
      </RecoilRoot>,
    );

    expect(screen.getByRole('button', { name: /^Ran 2 actions/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('keeps repeated legacy provider-id groups independently expanded', () => {
    const content = [
      makeMcpToolCall('call_0'),
      makeMcpToolCall('call_1'),
      makeTextPart('between batches'),
      makeMcpToolCall('call_0'),
      makeMcpToolCall('call_2'),
    ];
    const nextContent = [makeTextPart('streamed preface'), ...content];
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} content={content} />
      </RecoilRoot>,
    );

    const toggles = screen.getAllByRole('button', { name: /Everything/ });
    fireEvent.click(toggles[1]);
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false');
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <RecoilRoot>
        <ContentParts {...baseProps} content={nextContent} />
      </RecoilRoot>,
    );
    const shiftedToggles = screen.getAllByRole('button', { name: /Everything/ });
    expect(shiftedToggles[0]).toHaveAttribute('aria-expanded', 'false');
    expect(shiftedToggles[1]).toHaveAttribute('aria-expanded', 'true');
  });

  it('counts repeated legacy provider-id groups across activity phases', () => {
    const content = [
      makeMcpToolCall('call_0'),
      makeMcpToolCall('call_1'),
      makePhasePart(0, 2, 'First phase'),
      makeMcpToolCall('call_0'),
      makeMcpToolCall('call_2'),
      makePhasePart(3, 5, 'Second phase'),
    ];
    const shiftedContent = [
      makeTextPart('streamed preface'),
      makeMcpToolCall('call_0'),
      makeMcpToolCall('call_1'),
      makePhasePart(1, 3, 'First phase'),
      makeMcpToolCall('call_0'),
      makeMcpToolCall('call_2'),
      makePhasePart(4, 6, 'Second phase'),
    ];
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} content={content} />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'First phase' }));
    fireEvent.click(screen.getByRole('button', { name: 'Second phase' }));
    const toggles = screen.getAllByRole('button', { name: /Everything/ });
    fireEvent.click(toggles[1]);

    rerender(
      <RecoilRoot>
        <ContentParts {...baseProps} content={shiftedContent} />
      </RecoilRoot>,
    );
    for (const phase of ['First phase', 'Second phase']) {
      const phaseToggle = screen.getByRole('button', { name: phase });
      if (phaseToggle.getAttribute('aria-expanded') !== 'true') {
        fireEvent.click(phaseToggle);
      }
    }
    const shiftedToggles = screen.getAllByRole('button', { name: /Everything/ });
    expect(shiftedToggles[0]).toHaveAttribute('aria-expanded', 'false');
    expect(shiftedToggles[1]).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps a running tool group open when an individual tool is expanded before completion', () => {
    const runningContent = [makeMcpToolCall('t1', false), makeMcpToolCall('t2', false)];
    const completedContent = [
      makeMcpToolCall('t1', true, 'step-1'),
      makeMcpToolCall('t2', true, 'step-1'),
    ];

    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} isSubmitting isLatestMessage content={runningContent} />
      </RecoilRoot>,
    );

    /** A live run is one collapsed row; the reader opens it to reach the group,
     *  which still auto-expands around its running calls. */
    fireEvent.click(screen.getByRole('button', { name: /com_assistants_running_var/ }));
    const toggle = screen.getByRole('button', { name: /^Running 2 actions/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getAllByTestId('progress-text')[0]);

    rerender(
      <RecoilRoot>
        <ContentParts
          {...baseProps}
          isSubmitting={false}
          isLatestMessage
          content={completedContent}
        />
      </RecoilRoot>,
    );

    expect(screen.getByRole('button', { name: /^Ran 2 actions/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('does not reuse fallback-index expansion state across message ids', () => {
    const content = [makeMcpToolCallWithoutId('first'), makeMcpToolCallWithoutId('second')];

    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} messageId="msg1" content={content} />
      </RecoilRoot>,
    );

    const toggle = screen.getByRole('button', { name: /^Ran 2 actions/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <RecoilRoot>
        <ContentParts {...baseProps} messageId="msg2" content={content} />
      </RecoilRoot>,
    );

    expect(screen.getByRole('button', { name: /^Ran 2 actions/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('keeps id-backed expansion state across transient message id changes', () => {
    const content = [makeMcpToolCall('t1'), makeMcpToolCall('t2')];

    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} messageId="placeholder-msg" content={content} />
      </RecoilRoot>,
    );

    const toggle = screen.getByRole('button', { name: /^Ran 2 actions/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <RecoilRoot>
        <ContentParts {...baseProps} messageId="server-msg" content={content} />
      </RecoilRoot>,
    );

    expect(screen.getByRole('button', { name: /^Ran 2 actions/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('ContentParts — synthesized activity folds', () => {
  /** Settled by default: the fold is content-derived, so history and a live
   *  run partition identically. The streaming case gets its own test below. */
  const baseProps = {
    messageId: 'msg1',
    isCreatedByUser: false,
    isLast: true,
    showThinking: false,
    isSubmitting: false,
    isLatestMessage: true,
  };

  const makeChildLabel = (label: string): TMessageContentParts =>
    ({
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: label,
      pending: false,
    }) as unknown as TMessageContentParts;

  const TICKER = 'Confirmed the fix';
  const FIRST = 'Found 43 available GitHub tools';

  const labeledRun = () => [
    makeMcpToolCall('t1'),
    makeChildLabel(FIRST),
    makeMcpToolCall('t2'),
    makeChildLabel(TICKER),
  ];

  /** The card's header and the last sub-group's header carry the same text by
   *  design — the ticker IS that sub-group's line. The card is the outer one. */
  const foldHeader = () => screen.getAllByRole('button', { name: TICKER })[0];

  it('folds a labeled run into one collapsed card headed by the newest label', () => {
    renderContentParts({ ...baseProps, content: labeledRun() });

    expect(foldHeader()).toHaveAttribute('aria-expanded', 'false');
    /** Collapsed means unmounted, so the earlier row is not merely hidden. */
    expect(screen.queryByRole('button', { name: FIRST })).toBeNull();
    expect(screen.getAllByRole('button', { name: TICKER })).toHaveLength(1);
  });

  it('reveals the sub-groups, each still collapsed, when the card is opened', () => {
    renderContentParts({ ...baseProps, content: labeledRun() });

    fireEvent.click(foldHeader());

    expect(screen.getByRole('button', { name: FIRST })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button', { name: TICKER })[1]).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('keeps the in-flight tool call inside the card while the run streams', () => {
    renderContentParts({
      ...baseProps,
      isSubmitting: true,
      content: [...labeledRun(), makeMcpToolCall('t3', false)],
    });

    /** The header speaks for the call the reader is watching, so the block
     *  stays one row instead of growing a sibling row per call. */
    expect(screen.getAllByTestId('activity-phase-card')).toHaveLength(1);
    expect(screen.queryByTestId('tool-call')).toBeNull();
    expect(screen.getByRole('button', { name: /com_assistants_running_var/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('leaves the in-flight tool call outside a settled card', () => {
    renderContentParts({
      ...baseProps,
      content: [...labeledRun(), makeMcpToolCall('t3', false)],
    });

    const panel = screen.getByTestId('activity-phase-panel');
    expect(panel.contains(screen.getByTestId('tool-call'))).toBe(false);
  });

  it('keeps the reader’s toggle when the ticker advances', () => {
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} content={labeledRun()} />
      </RecoilRoot>,
    );
    fireEvent.click(foldHeader());

    rerender(
      <RecoilRoot>
        <ContentParts
          {...baseProps}
          content={[...labeledRun(), makeMcpToolCall('t3'), makeChildLabel('Checked the callers')]}
        />
      </RecoilRoot>,
    );

    expect(screen.getAllByRole('button', { name: 'Checked the callers' })[0]).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('keeps the reader’s toggle when a server summary replaces the ticker', () => {
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} content={labeledRun()} />
      </RecoilRoot>,
    );
    fireEvent.click(foldHeader());

    rerender(
      <RecoilRoot>
        <ContentParts
          {...baseProps}
          content={[...labeledRun(), makePhasePart(0, 4, 'Reviewed the release paths')]}
        />
      </RecoilRoot>,
    );

    expect(screen.getByRole('button', { name: 'Reviewed the release paths' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('does not replay the entrance fold when the summary replaces the ticker', () => {
    const streaming = { ...baseProps, isSubmitting: true };
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...streaming} content={labeledRun()} />
      </RecoilRoot>,
    );

    rerender(
      <RecoilRoot>
        <ContentParts
          {...streaming}
          content={[...labeledRun(), makePhasePart(0, 4, 'Reviewed the release paths')]}
        />
      </RecoilRoot>,
    );

    /** The entrance mounts a card OPEN and folds it shut over the next two
     *  painted frames. Playing it here would flash every sub-group back open
     *  on top of a card the reader already watched fold. */
    expect(screen.getByRole('button', { name: 'Reviewed the release paths' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('ticks the header forward as each sub-group resolves', () => {
    const steps = ['Read the config', 'Checked the callers', 'Confirmed the fix'];
    const content: TMessageContentParts[] = [];
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} content={[]} />
      </RecoilRoot>,
    );

    const headers: string[] = [];
    steps.forEach((step, index) => {
      content.push(makeMcpToolCall(`t${index}`), makeChildLabel(step));
      rerender(
        <RecoilRoot>
          <ContentParts {...baseProps} content={[...content]} />
        </RecoilRoot>,
      );
      const panel = screen.queryByTestId('activity-phase-panel');
      if (panel == null) {
        return;
      }
      const card = panel.parentElement?.querySelector('button');
      headers.push(card?.getAttribute('aria-label') ?? '');
      expect(card).toHaveAttribute('aria-expanded', 'false');
    });

    /** One card from the second activity on, its line always the newest —
     *  and never re-opening underneath the reader as the run advances. */
    expect(headers).toEqual(['Checked the callers', 'Confirmed the fix']);
  });

  it('refuses to fold a span holding an unresolved approval', () => {
    const awaiting = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 't2',
        name: `getTinyImage${MCP_DELIMITER}Everything`,
        args: '{}',
        output: '',
        approval: { state: 'pending' },
      },
    } as unknown as TMessageContentParts;

    renderContentParts({
      ...baseProps,
      content: [makeMcpToolCall('t1'), makeChildLabel(FIRST), awaiting, makeChildLabel(TICKER)],
    });

    /** No card: the run is blocked on the reader, and the request must not sit
     *  behind a disclosure they have to discover. */
    expect(screen.queryByTestId('activity-phase-panel')).toBeNull();
    expect(screen.getByRole('button', { name: FIRST })).toBeInTheDocument();
  });

  it('never mounts a fold expanded while the run is live', () => {
    /** The entrance mounts a card OPEN and folds it shut. This component
     *  remounts mid-run — `messageId` is in the key and changes when the
     *  placeholder hydrates to the server id — so an entrance here would flash
     *  the whole fold back open partway through the run. */
    renderContentParts({ ...baseProps, isSubmitting: true, content: labeledRun() });

    /** A live header is named by the line it shows rather than an `aria-label`. */
    expect(screen.getByRole('button', { name: new RegExp(TICKER) })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('button', { name: FIRST })).toBeNull();
  });

  it('keeps the toggle even when the summary claims more content than the fold', () => {
    /** The server extends a phase back across short intermediate text that the
     *  client treats as a boundary, so the two spans start in different
     *  places. They still share their first tool call, which is what the card
     *  is anchored to — so this is the same card gaining content, not a new
     *  one, and the reader's choice rides through. */
    const preface = makeTextPart('Checking now.');
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} content={[preface, ...labeledRun()]} />
      </RecoilRoot>,
    );
    fireEvent.click(foldHeader());

    rerender(
      <RecoilRoot>
        <ContentParts
          {...baseProps}
          content={[preface, ...labeledRun(), makePhasePart(0, 5, 'Reviewed the release paths')]}
        />
      </RecoilRoot>,
    );

    expect(screen.getByRole('button', { name: 'Reviewed the release paths' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('folds a span whose tool output is hoisted, carrying the output outside', () => {
    /** This span used to refuse to fold: `ToolCallGroup` renders
     *  `groupAttachments` outside its own panel so a generated image survives
     *  collapsing the group, and folding put that hoist back inside a
     *  disclosure. The card now lifts those files one level further, into its
     *  own row outside the fold, so the span folds like any other — which
     *  matters because runs that produce files are the ones with the longest
     *  lists to fold. */
    renderContentParts({
      ...baseProps,
      content: labeledRun(),
      attachments: [imageAttachment('t2', 'chart.png')],
    });

    expect(screen.getByTestId('activity-phase-panel')).toBeInTheDocument();
    const row = screen.getByTestId('attachment-group');
    expect(row.getAttribute('data-count')).toBe('1');
    expect(
      within(screen.getByTestId('activity-phase-panel')).queryByTestId('attachment-group'),
    ).toBeNull();
  });

  it('keeps the reader’s card open when the message takes its server id', () => {
    /** The assistant streams under a synthetic `<userId>_` for the whole run
     *  and only takes its real id at finalize. A key carrying `messageId`
     *  would remount every card at that moment and drop the toggle. */
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} content={labeledRun()} />
      </RecoilRoot>,
    );
    fireEvent.click(foldHeader());

    rerender(
      <RecoilRoot>
        <ContentParts {...baseProps} messageId="server-id" content={labeledRun()} />
      </RecoilRoot>,
    );

    expect(foldHeader()).toHaveAttribute('aria-expanded', 'true');
  });

  it('resets the card when the reader pages to another sibling', () => {
    /** `MultiMessage` reuses this instance across siblings, so a card anchored
     *  only to a content index would carry one response's open state into an
     *  unrelated one. The provider id on the span's first call separates them.
     *  No message identity can: `messageId` moves at settle too. */
    const otherSibling = [
      makeMcpToolCall('other-1'),
      makeChildLabel(FIRST),
      makeMcpToolCall('other-2'),
      makeChildLabel(TICKER),
    ];
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} siblingIdx={0} content={labeledRun()} />
      </RecoilRoot>,
    );
    fireEvent.click(foldHeader());

    rerender(
      <RecoilRoot>
        <ContentParts
          {...baseProps}
          siblingIdx={1}
          messageId="sibling-msg"
          content={otherSibling}
        />
      </RecoilRoot>,
    );

    expect(foldHeader()).toHaveAttribute('aria-expanded', 'false');
  });

  it('survives background churn that renumbers the response in place', () => {
    /** `MultiMessage` recomputes the viewed response's positional index when a
     *  sibling is added or dropped around it — dropping an optimistic row
     *  moves the newest response from index 1 to 0 while the reader stays on
     *  it. Nothing about the response changed, so neither should the card. */
    const { rerender } = render(
      <RecoilRoot>
        <ContentParts {...baseProps} siblingIdx={1} content={labeledRun()} />
      </RecoilRoot>,
    );
    fireEvent.click(foldHeader());

    rerender(
      <RecoilRoot>
        <ContentParts {...baseProps} siblingIdx={0} content={labeledRun()} />
      </RecoilRoot>,
    );

    expect(foldHeader()).toHaveAttribute('aria-expanded', 'true');
  });

  it('lets the live header stand in for the cursor when a placeholder trails the fold', () => {
    /** Providers append an empty TEXT slot after visible output. The run's
     *  tail is inside the card's span, and that trailing slot looks like the
     *  initial waiting state from inside its own segment. The live header's
     *  shimmer is the liveness signal: a cursor row under it would be a second
     *  row, and the segment's `EmptyText` a third. */
    const { container } = renderContentParts({
      ...baseProps,
      isSubmitting: true,
      content: [...labeledRun(), makeTextPart('')],
    });

    expect(container.querySelectorAll('.result-thinking')).toHaveLength(0);
    expect(screen.queryAllByTestId('empty-text')).toHaveLength(0);
    expect(screen.getByTestId('activity-phase-card').querySelector('.shimmer')).not.toBeNull();
  });

  it('leaves an unlabeled run rendering exactly as before', () => {
    renderContentParts({
      ...baseProps,
      content: [makeMcpToolCall('t1'), makeMcpToolCall('t2')],
    });

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('activity-phase-panel')).toBeNull();
  });
});

describe('ContentParts integration: phase media row', () => {
  const baseProps = {
    messageId: 'msg1',
    isCreatedByUser: false,
    isLast: true,
    isSubmitting: false,
    showThinking: false,
    isLatestMessage: true,
  };

  /** Two labeled calls the server has claimed as one phase, plus whatever the
   *  answer says afterwards. */
  const phaseContent = (answer?: string): TMessageContentParts[] => [
    makeMcpToolCall('t1'),
    makeMcpToolCall('t2'),
    makePhasePart(0, 2, 'Generated five mortgage charts'),
    ...(answer == null ? [] : [makeTextPart(answer)]),
  ];
  const phaseAttachments = [imageAttachment('t1', 'a.png'), imageAttachment('t2', 'b.png')];

  it("lifts a phase's files into a media row the fold cannot hide", () => {
    renderContentParts({ ...baseProps, content: phaseContent(), attachments: phaseAttachments });

    const rows = screen.getAllByTestId('attachment-group');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-count')).toBe('2');
    // The row is a sibling of the collapsed card, not a child of its panel.
    expect(
      within(screen.getByTestId('activity-phase-panel')).queryByTestId('attachment-group'),
    ).toBeNull();
  });

  it('still shows one row once the reader expands the phase', () => {
    renderContentParts({ ...baseProps, content: phaseContent(), attachments: phaseAttachments });

    fireEvent.click(screen.getByRole('button', { name: 'Generated five mortgage charts' }));

    const rows = screen.getAllByTestId('attachment-group');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-count')).toBe('2');
  });

  it('lifts the file of a lone tool call too, not just a grouped batch', () => {
    // One call never forms a ToolCallGroup, so this exercises Part -> ToolCall's
    // own `hideAttachments` rather than the group-level hoist.
    const content = [makeMcpToolCall('t1'), makePhasePart(0, 1, 'Rendered the chart')];

    renderContentParts({ ...baseProps, content, attachments: [imageAttachment('t1', 'a.png')] });

    const rows = screen.getAllByTestId('attachment-group');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-count')).toBe('1');
    expect(
      within(screen.getByTestId('activity-phase-panel')).queryByTestId('attachment-group'),
    ).toBeNull();
  });

  it('shows the latest record when a tool writes the same file twice', () => {
    // Both records name one stored file; the later carries the fresher
    // lifecycle fields. Hoisting makes this row the only surface for it, so a
    // first-seen dedup would pin the stale record on screen.
    const stale = { ...imageAttachment('t1', 'a.png'), file_id: 'f1' } as TAttachment;
    const fresh = { ...stale, filepath: '/files/a.png?v=2' } as TAttachment;
    const content = [makeMcpToolCall('t1'), makePhasePart(0, 1, 'Redrew the chart')];

    renderContentParts({ ...baseProps, content, attachments: [stale, fresh] });

    const row = screen.getByTestId('attachment-group');
    expect(row.getAttribute('data-count')).toBe('1');
    expect(row.getAttribute('data-paths')).toBe('/files/a.png?v=2');
  });

  it('renders no row for a phase that produced nothing', () => {
    renderContentParts({ ...baseProps, content: phaseContent() });

    expect(screen.queryByTestId('attachment-group')).toBeNull();
  });
});

describe('ContentParts integration: lane groups backed by one agent', () => {
  const baseProps = {
    messageId: 'msg-lane',
    isCreatedByUser: false,
    isLast: true,
    isSubmitting: false,
    showThinking: false,
    isLatestMessage: true,
  };

  const inLane = (part: TMessageContentParts, agentId: string, groupId = 1): TMessageContentParts =>
    ({ ...(part as object), agentId, groupId }) as unknown as TMessageContentParts;

  it('renders no lane header when a phase marker splits a single-agent group', () => {
    /** The reported shape: a multi-agent graph stamped a group id on the
     *  primary agent's own output, and a phase marker ending mid-group split
     *  it — so one lane rendered as TWO bordered cards, each repeating the
     *  message's own author, and the answer read as a separate message. */
    const answer = 'Monitoring the pull requests for the next hour.';
    const content = [
      makeMcpToolCall('t1'),
      makeMcpToolCall('t2'),
      inLane(makeMcpToolCall('t3'), 'agent_a'),
      inLane(makeTextPart(answer), 'agent_a'),
      makePhasePart(0, 3, 'Planned the monitoring run'),
    ];

    renderContentParts({ ...baseProps, content });
    /** The card mounts collapsed and its body is lazy, so open it — the split
     *  drew one header inside the card and one after it. */
    fireEvent.click(screen.getByRole('button', { name: 'Planned the monitoring run' }));

    expect(screen.queryAllByTestId('sibling-header')).toHaveLength(0);
    expect(screen.getAllByText(answer)).toHaveLength(1);
  });

  it('groups the tool calls of a single-agent group, which lanes never do', () => {
    const content = [
      inLane(makeMcpToolCall('t1'), 'agent_a'),
      inLane(makeMcpToolCall('t2'), 'agent_a'),
    ];

    renderContentParts({ ...baseProps, content });

    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('still renders columns once a second agent shares the group', () => {
    const content = [
      inLane(makeTextPart('primary answer'), 'agent_a'),
      inLane(makeTextPart('added answer'), 'agent_b____1'),
    ];

    renderContentParts({ ...baseProps, content });

    const headers = screen.getAllByTestId('sibling-header');
    expect(headers.map((header) => header.getAttribute('data-agent-id'))).toEqual([
      'agent_a',
      'agent_b____1',
    ]);
  });

  it('keeps lane attribution when a phase marker leaves one agent per slice', () => {
    /** Lane cardinality belongs to the MESSAGE. A marker that puts each agent
     *  of a real two-agent group in a different slice would otherwise demote
     *  both, and the added agent's answer would read as the primary's. */
    const content = [
      inLane(makeTextPart('primary answer'), 'agent_a'),
      inLane(makeTextPart('added answer'), 'agent_b____1'),
      makePhasePart(0, 1, 'Ran both agents'),
    ];

    renderContentParts({ ...baseProps, content });
    fireEvent.click(screen.getByRole('button', { name: 'Ran both agents' }));

    const agentIds = screen
      .getAllByTestId('sibling-header')
      .map((header) => header.getAttribute('data-agent-id'));
    expect(agentIds).toContain('agent_a');
    expect(agentIds).toContain('agent_b____1');
  });

  it('keeps content that runs between two lane groups in transcript order', () => {
    const content = [
      inLane(makeTextPart('first wave primary'), 'agent_a', 1),
      inLane(makeTextPart('first wave added'), 'agent_b____1', 1),
      makeTextPart('handover note between the waves'),
      inLane(makeTextPart('second wave primary'), 'agent_a', 2),
      inLane(makeTextPart('second wave added'), 'agent_b____1', 2),
    ];

    renderContentParts({ ...baseProps, content });

    const transcript = document.body.textContent ?? '';
    expect(transcript).toContain('handover note between the waves');
    expect(transcript.indexOf('handover note between the waves')).toBeGreaterThan(
      transcript.indexOf('first wave primary'),
    );
    expect(transcript.indexOf('handover note between the waves')).toBeLessThan(
      transcript.indexOf('second wave primary'),
    );
  });
});

describe('ContentParts — live activity fold', () => {
  const liveProps = {
    messageId: 'msg1',
    isCreatedByUser: false,
    isLast: true,
    showThinking: false,
    isSubmitting: true,
    isLatestMessage: true,
  };

  const intentCall = (id: string, intent: string, output = ''): TMessageContentParts =>
    ({
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id, name: 'lookup', args: `{"intent":"${intent}`, output },
    }) as unknown as TMessageContentParts;

  const liveHeader = () =>
    within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];

  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds an unlabeled running batch at one collapsed row without mounting its cards', () => {
    renderContentParts({
      ...liveProps,
      content: [intentCall('t1', 'Reading the lens file'), intentCall('t2', 'Querying the graph')],
    });

    expect(liveHeader()).toHaveAttribute('aria-expanded', 'false');
    expect(liveHeader()).toHaveTextContent('Querying the graph');
    expect(screen.queryByTestId('tool-call')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Running 2 actions/ })).toBeNull();
  });

  it('folds from the very first call so the block never changes shape as calls arrive', () => {
    const { rerender } = renderContentParts({
      ...liveProps,
      content: [intentCall('t1', 'Reading the lens file')],
    });
    expect(screen.getAllByRole('button')).toHaveLength(1);

    rerender(
      <RecoilRoot>
        <ContentParts
          {...liveProps}
          content={[intentCall('t1', 'Reading the lens file', 'ok'), intentCall('t2', 'Next')]}
        />
      </RecoilRoot>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('paints the first line at once, then at most one newer line per interval', () => {
    jest.useFakeTimers();
    const frame = (content: TMessageContentParts[]) => (
      <RecoilRoot>
        <ContentParts {...liveProps} content={content} />
      </RecoilRoot>
    );
    const { rerender } = render(frame([intentCall('t1', 'Reading')]));
    expect(liveHeader()).toHaveTextContent('Reading');

    rerender(frame([intentCall('t1', 'Reading the lens')]));
    rerender(frame([intentCall('t1', 'Reading the lens file')]));
    expect(liveHeader()).not.toHaveTextContent('Reading the lens');

    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(liveHeader()).toHaveTextContent('Reading the lens file');
  });

  it('lets a filled batch label take the line over from the call it describes', () => {
    renderContentParts({
      ...liveProps,
      content: [
        intentCall('t1', 'Reading the lens file', 'ok'),
        {
          type: ContentTypes.ACTIVITY_LABEL,
          [ContentTypes.ACTIVITY_LABEL]: 'Confirmed the missing lens',
          pending: false,
        } as unknown as TMessageContentParts,
      ],
    });

    expect(liveHeader()).toHaveTextContent('Confirmed the missing lens');
  });

  it('previews reasoning between calls one sentence at a time, in the same single row', () => {
    jest.useFakeTimers();
    const frame = (think: string) => (
      <RecoilRoot>
        <ContentParts
          {...liveProps}
          content={[
            intentCall('t1', 'Reading the lens file', 'ok'),
            { type: ContentTypes.THINK, think } as unknown as TMessageContentParts,
          ]}
        />
      </RecoilRoot>
    );
    const { rerender } = render(frame('Both refs share a commit.'));
    expect(liveHeader()).toHaveTextContent('Both refs share a commit.');
    expect(screen.queryByTestId('reasoning')).toBeNull();

    /** The next sentence is not shown while it is still being written. */
    rerender(frame('Both refs share a commit. That leaves the ordering'));
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(liveHeader()).toHaveTextContent('Both refs share a commit.');
    expect(liveHeader()).not.toHaveTextContent('That leaves the ordering');
    rerender(frame('Both refs share a commit. That leaves the ordering.'));
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(liveHeader()).toHaveTextContent('That leaves the ordering.');
    expect(within(liveHeader()).getByTitle('That leaves the ordering.')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('leaves a reasoning-bearing span unfolded when thinking opens by default', () => {
    renderContentParts({
      ...liveProps,
      showThinking: true,
      content: [
        intentCall('t1', 'Reading the lens file', 'ok'),
        {
          type: ContentTypes.THINK,
          think: 'Weighing the refs.',
        } as unknown as TMessageContentParts,
      ],
    });

    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
    expect(screen.getByTestId('compact-reasoning')).toBeInTheDocument();
  });

  it('holds the block at one row from a thought through the calls that follow it', () => {
    /** A reasoning model thinks, then calls. Rendering the thought as its own
     *  row gave it a multi-line peek that the first call then snapped shut — a
     *  jump up and back down on every step. The row count must not move. */
    const thought = {
      type: ContentTypes.THINK,
      think: 'Planning the lookup.',
    } as unknown as TMessageContentParts;
    const { rerender } = renderContentParts({ ...liveProps, content: [thought] });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(liveHeader()).toHaveTextContent('Planning the lookup.');
    expect(screen.queryByTestId('reasoning')).toBeNull();
    expect(screen.getByTestId('live-phase-thinking')).toBeInTheDocument();

    rerender(
      <RecoilRoot>
        <ContentParts {...liveProps} content={[thought, intentCall('t1', 'Reading the file')]} />
      </RecoilRoot>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByTestId('reasoning')).toBeNull();
  });

  it('keeps a row the reader opened on a thought open when the first tool call arrives', () => {
    /** Reasoning-only, the card has no provider id to key on; gaining one must
     *  not remount it. */
    const thought = {
      type: ContentTypes.THINK,
      think: 'Planning the lookup.',
    } as unknown as TMessageContentParts;
    const { rerender } = renderContentParts({ ...liveProps, content: [thought] });
    const card = screen.getByTestId('activity-phase-card');
    fireEvent.click(liveHeader());
    expect(liveHeader()).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <RecoilRoot>
        <ContentParts {...liveProps} content={[thought, intentCall('t1', 'Reading the file')]} />
      </RecoilRoot>,
    );

    expect(screen.getByTestId('activity-phase-card')).toBe(card);
    expect(liveHeader()).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps a reasoning-led card open through the summary and the response finalizing', () => {
    const thought = {
      type: ContentTypes.THINK,
      think: 'Planning the lookup.',
    } as unknown as TMessageContentParts;
    const calls = [makeMcpToolCall('t1'), makeMcpToolCall('t2')];
    const frame = (props: {
      content: TMessageContentParts[];
      messageId?: string;
      isSubmitting?: boolean;
    }) => (
      <RecoilRoot>
        <ContentParts {...liveProps} {...props} />
      </RecoilRoot>
    );
    const { rerender } = render(frame({ content: [thought] }));
    rerender(frame({ content: [thought, ...calls] }));
    fireEvent.click(liveHeader());
    const card = screen.getByTestId('activity-phase-card');

    const settled = [thought, ...calls, makePhasePart(0, 3, 'Fetched two images')];
    rerender(frame({ content: settled }));
    expect(screen.getByTestId('activity-phase-card')).toBe(card);

    /** The message takes its server id in the same commit the run ends. */
    rerender(frame({ content: settled, messageId: 'server-id', isSubmitting: false }));
    expect(screen.getByTestId('activity-phase-card')).toBe(card);
    expect(screen.getByRole('button', { name: 'Fetched two images' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('keeps a thought on its own open row for a reader who opens thinking by default', () => {
    renderContentParts({
      ...liveProps,
      showThinking: true,
      content: [
        { type: ContentTypes.THINK, think: 'Planning.' } as unknown as TMessageContentParts,
      ],
    });

    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
    expect(screen.getByTestId('reasoning')).toBeInTheDocument();
  });

  it('renders a span that is waiting on a sign-in unfolded', () => {
    const authCall = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 't1',
        name: `getTinyImage${MCP_DELIMITER}Everything`,
        args: '{}',
        output: '',
        auth: 'https://example.com/oauth',
      },
    } as unknown as TMessageContentParts;
    renderContentParts({ ...liveProps, content: [authCall] });

    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
  });

  it('leaves the run unfolded when the host opts out (tools expanded by default, subagent panel)', () => {
    renderContentParts({
      ...liveProps,
      foldLiveActivity: false,
      content: [makeMcpToolCall('t1', false), makeMcpToolCall('t2', false)],
    });

    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
    expect(screen.getAllByTestId('tool-call')).toHaveLength(2);
  });

  it('names short commentary streamed after a call instead of holding the stale call', () => {
    renderContentParts({
      ...liveProps,
      content: [
        intentCall('t1', 'Reading the lens file', 'ok'),
        { type: ContentTypes.TEXT, text: 'Now checking the callers.', phase: 'commentary' },
      ] as TMessageContentParts[],
    });

    expect(liveHeader()).toHaveTextContent('Now checking the callers.');
  });

  it('reports a call the run closed as failed or cancelled, never as completed', () => {
    const closed = (runStepStatus: string): TMessageContentParts =>
      ({
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: {
          id: 't1',
          name: 'lookup',
          args: '{}',
          output: '',
          runStepStatus,
        },
      }) as unknown as TMessageContentParts;
    const { unmount } = renderContentParts({ ...liveProps, content: [closed('failed')] });
    expect(liveHeader()).toHaveTextContent('com_ui_failed_subject');
    unmount();

    renderContentParts({ ...liveProps, content: [closed('cancelled')] });
    expect(liveHeader()).toHaveTextContent('com_ui_cancelled');
  });

  it('reports a cancelled background task even though its dispatch step completed', () => {
    const dispatched = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 't1',
        name: 'lookup',
        args: '{}',
        output: 'dispatched',
        runStepStatus: 'completed',
        backgroundTask: { cancelled: true },
      },
    } as unknown as TMessageContentParts;
    renderContentParts({ ...liveProps, content: [dispatched] });

    expect(liveHeader()).toHaveTextContent('com_ui_cancelled');
  });

  it('renders unfolded while a subagent’s own call waits on a sign-in', () => {
    const subagent = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 's1',
        name: 'lookup',
        args: '{}',
        output: '',
        subagent_content: [
          {
            type: ContentTypes.TOOL_CALL,
            [ContentTypes.TOOL_CALL]: {
              id: 'n1',
              name: `getTinyImage${MCP_DELIMITER}Everything`,
              args: '{}',
              output: '',
              auth: 'https://example.com/oauth',
            },
          },
        ],
      },
    } as unknown as TMessageContentParts;
    renderContentParts({ ...liveProps, content: [subagent] });

    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
  });

  it('reports a detached task that failed through its status attachment', () => {
    const handle = JSON.stringify({
      background_task_id: 'bg1',
      tool: 'lookup',
      status: 'running',
      message: 'Dispatched. Poll with check_background_task.',
    });
    const dispatched = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 't1',
        name: 'lookup',
        args: '{}',
        output: handle,
        runStepStatus: 'completed',
      },
    } as unknown as TMessageContentParts;
    const failed = {
      type: 'background_task_status',
      status: 'error',
      toolCallId: 't1',
      messageId: 'msg1',
    } as unknown as TAttachment;
    renderContentParts({ ...liveProps, content: [dispatched], attachments: [failed] });

    expect(liveHeader()).toHaveTextContent('com_ui_failed_subject');
  });

  it('keeps a handoff card out of the live row and folds the next agent’s calls after it', () => {
    const transfer = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'h1',
        name: 'lc_transfer_to_agent_b',
        args: '{}',
        output: '',
      },
    } as unknown as TMessageContentParts;
    renderContentParts({
      ...liveProps,
      content: [makeMcpToolCall('t1'), transfer, intentCall('t2', 'Picking up the task')],
    });

    expect(screen.getByTestId('agent-handoff')).toBeInTheDocument();
    expect(liveHeader()).toHaveTextContent('Picking up the task');
  });

  it('announces each finished line once through a polite region', () => {
    jest.useFakeTimers();
    const frame = (content: TMessageContentParts[]) => (
      <RecoilRoot>
        <ContentParts {...liveProps} content={content} />
      </RecoilRoot>
    );
    const { rerender } = render(frame([intentCall('t1', 'Reading the lens file')]));
    const status = () => screen.getByTestId('activity-phase-announcer');
    expect(status()).toBeEmptyDOMElement();

    rerender(
      frame([intentCall('t1', 'Reading the lens file', 'ok'), intentCall('t2', 'Querying')]),
    );
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(status()).toHaveTextContent('Reading the lens file');
  });

  /** One fixture per channel a call can report its outcome through. The live
   *  line reads the same resolver as the group header, so each must surface. */
  const handleOutput = JSON.stringify({
    background_task_id: 'bg1',
    tool: 'lookup',
    status: 'running',
    message: 'Dispatched. Poll with check_background_task.',
  });
  const statusAttachment = (status: string) =>
    ({
      type: 'background_task_status',
      status,
      toolCallId: 't1',
      messageId: 'msg1',
    }) as unknown as TAttachment;
  it.each([
    [
      'a cancelled status attachment',
      { name: 'lookup', output: handleOutput, runStepStatus: 'completed' },
      [statusAttachment('cancelled')],
      'com_ui_cancelled',
    ],
    [
      'a memory tool failing in prose',
      { name: 'set_memory', output: 'Invalid key "x". Must be one of: a' },
      [],
      'com_ui_failed',
    ],
  ])('surfaces %s in the collapsed row', (_name, call, attachments, expected) => {
    const part = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id: 't1', args: '{}', ...call },
    } as unknown as TMessageContentParts;
    renderContentParts({ ...liveProps, content: [part], attachments });

    expect(liveHeader()).toHaveTextContent(expected);
  });

  it('ends the live span at a legacy call mixed into an agents run', () => {
    const codeInterpreter = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'ci1',
        type: 'code_interpreter',
        code_interpreter: { input: 'print(1)', outputs: [] },
      },
    } as unknown as TMessageContentParts;
    renderContentParts({ ...liveProps, content: [makeMcpToolCall('t1'), codeInterpreter] });

    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
  });

  it('names the live disclosure by its current line alone, not the announced one', () => {
    jest.useFakeTimers();
    const frame = (content: TMessageContentParts[]) => (
      <RecoilRoot>
        <ContentParts {...liveProps} content={content} />
      </RecoilRoot>
    );
    const { rerender } = render(frame([intentCall('t1', 'Reading the lens file')]));
    rerender(
      frame([intentCall('t1', 'Reading the lens file', 'ok'), intentCall('t2', 'Querying')]),
    );
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(screen.getByTestId('activity-phase-announcer')).toHaveTextContent(
      'Reading the lens file',
    );
    /** No multiplier: both calls named their own work, so the line is a
     *  sentence about the newest one rather than the tool's label. */
    expect(liveHeader()).toHaveAccessibleName('Querying');
  });

  it('leaves a span of legacy Assistants calls, which the header cannot name, unfolded', () => {
    const codeInterpreter = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'ci1',
        type: 'code_interpreter',
        code_interpreter: { input: 'print(1)', outputs: [] },
      },
    } as unknown as TMessageContentParts;
    renderContentParts({ ...liveProps, content: [codeInterpreter] });

    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
  });

  it('stops folding once the answer starts, leaving the settled rendering', () => {
    renderContentParts({
      ...liveProps,
      content: [makeMcpToolCall('t1'), makeMcpToolCall('t2'), makeTextPart('Here is the answer.')],
    });

    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
    expect(screen.getByRole('button', { name: /^Ran 2 actions/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('keeps the reader’s toggle when the server summary replaces the live line', () => {
    const calls = [makeMcpToolCall('t1'), makeMcpToolCall('t2')];
    const { rerender } = renderContentParts({ ...liveProps, content: calls });
    fireEvent.click(liveHeader());
    expect(liveHeader()).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <RecoilRoot>
        <ContentParts
          {...liveProps}
          content={[...calls, makePhasePart(0, 2, 'Fetched two images')]}
        />
      </RecoilRoot>,
    );

    expect(screen.getByRole('button', { name: 'Fetched two images' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
