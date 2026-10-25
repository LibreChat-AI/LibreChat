import React from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  FullToolCall,
  PartMetadata,
  TMessage,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { ChatContract } from '~/hooks/Chat/contract';
import type { ChildConversationTurn } from './adapters';
import type { TurnAuthor } from './author';
import SubagentConversation from './SubagentConversation';
import { mergeChildConversationTurns } from './adapters';
import { ChatContext } from '~/Providers/ChatContext';
import { ChatSurfaceHarness } from 'test/harness';

const mockRecoveredQuery = jest.fn();
jest.mock('~/data-provider/Subagents/content', () => ({
  ...jest.requireActual('~/data-provider/Subagents/content'),
  useSubagentTaskContentQuery: (...args: unknown[]) => mockRecoveredQuery(...args),
}));

const mockCopyMessage = jest.fn();
const mockRenderedContent = jest.fn();
const mockPartScope = jest.fn();
const mockParentAsk = jest.fn();

jest.mock('~/Providers/MessagePartsHostContext', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Context = React.createContext({
    useShowThinking: () => false,
    useAutoExpandTools: () => false,
    useMessagesAsk: () => mockParentAsk,
  });
  return {
    MessagePartsHostProvider: ({
      host,
      children,
    }: {
      host: React.ContextType<typeof Context>;
      children: React.ReactNode;
    }) => <Context.Provider value={host}>{children}</Context.Provider>,
    useMessagePartsHost: () => React.useContext(Context),
  };
});

jest.mock('~/components/Chat/Messages/MinimalHoverButtons', () => ({
  __esModule: true,
  default: ({ message }: { message: TMessage }) => {
    mockCopyMessage(message);
    return <button type="button" aria-label="copy" />;
  },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => undefined,
}));

jest.mock('~/components/Chat/Messages/Content/ContentParts', () => ({
  __esModule: true,
  default: function ContentPartsMock({
    content,
    messageId,
  }: {
    content: Array<Record<string, unknown>>;
    messageId: string;
  }) {
    const React = jest.requireActual<typeof import('react')>('react');
    const { ChatContext } = jest.requireActual('~/Providers/ChatContext');
    const { useMessagePartsHost } = jest.requireMock('~/Providers/MessagePartsHostContext');
    mockPartScope(React.useContext(ChatContext), useMessagePartsHost().useMessagesAsk());
    mockRenderedContent(content);
    return (
      <div data-testid="shared-content-parts" data-message-id={messageId}>
        {content.map((part, index) => (
          <span key={index}>
            {(part?.text as string | undefined) ??
              (part?.think as string | undefined) ??
              (part?.tool_call as { name?: string } | undefined)?.name ??
              ''}
          </span>
        ))}
      </div>
    );
  },
}));

jest.mock('~/components/Chat/Messages/Content/Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('~/components/Chat/Messages/Content/Parts', () => ({
  EmptyText: ({ underHeaderIcon }: { underHeaderIcon?: boolean }) => (
    <div data-testid="thinking-cursor" data-under-header-icon={String(underHeaderIcon === true)} />
  ),
}));

jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="message-icon" />,
}));

jest.mock('lucide-react', () => ({
  AlertCircle: () => null,
  Bot: () => null,
  CheckCircle2: () => null,
  Clock3: () => null,
  ChevronDown: () => null,
  CornerDownRight: () => null,
  Radio: () => null,
  XCircle: () => null,
  Zap: () => null,
}));

const author: TurnAuthor = { name: 'Research child', icon: <span data-testid="child-face" /> };
const parentAuthor: TurnAuthor = { name: 'Lia', icon: <span data-testid="parent-face" /> };

const turns: ChildConversationTurn[] = [
  {
    taskId: 'task-1',
    trigger: {
      kind: 'parent_dispatch',
      summary: 'Investigate the release.',
      createdAt: '2026-08-25T12:00:00.000Z',
    },
    activity: {
      title: 'Research child',
      status: 'completed',
      items: [
        { type: 'reasoning', text: 'Checked the constraints.' },
        {
          type: 'tool',
          toolCallId: 'search-1',
          name: 'search',
          status: 'completed',
          outputTruncated: true,
        },
        { type: 'writing', text: 'The release is ready.' },
      ],
    },
  },
  {
    taskId: 'task-2',
    trigger: {
      kind: 'external_event',
      summary: '',
      externalEvent: {
        eventType: 'chess.turn.ready',
        sourceType: 'speed-chess',
        occurredAt: '2026-08-25T12:01:00.000Z',
        expectedActionToolName: 'submit_move',
      },
    },
    activity: {
      title: 'Research child',
      status: 'running',
      items: [],
    },
  },
];

describe('SubagentConversation', () => {
  it('renders parent turns and child activity through the main chat row and content modules', () => {
    const { container } = render(
      <ChatSurfaceHarness>
        <SubagentConversation turns={turns} author={author} parentAuthor={parentAuthor} />
      </ChatSurfaceHarness>,
    );

    /** The parent's briefing is a user turn in the parent's name, filled like
     *  one; only the external event, which no agent wrote, is a system turn. */
    const briefing = screen.getByRole('group', { name: 'com_ui_subagent_trigger_parent_dispatch' });
    expect(briefing).toHaveClass('justify-end');
    expect(within(briefing).getByRole('heading', { name: /Lia$/ })).toBeInTheDocument();
    expect(within(briefing).getByTestId('parent-face')).toBeInTheDocument();
    expect(within(briefing).getByTestId('message-body')).toHaveClass('bg-surface-user-message');
    expect(screen.queryByText('com_ui_subagent_trigger_parent_dispatch')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_subagent_trigger_external_event')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: /^com_ui_system_event/ })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Research child' })).toHaveLength(2);
    expect(screen.getByText('Investigate the release.')).toBeInTheDocument();
    expect(screen.getByText('Checked the constraints.')).toBeInTheDocument();
    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.getByText('The release is ready.')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_thread_status_completed')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_thread_status_running')).not.toBeInTheDocument();
    /** Both halves of the main chat author column: the shared glyph, and the
     *  streaming dot inset onto that glyph's axis the way main chat insets it. */
    expect(screen.getAllByTestId('child-face')).toHaveLength(2);
    expect(screen.getByTestId('thinking-cursor')).toHaveAttribute('data-under-header-icon', 'true');
    expect(container.querySelectorAll('.message-render')).toHaveLength(4);
    expect(container.querySelectorAll('.user-turn')).toHaveLength(1);
    expect(container.querySelectorAll('.agent-turn')).toHaveLength(2);
    expect(container.querySelector('[data-subagent-conversation]')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_prompt')).not.toBeInTheDocument();
    expect(
      screen.queryByText('com_ui_subagent_activity_details_truncated'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_activity_details_unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('stream-elapsed')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: /com_ui_subagent_trigger_external_event.*chess\.turn\.ready.*speed-chess/,
      }),
    );
    expect(screen.getByText('chess.turn.ready')).toBeInTheDocument();
    expect(screen.getByText('speed-chess')).toBeInTheDocument();
    expect(screen.getByText('submit_move')).toBeInTheDocument();
  });

  it('names an empty parent follow-up instead of rendering a blank bubble', () => {
    const followUp: ChildConversationTurn = {
      ...turns[0],
      taskId: 'task-4',
      trigger: { kind: 'parent_continuation', summary: '' },
    };
    render(
      <ChatSurfaceHarness>
        <SubagentConversation turns={[followUp]} author={author} parentAuthor={parentAuthor} />
      </ChatSurfaceHarness>,
    );

    const row = screen.getByRole('group', { name: 'com_ui_subagent_trigger_parent_continuation' });
    expect(within(row).getByRole('heading', { name: /Lia$/ })).toBeInTheDocument();
    expect(
      within(row).getByText('com_ui_subagent_trigger_parent_continuation'),
    ).toBeInTheDocument();
    expect(within(row).queryByTestId('shared-content-parts')).not.toBeInTheDocument();
  });

  it('requests an exact bounded projection only when shortened turn activity is opened', () => {
    const loadDetails = jest.fn();
    const shortened = [
      { ...turns[0], activity: { ...turns[0].activity, activityTruncated: true } },
    ];
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          turns={shortened}
          author={author}
          parentAuthor={parentAuthor}
          onLoadTurnDetails={loadDetails}
        />
      </ChatSurfaceHarness>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_load_more' }));
    expect(loadDetails).toHaveBeenCalledWith('task-1');
  });

  it('gives repeated external-event disclosures distinguishable accessible names', () => {
    const secondEvent: ChildConversationTurn = {
      ...turns[1],
      taskId: 'task-3',
      trigger: {
        kind: 'external_event',
        summary: '',
        externalEvent: {
          eventType: 'chess.turn.ready',
          sourceType: 'speed-chess',
          occurredAt: '2026-08-25T12:02:00.000Z',
        },
      },
    };

    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          turns={[turns[1], secondEvent]}
          author={author}
          parentAuthor={parentAuthor}
        />
      </ChatSurfaceHarness>,
    );

    expect(
      screen.getByRole('button', {
        name: /com_ui_subagent_trigger_external_event.*chess\.turn\.ready.*speed-chess.*2026-08-25T12:01:00.000Z/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /com_ui_subagent_trigger_external_event.*chess\.turn\.ready.*speed-chess.*2026-08-25T12:02:00.000Z/,
      }),
    ).toBeInTheDocument();
  });
});

describe('standard conversation content', () => {
  beforeEach(() => {
    mockCopyMessage.mockClear();
    mockPartScope.mockClear();
    mockParentAsk.mockClear();
  });

  it('copies the standard message source through the normal safe-copy action', () => {
    const content = [
      { type: 'text', text: 'Authoritative answer', phase: 'final_answer' },
      {
        type: 'tool_call',
        tool_call: { id: 'tool', name: 'bash', args: 'private input', output: 'private output' },
      },
    ] as TMessageContentParts[];
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          turns={[
            {
              ...turns[0],
              activity: { ...turns[0].activity, content, messageId: 'stable-response' },
            },
          ]}
          author={author}
          parentAuthor={parentAuthor}
        />
      </ChatSurfaceHarness>,
    );
    expect(mockCopyMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'stable-response',
        content,
        text: '',
        isCreatedByUser: false,
      }),
    );
    expect(mockCopyMessage.mock.calls.at(-1)?.[0].content).toBe(content);
    expect(screen.queryByText('The release is ready.')).not.toBeInTheDocument();
  });

  it.each([false, true])(
    'never binds normal send effects, interactive approval scope=%s',
    (interactive) => {
      const parent: ChatContract = {
        index: 0,
        conversation: {
          conversationId: 'parent',
          title: null,
          endpoint: null,
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z',
        },
        setConversation: () => undefined,
        newConversation: () => undefined,
        preset: null,
        setPreset: () => undefined,
        optionSettings: {},
        setOptionSettings: () => undefined,
        messagesKey: 'parent',
        getMessages: () => [],
        setMessages: () => undefined,
        setSiblingIdx: () => undefined,
        latestMessageId: undefined,
        latestMessageDepth: undefined,
        useLiveAttachments: () => ({}),
        ask: mockParentAsk,
        regenerate: () => undefined,
        isSubmitting: false,
        setIsSubmitting: () => undefined,
        handleRegenerate: () => undefined,
        handleContinue: () => undefined,
        stopGenerating: async () => undefined,
        handleStopGenerating: () => undefined,
        abortScroll: false,
        setAbortScroll: () => undefined,
        files: new Map(),
        setFiles: () => undefined,
        filesLoading: false,
        setFilesLoading: () => undefined,
        feedbackEnabled: false,
      };
      render(
        <ChatSurfaceHarness>
          <ChatContext.Provider value={parent}>
            <SubagentConversation
              turns={[turns[0]]}
              author={author}
              parentAuthor={parentAuthor}
              interactive={interactive}
            />
          </ChatContext.Provider>
        </ChatSurfaceHarness>,
      );
      const [context, ask] = mockPartScope.mock.calls.at(-1)!;
      expect(context).toBe(interactive ? parent : null);
      ask({ text: 'Do not send this through the parent' });
      expect(mockParentAsk).not.toHaveBeenCalled();
    },
  );
});

it.each(['failed', 'cancelled', 'interrupted', 'completed'] as const)(
  'keeps the durable %s explanation when recovered content is empty',
  (status) => {
    mockRecoveredQuery.mockReturnValue({
      data: {
        messageId: 'task-1:assistant',
        status,
        recovery: 'complete',
        content: [],
        throughSequence: -1,
        targetThroughSequence: -1,
      },
      isError: false,
      isUnavailable: false,
    });
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          author={author}
          parentAuthor={parentAuthor}
          recovery={{
            parentConversationId: 'parent',
            threadId: 'child',
            selectedTaskId: 'task-1',
            ready: true,
          }}
          turns={[
            {
              ...turns[0],
              activity: {
                ...turns[0].activity,
                status,
                items: [{ type: 'writing', text: 'Safe durable outcome.' }],
              },
            },
          ]}
        />
      </ChatSurfaceHarness>,
    );
    expect(screen.getByText('Safe durable outcome.')).toBeInTheDocument();
  },
);

it.each(['running', 'completed'] as const)(
  'keeps visible activity until the %s recovery snapshot has renderable content',
  (status) => {
    mockRecoveredQuery.mockReturnValue({
      data: {
        messageId: 'task-1:assistant',
        status,
        recovery: 'partial',
        content: [],
        throughSequence: -1,
        targetThroughSequence: -1,
      },
    });
    const props = {
      author,
      parentAuthor,
      recovery: {
        parentConversationId: 'parent',
        threadId: 'child',
        selectedTaskId: 'task-1',
        ready: true,
      },
      turns: [
        {
          ...turns[0],
          activity: {
            ...turns[0].activity,
            status,
            items: [{ type: 'writing' as const, text: 'Visible live activity.' }],
          },
        },
      ],
    };
    const { rerender } = render(
      <ChatSurfaceHarness>
        <SubagentConversation {...props} />
      </ChatSurfaceHarness>,
    );
    expect(screen.getByText('Visible live activity.')).toBeInTheDocument();
    mockRecoveredQuery.mockReturnValue({
      data: {
        messageId: 'task-1:assistant',
        status,
        recovery: 'partial',
        content: [{ type: 'text', text: 'Committed history.' }],
        throughSequence: 0,
        targetThroughSequence: 0,
      },
    });
    rerender(
      <ChatSurfaceHarness>
        <SubagentConversation {...props} />
      </ChatSurfaceHarness>,
    );
    expect(screen.getByText('Committed history.')).toBeInTheDocument();
    expect(screen.queryByText('Visible live activity.')).not.toBeInTheDocument();
  },
);

it.each([false, true, undefined])(
  'gates historical recovery with loaded task capability %s',
  (contentRecoveryAvailable) => {
    mockRecoveredQuery.mockReset();
    mockRecoveredQuery.mockReturnValue({});
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          author={author}
          parentAuthor={parentAuthor}
          recovery={{
            parentConversationId: 'parent',
            threadId: 'child',
            selectedTaskId: 'other',
            ready: true,
          }}
          turns={[{ ...turns[0], contentRecoveryAvailable }]}
        />
      </ChatSurfaceHarness>,
    );
    expect(mockRecoveredQuery).toHaveBeenLastCalledWith(
      { parentConversationId: 'parent', threadId: 'child', taskId: 'task-1' },
      { enabled: contentRecoveryAvailable !== false },
    );
  },
);

it('does not render cached recovery after refreshed history revokes the retained task', () => {
  mockRecoveredQuery.mockReturnValue({
    data: {
      messageId: 'task-1:assistant',
      status: 'completed',
      recovery: 'complete',
      content: [{ type: 'text', text: 'Cached recovered content.' }],
      throughSequence: 0,
      targetThroughSequence: 0,
    },
  });
  const props = {
    author,
    parentAuthor,
    recovery: {
      parentConversationId: 'parent',
      threadId: 'child',
      selectedTaskId: 'task-1',
      ready: true,
    },
    turns: [
      {
        ...turns[0],
        contentRecoveryAvailable: true,
        activity: {
          ...turns[0].activity,
          items: [{ type: 'writing' as const, text: 'Current durable activity.' }],
        },
      },
    ],
  };
  const { rerender } = render(
    <ChatSurfaceHarness>
      <SubagentConversation {...props} />
    </ChatSurfaceHarness>,
  );
  expect(screen.getByText('Cached recovered content.')).toBeInTheDocument();
  rerender(
    <ChatSurfaceHarness>
      <SubagentConversation
        {...props}
        turns={mergeChildConversationTurns(props.turns, [
          { ...props.turns[0], contentRecoveryAvailable: false },
        ])}
      />
    </ChatSurfaceHarness>,
  );
  expect(screen.queryByText('Cached recovered content.')).not.toBeInTheDocument();
  expect(screen.getByText('Current durable activity.')).toBeInTheDocument();
  expect(mockRecoveredQuery).toHaveBeenLastCalledWith(expect.any(Object), { enabled: false });
});

it.each(
  (['running', 'completed'] as const).flatMap((status) =>
    (['snapshot', 'live fallback', 'revoked cache'] as const).map((source) => ({ status, source })),
  ),
)(
  'strips root and nested approvals from $status $source without changing the cache',
  ({ status, source }) => {
    const nested: FullToolCall & PartMetadata = {
      id: 'nested',
      name: 'nested_tool',
      args: '{}',
      output: '',
      progress: 0,
      approval: { actionId: 'nested-approval', allowed_decisions: ['approve'] },
    };
    const tool: FullToolCall & PartMetadata = {
      id: 'root',
      name: 'protected_tool',
      args: '{}',
      output: '',
      progress: 0,
      stepId: 'root-step',
      toolPreparationDurationMs: 12,
      approval: { actionId: 'root-approval', allowed_decisions: ['approve', 'reject'] },
      subagent_content: [
        { type: ContentTypes.TOOL_CALL, agentId: 'nested-worker', tool_call: nested },
      ],
    };
    const content: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'Recovered answer.',
        phase: 'commentary',
        agentId: 'worker',
      },
      { type: ContentTypes.TOOL_CALL, agentId: 'worker', tool_call: tool },
    ];
    const cached = JSON.parse(JSON.stringify(content));
    mockRecoveredQuery.mockReturnValue({
      data:
        source === 'live fallback'
          ? undefined
          : {
              messageId: 'task-1:assistant',
              status,
              recovery: 'complete',
              content,
              throughSequence: 1,
              targetThroughSequence: 1,
            },
    });
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          author={author}
          parentAuthor={parentAuthor}
          recovery={{
            parentConversationId: 'parent',
            threadId: 'child',
            selectedTaskId: 'task-1',
            ready: true,
          }}
          turns={[
            {
              ...turns[0],
              contentRecoveryAvailable: source !== 'revoked cache',
              activity: { ...turns[0].activity, status, content },
            },
          ]}
        />
      </ChatSurfaceHarness>,
    );
    const rendered = mockRenderedContent.mock.calls.findLast(([parts]) =>
      parts.some(
        (part: TMessageContentParts) => part?.type === 'tool_call' && part.tool_call.id === 'root',
      ),
    )?.[0];
    expect(rendered).toBeDefined();
    expect(JSON.stringify(rendered)).not.toContain('approval');
    expect(rendered[0]).toEqual(content[0]);
    expect(rendered[1]).toMatchObject({
      agentId: 'worker',
      tool_call: {
        id: 'root',
        stepId: 'root-step',
        toolPreparationDurationMs: 12,
        subagent_content: [
          { agentId: 'nested-worker', tool_call: { id: 'nested', name: 'nested_tool' } },
        ],
      },
    });
    expect(content).toEqual(cached);
    expect(mockPartScope.mock.calls.at(-1)?.[0]).toBeNull();
    if (status === 'completed') {
      expect(mockCopyMessage.mock.calls.at(-1)?.[0].content).toEqual(rendered);
    }
  },
);

it.each(
  (['completed', 'failed', 'cancelled', 'interrupted'] as const).flatMap((status) =>
    (['partial', 'complete'] as const).map((recovery) => ({ status, recovery })),
  ),
)(
  'retains the durable $status outcome beside nonempty $recovery history without replaying it',
  ({ status, recovery }) => {
    const content: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Retained earlier work.' },
    ];
    mockRecoveredQuery.mockReturnValue({
      data: {
        messageId: 'task-1:assistant',
        status,
        recovery,
        content,
        throughSequence: 0,
        targetThroughSequence: 0,
        retryUntil: 0,
      },
    });
    const props = {
      author,
      parentAuthor,
      recovery: {
        parentConversationId: 'parent',
        threadId: 'child',
        selectedTaskId: 'task-1',
        ready: true,
      },
      turns: [
        {
          ...turns[0],
          outcome: {
            messageId: 'task-1:assistant',
            parentMessageId: 'task-1:user',
            role: 'assistant' as const,
            text: 'Durable final outcome.',
            ...(status === 'failed' ? { error: true } : {}),
          },
          activity: { ...turns[0].activity, status },
        },
      ],
    };
    const { rerender } = render(
      <ChatSurfaceHarness>
        <SubagentConversation {...props} />
      </ChatSurfaceHarness>,
    );
    expect(screen.getByText('Retained earlier work.')).toBeInTheDocument();
    expect(screen.getAllByText('Durable final outcome.')).toHaveLength(1);
    expect(mockCopyMessage.mock.calls.at(-1)?.[0].content).toEqual([
      ...content,
      { type: ContentTypes.TEXT, text: 'Durable final outcome.', phase: 'final_answer' },
    ]);
    expect(content).toHaveLength(1);
    mockRecoveredQuery.mockReturnValue({
      data: {
        messageId: 'task-1:assistant',
        status,
        recovery: 'complete',
        content: [
          ...content,
          { type: ContentTypes.TEXT, text: 'Durable final outcome.', phase: 'final_answer' },
        ],
        throughSequence: 1,
        targetThroughSequence: 1,
      },
    });
    rerender(
      <ChatSurfaceHarness>
        <SubagentConversation {...props} />
      </ChatSurfaceHarness>,
    );
    expect(screen.getAllByText('Durable final outcome.')).toHaveLength(1);
  },
);

it('shows the durable outcome when partial capture and fallback both lack the final answer', () => {
  mockRecoveredQuery.mockReturnValue({
    data: {
      messageId: 'task-1:assistant',
      status: 'completed',
      recovery: 'partial',
      content: [],
      throughSequence: -1,
      targetThroughSequence: -1,
    },
  });
  render(
    <ChatSurfaceHarness>
      <SubagentConversation
        author={author}
        parentAuthor={parentAuthor}
        recovery={{
          parentConversationId: 'parent',
          threadId: 'child',
          selectedTaskId: 'task-1',
          ready: true,
        }}
        turns={[
          {
            ...turns[0],
            activity: { ...turns[0].activity, items: [] },
            outcome: {
              messageId: 'task-1:assistant',
              parentMessageId: 'task-1:user',
              role: 'assistant',
              text: 'Durable outcome survives.',
            },
          },
        ]}
      />
    </ChatSurfaceHarness>,
  );
  expect(screen.getAllByText('Durable outcome survives.')).toHaveLength(1);
});

it.each(['partial', 'complete'] as const)(
  'does not append a truncated terminal projection already present in %s journal text',
  (recovery) => {
    const content: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'Durable final outcome with retained full detail.',
        phase: 'final_answer',
      },
    ];
    mockRecoveredQuery.mockReturnValue({
      data: {
        messageId: 'task-1:assistant',
        status: 'completed',
        recovery,
        content,
        throughSequence: 1,
        targetThroughSequence: 1,
      },
    });
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          author={author}
          parentAuthor={parentAuthor}
          recovery={{
            parentConversationId: 'parent',
            threadId: 'child',
            selectedTaskId: 'task-1',
            ready: true,
          }}
          turns={[
            {
              ...turns[0],
              outcome: {
                messageId: 'task-1:assistant',
                parentMessageId: 'task-1:user',
                role: 'assistant',
                text: 'Durable final outcome',
                textTruncated: true,
              },
            },
          ]}
        />
      </ChatSurfaceHarness>,
    );
    expect(screen.getAllByText('Durable final outcome with retained full detail.')).toHaveLength(1);
    expect(screen.queryByText('Durable final outcome', { exact: true })).not.toBeInTheDocument();
    expect(mockCopyMessage.mock.calls.at(-1)?.[0].content).toBe(content);
    expect(content).toHaveLength(1);
  },
);

it.each(['partial', 'complete'] as const)(
  'does not display a terminal outcome while a %s capture is still running',
  (recovery) => {
    mockRecoveredQuery.mockReturnValue({
      data: {
        messageId: 'task-1:assistant',
        status: 'running',
        recovery,
        content: [{ type: ContentTypes.TEXT, text: 'Current work.' }],
        throughSequence: 0,
        targetThroughSequence: 0,
      },
    });
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          author={author}
          parentAuthor={parentAuthor}
          recovery={{
            parentConversationId: 'parent',
            threadId: 'child',
            selectedTaskId: 'task-1',
            ready: true,
          }}
          turns={[
            {
              ...turns[0],
              outcome: {
                messageId: 'task-1:assistant',
                parentMessageId: 'task-1:user',
                role: 'assistant',
                text: 'Durable terminal outcome.',
              },
            },
          ]}
        />
      </ChatSurfaceHarness>,
    );
    expect(screen.getByText('Current work.')).toBeInTheDocument();
    expect(screen.queryByText('Durable terminal outcome.')).not.toBeInTheDocument();
  },
);

it.each(['partial', 'complete'] as const)(
  'does not append the locked SDK multi-block result already present in %s recovered content',
  (recovery) => {
    const outcome = 'First paragraph.\nAn intrinsic line.\nSecond paragraph.';
    const content: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'First paragraph.\nAn intrinsic line.Second paragraph.' },
    ];
    mockRecoveredQuery.mockReturnValue({
      data: {
        messageId: 'task-1:assistant',
        status: 'completed',
        recovery,
        content,
        throughSequence: 1,
        targetThroughSequence: 1,
      },
    });
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          author={author}
          parentAuthor={parentAuthor}
          recovery={{
            parentConversationId: 'parent',
            threadId: 'child',
            selectedTaskId: 'task-1',
            ready: true,
          }}
          turns={[
            {
              ...turns[0],
              outcome: {
                messageId: 'task-1:assistant',
                parentMessageId: 'task-1:user',
                role: 'assistant',
                text: outcome,
              },
            },
          ]}
        />
      </ChatSurfaceHarness>,
    );
    expect(
      screen.queryByText(outcome, { exact: true, normalizer: (text) => text }),
    ).not.toBeInTheDocument();
    expect(mockCopyMessage.mock.calls.at(-1)?.[0].content).toBe(content);
    expect(content).toHaveLength(1);
  },
);

it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
  'keeps the %s outcome after ordered guidance with recovery disabled',
  (status) => {
    mockRecoveredQuery.mockReturnValue({ data: undefined });
    const content: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Before guidance.' },
      {
        type: ContentTypes.STEER,
        steer: 'Parent guidance.',
        steerId: 'control',
        clientSteerId: 'invocation',
      },
      { type: ContentTypes.TEXT, text: 'After guidance.' },
    ];
    const outcome = {
      messageId: 'task-1:assistant',
      parentMessageId: 'task-1:user',
      role: 'assistant' as const,
      text: `Durable ${status} result.`,
      ...(status === 'failed' ? { error: true } : {}),
    };
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          author={author}
          parentAuthor={parentAuthor}
          recovery={{
            parentConversationId: 'parent',
            threadId: 'child',
            selectedTaskId: 'task-1',
            ready: true,
          }}
          turns={[
            {
              ...turns[0],
              contentRecoveryAvailable: false,
              outcome,
              activity: { ...turns[0].activity, status, content },
            },
          ]}
        />
      </ChatSurfaceHarness>,
    );
    expect(screen.getAllByText(outcome.text)).toHaveLength(1);
    expect(mockCopyMessage.mock.calls.at(-1)?.[0].content).toEqual([
      ...content,
      { type: ContentTypes.TEXT, text: outcome.text, phase: 'final_answer' },
    ]);
    expect(content).toHaveLength(3);
  },
);
