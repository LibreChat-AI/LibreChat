import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Agents, TMessage } from 'librechat-data-provider';
import type { PendingSteer } from '~/store/families';
import { applyPendingAction } from '~/utils/approval';
import PendingSteers from '../PendingSteers';
import store from '~/store';

const mockRetry = jest.fn();
const mockSendAsNew = jest.fn();
const mockEscalate = jest.fn();
const mockMoveToQueue = jest.fn();
const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Chat/useSteerEscalate', () => ({
  __esModule: true,
  default: () => mockEscalate,
}));

jest.mock('~/hooks/Chat/useSteerRecovery', () => ({
  __esModule: true,
  default: () => ({ retry: mockRetry, sendAsNew: mockSendAsNew }),
}));

jest.mock('~/hooks/Chat/useSteerCancel', () => ({
  useSteerMoveToQueue: () => mockMoveToQueue,
}));

jest.mock('../SteerPart', () => ({
  __esModule: true,
  default: ({ steer }: { steer: string }) => <div data-testid="steer-part">{steer}</div>,
}));

const CONVO_ID = 'convo-1';

const pending = (over: Partial<PendingSteer> = {}): PendingSteer => ({
  steerId: 's1',
  text: 'change of plan',
  status: 'sending',
  createdAt: 1,
  ...over,
});

function renderPending(steers: PendingSteer[], messages?: TMessage[]) {
  /* The escalation control reads the message cache to gate on a run pause,
     which is route-scoped: the same providers the chat view supplies around
     this row in the app. */
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData([QueryKeys.messages, CONVO_ID], messages ?? []);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <RecoilRoot
          initializeState={({ set }) => set(store.pendingSteersByConvoId(CONVO_ID), steers)}
        >
          <PendingSteers conversationId={CONVO_ID} />
        </RecoilRoot>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('PendingSteers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMoveToQueue.mockResolvedValue('reclaimed');
  });

  it('renders nothing with no pending steers', () => {
    const { container } = renderPending([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a dimmed steer part with sending status', () => {
    renderPending([pending()]);
    expect(screen.getByTestId('steer-part')).toHaveTextContent('change of plan');
    expect(screen.getByText('com_ui_sending')).toBeInTheDocument();
  });

  it('offers retry and send-as-new on failure', () => {
    renderPending([pending({ status: 'failed' })]);
    expect(screen.getByText('com_ui_steer_failed_inline')).toBeInTheDocument();
    expect(screen.getByText('com_ui_retry')).toBeInTheDocument();
    expect(screen.getByText('com_ui_send_as_new')).toBeInTheDocument();
  });

  it('shows the quote count carried by a failed steer', () => {
    renderPending([pending({ status: 'failed', quotes: ['first', 'second'] })]);

    expect(screen.getByText('2')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('com_ui_queued_quote_count')).toHaveClass('sr-only');
  });

  it('locks recovery actions while a protocol-v1 delivery is uncertain', () => {
    renderPending([
      pending({
        status: 'failed',
        deliveryUncertain: true,
        generationProtocolVersion: 1,
      }),
    ]);

    expect(screen.getByText('com_ui_steer_delivery_uncertain')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_retry')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_send_as_new')).not.toBeInTheDocument();
  });

  it('offers only same-id retry for an uncertain protocol-v2 delivery', () => {
    renderPending([
      pending({
        status: 'failed',
        deliveryUncertain: true,
        generationProtocolVersion: 2,
      }),
    ]);

    expect(screen.getByText('com_ui_steer_delivery_uncertain')).toBeInTheDocument();
    expect(screen.getByText('com_ui_retry')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_send_as_new')).not.toBeInTheDocument();
  });

  it('reclaims an acknowledged steer before moving it to the queue', async () => {
    const steer = pending({ status: 'pending', steerId: 's-ack' });
    renderPending([steer]);

    fireEvent.click(screen.getByText('com_ui_convert_to_queue'));

    await waitFor(() => expect(mockMoveToQueue).toHaveBeenCalledWith(steer));
  });

  it('reports when a steer reached the agent before it could be reclaimed', async () => {
    mockMoveToQueue.mockResolvedValue('applied');
    renderPending([pending({ status: 'pending' })]);

    fireEvent.click(screen.getByText('com_ui_convert_to_queue'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_steer_already_applied',
        status: 'info',
      }),
    );
  });

  it('retries the failed steer by id', () => {
    renderPending([pending({ status: 'failed', steerId: 's-failed' })]);
    fireEvent.click(screen.getByText('com_ui_retry'));
    expect(mockRetry).toHaveBeenCalledWith('s-failed');
    expect(mockSendAsNew).not.toHaveBeenCalled();
  });

  it('sends the failed steer as new by id', () => {
    renderPending([pending({ status: 'failed', steerId: 's-failed' })]);
    fireEvent.click(screen.getByText('com_ui_send_as_new'));
    expect(mockSendAsNew).toHaveBeenCalledWith('s-failed');
    expect(mockRetry).not.toHaveBeenCalled();
  });

  /* The escalation control is the in-thread half of the `escalateSteer`
     shortcut: it only exists on a steer the server can still be asked to
     interrupt, so the shortcut never aims at a row that cannot act. */
  describe('interrupt escalation', () => {
    it('offers escalation on an acknowledged steer', () => {
      renderPending([pending({ status: 'pending', steerId: 's-ack' })]);
      expect(screen.getByTestId('steer-escalate-now')).toBeEnabled();
    });

    it('arms the steer by id, carrying its own generation', () => {
      renderPending([pending({ status: 'pending', steerId: 's-ack', generationCreatedAt: 4141 })]);
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
      expect(mockEscalate).toHaveBeenCalledWith({
        steerId: 's-ack',
        generationCreatedAt: 4141,
      });
    });

    it.each([
      ['still sending, so it has no server id to arm', { status: 'sending' as const }],
      ['already interrupting', { status: 'pending' as const, preempt: true }],
      ['failed, where retry is the offer instead', { status: 'failed' as const }],
    ])('offers nothing on a steer that is %s', (_label, over) => {
      renderPending([pending(over)]);
      expect(screen.queryByTestId('steer-escalate-now')).not.toBeInTheDocument();
    });

    /* One interrupt at a time: a second arm would seal the same run twice. */
    it('disables escalation while another steer is already interrupting', () => {
      renderPending([
        pending({ status: 'pending', steerId: 's-arming', preempt: true }),
        pending({ status: 'pending', steerId: 's-other' }),
      ]);
      expect(screen.getByTestId('steer-escalate-now')).toBeDisabled();
    });

    /* Both an unresolved tool approval and a live `ask_user_question` suspend
       the generation while keeping its submission slot occupied, so an arm
       would be refused either way. Gating on approvals alone left this control
       enabled through a question while the composer correctly refused. */
    it('disables escalation while the run is paused on a question', () => {
      const askAction = {
        actionId: 'a1',
        streamId: 's1',
        createdAt: 0,
        payload: { type: 'ask_user_question', question: { question: 'Which one?' } },
      } as unknown as Agents.PendingAction;
      const paused = applyPendingAction(
        { messageId: 'm1', isCreatedByUser: false, content: [] } as unknown as TMessage,
        askAction,
      );

      renderPending([pending({ status: 'pending', steerId: 's-paused' })], [paused]);
      expect(screen.getByTestId('steer-escalate-now')).toBeDisabled();
    });

    it('labels a steer that is already interrupting', () => {
      renderPending([pending({ status: 'pending', preempt: true })]);
      expect(screen.getByText('com_ui_steer_in_flight_preempt')).toBeInTheDocument();
    });
  });
});
