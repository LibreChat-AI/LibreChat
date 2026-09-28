import React from 'react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { EModelEndpoint } from 'librechat-data-provider';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import type { RevealedQueuedTurn } from '~/store/steer';
import type { QueuedMessage } from '~/store/families';
import { QueuedTurnPortalProvider } from '~/components/Chat/Steering/QueuedTurnPortal';
import PendingTurn from '~/components/Chat/Messages/PendingTurn';
import { revealedQueuedTurnFamily } from '~/store/steer';
import PendingSteerChips from '../PendingSteerChips';
import { ChatContext } from '~/Providers';
import store from '~/store';

const CONVO_ID = 'convo-queued-turn';
const RESPONSE_ID = 'completed-response';
const removeQueued = jest.fn();
const discardQueued = jest.fn(async (_message: QueuedMessage) => true);
const restoreToComposer = jest.fn(() => true);
const editToComposer = jest.fn();
const sendQueuedNow = jest.fn();
const mockShowToast = jest.fn();

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { name: 'Danny' } }),
}));
jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="message-icon" />,
}));
jest.mock('~/components/Chat/Messages/Content/Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));
jest.mock('@librechat/client', () => {
  const { createSteerMorphIconMock } = jest.requireActual('~/../test/mockMorphIcon');
  return {
    useToastContext: () => ({ showToast: mockShowToast }),
    TooltipAnchor: jest.requireActual('@librechat/client').TooltipAnchor,
    MorphIcon: createSteerMorphIconMock(),
  };
});

const conversation = {
  conversationId: CONVO_ID,
  endpoint: EModelEndpoint.agents,
  model: 'gpt-x',
} as TConversation;

const serverRow = (requestId: string, status: 'queued' | 'claimed' = 'queued'): QueuedMessage => ({
  id: `row-${requestId}`,
  text: `queued ${requestId}`,
  createdAt: 1,
  clientRequestId: requestId,
  server: { id: `server-${requestId}`, status, revision: 1 },
});

const reveal = (requestId: string): RevealedQueuedTurn => ({
  clientRequestId: requestId,
  parentMessageId: RESPONSE_ID,
  text: `queued ${requestId}`,
  revealedAt: '2026-09-14T00:00:00.000Z',
});

function QueueState({ onSet }: { onSet: (setter: (id: string) => void) => void }) {
  const setQueue = useSetRecoilState(store.queuedMessagesByConvoId(CONVO_ID));
  onSet((id) => setQueue((items) => items.filter((item) => item.id !== id)));
  return null;
}

function renderQueue(rows: QueuedMessage[], latestMessageId = RESPONSE_ID) {
  const jotaiStore = createStore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const steering = {
    queueKey: CONVO_ID,
    defaultAction: 'steer',
    duringRunActive: false,
    canSendQueuedNow: true,
    canSteer: false,
    pausedOnApproval: false,
    removeQueued,
    discardQueued,
    sendQueuedNow,
    setDefaultAction: jest.fn(),
  } as unknown as SteeringControls;
  let setQueueById: (id: string) => void = () => undefined;
  removeQueued.mockImplementation((id: string) => setQueueById(id));
  const view = (tail: string, messages?: TMessage[]) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot initializeState={({ set }) => set(store.queuedMessagesByConvoId(CONVO_ID), rows)}>
        <JotaiProvider store={jotaiStore}>
          <ChatContext.Provider
            value={
              { conversation, latestMessageId: tail, index: 0 } as React.ContextType<
                typeof ChatContext
              >
            }
          >
            <QueuedTurnPortalProvider>
              <PendingTurn messages={messages} />
              <PendingSteerChips
                conversationId={CONVO_ID}
                steering={steering}
                onEditToComposer={editToComposer}
                onRestoreToComposer={restoreToComposer}
              />
              <QueueState onSet={(setter) => (setQueueById = setter)} />
            </QueuedTurnPortalProvider>
          </ChatContext.Provider>
        </JotaiProvider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const result = render(view(latestMessageId));
  return {
    jotaiStore,
    renderView: (tail: string, messages?: TMessage[]) => result.rerender(view(tail, messages)),
  };
}

describe('queued starting turn controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('replaces only the matching queue row with a user turn carrying Edit and Remove', () => {
    const { jotaiStore } = renderQueue([serverRow('first'), serverRow('second')]);
    expect(screen.getAllByTestId('queued-message-row')).toHaveLength(2);

    act(() => jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), reveal('first')));

    const turn = screen.getByTestId('pending-turn');
    expect(turn).toHaveTextContent('queued first');
    expect(within(turn).getByRole('status')).toHaveTextContent('com_ui_queued_turn_starting');
    expect(within(turn).getByRole('button', { name: 'com_ui_edit_message' })).toBeEnabled();
    expect(within(turn).getByRole('button', { name: 'com_ui_remove_queued' })).toBeEnabled();
    expect(within(turn).queryByRole('button', { name: 'com_ui_send_now' })).toBeNull();
    expect(screen.getAllByTestId('queued-message-row')).toHaveLength(1);
    expect(screen.getByTestId('queued-message-row')).toHaveTextContent('queued second');
    expect(screen.getAllByText('queued first')).toHaveLength(1);
  });

  it('edits a starting turn only after cancelling its durable copy', async () => {
    const row = {
      ...serverRow('first'),
      files: [{ file_id: 'file-1' }],
      quotes: ['quote'],
      manualSkills: ['skill'],
    };
    const { jotaiStore } = renderQueue([row]);
    act(() => jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), reveal('first')));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_edit_message' }));

    await waitFor(() => expect(discardQueued).toHaveBeenCalledWith(row));
    await waitFor(() => expect(removeQueued).toHaveBeenCalledWith(row.id));
    expect(restoreToComposer).toHaveBeenCalledWith(
      row.text,
      row.files,
      { quotes: ['quote'], manualSkills: ['skill'] },
      CONVO_ID,
    );
    expect(editToComposer).not.toHaveBeenCalled();
  });

  it('keeps a claimed turn removable but never offers edit or a second send', () => {
    const { jotaiStore } = renderQueue([serverRow('first', 'claimed')]);
    act(() => jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), reveal('first')));

    const turn = screen.getByTestId('pending-turn');
    expect(within(turn).queryByRole('button', { name: 'com_ui_edit_message' })).toBeNull();
    expect(within(turn).getByRole('button', { name: 'com_ui_remove_queued' })).toBeEnabled();
    expect(screen.queryByTestId('pending-steer-chips')).toBeNull();
    expect(sendQueuedNow).not.toHaveBeenCalled();
  });

  it('does not lose the in-flight cancellation lock when the row moves to the turn', async () => {
    let finish: (accepted: boolean) => void = () => undefined;
    discardQueued.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finish = resolve)),
    );
    const { jotaiStore } = renderQueue([serverRow('first')]);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_remove_queued' }));
    expect(discardQueued).toHaveBeenCalledTimes(1);

    act(() => jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), reveal('first')));
    const turn = screen.getByTestId('pending-turn');
    expect(within(turn).getByRole('button', { name: 'com_ui_remove_queued' })).toBeDisabled();
    expect(within(turn).getByRole('button', { name: 'com_ui_edit_message' })).toBeDisabled();
    fireEvent.click(within(turn).getByRole('button', { name: 'com_ui_remove_queued' }));
    expect(discardQueued).toHaveBeenCalledTimes(1);

    await act(async () => finish(false));
    expect(within(turn).getByRole('button', { name: 'com_ui_remove_queued' })).toBeEnabled();
    expect(removeQueued).not.toHaveBeenCalled();
    expect(restoreToComposer).not.toHaveBeenCalled();
  });

  it('restores the full context after confirmed removal, never on failed cancellation', async () => {
    const row = {
      ...serverRow('first'),
      files: [{ file_id: 'file-1' }],
      quotes: ['q'],
      manualSkills: ['s'],
    };
    discardQueued.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { jotaiStore } = renderQueue([row]);
    act(() => jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), reveal('first')));
    const remove = screen.getByRole('button', { name: 'com_ui_remove_queued' });

    fireEvent.click(remove);
    await waitFor(() => expect(remove).toBeEnabled());
    expect(restoreToComposer).not.toHaveBeenCalled();
    expect(removeQueued).not.toHaveBeenCalled();

    fireEvent.click(remove);
    await waitFor(() => expect(removeQueued).toHaveBeenCalledWith(row.id));
    expect(restoreToComposer).toHaveBeenCalledWith(
      row.text,
      row.files,
      { quotes: ['q'], manualSkills: ['s'] },
      CONVO_ID,
    );
    act(() => jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), null));
    expect(screen.queryByTestId('pending-turn')).toBeNull();
    expect(screen.queryByTestId('queued-message-row')).toBeNull();
  });

  it('returns the queue row when the bubble is hidden by a different tail or real successor', () => {
    const { jotaiStore, renderView } = renderQueue([serverRow('first')]);
    act(() => jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), reveal('first')));
    expect(screen.queryByTestId('queued-message-row')).toBeNull();

    renderView('another-response');
    expect(screen.queryByTestId('pending-turn')).toBeNull();
    expect(screen.getByTestId('queued-message-row')).toHaveTextContent('queued first');

    renderView(RESPONSE_ID, [{ messageId: 'real-user', parentMessageId: RESPONSE_ID } as TMessage]);
    expect(screen.queryByTestId('pending-turn')).toBeNull();
    expect(screen.getByTestId('queued-message-row')).toHaveTextContent('queued first');
    expect(sendQueuedNow).not.toHaveBeenCalled();
  });
});
