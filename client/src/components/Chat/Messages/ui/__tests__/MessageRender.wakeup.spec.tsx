import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import { ContentTypes, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ParentSubagentSummary, TMessage } from 'librechat-data-provider';
import type { TMessageChatContext } from '~/common';
import { ShareMessagesProvider } from '~/components/Share/ShareMessagesProvider';
import { ShareContext } from '~/Providers/ShareContext';
import MessageRender from '../MessageRender';

const mockAgentsMap = {
  agent_reviewer: { id: 'agent_reviewer', name: 'Code Reviewer' },
  agent_lia: { id: 'agent_lia', name: 'Lia' },
};

let mockChildren = new Map<string, ParentSubagentSummary>();
jest.mock('~/components/Chat/Subagents/ParentSubagentsProvider', () => ({
  useParentSubagents: () => ({ byThreadId: mockChildren }),
}));

jest.mock('~/Providers', () => ({
  ...jest.requireActual('~/Providers/MessageContext'),
  useAgentsMapContext: () => mockAgentsMap,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useContentMetadata: () => ({ hasParallelContent: false }),
  useMessageActions: ({ message }: { message: TMessage }) => ({
    ask: jest.fn(),
    edit: false,
    index: 0,
    agent: mockAgentsMap.agent_lia,
    assistant: undefined,
    enterEdit: jest.fn(),
    conversation: { conversationId: 'conversation-1', endpoint: 'agents' },
    messageLabel: message.isCreatedByUser ? 'Danny' : 'Lia',
    handleFeedback: jest.fn(),
    handleContinue: jest.fn(),
    copyToClipboard: jest.fn(),
    getCanCopy: () => true,
    regenerateMessage: jest.fn(),
    hasConfiguredSender: false,
  }),
}));

/** The author glyph reduced to whose face it is. */
jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: ({ agent, iconData }: { agent?: { name?: string }; iconData: { iconURL?: string } }) => (
    <span data-testid="author-face" data-agent={agent?.name ?? ''} data-icon={iconData.iconURL} />
  ),
}));
jest.mock('~/components/Chat/Messages/Content/Wakeup', () => ({
  __esModule: true,
  default: () => <div data-testid="wakeup-card" />,
}));
jest.mock('~/components/Chat/Messages/Content/MessageContent', () => ({
  __esModule: true,
  default: () => <div data-testid="message-content" />,
}));
jest.mock('~/components/Chat/Messages/HoverButtons', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Chat/Messages/SiblingSwitch', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Chat/Messages/ui/MessageTimestamp', () => ({
  __esModule: true,
  default: () => null,
}));

const chatContext = { latestMessageId: 'wake' } as unknown as TMessageChatContext;

const subagentWakeup = (subagentType: string) =>
  [
    'A detached subagent task has completed. Continue the parent task using its durable result below.',
    JSON.stringify({
      background_task_id: 'task-1',
      subagent_thread_id: 'thread-1',
      subagent_type: subagentType,
      status: 'completed',
      result: 'One finding.',
    }),
  ].join('\n');

const backgroundWakeup = [
  'A background tool task has finished. Continue using its durable result below.',
  JSON.stringify([
    {
      background_task_id: 'task-2',
      tool_call_id: 'call-1',
      tool: 'bash',
      status: 'completed',
      result: 'ok',
    },
  ]),
].join('\n');

function renderMessage(
  text: string,
  parentModel = 'agent_lia',
  shared = false,
  submitted = false,
  dispatch?: TMessage,
) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    [QueryKeys.messages, 'conversation-1'],
    [
      dispatch ?? {
        messageId: 'dispatch',
        isCreatedByUser: false,
        endpoint: 'agents',
        model: parentModel,
        sender: 'Historical Parent',
        iconURL: '/historical.png',
      },
    ],
  );
  const message = {
    messageId: 'wake',
    parentMessageId: 'parent',
    conversationId: 'conversation-1',
    isCreatedByUser: true,
    isUserSubmitted: submitted,
    text,
  } as unknown as TMessage;
  const row = <MessageRender message={message} chatContext={chatContext} currentEditId={null} />;
  const sharedReply: TMessage = {
    messageId: 'shared-reply',
    parentMessageId: 'wake',
    conversationId: 'original-shared-conversation',
    text: 'Parent continuation',
    isCreatedByUser: false,
    endpoint: 'agents',
    model: parentModel,
    sender: 'Shared Historical Parent',
    iconURL: '/shared-historical.png',
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        {shared ? (
          <ShareContext.Provider value={{ isSharedConvo: true, shareId: 'share-1' }}>
            <ShareMessagesProvider messages={[message, sharedReply]}>{row}</ShareMessagesProvider>
          </ShareContext.Provider>
        ) : (
          <ShareMessagesProvider
            messages={
              queryClient.getQueryData<TMessage[]>([QueryKeys.messages, 'conversation-1']) ?? []
            }
          >
            {row}
          </ShareMessagesProvider>
        )}
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('MessageRender wake-up rows', () => {
  beforeEach(() => {
    mockChildren = new Map([
      [
        'thread-1',
        {
          threadId: 'thread-1',
          parentMessageId: 'dispatch',
          subagentType: 'agent_reviewer',
          subagentKind: 'agent',
          agentId: 'agent_reviewer',
          title: 'Stored Reviewer',
        } as ParentSubagentSummary,
      ],
    ]);
  });
  it('heads a subagent report with the subagent name and face instead of a system label', () => {
    renderMessage(subagentWakeup('agent_reviewer'));

    const heading = screen.getByRole('heading', { name: 'Code Reviewer' });
    expect(heading).not.toHaveClass('sr-only');
    expect(screen.getByTestId('author-face')).toHaveAttribute('data-agent', 'Code Reviewer');
    expect(screen.queryByText('com_ui_system_event')).not.toBeInTheDocument();
    expect(screen.queryByText(/agent_reviewer/)).not.toBeInTheDocument();
    /** Delivered by the host, not typed: outlined, on the user's side. */
    expect(screen.getByTestId('message-body')).toHaveClass('border', 'border-border-medium');
    expect(screen.getByTestId('message-body')).not.toHaveClass('bg-surface-tertiary');
    expect(screen.getByTestId('wakeup-card')).toBeInTheDocument();
  });

  it('names a self-spawned report after the agent it woke', () => {
    mockChildren.set('thread-1', {
      ...mockChildren.get('thread-1')!,
      subagentType: 'self',
      agentId: 'agent_lia',
    });
    renderMessage(subagentWakeup('self'));

    expect(screen.getByRole('heading', { name: /Lia$/ })).toBeInTheDocument();
    expect(screen.getByTestId('author-face')).toHaveAttribute('data-agent', 'Lia');
  });

  it('keeps historical self-spawn identity after switching the current agent', () => {
    mockChildren.set('thread-1', { ...mockChildren.get('thread-1')!, subagentType: 'self' });
    renderMessage(subagentWakeup('self'), 'agent_reviewer');
    expect(screen.getByRole('heading', { name: 'Code Reviewer' })).toBeInTheDocument();
    expect(screen.getByTestId('author-face')).toHaveAttribute('data-agent', 'Code Reviewer');
  });

  it('retains the historical avatar when the self-spawning agent is unavailable', () => {
    mockChildren.set('thread-1', {
      ...mockChildren.get('thread-1')!,
      subagentType: 'self',
      agentId: 'agent_deleted',
    });
    renderMessage(subagentWakeup('self'), 'agent_deleted');
    expect(screen.getByRole('heading', { name: 'Historical Parent' })).toBeInTheDocument();
    expect(screen.getByTestId('author-face')).toHaveAttribute('data-icon', '/historical.png');
  });

  it.each(['agent_reviewer', 'agent_deleted'])(
    'reads an unindexed public self wake-up author from the shared transcript (%s)',
    (parentModel) => {
      mockChildren.clear();
      renderMessage(subagentWakeup('self'), parentModel, true);
      const name = parentModel === 'agent_reviewer' ? 'Code Reviewer' : 'Shared Historical Parent';
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
      expect(screen.getByTestId('author-face')).toHaveAttribute(
        'data-icon',
        '/shared-historical.png',
      );
      expect(screen.queryByRole('heading', { name: 'Lia' })).not.toBeInTheDocument();
    },
  );

  it.each(['agent_reviewer', 'agent_research_team'])(
    'preserves the explicit graph alias %s without resolving a saved agent',
    (subagentType) => {
      mockChildren.set('thread-1', {
        ...mockChildren.get('thread-1')!,
        subagentType,
        subagentKind: 'graph',
        title: subagentType,
      });
      renderMessage(subagentWakeup(subagentType));
      expect(screen.getByRole('heading', { name: subagentType })).toBeInTheDocument();
      expect(screen.getByTestId('author-face')).toHaveAttribute('data-agent', '');
    },
  );

  it('preserves an unindexed legacy alias without resolving a saved agent', () => {
    mockChildren.clear();
    renderMessage(subagentWakeup('agent_reviewer'));
    expect(screen.getByRole('heading', { name: 'agent_reviewer' })).toBeInTheDocument();
    expect(screen.getByTestId('author-face')).toHaveAttribute('data-agent', '');
  });

  it('names an unresolvable known agent generically, never by its id', () => {
    mockChildren.set('thread-1', {
      ...mockChildren.get('thread-1')!,
      subagentKind: 'agent',
      agentId: 'agent_unknown',
      subagentType: 'agent_unknown',
      title: 'agent_unknown',
    });
    renderMessage(subagentWakeup('agent_unknown'));

    expect(screen.getByRole('heading', { name: /com_ui_subagent_actor$/ })).toBeInTheDocument();
    expect(screen.queryByText(/agent_unknown/)).not.toBeInTheDocument();
  });

  it('keeps a background tool report a system turn, since no agent wrote it', () => {
    renderMessage(backgroundWakeup);

    expect(screen.getByRole('heading', { name: 'com_ui_system_event' })).toBeInTheDocument();
    expect(screen.queryByTestId('author-face')).not.toBeInTheDocument();
  });

  it.each([
    ['self', 'graph', 'self'],
    ['agent_reviewer', 'agent', 'Code Reviewer'],
    ['self', 'agent', 'Code Reviewer'],
  ] as const)(
    'recovers a private child omitted from the bounded index (%s/%s)',
    (alias, kind, label) => {
      mockChildren.clear();
      const dispatch: TMessage = {
        messageId: 'old-dispatch',
        parentMessageId: null,
        conversationId: 'conversation-1',
        isCreatedByUser: false,
        text: '',
        endpoint: 'agents',
        model: 'agent_lia',
        sender: 'Lia',
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'old-call',
              name: 'subagent',
              args: { run_in_background: true },
              output: JSON.stringify({
                background_task_id: 'task-1',
                subagent_thread_id: 'thread-1',
                tool: 'subagent',
                subagent_type: alias,
                status: 'running',
                message: 'Poll using background_task_id task-1.',
              }),
              subagentIdentity: {
                subagentKind: kind,
                subagentAgentId: kind === 'graph' ? 'graph:self' : 'agent_reviewer',
              },
            },
          },
        ],
      };
      renderMessage(subagentWakeup(alias), 'agent_lia', false, false, dispatch);
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Lia' })).not.toBeInTheDocument();
    },
  );

  it('preserves a graph title whose prefix resembles a legacy label', () => {
    mockChildren.set('thread-1', {
      ...mockChildren.get('thread-1')!,
      subagentType: 'Subagent: research',
      title: 'Subagent: research',
      subagentKind: 'graph',
      agentId: undefined,
    });
    renderMessage(subagentWakeup('Subagent: research'));
    expect(screen.getByRole('heading', { name: 'Subagent: research' })).toBeInTheDocument();
  });

  it('leaves an ordinary user turn without a visible author', () => {
    renderMessage('Hello there');

    expect(screen.getByRole('heading', { hidden: true })).toHaveClass('sr-only');
    expect(screen.getByTestId('message-body')).toHaveClass('bg-surface-tertiary');
  });
});

it('keeps user-submitted wake-up lookalikes as ordinary chat prompts', () => {
  const text = subagentWakeup('self');
  renderMessage(text, 'agent_lia', false, true);
  expect(screen.getByTestId('message-content')).toBeInTheDocument();
  expect(screen.queryByTestId('wakeup-card')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { hidden: true })).toHaveClass('sr-only');
});

it('uses the validated spawning lane for a private self wake-up', () => {
  mockChildren.set('thread-1', {
    ...mockChildren.get('thread-1')!,
    subagentType: 'self',
    agentId: 'agent_reviewer',
  });
  renderMessage(subagentWakeup('self'), 'agent_lia');
  expect(screen.getByRole('heading', { name: 'Code Reviewer' })).toBeInTheDocument();
  expect(screen.getByTestId('author-face')).toHaveAttribute('data-agent', 'Code Reviewer');
});
