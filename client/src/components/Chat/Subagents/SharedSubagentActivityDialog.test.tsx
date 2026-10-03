import React from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import SubagentCall from '~/components/Chat/Messages/Content/Parts/SubagentCall';
import SharedSubagentActivityDialog from './SharedSubagentActivityDialog';
import { MessageContext } from '~/Providers/MessageContext';
import { ShareContext } from '~/Providers/ShareContext';
import { ChatSurfaceHarness } from 'test/harness';

const mockUseSubagentThreadQuery = jest.fn();

jest.mock('~/data-provider', () => ({
  useSubagentThreadQuery: (...args: unknown[]) => mockUseSubagentThreadQuery(...args),
}));

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string => {
      if (key === 'com_ui_subagent_complete') return 'Ran agent';
      if (key === 'com_ui_subagent_activity') return 'Agent activity';
      return key;
    },
}));

jest.mock('~/Providers', () => ({ useAgentsMapContext: () => ({}) }));
jest.mock('~/components/Share/MessageIcon', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="author-face" />,
}));
jest.mock('~/hooks/MCP', () => ({ useMCPServerNames: () => [] }));

jest.mock('./SubagentActivity', () => ({
  __esModule: true,
  SubagentActivityScrollSurface: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shared-scroll-surface">{children}</div>
  ),
  default: ({
    activity,
  }: {
    activity: { title: string; items: Array<{ type: string; text?: string }> };
  }) => (
    <div data-testid="shared-subagent-activity">
      <span>{activity.title}</span>
      {activity.items.map((item, index) => (
        <span key={index}>{item.text ?? item.type}</span>
      ))}
    </div>
  ),
}));

jest.mock('./SubagentConversation', () => ({
  __esModule: true,
  default: ({
    turns,
    author,
    parentAuthor,
  }: {
    author: { name: string };
    parentAuthor: { name: string };
    turns: Array<{
      taskId: string;
      trigger: { summary: string };
      activity: { items: Array<{ type: string; text?: string }> };
    }>;
  }) => {
    const { MessageSurfaceContext } = jest.requireActual('~/components/Chat/Messages/ui/surface');
    return (
      <MessageSurfaceContext.Consumer>
        {(surface: string) => (
          <div
            data-testid="subagent-conversation"
            data-message-surface={surface}
            data-author={author.name}
            data-parent-author={parentAuthor.name}
          >
            {turns.map((turn) => (
              <div key={turn.taskId}>
                {turn.trigger.summary}
                {turn.activity.items.map((item, index) => (
                  <span key={index}>{item.text ?? item.type}</span>
                ))}
              </div>
            ))}
          </div>
        )}
      </MessageSurfaceContext.Consumer>
    );
  },
}));

const persistedContent = (text: string): TMessageContentParts[] => [
  { type: ContentTypes.TEXT, text } as TMessageContentParts,
];

const detachedOutput = JSON.stringify({
  background_task_id: 'task-1',
  subagent_thread_id: 'thread-1',
  tool: 'subagent',
  subagent_type: 'researcher',
  status: 'running',
  message:
    'Started subagent "researcher" background task. Poll the host background-task tool with background_task_id "task-1".',
});

/** The shared thread as ShareView holds it: the agent that dispatched the child. */
const sharedMessages = [
  {
    messageId: 'shared-parent',
    parentMessageId: null,
    conversationId: 'shared-conversation',
    isCreatedByUser: false,
    endpoint: 'agents',
    model: 'agent_parent',
    sender: 'Lia',
    text: '',
  } as unknown as TMessage,
];

function renderSharedCall(input: {
  output?: string;
  persistedContent?: TMessageContentParts[];
  detached?: boolean;
}) {
  return render(
    <ChatSurfaceHarness>
      <ShareContext.Provider value={{ isSharedConvo: true, shareId: 'share-1' }}>
        <MessageContext.Provider
          value={{
            conversationId: 'shared-conversation',
            messageId: 'shared-parent',
            isExpanded: false,
          }}
        >
          <SubagentCall
            toolCallId="shared-call"
            initialProgress={1}
            args={{
              subagent_type: 'researcher',
              description: 'Review the release.',
              run_in_background: input.detached === true,
            }}
            output={input.output}
            persistedContent={input.persistedContent}
          />
          <SharedSubagentActivityDialog shareId="share-1" messages={sharedMessages} />
        </MessageContext.Provider>
      </ShareContext.Provider>
    </ChatSurfaceHarness>,
  );
}

describe('SharedSubagentActivityDialog', () => {
  beforeEach(() => mockUseSubagentThreadQuery.mockClear());

  it('opens readable foreground activity from the shared message payload and restores focus', async () => {
    renderSharedCall({
      output: 'Legacy fallback.',
      persistedContent: persistedContent('Shared review complete.'),
    });
    const trigger = screen.getByRole('button', { name: 'Ran agent' });

    fireEvent.click(trigger);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute(
      'data-message-surface',
      'bg-surface-dialog',
    );
    expect(screen.getByText('Shared review complete.')).toBeInTheDocument();
    /** Named as main chat names them: the child by its readable type, the
     *  briefing by the shared agent that sent it. */
    expect(screen.getByRole('heading', { name: 'researcher' })).toBeInTheDocument();
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute(
      'data-author',
      'researcher',
    );
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute(
      'data-parent-author',
      'Lia',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('renders detached persisted activity without performing the private durable query', () => {
    renderSharedCall({
      output: detachedOutput,
      persistedContent: persistedContent('Detached work survived refresh.'),
      detached: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Agent activity' }));

    expect(screen.getByText('Detached work survived refresh.')).toBeInTheDocument();
    expect(mockUseSubagentThreadQuery).not.toHaveBeenCalled();
  });

  it('makes a detached shared card without persisted activity explicitly noninteractive', () => {
    renderSharedCall({ output: detachedOutput, detached: true });

    expect(screen.getByRole('button', { name: 'Agent activity' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockUseSubagentThreadQuery).not.toHaveBeenCalled();
  });

  it('keeps a shared detached card with only invisible reservations noninteractive', () => {
    renderSharedCall({
      output: detachedOutput,
      detached: true,
      persistedContent: [
        {
          type: ContentTypes.ACTIVITY_LABEL,
          activity_label: '',
        } as TMessageContentParts,
      ],
    });

    expect(screen.getByRole('button', { name: 'Agent activity' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
