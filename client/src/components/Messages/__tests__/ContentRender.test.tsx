import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, within } from '@testing-library/react';
import type { Agent, TConversation, TMessage } from 'librechat-data-provider';
import type { TMessageChatContext } from '~/common';
import ContentRender from '../ContentRender';

const mockRenders = { parts: 0 };

/**
 * Memoized like the real parts tree with its default comparator, and rendering the
 * resume header it is handed where a steer would place it.
 */
jest.mock('~/components/Chat/Messages/Content/ContentParts', () => {
  const { memo } = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: memo(function MockContentParts({ authorHeader }: { authorHeader?: React.ReactNode }) {
      mockRenders.parts += 1;
      return <div data-testid="parts">{authorHeader}</div>;
    }),
  };
});

jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: ({ agent }: { agent?: { name?: string } }) => (
    <span data-testid="message-icon" data-agent={agent?.name ?? ''} />
  ),
}));

jest.mock('~/components/Chat/Messages/HoverButtons', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Chat/Messages/ui/MessageTimestamp', () => ({
  __esModule: true,
  default: () => null,
}));

/**
 * Stands in for the agents map: `useMessageActions` reads it through context, so the
 * agents list landing re-renders the memoized row without any new props.
 */
const mockAgentContext = React.createContext<Agent | undefined>(undefined);
const mockActions = {
  enterEdit: jest.fn(),
  handleContinue: jest.fn(),
  handleFeedback: jest.fn(),
  copyToClipboard: jest.fn(),
  getCanCopy: jest.fn(() => true),
  regenerateMessage: jest.fn(),
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAttachments: () => ({ attachments: undefined, searchResults: undefined }),
  useContentMetadata: () => ({ hasParallelContent: false }),
  useMessageActions: ({
    message,
    chatContext,
  }: {
    message?: TMessage;
    chatContext: TMessageChatContext;
  }) => {
    const { useContext } = jest.requireActual<typeof import('react')>('react');
    const agent = useContext(mockAgentContext);
    return {
      ...mockActions,
      edit: false,
      index: chatContext.index,
      agent,
      assistant: undefined,
      conversation: chatContext.conversation,
      messageLabel: agent?.name ?? message?.sender,
      latestMessageId: chatContext.latestMessageId,
      latestMessageDepth: chatContext.latestMessageDepth,
      hasConfiguredSender: false,
    };
  },
}));

const conversation = {
  conversationId: 'convo-1',
  endpoint: 'agents',
  agent_id: 'agent_lia',
} as TConversation;

const chatContext: TMessageChatContext = {
  ask: jest.fn(),
  index: 0,
  regenerate: jest.fn(),
  conversation,
  latestMessageId: 'user-1',
  latestMessageDepth: 1,
  handleContinue: jest.fn(),
  feedbackEnabled: false,
  isSubmitting: false,
};

const assistantMessage = {
  messageId: 'assistant-1',
  parentMessageId: 'user-1',
  conversationId: conversation.conversationId,
  sender: 'agent_lia',
  isCreatedByUser: false,
  text: '',
  content: [{ type: 'text', text: 'Done.' }],
  createdAt: '2026-09-17T00:00:00.000Z',
} as TMessage;

const lia = { id: 'agent_lia', name: 'Lia' } as Agent;
const setSiblingIdx = jest.fn();
const setCurrentEditId = jest.fn();

/** Renders one row with no agent resolved yet, and lets the test land the agents list. */
const renderRow = (message: TMessage) => {
  const view = (agent?: Agent) => (
    <RecoilRoot>
      <mockAgentContext.Provider value={agent}>
        <ContentRender
          message={message}
          chatContext={chatContext}
          siblingIdx={0}
          siblingCount={1}
          setSiblingIdx={setSiblingIdx}
          currentEditId={null}
          setCurrentEditId={setCurrentEditId}
        />
      </mockAgentContext.Provider>
    </RecoilRoot>
  );
  const result = render(view());
  return { ...result, resolveAgent: (agent: Agent) => result.rerender(view(agent)) };
};

describe('ContentRender resume author header', () => {
  beforeEach(() => {
    mockRenders.parts = 0;
  });

  it('keeps the parts tree from re-rendering when the agent resolves after paint', () => {
    const { resolveAgent } = renderRow(assistantMessage);
    const partsRendersAtPaint = mockRenders.parts;

    resolveAgent(lia);

    // The row itself did re-render: its own header now names the agent.
    expect(screen.getAllByTestId('message-icon')[0]).toHaveAttribute('data-agent', 'Lia');
    expect(mockRenders.parts).toBe(partsRendersAtPaint);
  });

  it('still restates the resolved author inside the message', () => {
    const { resolveAgent } = renderRow(assistantMessage);
    const parts = screen.getByTestId('parts');
    expect(within(parts).getByRole('heading', { level: 2 })).toHaveTextContent('agent_lia');

    resolveAgent(lia);

    expect(within(parts).getByRole('heading', { level: 2 })).toHaveTextContent('Lia');
    expect(within(parts).getByTestId('message-icon')).toHaveAttribute('data-agent', 'Lia');
  });

  it('hands a user message no resume header', () => {
    renderRow({ ...assistantMessage, messageId: 'user-2', isCreatedByUser: true });

    expect(screen.getByTestId('parts')).toBeEmptyDOMElement();
  });
});
