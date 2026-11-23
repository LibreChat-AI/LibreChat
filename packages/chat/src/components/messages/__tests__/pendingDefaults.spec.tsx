/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import type { RevealedQueuedTurn } from '../../../react/steer/rows';
import type { ChatContract } from '../../../react/chat/contract';
import type { PendingSteer } from '../../../core';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { revealedQueuedTurnFamily } from '../../../react/steer/rows';
import { pendingSteersByConvoId } from '../../../react/steer/atoms';
import { MessagesHostProvider } from '../../../react/messages/host';
import { createSteerHost } from '../../../__fixtures__/steerHost';
import { MessagePartsHostProvider } from '../../../react/host';
import { SteerHostProvider } from '../../../react/steer/host';
import { ChatContext } from '../../../react/chat/context';
import { initEnglish } from '../../../__fixtures__/i18n';
import MessagesView from '../MessagesView';

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  return initEnglish();
});

const CONVO_ID = 'shared-convo';
const RESPONSE_ID = 'reply-1';

const messages = [
  { messageId: RESPONSE_ID, conversationId: CONVO_ID, text: 'shared reply' },
] as TMessage[];

const reveal: RevealedQueuedTurn = {
  clientRequestId: 'queued-request',
  parentMessageId: RESPONSE_ID,
  text: 'queued follow-up',
  revealedAt: '2026-09-14T00:00:00.000Z',
};

const steer: PendingSteer = {
  steerId: 's1',
  text: 'change of plan',
  status: 'sending',
  createdAt: 1,
};

const chat: ChatContract = Object.assign(
  {
    index: 0,
    isSubmitting: false,
    latestMessageId: RESPONSE_ID,
    latestMessageDepth: 0,
    messagesKey: CONVO_ID,
  } as ChatContract,
  {
    abortScroll: false,
    setAbortScroll: () => undefined,
    conversation: {
      conversationId: CONVO_ID,
      endpoint: null,
      title: null,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
    },
  },
);

function renderList(withSteerHost: boolean) {
  const store = createStore();
  store.set(pendingSteersByConvoId(CONVO_ID), [steer]);
  store.set(revealedQueuedTurnFamily(CONVO_ID), reveal);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const list = (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <ChatContext.Provider value={chat}>
          <MessagesHostProvider host={createMessagesHost()}>
            <MessagePartsHostProvider host={createMessagePartsHost()}>
              <MessagesView
                messagesTree={messages}
                messages={messages}
                showScrollButton={false}
                maximizeChatSpace={false}
                renderThread={({ messagesTree }) => (
                  <ol>
                    {messagesTree?.map((message) => (
                      <li key={message.messageId}>{message.text}</li>
                    ))}
                  </ol>
                )}
              />
            </MessagePartsHostProvider>
          </MessagesHostProvider>
        </ChatContext.Provider>
      </JotaiProvider>
    </QueryClientProvider>
  );
  return render(
    withSteerHost ? <SteerHostProvider host={createSteerHost()}>{list}</SteerHostProvider> : list,
  );
}

describe('MessagesView pending defaults', () => {
  it('renders the thread and no pending rows when no steer host is mounted', () => {
    renderList(false);

    expect(screen.getByText('shared reply')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-turn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-steers')).not.toBeInTheDocument();
  });

  it('renders the pending turn and pending steers when a steer host is mounted', () => {
    renderList(true);

    expect(screen.getByText('shared reply')).toBeInTheDocument();
    expect(screen.getByTestId('pending-turn')).toHaveTextContent('queued follow-up');
    expect(screen.getByTestId('pending-steers')).toHaveTextContent('change of plan');
  });
});
