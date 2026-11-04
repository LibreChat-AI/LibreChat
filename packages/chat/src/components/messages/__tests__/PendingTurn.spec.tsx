/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import type { RevealedQueuedTurn } from '../../../react';
import { revealedQueuedTurnFamily } from '../../../react/steer/rows';
import PendingTurn from '../PendingTurn';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

const CONVO_ID = 'convo-pending';
const RESPONSE_ID = 'response-1';

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
  latestMessageId?: string;
  messages?: TMessage[];
}) {
  const store = createStore();
  if (revealed != null) {
    store.set(revealedQueuedTurnFamily(CONVO_ID), revealed);
  }
  const rendered = render(
    <JotaiProvider store={store}>
      <PendingTurn
        messages={messages}
        conversationId={CONVO_ID}
        latestMessageId={latestMessageId}
        label="Danny"
        icon={<span data-testid="message-icon" />}
        renderBody={(_message, text) => <span data-testid="body">{text}</span>}
      />
    </JotaiProvider>,
  );
  return { ...rendered, store };
}

describe('PendingTurn', () => {
  it('draws the revealed queued turn as a user turn after the response it follows', () => {
    const { container } = renderPendingTurn({ revealed: reveal() });

    const row = screen.getByTestId('pending-turn');
    expect(row.querySelector('.message-render')).not.toBeNull();
    expect(row.querySelector('.user-turn')).not.toBeNull();
    expect(screen.getByTestId('body')).toHaveTextContent('queued follow-up');
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
