import React from 'react';
import { ContentTypes, Tools } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessageContentParts, TAttachment } from 'librechat-data-provider';
import { preserveStreamedContentIdentity } from '~/utils/messages';
import { groupSequentialToolCalls } from '~/utils';

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  mapAttachments: () => ({}),
  filterAttachmentsForPart: (attachments: unknown) => attachments,
  groupSequentialToolCalls: jest.fn(),
  hasPendingApprovalInPart: jest.requireActual('~/utils/groupToolCalls').hasPendingApprovalInPart,
  getPartKeyIndex: jest.requireActual('~/utils/messages').getPartKeyIndex,
  /** Real implementations: the media helpers are pure and drive the phase
   * card's attachment row, so stubbing them would make that path inert here. */
  ...jest.requireActual<typeof import('~/utils/media')>('~/utils/media'),
}));

jest.mock('~/Providers', () => {
  return {
    /** Use the real context: cloning the immediate child assumes Part has no
     * intervening providers and does not exercise context propagation. */
    MessageContext: jest.requireActual<typeof import('~/Providers/MessageContext')>(
      '~/Providers/MessageContext',
    ).MessageContext,
    SearchContext: {
      Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    },
    /** `WebSearch` reads this; leaving it off the mock threw inside the render and
     * the component's own catch swallowed it, so the sources path was dead here
     * while the suite still passed. */
    useSearchContext: () => ({ searchResults: undefined }),
    MediaContext: {
      Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    },
    useMediaContext: () => ({ attachmentsByName: undefined }),
  };
});

jest.mock('../Parts', () => ({
  EmptyText: ({ underHeaderIcon }: { underHeaderIcon?: boolean }) => (
    <div data-testid="empty-text" data-under-header-icon={String(underHeaderIcon === true)} />
  ),
  AttachmentGroup: ({ attachments }: { attachments?: unknown[] }) => (
    <div data-testid="attachment-group" data-count={String(attachments?.length ?? 0)} />
  ),
  AgentUpdate: ({ currentAgentId }: { currentAgentId: string }) => (
    <div data-testid="post-steer-agent-update" data-agent-id={currentAgentId} />
  ),
}));

jest.mock('../MemoryArtifacts', () => ({
  __esModule: true,
  default: () => <div data-testid="memory-artifacts" />,
  hasMemoryArtifacts:
    jest.requireActual<typeof import('../MemoryArtifacts')>('../MemoryArtifacts')
      .hasMemoryArtifacts,
}));

jest.mock('../Parts/PendingSkillCall', () => ({
  __esModule: true,
  default: ({ skillName, loaded }: { skillName: string; loaded: boolean }) => (
    <div data-testid="pending-skill-call" data-skill={skillName} data-loaded={String(loaded)} />
  ),
}));

jest.mock('../Parts/WorkspaceChanges', () => ({
  __esModule: true,
  default: ({ attachments }: { attachments: TAttachment[] }) =>
    attachments.length > 0 ? (
      <div data-testid="workspace-changes" data-count={attachments.length} />
    ) : null,
  partitionWorkspaceChanges: (attachments?: TAttachment[]) => ({
    inlineAttachments: (attachments ?? []).filter((attachment) => !attachment.workspaceChange),
    workspaceChanges: (attachments ?? []).filter((attachment) => attachment.workspaceChange),
  }),
}));

jest.mock('../ToolCallGroup', () => ({
  __esModule: true,
  default: ({
    initialExpansionState,
    onExpansionChange,
  }: {
    initialExpansionState?: { isExpanded: boolean; userOverride: boolean };
    onExpansionChange?: (state: { isExpanded: boolean; userOverride: boolean }) => void;
  }) => (
    <button
      data-testid="tool-call-group"
      data-initial-expanded={
        initialExpansionState == null ? 'unset' : String(initialExpansionState.isExpanded)
      }
      onClick={() => onExpansionChange?.({ isExpanded: false, userOverride: true })}
    />
  ),
}));

jest.mock('../ActivityPhaseGroup', () => ({
  __esModule: true,
  default: ({
    children,
    showCursor,
    animateEntrance,
  }: {
    children: React.ReactNode;
    showCursor?: boolean;
    animateEntrance?: boolean;
  }) => (
    <div
      data-testid="activity-phase-group"
      data-show-cursor={String(showCursor === true)}
      data-animate-entrance={String(animateEntrance === true)}
    >
      {children}
    </div>
  ),
}));

jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="container">{children}</div>
  ),
}));

jest.mock('../Part', () => {
  const { useMessageContext } = jest.requireActual<typeof import('~/Providers/MessageContext')>(
    '~/Providers/MessageContext',
  );
  return {
    __esModule: true,
    default: function MockPart({
      part,
      showCursor,
      isLast,
    }: {
      part: TMessageContentParts;
      showCursor?: boolean;
      isLast?: boolean;
    }) {
      const { partIndex } = useMessageContext();
      return (
        <div
          data-testid={`real-part-${part.type}`}
          data-index={partIndex}
          data-show-cursor={String(showCursor === true)}
          data-is-last={String(isLast === true)}
        />
      );
    },
  };
});

jest.mock('../ParallelContent', () => ({
  /** Invokes `renderResumeAttribution` per content index like the real
   *  renderer does for its sequential stretches, so the wiring is testable. */
  ParallelContentRenderer: ({
    content,
    contentIndexOffset = 0,
    renderResumeAttribution,
  }: {
    content?: Array<TMessageContentParts | undefined>;
    contentIndexOffset?: number;
    renderResumeAttribution?: (idx: number) => React.ReactNode;
  }) => (
    <div data-testid="parallel-renderer" data-index-offset={contentIndexOffset}>
      {content?.map((_, idx) => renderResumeAttribution?.(idx + contentIndexOffset))}
    </div>
  ),
}));

jest.mock('../Parts/PendingSteers', () => ({
  __esModule: true,
  default: () => <div data-testid="pending-steers" />,
}));

import ContentParts from '../ContentParts';

const baseProps = {
  messageId: 'msg-1',
  isLast: false,
  isSubmitting: false,
  isLatestMessage: false,
  isCreatedByUser: false,
  showThinking: false,
  content: [],
};

beforeEach(() => {
  jest
    .mocked(groupSequentialToolCalls)
    .mockImplementation((parts) => parts.map((part) => ({ type: 'single', part })));
});

describe('ContentParts: interim skill cards', () => {
  it('renders stateful workspace changes once at message level', () => {
    const content: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'done' } as TMessageContentParts,
    ];
    const attachment = {
      filename: 'report.csv',
      filepath: '/uploads/report.csv',
      conversationId: 'conversation-1',
      messageId: 'msg-1',
      toolCallId: 'tool-1',
      workspaceChange: {
        profile: 'stateful',
        operation: 'created',
        path: 'report.csv',
      },
    } as TAttachment;

    render(<ContentParts {...baseProps} content={content} attachments={[attachment]} />);

    expect(screen.getAllByTestId('workspace-changes')).toHaveLength(1);
    expect(screen.getByTestId('workspace-changes')).toHaveAttribute('data-count', '1');
  });

  it('renders stateful workspace changes when the assistant message has no content yet', () => {
    const attachment = {
      filename: 'report.csv',
      filepath: '/uploads/report.csv',
      conversationId: 'conversation-1',
      messageId: 'msg-1',
      toolCallId: 'tool-1',
      workspaceChange: {
        profile: 'stateful',
        operation: 'created',
        path: 'report.csv',
      },
    } as TAttachment;

    render(<ContentParts {...baseProps} content={undefined} attachments={[attachment]} />);

    expect(screen.getByTestId('workspace-changes')).toHaveAttribute('data-count', '1');
  });

  it('renders a PendingSkillCall per manual skill on assistant messages', () => {
    render(<ContentParts {...baseProps} manualSkills={['brand-guidelines', 'pptx']} />);
    const cards = screen.getAllByTestId('pending-skill-call');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-skill', 'brand-guidelines');
    expect(cards[1]).toHaveAttribute('data-skill', 'pptx');
  });

  it('starts pending skill cards in the not-loaded state (no real content yet)', () => {
    render(<ContentParts {...baseProps} manualSkills={['pptx']} />);
    expect(screen.getByTestId('pending-skill-call')).toHaveAttribute('data-loaded', 'false');
  });

  it('flips pending cards to loaded once any real content part arrives', () => {
    const content: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'streamed' } as unknown as TMessageContentParts,
    ];
    render(<ContentParts {...baseProps} content={content} manualSkills={['pptx']} />);
    expect(screen.getByTestId('pending-skill-call')).toHaveAttribute('data-loaded', 'true');
  });

  it('does NOT render skill cards on user messages', () => {
    render(<ContentParts {...baseProps} isCreatedByUser manualSkills={['pptx']} />);
    expect(screen.queryByTestId('pending-skill-call')).toBeNull();
  });

  it('renders nothing when manualSkills is empty and content is undefined', () => {
    const { container } = render(
      <ContentParts {...baseProps} content={undefined} manualSkills={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders pending skill cards even when content is undefined', () => {
    render(<ContentParts {...baseProps} content={undefined} manualSkills={['pptx']} />);
    expect(screen.getAllByTestId('pending-skill-call')).toHaveLength(1);
  });

  it('renders pending skill cards above parallel content', () => {
    /** Two agents, so the group renders as columns at all. */
    const parallelContent: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'primary',
        agentId: 'agent_a',
        groupId: 1,
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.TEXT,
        text: 'added',
        agentId: 'agent_b____1',
        groupId: 1,
      } as unknown as TMessageContentParts,
    ];
    render(<ContentParts {...baseProps} content={parallelContent} manualSkills={['pptx']} />);
    const skillCard = screen.getByTestId('pending-skill-call');
    const parallelRenderer = screen.getByTestId('parallel-renderer');
    expect(skillCard).toBeTruthy();
    expect(parallelRenderer).toBeTruthy();
    expect(skillCard.compareDocumentPosition(parallelRenderer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('renders pending skill cards above sequential content', () => {
    const sequentialContent: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'streamed' } as unknown as TMessageContentParts,
    ];
    render(<ContentParts {...baseProps} content={sequentialContent} manualSkills={['pptx']} />);
    const skillCard = screen.getByTestId('pending-skill-call');
    const textPart = screen.getByTestId(`real-part-${ContentTypes.TEXT}`);
    expect(skillCard).toBeTruthy();
    expect(textPart).toBeTruthy();
    expect(skillCard.compareDocumentPosition(textPart)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('ContentParts: thinking-dot header alignment', () => {
  const submittingProps = { ...baseProps, isSubmitting: true, isLatestMessage: true };
  const memoryAttachment = {
    type: Tools.memory,
    [Tools.memory]: { type: 'update', key: 'user', value: 'test value' },
  } as TAttachment;

  it('nudges the cursor onto the header-icon axis when nothing precedes it', () => {
    render(<ContentParts {...submittingProps} />);
    expect(screen.getByTestId('empty-text')).toHaveAttribute('data-under-header-icon', 'true');
  });

  it('keeps the cursor flush when pending skill rows render above it', () => {
    render(<ContentParts {...submittingProps} manualSkills={['pptx']} />);
    expect(screen.getByTestId('empty-text')).toHaveAttribute('data-under-header-icon', 'false');
  });

  it('keeps the cursor flush when a memory-artifact row renders above it', () => {
    render(<ContentParts {...submittingProps} attachments={[memoryAttachment]} />);
    expect(screen.getByTestId('empty-text')).toHaveAttribute('data-under-header-icon', 'false');
  });

  it('keeps the cursor flush inside a nested activity phase', () => {
    render(<ContentParts {...submittingProps} nestedActivityPhase />);
    expect(screen.getByTestId('empty-text')).toHaveAttribute('data-under-header-icon', 'false');
  });

  it('routes a solitary seeded empty text part through the nudged placeholder', () => {
    const seeded = [{ type: ContentTypes.TEXT, text: { value: '' } }] as TMessageContentParts[];
    render(<ContentParts {...submittingProps} content={seeded} />);
    expect(screen.getByTestId('empty-text')).toHaveAttribute('data-under-header-icon', 'true');
    expect(screen.queryByTestId('real-part-text')).toBeNull();
  });

  it('keeps the gate for a seeded placeholder behind pending skill rows', () => {
    const seeded = [{ type: ContentTypes.TEXT, text: '' }] as TMessageContentParts[];
    render(<ContentParts {...submittingProps} content={seeded} manualSkills={['pptx']} />);
    expect(screen.getByTestId('empty-text')).toHaveAttribute('data-under-header-icon', 'false');
  });

  it('renders a persisted empty text part normally once submission ends', () => {
    const seeded = [{ type: ContentTypes.TEXT, text: { value: '' } }] as TMessageContentParts[];
    render(<ContentParts {...baseProps} content={seeded} />);
    expect(screen.queryByTestId('empty-text')).toBeNull();
    expect(screen.getByTestId('real-part-text')).toBeInTheDocument();
  });

  it('leaves real text content out of the placeholder path', () => {
    const textContent = [{ type: ContentTypes.TEXT, text: 'hello' }] as TMessageContentParts[];
    render(<ContentParts {...submittingProps} content={textContent} />);
    expect(screen.queryByTestId('empty-text')).toBeNull();
    expect(screen.getByTestId('real-part-text')).toBeInTheDocument();
  });
});

describe('ContentParts: post-steer author re-attribution', () => {
  const steerPart = {
    type: ContentTypes.STEER,
    steer: 'go left',
  } as unknown as TMessageContentParts;
  const textPart = (text: string) =>
    ({ type: ContentTypes.TEXT, text }) as unknown as TMessageContentParts;
  const header = <div data-testid="author-header" />;

  it('re-renders the author header between a steer and the content that resumes after it', () => {
    render(
      <ContentParts
        {...baseProps}
        content={[textPart('a'), steerPart, textPart('b')]}
        authorHeader={header}
      />,
    );
    const headers = screen.getAllByTestId('author-header');
    expect(headers).toHaveLength(1);
    const steer = screen.getByTestId(`real-part-${ContentTypes.STEER}`);
    const textParts = screen.getAllByTestId(`real-part-${ContentTypes.TEXT}`);
    expect(steer.compareDocumentPosition(headers[0])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(headers[0].compareDocumentPosition(textParts[1])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('renders one header per steer block and none after a trailing steer', () => {
    render(
      <ContentParts
        {...baseProps}
        content={[textPart('a'), steerPart, steerPart, textPart('b'), steerPart]}
        authorHeader={header}
      />,
    );
    expect(screen.getAllByTestId('author-header')).toHaveLength(1);
  });

  it('skips empty content slots when finding the part that resumes after a steer', () => {
    render(
      <ContentParts
        {...baseProps}
        content={[steerPart, undefined, textPart('b')]}
        authorHeader={header}
      />,
    );
    expect(screen.getAllByTestId('author-header')).toHaveLength(1);
  });

  it('renders no header when authorHeader is not provided', () => {
    render(<ContentParts {...baseProps} content={[textPart('a'), steerPart, textPart('b')]} />);
    expect(screen.queryByTestId('author-header')).toBeNull();
  });

  it('re-attributes to the ACTIVE agent when a handoff preceded the steer', () => {
    const agentUpdate = {
      type: ContentTypes.AGENT_UPDATE,
      [ContentTypes.AGENT_UPDATE]: { agentId: 'agent_b', index: 1 },
    } as unknown as TMessageContentParts;
    render(
      <ContentParts
        {...baseProps}
        content={[textPart('a'), agentUpdate, textPart('b'), steerPart, textPart('c')]}
        authorHeader={header}
      />,
    );
    const marker = screen.getAllByTestId('post-steer-agent-update');
    expect(marker).toHaveLength(1);
    expect(marker[0]).toHaveAttribute('data-agent-id', 'agent_b');
    expect(screen.queryByTestId('author-header')).toBeNull();
  });

  it('provides resume attribution to the parallel renderer for its sequential stretches', () => {
    const laneText = (agentId: string) =>
      ({
        type: ContentTypes.TEXT,
        text: `column ${agentId}`,
        agentId,
        groupId: 1,
      }) as unknown as TMessageContentParts;
    render(
      <ContentParts
        {...baseProps}
        content={[laneText('agent_a'), laneText('agent_b____1'), steerPart, textPart('resumed')]}
        authorHeader={header}
      />,
    );
    const renderer = screen.getByTestId('parallel-renderer');
    expect(renderer).toBeTruthy();
    expect(screen.getAllByTestId('author-header')).toHaveLength(1);
  });

  it('keeps the top-level header when the handoff comes AFTER the steer', () => {
    const agentUpdate = {
      type: ContentTypes.AGENT_UPDATE,
      [ContentTypes.AGENT_UPDATE]: { agentId: 'agent_b', index: 2 },
    } as unknown as TMessageContentParts;
    render(
      <ContentParts
        {...baseProps}
        content={[textPart('a'), steerPart, agentUpdate, textPart('b')]}
        authorHeader={header}
      />,
    );
    expect(screen.getAllByTestId('author-header')).toHaveLength(1);
    expect(screen.queryByTestId('post-steer-agent-update')).toBeNull();
  });

  it('retains steer attribution when resumed content moves into a phase slice', () => {
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Reconciled both release paths',
      activity_label_type: 'phase',
      activity_start_index: 2,
      activity_count: 2,
      pending: false,
    } as unknown as TMessageContentParts;
    render(
      <ContentParts
        {...baseProps}
        content={[textPart('a'), steerPart, textPart('resumed'), phase]}
        authorHeader={header}
      />,
    );

    expect(screen.getByTestId('activity-phase-group')).toBeTruthy();
    expect(screen.getAllByTestId('author-header')).toHaveLength(1);
    expect(screen.getAllByTestId(`real-part-${ContentTypes.TEXT}`)[1]).toHaveAttribute(
      'data-index',
      '2',
    );
  });
});

describe('ContentParts — activity phase state', () => {
  it('keeps a streaming cursor on visible text when a provider appends an empty placeholder', () => {
    render(
      <ContentParts
        {...baseProps}
        content={[
          { type: ContentTypes.TEXT, text: 'Visible answer' } as TMessageContentParts,
          { type: ContentTypes.TEXT, text: '' } as TMessageContentParts,
        ]}
        isLast
        isSubmitting
        isLatestMessage
      />,
    );

    const textParts = screen.getAllByTestId(`real-part-${ContentTypes.TEXT}`);
    expect(textParts[0]).toHaveAttribute('data-show-cursor', 'true');
    expect(textParts[1]).toHaveAttribute('data-show-cursor', 'false');
  });

  /** Activity phases split one response into several bodies, and every settled
   *  body has a trailing part. Only the body holding the message's cursor may
   *  own a live one — otherwise a phase that finished minutes ago keeps its
   *  reasoning shimmering while later phases stream. */
  it("leaves an earlier phase's trailing part settled while a later part streams", () => {
    const think = {
      type: ContentTypes.THINK,
      think: 'weighing the options',
    } as unknown as TMessageContentParts;
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Mapped the schema',
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 1,
      activity_count: 1,
      pending: false,
    } as unknown as TMessageContentParts;
    render(
      <ContentParts
        {...baseProps}
        content={[
          think,
          phase,
          { type: ContentTypes.TEXT, text: 'Good — schema mapped.' } as TMessageContentParts,
        ]}
        isLast
        isSubmitting
        isLatestMessage
      />,
    );

    expect(screen.getByTestId(`real-part-${ContentTypes.THINK}`)).toHaveAttribute(
      'data-is-last',
      'false',
    );
    expect(screen.getByTestId(`real-part-${ContentTypes.TEXT}`)).toHaveAttribute(
      'data-is-last',
      'true',
    );
  });

  it('renders a completion-appended parent before the final root text', () => {
    const tool = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id: 'tool-1', name: 'search', args: {}, output: 'done' },
    } as unknown as TMessageContentParts;
    const final = {
      type: ContentTypes.TEXT,
      text: 'Final answer',
    } as unknown as TMessageContentParts;
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Completed the full investigation',
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
      pending: false,
    } as unknown as TMessageContentParts;

    render(<ContentParts {...baseProps} content={[tool, tool, final, phase]} />);

    const parent = screen.getByTestId('activity-phase-group');
    const finalPart = screen.getByTestId(`real-part-${ContentTypes.TEXT}`);
    expect(parent.compareDocumentPosition(finalPart)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(parent).toHaveAttribute('data-animate-entrance', 'false');
    expect(finalPart).toHaveAttribute('data-index', '2');
  });

  it('keeps a streaming cursor when a completed phase marker is the visible tail', () => {
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Compared both search results',
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_count: 2,
      pending: false,
    } as unknown as TMessageContentParts;

    render(
      <ContentParts
        {...baseProps}
        content={[
          { type: ContentTypes.TEXT, text: 'working' } as unknown as TMessageContentParts,
          phase,
        ]}
        isLast
        isSubmitting
        isLatestMessage
      />,
    );

    expect(screen.getByTestId('activity-phase-group')).toHaveAttribute('data-show-cursor', 'true');
  });

  it('carries the absolute index offset into a parallel phase segment', () => {
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Compared both agent results',
      activity_label_type: 'phase',
      activity_start_index: 1,
      activity_count: 2,
      pending: false,
    } as unknown as TMessageContentParts;
    const lane = (agentId: string) =>
      ({
        type: ContentTypes.TEXT,
        text: `lane result ${agentId}`,
        agentId,
        groupId: 1,
      }) as unknown as TMessageContentParts;

    render(
      <ContentParts
        {...baseProps}
        content={[
          { type: ContentTypes.TEXT, text: 'before' } as unknown as TMessageContentParts,
          lane('agent_a'),
          lane('agent_b____1'),
          phase,
        ]}
      />,
    );

    expect(screen.getByTestId('parallel-renderer')).toHaveAttribute('data-index-offset', '1');
  });

  it('retains a tool-group expansion override when a completed phase remounts the group', () => {
    jest.mocked(groupSequentialToolCalls).mockImplementation((parts) => {
      const toolParts = parts.filter(({ part }) => part.type === ContentTypes.TOOL_CALL);
      if (toolParts.length > 0) {
        return [{ type: 'tool-group', parts: toolParts }];
      }
      return parts.map((part) => ({ type: 'single', part }));
    });
    const tools = [
      {
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: { id: 'tool-1', name: 'search', args: {}, output: 'one' },
      },
      {
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: { id: 'tool-2', name: 'search', args: {}, output: 'two' },
      },
    ] as unknown as TMessageContentParts[];
    const pendingPhase = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: '',
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_count: 2,
      pending: true,
    } as unknown as TMessageContentParts;
    const { rerender } = render(<ContentParts {...baseProps} content={[...tools, pendingPhase]} />);

    const pendingGroup = screen.getByTestId('tool-call-group');
    expect(pendingGroup).toHaveAttribute('data-initial-expanded', 'unset');
    fireEvent.click(pendingGroup);

    const completedPhase = {
      ...pendingPhase,
      [ContentTypes.ACTIVITY_LABEL]: 'Compared both search results',
      pending: false,
    } as unknown as TMessageContentParts;
    rerender(<ContentParts {...baseProps} content={[...tools, completedPhase]} />);

    expect(screen.getByTestId('activity-phase-group')).toBeInTheDocument();
    expect(screen.getByTestId('activity-phase-group')).toHaveAttribute(
      'data-animate-entrance',
      'true',
    );
    expect(screen.getByTestId('tool-call-group')).toHaveAttribute('data-initial-expanded', 'false');
  });

  test('does not replay the entrance when switching to a sibling with its own phases', () => {
    const phase = (label: string) =>
      ({
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: label,
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_count: 1,
        pending: false,
      }) as unknown as TMessageContentParts;

    const tool = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id: 'tool-1', name: 'search', args: {}, output: 'one' },
    } as unknown as TMessageContentParts;

    const { rerender } = render(
      <ContentParts {...baseProps} messageId="sibling-a" content={[tool, phase('First')]} />,
    );
    expect(screen.getByTestId('activity-phase-group')).toHaveAttribute(
      'data-animate-entrance',
      'false',
    );

    /** MultiMessage swaps siblings without a key, so this instance keeps its
     *  refs while messageId and content change wholesale. The incoming
     *  sibling's phase is history and must not animate. */
    rerender(
      <ContentParts {...baseProps} messageId="sibling-b" content={[tool, tool, phase('Second')]} />,
    );

    expect(screen.getByTestId('activity-phase-group')).toHaveAttribute(
      'data-animate-entrance',
      'false',
    );
  });
});

describe('ContentParts: settled content identity across compaction', () => {
  /** Mirrors a captured run: the aggregator leaves holes at the source indexes
   *  of steps that produced nothing, and `finalHandler` swaps in the server's
   *  compacted array. Without the streamed-index stamp every index-derived key
   *  shifts and the settled message remounts wholesale. */
  const toolPart = {
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id: 'call_a', name: 'search', args: {}, output: 'one' },
  } as unknown as TMessageContentParts;
  const batchLabel = {
    type: ContentTypes.ACTIVITY_LABEL,
    [ContentTypes.ACTIVITY_LABEL]: 'Recorded the fact',
    tool_call_ids: ['call_a'],
  } as unknown as TMessageContentParts;
  const answer = { type: ContentTypes.TEXT, text: 'done' } as unknown as TMessageContentParts;
  const phaseLabel = (bounds: { start: number; end: number }) =>
    ({
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Researched the question',
      activity_label_type: 'phase',
      activity_start_index: bounds.start,
      activity_end_index: bounds.end,
      activity_count: 1,
      pending: false,
    }) as unknown as TMessageContentParts;

  const streamed: Array<TMessageContentParts | undefined> = [
    undefined,
    toolPart,
    batchLabel,
    undefined,
    answer,
    phaseLabel({ start: 1, end: 4 }),
  ];
  const compacted = [toolPart, batchLabel, answer, phaseLabel({ start: 0, end: 2 })];

  const renderStreaming = () =>
    render(<ContentParts {...baseProps} content={streamed} isLast isSubmitting isLatestMessage />);

  it('keeps every part and the phase group mounted when the final content is stamped', () => {
    const { rerender } = renderStreaming();
    const phaseNode = screen.getByTestId('activity-phase-group');
    const toolNode = screen.getByTestId('real-part-tool_call');
    const textNode = screen.getByTestId('real-part-text');

    const finalContent = preserveStreamedContentIdentity(streamed, compacted);
    rerender(<ContentParts {...baseProps} content={finalContent} isLast />);

    expect(screen.getByTestId('activity-phase-group')).toBe(phaseNode);
    expect(screen.getByTestId('real-part-tool_call')).toBe(toolNode);
    expect(screen.getByTestId('real-part-text')).toBe(textNode);
    expect(phaseNode).toHaveAttribute('data-animate-entrance', 'false');
  });

  /** When the stamp cannot pair the two arrays every index-derived key
   *  shifts and the phase group remounts — but its label text was already on
   *  screen, so the remounted card must mount settled instead of replaying
   *  the fold over content the reader already watched fold. */
  it('remounts without replaying the phase entrance when the settle re-keys the content', () => {
    const { rerender } = renderStreaming();
    const phaseNode = screen.getByTestId('activity-phase-group');

    rerender(<ContentParts {...baseProps} content={compacted} isLast />);

    const settledPhase = screen.getByTestId('activity-phase-group');
    expect(settledPhase).not.toBe(phaseNode);
    expect(settledPhase).toHaveAttribute('data-animate-entrance', 'false');
  });

  /** Identical summaries are legitimate across phases of one run. A second
   *  marker with an already-seen text is a grown occurrence count, not a
   *  re-key of the first — only the newcomer animates. */
  it('animates a second phase that repeats an earlier label text', () => {
    const repeatedPhase = (index: number, bounds: { start: number; end: number }) =>
      ({
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: 'Completed the activity phase',
        activity_label_type: 'phase',
        activity_start_index: bounds.start,
        activity_end_index: bounds.end,
        activity_count: 1,
        pending: false,
        streamedIndex: index,
      }) as unknown as TMessageContentParts;
    const { rerender } = render(
      <ContentParts
        {...baseProps}
        content={[toolPart, repeatedPhase(1, { start: 0, end: 1 })]}
        isLast
        isSubmitting
        isLatestMessage
      />,
    );

    rerender(
      <ContentParts
        {...baseProps}
        content={[
          toolPart,
          repeatedPhase(1, { start: 0, end: 1 }),
          toolPart,
          repeatedPhase(3, { start: 2, end: 3 }),
        ]}
        isLast
        isSubmitting
        isLatestMessage
      />,
    );

    const phases = screen.getAllByTestId('activity-phase-group');
    expect(phases).toHaveLength(2);
    expect(phases[0]).toHaveAttribute('data-animate-entrance', 'false');
    expect(phases[1]).toHaveAttribute('data-animate-entrance', 'true');
  });

  /** Concurrent fills can resolve out of order: a later-index marker
   *  renders first, then an earlier reserved marker fills with an identical
   *  summary. No previously rendered key vanished, so key identity stays
   *  authoritative and the newly filled earlier marker still animates. */
  it('animates an earlier marker that fills out of order behind a same-text twin', () => {
    const twinPhase = (bounds: { start: number; end: number }) =>
      ({
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: 'Completed the activity phase',
        activity_label_type: 'phase',
        activity_start_index: bounds.start,
        activity_end_index: bounds.end,
        activity_count: 1,
        pending: false,
      }) as unknown as TMessageContentParts;
    const pendingReservation = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: '',
      activity_label_type: 'phase',
      activity_start_index: 0,
      pending: true,
    } as unknown as TMessageContentParts;
    const { rerender } = render(
      <ContentParts
        {...baseProps}
        content={[toolPart, pendingReservation, toolPart, twinPhase({ start: 2, end: 3 })]}
        isLast
        isSubmitting
        isLatestMessage
      />,
    );

    rerender(
      <ContentParts
        {...baseProps}
        content={[
          toolPart,
          twinPhase({ start: 0, end: 1 }),
          toolPart,
          twinPhase({ start: 2, end: 3 }),
        ]}
        isLast
        isSubmitting
        isLatestMessage
      />,
    );

    const phases = screen.getAllByTestId('activity-phase-group');
    expect(phases).toHaveLength(2);
    expect(phases[0]).toHaveAttribute('data-animate-entrance', 'true');
    expect(phases[1]).toHaveAttribute('data-animate-entrance', 'false');
  });

  /** A settle can re-key every existing marker AND land a new same-text
   *  phase in the same commit. Occurrences pair by position: the re-keyed
   *  first and second stay settled; only the third — past the previously
   *  rendered count — animates. */
  it('animates only the new occurrence when a re-key lands with a repeated label', () => {
    const repeatedPhase = (bounds: { start: number; end: number }) =>
      ({
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: 'Completed the activity phase',
        activity_label_type: 'phase',
        activity_start_index: bounds.start,
        activity_end_index: bounds.end,
        activity_count: 1,
        pending: false,
      }) as unknown as TMessageContentParts;
    const { rerender } = render(
      <ContentParts
        {...baseProps}
        content={[
          toolPart,
          repeatedPhase({ start: 0, end: 1 }),
          toolPart,
          repeatedPhase({ start: 2, end: 3 }),
        ]}
        isLast
        isSubmitting
        isLatestMessage
      />,
    );

    rerender(
      <ContentParts
        {...baseProps}
        content={[
          toolPart,
          toolPart,
          repeatedPhase({ start: 0, end: 2 }),
          toolPart,
          repeatedPhase({ start: 3, end: 4 }),
          toolPart,
          repeatedPhase({ start: 5, end: 6 }),
        ]}
        isLast
      />,
    );

    const phases = screen.getAllByTestId('activity-phase-group');
    expect(phases).toHaveLength(3);
    expect(phases[0]).toHaveAttribute('data-animate-entrance', 'false');
    expect(phases[1]).toHaveAttribute('data-animate-entrance', 'false');
    expect(phases[2]).toHaveAttribute('data-animate-entrance', 'true');
  });

  it('still animates a phase whose label first appears at settle', () => {
    const { rerender } = renderStreaming();

    const lateLabel = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Wrote the final summary',
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 1,
      pending: false,
    } as unknown as TMessageContentParts;
    rerender(
      <ContentParts {...baseProps} content={[toolPart, batchLabel, answer, lateLabel]} isLast />,
    );

    expect(screen.getByTestId('activity-phase-group')).toHaveAttribute(
      'data-animate-entrance',
      'true',
    );
  });
});

/* The pending block belongs to the latest reply. A late failed receipt can
   arrive after submission state clears, and its recovery controls must remain. */
describe('ContentParts: pending steers', () => {
  const withGate = (over: Partial<typeof baseProps> & { conversationId?: string }) =>
    render(<ContentParts {...baseProps} {...over} />);

  it('shows them on the last message while a run is live', () => {
    withGate({ isLast: true, isSubmitting: true, conversationId: 'convo-1' });
    expect(screen.getByTestId('pending-steers')).toBeInTheDocument();
  });

  it('keeps late recovery controls on the last message after the run finishes', () => {
    withGate({ isLast: true, isSubmitting: false, conversationId: 'convo-1' });
    expect(screen.getByTestId('pending-steers')).toBeInTheDocument();
  });

  it.each([
    ['an earlier message', { isLast: false, isSubmitting: true, conversationId: 'convo-1' }],
    ['no conversation yet', { isLast: true, isSubmitting: true, conversationId: undefined }],
  ])('shows nothing for %s', (_label, over) => {
    withGate(over);
    expect(screen.queryByTestId('pending-steers')).not.toBeInTheDocument();
  });
});
