/**
 * @jest-environment jsdom
 */
import { EModelEndpoint } from 'librechat-data-provider';
import { act, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { MessagesHost } from '../../../react/messages/host';
import type { ChatContract } from '../../../react/chat/contract';
import type { RevealedQueuedTurn } from '../../../react';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { revealedQueuedTurnFamily } from '../../../react/steer/rows';
import { MessagesHostProvider } from '../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { ChatContext } from '../../../react/chat/context';
import PendingTurn from '../PendingTurn';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

const CONVO_ID = 'convo-pending';
const RESPONSE_ID = 'response-1';

const conversation = {
  conversationId: CONVO_ID,
  endpoint: EModelEndpoint.agents,
  model: 'gpt-x',
} as TConversation;

const reveal = (overrides: Partial<RevealedQueuedTurn> = {}): RevealedQueuedTurn => ({
  clientRequestId: 'client-request-1',
  parentMessageId: RESPONSE_ID,
  text: 'queued follow-up',
  revealedAt: '2026-09-14T00:00:00.000Z',
  ...overrides,
});

function renderPendingTurn({
  revealed,
  latestMessageId = RESPONSE_ID,
  messages,
  usernameDisplay = false,
  userName = 'Danny',
  enableUserMsgMarkdown = false,
  renderMarkdown = ({ content }: { content: string }) => (
    <span data-testid="markdown">{content}</span>
  ),
  renderMessageIcon = jest.fn(() => <span data-testid="message-icon" />),
}: {
  revealed?: RevealedQueuedTurn | null;
  latestMessageId?: string;
  messages?: TMessage[];
  usernameDisplay?: boolean;
  userName?: string;
  enableUserMsgMarkdown?: boolean;
  renderMarkdown?: (props: { content: string }) => ReactNode;
  renderMessageIcon?: MessagesHost['renderMessageIcon'];
} = {}) {
  const store = createStore();
  if (revealed != null) {
    store.set(revealedQueuedTurnFamily(CONVO_ID), revealed);
  }
  const partsHost = createMessagePartsHost({
    useUser: () => ({ name: userName, username: 'danny' }),
    useUserTextPreferences: () => ({
      enableUserMsgMarkdown,
      collapseLongUserMessages: false,
      usernameDisplay,
    }),
    renderMarkdown,
  });
  const messagesHost = createMessagesHost({ renderMessageIcon });
  const rendered = render(
    <JotaiProvider store={store}>
      <ChatContext.Provider
        value={
          {
            conversation,
            latestMessageId,
            index: 0,
          } as ChatContract
        }
      >
        <MessagesHostProvider host={messagesHost}>
          <MessagePartsHostProvider host={partsHost}>
            <PendingTurn messages={messages} />
          </MessagePartsHostProvider>
        </MessagesHostProvider>
      </ChatContext.Provider>
    </JotaiProvider>,
  );
  return { ...rendered, store, renderMessageIcon };
}

describe('PendingTurn', () => {
  it('draws the revealed queued turn as a user turn after the response it follows', () => {
    const { container } = renderPendingTurn({ revealed: reveal() });

    const row = screen.getByTestId('pending-turn');
    expect(row.querySelector('.message-render')).not.toBeNull();
    expect(row.querySelector('.user-turn')).not.toBeNull();
    expect(row).toHaveTextContent('queued follow-up');
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_queued_turn_starting');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('labels the turn with the signed-in name when the viewer asks for it', () => {
    const { renderMessageIcon } = renderPendingTurn({
      revealed: reveal(),
      usernameDisplay: true,
    });

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Danny');
    expect(renderMessageIcon).toHaveBeenCalledWith({
      iconData: {
        endpoint: EModelEndpoint.agents,
        model: 'gpt-x',
        modelLabel: 'Danny',
        isCreatedByUser: true,
      },
    });
  });

  it('uses the generic user label when names are hidden', () => {
    renderPendingTurn({ revealed: reveal(), usernameDisplay: false });

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('com_user_message');
  });

  it('renders plain text unless the viewer wants user markdown', () => {
    const { container, renderMessageIcon: plainIcon } = renderPendingTurn({
      revealed: reveal(),
    });
    expect(container.querySelector('.whitespace-pre-wrap')).not.toBeNull();
    expect(screen.queryByTestId('markdown')).toBeNull();
    expect(plainIcon).toHaveBeenCalled();

    const markdown = jest.fn(({ content }: { content: string }) => (
      <span data-testid="markdown">{content}</span>
    ));
    renderPendingTurn({
      revealed: reveal(),
      enableUserMsgMarkdown: true,
      renderMarkdown: markdown,
    });
    expect(screen.getByTestId('markdown')).toHaveTextContent('queued follow-up');
    expect(markdown).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'queued follow-up', variant: 'lite' }),
    );
  });

  it('renders nothing without a reveal', () => {
    renderPendingTurn({ revealed: null });
    expect(screen.queryByTestId('pending-turn')).toBeNull();
  });

  it('renders nothing while the thread shows a different tail than the response it follows', () => {
    renderPendingTurn({ revealed: reveal(), latestMessageId: 'another-branch' });
    expect(screen.queryByTestId('pending-turn')).toBeNull();
  });

  it('leaves the thread the moment the reveal ends', () => {
    const { store } = renderPendingTurn({ revealed: reveal() });
    expect(screen.getByTestId('pending-turn')).toBeInTheDocument();

    act(() => {
      store.set(revealedQueuedTurnFamily(CONVO_ID), null);
    });

    expect(screen.queryByTestId('pending-turn')).toBeNull();
  });

  it('hides the drawing once history has a successor while the handoff guard remains', () => {
    const { store } = renderPendingTurn({
      revealed: reveal(),
      messages: [
        {
          messageId: 'real-successor',
          parentMessageId: RESPONSE_ID,
          isCreatedByUser: true,
        } as TMessage,
      ],
    });

    expect(screen.queryByTestId('pending-turn')).toBeNull();
    expect(store.get(revealedQueuedTurnFamily(CONVO_ID))).not.toBeNull();
  });
});
