import React from 'react';
import { RecoilRoot } from 'recoil';
import { EModelEndpoint } from 'librechat-data-provider';
import { act, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { RevealedQueuedTurn } from '~/store/steer';
import PendingTurn from '~/components/Chat/Messages/PendingTurn';
import { revealedQueuedTurnFamily } from '~/store/steer';
import { ChatContext } from '~/Providers';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { name: 'Danny', username: 'danny' } }),
}));

jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="message-icon" />,
}));

jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <span data-testid="markdown-lite">{content}</span>,
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
}: {
  revealed?: RevealedQueuedTurn | null;
  latestMessageId?: string | undefined;
  messages?: TMessage[];
}) {
  const jotaiStore = createStore();
  if (revealed != null) {
    jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), revealed);
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const chatContext = { conversation, latestMessageId, index: 0 } as unknown as React.ContextType<
    typeof ChatContext
  >;
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <JotaiProvider store={jotaiStore}>
          <ChatContext.Provider value={chatContext}>
            <PendingTurn messages={messages} />
          </ChatContext.Provider>
        </JotaiProvider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
  return { ...rendered, jotaiStore };
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

  it('renders nothing without a reveal', () => {
    renderPendingTurn({ revealed: null });
    expect(screen.queryByTestId('pending-turn')).toBeNull();
  });

  it('renders nothing while the thread shows a different tail than the response it follows', () => {
    renderPendingTurn({ revealed: reveal(), latestMessageId: 'another-branch' });
    expect(screen.queryByTestId('pending-turn')).toBeNull();
  });

  it('leaves the thread the moment the reveal ends', () => {
    const { jotaiStore } = renderPendingTurn({ revealed: reveal() });
    expect(screen.getByTestId('pending-turn')).toBeInTheDocument();

    act(() => {
      jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), null);
    });

    expect(screen.queryByTestId('pending-turn')).toBeNull();
  });
  it('hides the drawing once history has a successor while the handoff guard remains', () => {
    const { jotaiStore } = renderPendingTurn({
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
    expect(jotaiStore.get(revealedQueuedTurnFamily(CONVO_ID))).not.toBeNull();
  });
});
