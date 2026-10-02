import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageChatContext } from '~/common';
import MessageRender from '../MessageRender';

const mockAgentsMap = {
  agent_reviewer: { id: 'agent_reviewer', name: 'Code Reviewer' },
  agent_lia: { id: 'agent_lia', name: 'Lia' },
};

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
  default: ({ agent }: { agent?: { name?: string } }) => (
    <span data-testid="author-face" data-agent={agent?.name ?? ''} />
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

function renderMessage(text: string) {
  const message = {
    messageId: 'wake',
    parentMessageId: 'parent',
    conversationId: 'conversation-1',
    isCreatedByUser: true,
    text,
  } as unknown as TMessage;
  return render(
    <RecoilRoot>
      <MessageRender message={message} chatContext={chatContext} currentEditId={null} />
    </RecoilRoot>,
  );
}

describe('MessageRender wake-up rows', () => {
  it('heads a subagent report with the subagent name and face instead of a system label', () => {
    renderMessage(subagentWakeup('agent_reviewer'));

    const heading = screen.getByRole('heading', { name: /Code Reviewer$/ });
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
    renderMessage(subagentWakeup('self'));

    expect(screen.getByRole('heading', { name: /Lia$/ })).toBeInTheDocument();
    expect(screen.getByTestId('author-face')).toHaveAttribute('data-agent', 'Lia');
  });

  it('names an unresolvable subagent generically, never by its id', () => {
    renderMessage(subagentWakeup('agent_unknown'));

    expect(screen.getByRole('heading', { name: /com_ui_subagent_actor$/ })).toBeInTheDocument();
    expect(screen.queryByText(/agent_unknown/)).not.toBeInTheDocument();
  });

  it('keeps a background tool report a system turn, since no agent wrote it', () => {
    renderMessage(backgroundWakeup);

    expect(screen.getByRole('heading', { name: 'com_ui_system_event' })).toBeInTheDocument();
    expect(screen.queryByTestId('author-face')).not.toBeInTheDocument();
  });

  it('leaves an ordinary user turn without a visible author', () => {
    renderMessage('Hello there');

    expect(screen.getByRole('heading', { hidden: true })).toHaveClass('sr-only');
    expect(screen.getByTestId('message-body')).toHaveClass('bg-surface-tertiary');
  });
});
