/**
 * @jest-environment jsdom
 */
import { memo, createContext, useContext } from 'react';
import { render, screen, within } from '@testing-library/react';
import type { Agent, TConversation, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { MessagePartsHost, ContentPartsSlotProps } from '../../../react/host';
import type { TMessageChatContext } from '../../../react/messages/types';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { initEnglish } from '../../../__fixtures__/i18n';
import ContentRender from '../ContentRender';

beforeAll(initEnglish);

const mockRenders = { parts: 0 };

/**
 * Memoized like the real parts tree with its default comparator, and rendering the
 * resume header it is handed where a steer would place it.
 */
const MockContentParts = memo(function MockContentParts({
  authorHeader,
}: Pick<ContentPartsSlotProps, 'authorHeader'>) {
  mockRenders.parts += 1;
  return <div data-testid="parts">{authorHeader}</div>;
});

/**
 * Stands in for the agents list: the parts host resolves the agent through context, so the
 * agents list landing re-renders the memoized row without any new props.
 */
const mockAgentContext = createContext<Agent | undefined>(undefined);

const partsHost = {
  useAgent: () => useContext(mockAgentContext),
  useUser: () => undefined,
  useUserTextPreferences: () => ({
    usernameDisplay: false,
    enableUserMsgMarkdown: false,
    collapseLongUserMessages: false,
  }),
  useShowThinking: () => true,
  useAutoExpandTools: () => false,
  renderContentParts: (props: ContentPartsSlotProps) => (
    <MockContentParts authorHeader={props.authorHeader} />
  ),
} as unknown as MessagePartsHost;

const messagesHost = createMessagesHost({
  renderMessageIcon: ({ agent }) => (
    <span data-testid="message-icon" data-agent={agent?.name ?? ''} />
  ),
});

jest.mock('../HoverButtons', () => ({ __esModule: true, default: () => null }));

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
  const view = (agent?: Agent): ReactNode => (
    <MessagesHostProvider host={messagesHost}>
      <MessagePartsHostProvider host={partsHost}>
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
      </MessagePartsHostProvider>
    </MessagesHostProvider>
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
